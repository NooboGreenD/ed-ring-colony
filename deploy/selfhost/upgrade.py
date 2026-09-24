#!/usr/bin/env python3
"""Existing-installation upgrade, Ubuntu 20.04+, Python 3.8 stdlib + Docker Compose v2.
No schema install, volume removal, git reset, apt upgrade or TLS replacement.
Default command is plan; apply requires an explicit terminal confirmation.
"""
from __future__ import annotations
import argparse
import copy
import datetime as dt
import getpass
import fcntl
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import tarfile
import urllib.error
import urllib.request

SITE = 'https://edringcolony.ru'
SUPABASE = 'https://supabase.edringcolony.ru'
REPO = 'NooboGreenD/ed-ring-colony'
LEGACY_WORKFLOWS = {'auto-translate.yml', 'cron-capi-sync.yml', 'cron-cg-check.yml',
                    'cron-eddn-cleanup.yml', 'galnet-sync.yml', 'update-progress.yml'}
STATE_DEFAULT = '/var/lib/ed-ring-colony'
ENV_NAME = re.compile(r'^[A-Za-z_][A-Za-z0-9_]*$')
JOBS_PATTERN = re.compile(r'/api/(?:cron/|galnet(?:\?|\s|["\']))|(?:server-jobs|fetch-progress|galnet-sync)\.(?:mjs|js)')

class UpgradeError(Exception):
    pass

def private_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_suffix(path.suffix + '.tmp')
    with os.fdopen(os.open(str(temporary), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write('\n')
    temporary.chmod(0o600)
    temporary.replace(path)

def write_env(path, values):
    lines = []
    for key, value in sorted(values.items()):
        if not ENV_NAME.fullmatch(key):
            raise UpgradeError('Некорректное имя переменной окружения.')
        value = '' if value is None else str(value)
        if any(c in value for c in '\r\n\x00'):
            raise UpgradeError('Многострочная переменная требует ручной настройки: ' + key)
        # Double-quoted dotenv uses shell escapes, while $$ is a literal dollar.
        # A single-quoted value ending in backslash is ambiguous in Compose.
        lines.append('%s=%s\n' % (key, json.dumps(value.replace('$', '$$'), ensure_ascii=False)))
    path = Path(path)
    with os.fdopen(os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w') as stream:
        stream.writelines(lines)
    path.chmod(0o600)

def dollar_strings(value, old, new):
    if isinstance(value, str):
        return value.replace(old, new)
    if isinstance(value, list):
        return [dollar_strings(item, old, new) for item in value]
    if isinstance(value, dict):
        return {key.replace(old, new): dollar_strings(item, old, new) for key, item in value.items()}
    return value

def compose_read(context):
    # `compose config` deliberately doubles all dollars in its serialized output.
    return dollar_strings(json.loads(run(dc(context, 'config', '--format', 'json'))), '$$', '$')

def compose_write(path, config):
    # Re-escape literal values before loading this materialized JSON as Compose.
    private_json(path, dollar_strings(config, '$', '$$'))

def assert_compose_roundtrip(context, expected):
    actual = compose_read(context)
    for name, service in expected['services'].items():
        if actual['services'][name].get('environment', {}) != service.get('environment', {}):
            raise UpgradeError('Compose изменил environment при повторном чтении (%s). Остановлено, значения не выводятся.' % name)

def run(args, cwd=None, logfile=None):
    if logfile:
        with open(logfile, 'ab') as output:
            os.chmod(logfile, 0o600)
            result = subprocess.run(args, cwd=cwd, stdout=output, stderr=subprocess.STDOUT)
        if result.returncode:
            raise UpgradeError('Команда завершилась с ошибкой. Закрытый журнал: ' + str(logfile))
        return ''
    result = subprocess.run(args, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if result.returncode:
        # Docker config and SMTP failures can contain secret values: never print raw output.
        raise UpgradeError('Не выполнена команда %s (код %s). Проверьте Docker/Compose и пути, не публикуйте config/env.' %
                           (args[0], result.returncode))
    return result.stdout

def dc(context, *args):
    command = ['docker', 'compose', '--project-name', context['project'], '--project-directory', context['directory']]
    if context.get('env_file'):
        command += ['--env-file', context['env_file']]
    for file in context['files']:
        command += ['-f', file]
    return command + list(args)

# Secrets carried over from the running web container when the compose file lacks them.
OPTIONAL_WEB_SECRETS = (
    'YANDEX_TRANSLATE_API_KEY', 'YANDEX_TRANSLATE_IAM_TOKEN', 'YANDEX_TRANSLATE_FOLDER_ID',
    'VK_ID_CLIENT_ID', 'VK_ID_CLIENT_SECRET',
    'FRONTIER_CLIENT_ID', 'FRONTIER_CLIENT_SECRET', 'NEXT_PUBLIC_VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY',
    'VAPID_SUBJECT', 'EDDN_INGEST_SECRET', 'EDDN_INGEST_URL', 'INARA_API_KEY', 'DISCORD_WEBHOOK_URL',
    'RAVEN_API_BASE', 'GALNET_FEED_LIMIT', 'GALNET_TRANSLATE_LIMIT', 'BILLING_STORAGE', 'BILLING_PREVIEW_ADMIN',
)

def env_dict(container):
    return dict(item.split('=', 1) for item in container['Config'].get('Env', []) if '=' in item)

def context_of(container, env_override=None):
    labels = container['Config'].get('Labels') or {}
    directory = labels.get('com.docker.compose.project.working_dir')
    files = labels.get('com.docker.compose.project.config_files', '').split(',')
    project = labels.get('com.docker.compose.project')
    if not project or not directory or not all(files):
        raise UpgradeError('Контейнер запущен не через поддерживаемый Docker Compose.')
    if not Path(directory).is_dir() or any(not Path(file).is_file() for file in files):
        raise UpgradeError('Исходные Compose-файлы не найдены на хосте. Нужна ручная сверка путей.')
    env_file = env_override or labels.get('com.docker.compose.project.environment_file')
    if not env_file:
        for name in ('.env.production', '.env'):
            if (Path(directory) / name).is_file():
                env_file = str(Path(directory) / name)
                break
    if env_file and not Path(env_file).is_file():
        raise UpgradeError('Не найден env-файл стека.')
    return dict(directory=directory, files=files, project=project, env_file=env_file)

def select_container(containers, service, explicit=None):
    matches = []
    for item in containers:
        labels = item['Config'].get('Labels') or {}
        if explicit:
            match = explicit in (item['Name'].lstrip('/'), item['Id'])
        else:
            env = env_dict(item)
            match = labels.get('com.docker.compose.service') == service
            if service == 'web':
                match = match and (env.get('NEXT_PUBLIC_SITE_URL', '').rstrip('/') == SITE or env.get('NEXT_PUBLIC_SUPABASE_URL', '').rstrip('/') == SUPABASE)
            else:
                match = match and ('supabase/gotrue' in item['Config'].get('Image', '') or env.get('GOTRUE_SITE_URL', '').rstrip('/') == SITE)
        if match:
            matches.append(item)
    if len(matches) != 1:
        raise UpgradeError('Не удалось однозначно выбрать контейнер %s. Укажите --web-container / --auth-container (docker ps).' % service)
    return matches[0]

def discover(args):
    ids = run(['docker', 'ps', '-q']).split()
    if not ids:
        raise UpgradeError('Нет работающих контейнеров.')
    containers = json.loads(run(['docker', 'inspect'] + ids))
    web = select_container(containers, 'web', args.web_container)
    auth = select_container(containers, 'auth', args.auth_container)
    site_context = context_of(web, args.site_env)
    auth_context = context_of(auth, args.supabase_env)
    if site_context['project'] == auth_context['project']:
        raise UpgradeError('Сайт и Supabase в одном Compose-проекте. Автоматическое разделение не выполняется; используйте инструкцию ручного обновления.')
    if web['Config']['Labels']['com.docker.compose.service'] != 'web' or auth['Config']['Labels']['com.docker.compose.service'] != 'auth':
        raise UpgradeError('Ожидаются сервисы web и auth. Произвольные имена требуют ручной адаптации, чтобы не создать дубликаты.')
    return containers, web, auth, site_context, auth_context

def smtp_ready(env):
    host = env.get('GOTRUE_SMTP_HOST', '').strip()
    sender = env.get('GOTRUE_SMTP_ADMIN_EMAIL', '').strip()
    bad = ('example.', 'fake_', 'your-', 'changeme')
    if not host or host in ('supabase-mail', 'inbucket', 'mailpit') or '@' not in sender:
        return False
    if any(word in (host + ' ' + sender).lower() for word in bad):
        return False
    user = env.get('GOTRUE_SMTP_USER', '')
    password = env.get('GOTRUE_SMTP_PASS', '')
    return not user or bool(password and not any(word in (user + ' ' + password).lower() for word in bad))

def configure_smtp(env, force=False):
    result = dict(env)
    if smtp_ready(result) and not force:
        print('Обнаружена существующая SMTP-конфигурация: сохраняю её (значения не показываются).')
        return result
    if input('Настроить настоящий SMTP сейчас? [y/N] ').strip().lower() != 'y':
        return result
    for key, prompt, default in [
        ('GOTRUE_SMTP_HOST', 'SMTP host', ''), ('GOTRUE_SMTP_PORT', 'SMTP port', '587'),
        ('GOTRUE_SMTP_ADMIN_EMAIL', 'Адрес отправителя', ''), ('GOTRUE_SMTP_USER', 'SMTP login (пусто для доверенного relay)', ''),
    ]:
        result[key] = input('%s [%s]: ' % (prompt, default)).strip() or default
    if result['GOTRUE_SMTP_USER']:
        result['GOTRUE_SMTP_PASS'] = getpass.getpass('SMTP password (не выводится): ')
    else:
        result['GOTRUE_SMTP_PASS'] = ''
    if not result['GOTRUE_SMTP_PORT'].isdigit() or not 1 <= int(result['GOTRUE_SMTP_PORT']) <= 65535 or not smtp_ready(result):
        raise UpgradeError('Некорректный SMTP; изменения ещё не применены.')
    result['GOTRUE_SMTP_SENDER_NAME'] = 'ED Ring Colony'
    return result

def auth_environment(previous, smtp):
    result = dict(previous)
    result.update({k: v for k, v in smtp.items() if k.startswith('GOTRUE_SMTP_')})
    allow = [value.strip() for value in result.get('GOTRUE_URI_ALLOW_LIST', '').split(',') if value.strip()]
    allow = list(dict.fromkeys(allow + [SITE + '/api/auth/callback', SITE + '/auth/email']))
    result.update({
        'GOTRUE_SITE_URL': SITE, 'API_EXTERNAL_URL': SUPABASE, 'GOTRUE_URI_ALLOW_LIST': ','.join(allow),
        'GOTRUE_MAILER_AUTOCONFIRM': 'false', 'GOTRUE_DISABLE_SIGNUP': 'false' if smtp_ready(result) else 'true',
        'GOTRUE_SECURITY_MANUAL_LINKING_ENABLED': 'true', 'GOTRUE_PASSWORD_MIN_LENGTH': '12',
        'GOTRUE_SECURITY_UPDATE_PASSWORD_REQUIRE_REAUTHENTICATION': 'true', 'GOTRUE_MAILER_OTP_EXP': '3600',
        'GOTRUE_MAILER_TEMPLATES_CONFIRMATION': SITE + '/auth/templates/signup',
        'GOTRUE_MAILER_TEMPLATES_RECOVERY': SITE + '/auth/templates/recovery',
    })
    # Preserve provider keys/flags, correcting only their canonical callback.
    for provider in ('DISCORD', 'GOOGLE', 'GITHUB'):
        prefix = 'GOTRUE_EXTERNAL_' + provider
        if str(result.get(prefix + '_ENABLED', '')).lower() == 'true':
            result[prefix + '_REDIRECT_URI'] = SUPABASE + '/auth/v1/callback'
    return result

def strip_site_cron(text):
    output, count = [], 0
    for line in text.splitlines(keepends=True):
        if not line.lstrip().startswith('#') and JOBS_PATTERN.search(line):
            count += 1
            output.append('# disabled by edrc upgrade: job moved to Compose\n')
        else:
            output.append(line)
    return ''.join(output), count

def cron_check():
    managed = Path('/etc/cron.d/ed-ring-colony')
    others = []
    for file in [Path('/etc/crontab')] + list(Path('/etc/cron.d').glob('*')):
        if file == managed or not file.is_file():
            continue
        if strip_site_cron(file.read_text(errors='replace'))[1]:
            others.append(str(file))
    for user in ('root', 'www-data'):
        result = subprocess.run(['crontab', '-u', user, '-l'], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) if shutil.which('crontab') else None
        if result and result.returncode == 0 and strip_site_cron(result.stdout)[1]:
            others.append('crontab пользователя ' + user)
    if others:
        raise UpgradeError('Обнаружены другие расписания сайта: %s. Отключите только задания сайта, не backup cron, затем повторите.' % ', '.join(others))
    return managed

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        raise UpgradeError('Неожиданное перенаправление HTTPS. Проверьте канонический домен.')

def secure_open(request, timeout=30):
    return urllib.request.build_opener(NoRedirect()).open(request, timeout=timeout)

def public_json(url, headers=None, data=None):
    request = urllib.request.Request(url, headers={'User-Agent': 'EDRC-server-upgrade', **(headers or {})}, data=data)
    # HTTPS verification remains enabled; never offer --insecure.
    with secure_open(request) as response:
        return json.load(response)

def github_schedulers_off(fetch=public_json):
    response = fetch('https://api.github.com/repos/%s/actions/workflows?per_page=100' % REPO)
    workflows = response['workflows']
    if response.get('total_count', len(workflows)) > len(workflows):
        raise UpgradeError('Слишком много workflows для автоматической проверки. Проверьте их вручную; jobs не запущен.')
    active = [item['name'] for item in workflows if Path(item['path']).name in LEGACY_WORKFLOWS and item['state'] == 'active']
    if active:
        raise UpgradeError('GitHub ещё запускает: %s. Сначала отключите эти 6 workflows в Actions (Build Colonial Helper EXE оставить). Затем повторите activate-jobs.' % ', '.join(active))
    # A disabled schedule can still have an in-flight workflow that writes directly to Supabase.
    for status in ('in_progress', 'queued', 'waiting', 'pending', 'requested'):
        response = fetch('https://api.github.com/repos/%s/actions/runs?status=%s&per_page=100' % (REPO, status))
        runs = response['workflow_runs']
        if response.get('total_count', len(runs)) > len(runs):
            raise UpgradeError('Не все текущие запуски поместились в ответ GitHub. Нужна ручная проверка; jobs не запущен.')
        if any(Path(item.get('path', '')).name in LEGACY_WORKFLOWS for item in runs):
            raise UpgradeError('Старые workflow ещё выполняются/ожидают. Дождитесь завершения либо отмените их до включения jobs.')

def verify_layout(site, auth, web_container, auth_container):
    web = site['services']['web']
    if web.get('network_mode'):
        raise UpgradeError('Нестандартный network_mode web. Сеть jobs нужно согласовать вручную.')
    if 'db' not in auth['services'] or 'storage' not in auth['services']:
        raise UpgradeError('Ожидается стандартный локальный Supabase с db и storage. Схема не будет угадана.')
    storage = auth['services']['storage']
    if storage.get('environment', {}).get('STORAGE_BACKEND', 'file') == 'file':
        mounts = [item for item in storage.get('volumes', []) if item.get('target') == '/var/lib/storage']
        if not mounts or mounts[0].get('type') != 'bind' or not Path(mounts[0]['source']).is_dir():
            raise UpgradeError('Storage использует нестандартный/отсутствующий mount. Нужен ручной backup; контейнеры не остановлены.')
    for service, container, keys in [
        (web, web_container, ['SUPABASE_SERVICE_ROLE_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY']),
        (auth['services']['auth'], auth_container, ['GOTRUE_JWT_SECRET', 'GOTRUE_DB_DATABASE_URL']),
    ]:
        live = env_dict(container)
        configured = service.get('environment', {})
        keys = set(keys) | {key for key in configured if key.endswith(('_SECRET', '_KEY', '_PASS', '_PASSWORD'))}
        for key in keys:
            if configured.get(key) != live.get(key):
                raise UpgradeError('Файлы и работающий контейнер различаются по %s. Сначала согласуйте конфигурацию; значения не выводятся.' % key)
    jobs = site['services'].get('jobs')
    if jobs and not jobs.get('environment', {}).get('JOBS_STATE_FILE'):
        raise UpgradeError('Сервис jobs уже существует, но это не распознанный scheduler. Автоматическая замена запрещена.')


def check_backup_space(context, config, directory):
    size = run(dc(context, 'exec', '-T', 'db', 'sh', '-ec',
        'psql -U supabase_admin -d "${POSTGRES_DB:-postgres}" -Atc "select pg_database_size(current_database())"')).strip()
    if not size.isdigit():
        raise UpgradeError('Не удалось оценить размер БД перед backup.')
    storage_size = 0
    for mount in config.get('services', {}).get('storage', {}).get('volumes', []):
        if mount.get('target') == '/var/lib/storage' and mount.get('type') == 'bind':
            storage_size += int(run(['du', '-sk', mount['source']]).split()[0]) * 1024
    required = int((int(size) + storage_size) * 1.2) + 4 * 1024**3
    if shutil.disk_usage(directory).free < required:
        raise UpgradeError('Недостаточно свободного места для backup и сборки (консервативная оценка: %.1f GiB). Освободите место без удаления рабочих томов.' % (required / 1024**3))


def backup_database(context, directory):
    archive = directory / 'database.dump'
    with open(archive, 'wb') as output, open(directory / 'backup.log', 'ab') as errors:
        archive.chmod(0o600)
        result = subprocess.run(dc(context, 'exec', '-T', 'db', 'sh', '-ec',
            'pg_dump -U supabase_admin -d "${POSTGRES_DB:-postgres}" -Fc'), stdout=output, stderr=errors)
    if result.returncode or archive.stat().st_size == 0:
        raise UpgradeError('Резервная копия БД не создана. Обновление остановлено.')
    with open(directory / 'roles.sql', 'wb') as roles, open(directory / 'backup.log', 'ab') as errors:
        result = subprocess.run(dc(context, 'exec', '-T', 'db', 'pg_dumpall', '-U', 'supabase_admin', '--globals-only'),
                                stdout=roles, stderr=errors)
    if result.returncode:
        raise UpgradeError('Не удалось сохранить роли PostgreSQL. Обновление остановлено.')
    # Parse with the very same PostgreSQL image; do not rely on Ubuntu's older pg_restore.
    with open(archive, 'rb') as source:
        result = subprocess.run(dc(context, 'exec', '-T', 'db', 'pg_restore', '--list'),
                                stdin=source, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    if result.returncode:
        raise UpgradeError('pg_restore не смог прочитать архив. Обновление остановлено.')

def backup_storage(config, directory):
    storage = config.get('services', {}).get('storage', {})
    env = storage.get('environment', {})
    if env.get('STORAGE_BACKEND', 'file') != 'file':
        print('Storage использует внешнее хранилище: его backup/versioning должен быть настроен отдельно.')
        return
    mounts = [mount for mount in storage.get('volumes', []) if mount.get('target') == '/var/lib/storage']
    if not mounts:
        raise UpgradeError('Не найден Storage volume. Нужна проверка резервного копирования перед обновлением.')
    mount = mounts[0]
    if mount['type'] != 'bind' or not Path(mount['source']).is_dir():
        raise UpgradeError('Storage не является стандартным bind mount. Сделайте его backup вручную и адаптируйте скрипт.')
    target = directory / 'storage.tar.gz'
    with tarfile.open(target, 'w:gz') as archive:
        archive.add(mount['source'], arcname='storage')
    target.chmod(0o600)

def existing_snapshot(config, containers, service, tag):
    result = copy.deepcopy(config)
    selected = [item for item in containers if (item['Config'].get('Labels') or {}).get('com.docker.compose.service') == service and
                (item['Config'].get('Labels') or {}).get('com.docker.compose.project') == config.get('name')]
    if len(selected) != 1:
        raise UpgradeError('Не найден единственный работающий образ ' + service)
    run(['docker', 'tag', selected[0]['Image'], tag])
    result['services'][service]['image'] = tag
    result['services'][service].pop('build', None)
    return result

def context_for(path, original):
    return dict(project=original['project'], directory=original['directory'], files=[str(path)], env_file=None)

def saved_manifest(root):
    try:
        return json.loads((root / 'current.json').read_text())
    except (FileNotFoundError, ValueError):
        raise UpgradeError('Нет сохранённого обновления. Сначала plan / apply.')

def assert_root():
    if os.geteuid() != 0:
        raise UpgradeError('Для backup и управления Compose запустите через sudo.')

def apply(args, source, root):
    containers, web, auth, site_context, auth_context = discover(args)
    managed_cron = cron_check()
    site_old = compose_read(site_context)
    auth_old = compose_read(auth_context)
    verify_layout(site_old, auth_old, web, auth)
    print('Сайт: проект %s, каталог %s' % (site_context['project'], site_context['directory']))
    print('Supabase: проект %s, каталог %s' % (auth_context['project'], auth_context['directory']))
    print('Обновится web; у Supabase пересоздастся ТОЛЬКО auth. База/тома/сертификаты не заменяются.')
    print('Будет перерыв web/auth, а Storage приостановится на время согласованного backup. jobs останется ОСТАНОВЛЕН до activate-jobs.')
    print('Без SMTP новые регистрации закрываются; существующий вход сохраняется.')
    if args.command == 'plan':
        print('Это план. Изменений нет. Для применения: тот же вызов с apply.')
        return
    assert_root()
    if input('Для применения введите edringcolony.ru: ').strip() != 'edringcolony.ru':
        raise UpgradeError('Отменено.')
    if not (source / 'docker-compose.yml').is_file() or not (source / 'package-lock.json').is_file():
        raise UpgradeError('Нужен полный новый исходный архив, не один файл upgrade.py.')
    marker = source / '.edrc-release.json'
    if source.resolve() == Path(site_context['directory']).resolve() or (source / '.env.production').is_symlink() or marker.is_symlink():
        raise UpgradeError('Нужен отдельный каталог release, не текущий каталог и не symlink на env.')
    if (source / '.env.production').exists():
        try:
            if json.loads(marker.read_text()).get('project') != site_context['project']:
                raise ValueError()
        except (FileNotFoundError, ValueError):
            raise UpgradeError('В release уже есть чужой .env.production. Используйте свежий каталог.')
    smtp = configure_smtp(env_dict(auth))
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    root.chmod(0o700)
    stamp = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + secrets.token_hex(3)
    directory = root / 'backups' / stamp
    directory.mkdir(parents=True, mode=0o700)
    compose_write(directory / 'site-original.json', site_old)
    compose_write(directory / 'auth-original.json', auth_old)
    old_site = existing_snapshot(site_old, containers, 'web', 'edrc-web-rollback:' + stamp.lower())
    old_auth = existing_snapshot(auth_old, containers, 'auth', 'edrc-auth-rollback:' + stamp.lower())
    compose_write(directory / 'site-rollback.json', old_site)
    compose_write(directory / 'auth-rollback.json', old_auth)
    for label, ctx in [('site', site_context), ('supabase', auth_context)]:
        for number, file in enumerate(ctx['files'] + ([ctx['env_file']] if ctx['env_file'] else [])):
            shutil.copy2(file, directory / ('%s-config-%s' % (label, number)))
            (directory / ('%s-config-%s' % (label, number))).chmod(0o600)
    if managed_cron.is_file():
        shutil.copy2(managed_cron, directory / 'cron-original')
    verify_layout(site_old, auth_old, web, auth)
    check_backup_space(auth_context, auth_old, directory)
    print('Создание Postgres backup (включая auth) и копии файлов Storage…')
    storage_running = any((item['Config'].get('Labels') or {}).get('com.docker.compose.project') == auth_context['project']
                          and (item['Config'].get('Labels') or {}).get('com.docker.compose.service') == 'storage' for item in containers)
    if storage_running:
        run(dc(auth_context, 'stop', 'storage'))
    try:
        backup_database(auth_context, directory)
        backup_storage(auth_old, directory)
    finally:
        if storage_running:
            run(dc(auth_context, 'up', '-d', '--no-deps', 'storage'), logfile=directory / 'storage-restart.log')
    print('Архив БД прочитан pg_restore --list. Полный тест восстановления этим не заменяется.')
    env = dict(site_old['services']['web'].get('environment', {}))
    live = env_dict(web)
    for name in ('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'):
        env[name] = env.get(name) or live.get(name)
        if not env[name]:
            raise UpgradeError('Не найден ' + name + '. Нельзя пересобирать сайт с пустыми ключами.')
    # Optional secrets that older installs kept only in env_file (which we drop below).
    # Without this the Galnet translator silently stops after the first upgrade.
    for name in OPTIONAL_WEB_SECRETS:
        if not env.get(name) and live.get(name):
            env[name] = live[name]
    if not (env.get('YANDEX_TRANSLATE_API_KEY') or env.get('YANDEX_TRANSLATE_IAM_TOKEN')):
        print('Внимание: ключ Yandex Translate не найден — новости Galnet останутся без перевода '
              '(добавьте YANDEX_TRANSLATE_API_KEY в environment web).')
    env.update({'NEXT_PUBLIC_SITE_URL': SITE, 'NEXT_PUBLIC_SUPABASE_URL': SUPABASE,
                'FRONTIER_REDIRECT_URI': SITE + '/api/capi/callback', 'AUTH_EMAIL_ENABLED': 'false'})
    env['CRON_SECRET'] = env.get('CRON_SECRET') or secrets.token_hex(32)
    env.setdefault('AUTH_OAUTH_PROVIDERS', 'discord')
    # Only replace our own per-release env, never the working installation's file.
    private_json(marker, {'project': site_context['project'], 'managed': True})
    write_env(source / '.env.production', env)
    template_context = dict(project=site_context['project'], directory=str(source),
                            files=[str(source / 'docker-compose.yml')], env_file=str(source / '.env.production'))
    template = compose_read(template_context)
    # Catch dotenv punctuation/interpolation damage before deploying any container.
    for name, value in env.items():
        if template['services']['web'].get('environment', {}).get(name) != ('' if value is None else str(value)):
            raise UpgradeError('Проверка env release не прошла для %s. Значения не выводятся; контейнеры не заменены.' % name)
    site_new = copy.deepcopy(site_old)
    web_new = site_new['services']['web']
    web_new.update({key: template['services']['web'][key] for key in ('build', 'environment', 'healthcheck')})
    if not web_new.get('ports') and template['services']['web'].get('ports'):
        web_new['ports'] = copy.deepcopy(template['services']['web']['ports'])
    web_new.pop('env_file', None)
    web_new['image'] = 'edrc-web:' + stamp.lower()
    web_new['healthcheck']['test'] = ['CMD', 'wget', '-qO-', 'http://127.0.0.1:3000/api/health']
    site_new['services']['jobs'] = template['services']['jobs']
    site_new['services']['jobs']['image'] = 'edrc-jobs:' + stamp.lower()
    for name, definition in template.get('volumes', {}).items():
        site_new.setdefault('volumes', {}).setdefault(name, definition)
    # Preserve an already running scheduler's actual state volume/bind mount.
    for mount in site_old['services'].get('jobs', {}).get('volumes', []):
        if mount.get('target') == '/data':
            site_new['services']['jobs']['volumes'] = [copy.deepcopy(mount)]
            prior_state = site_old['services']['jobs'].get('environment', {}).get('JOBS_STATE_FILE', '/data/jobs-state.json')
            if not prior_state.startswith('/data/') or mount.get('read_only'):
                raise UpgradeError('Нестандартный или read-only state jobs. Требуется ручная сверка.')
            site_new['services']['jobs']['environment']['JOBS_STATE_FILE'] = prior_state
    # Retain custom default network for web; jobs must join the same network.
    if web_new.get('networks'):
        site_new['services']['jobs']['networks'] = copy.deepcopy(web_new['networks'])
        for options in site_new['services']['jobs']['networks'].values():
            if isinstance(options, dict):
                options.pop('aliases', None)
                options.pop('ipv4_address', None)
                options.pop('ipv6_address', None)
    auth_new = copy.deepcopy(auth_old)
    auth_new['services']['auth']['environment'] = auth_environment(auth_old['services']['auth'].get('environment', {}), smtp)
    auth_new['services']['auth']['environment']['GOTRUE_DISABLE_SIGNUP'] = 'true'
    # Use the currently running GoTrue image, never silently upgrade the database/auth stack.
    auth_new['services']['auth']['image'] = old_auth['services']['auth']['image']
    compose_write(directory / 'site-new.json', site_new)
    compose_write(directory / 'auth-new.json', auth_new)
    new_site_context = context_for(directory / 'site-new.json', site_context)
    new_auth_context = context_for(directory / 'auth-new.json', auth_context)
    manifest = {'phase': 'prepared', 'source': str(source), 'backup': str(directory),
                'site': new_site_context, 'auth': new_auth_context,
                'rollback_site': context_for(directory / 'site-rollback.json', site_context),
                'rollback_auth': context_for(directory / 'auth-rollback.json', auth_context)}
    assert_compose_roundtrip(new_site_context, site_new)
    assert_compose_roundtrip(new_auth_context, auth_new)
    print('Сборка web + jobs с тестами. Журнал не выводит закрытую конфигурацию.')
    run(dc(new_site_context, 'build', 'web', 'jobs'), logfile=directory / 'build.log')
    # From here an operator can always invoke rollback, even if deployment fails.
    private_json(root / 'current.json', manifest)
    shutil.copy2(__file__, root / 'upgrade.py')
    if 'jobs' in site_old['services']:
        run(dc(new_site_context, 'stop', 'jobs'))
    if managed_cron.is_file():
        updated, count = strip_site_cron(managed_cron.read_text())
        if count:
            managed_cron.write_text(updated)
            print('Отключены %s старых строк site cron; backup cron сохранён.' % count)
    try:
        run(dc(new_site_context, 'up', '-d', '--no-deps', '--wait', '--wait-timeout', '180', 'web'), logfile=directory / 'apply.log')
        # Templates must be available before configuring GoTrue to download them.
        for name in ('signup', 'recovery'):
            with secure_open(SITE + '/auth/templates/' + name) as response:
                if b'{{ .TokenHash }}' not in response.read(16_384):
                    raise UpgradeError('Новый шаблон не доступен через публичный HTTPS; проверьте reverse proxy.')
        run(dc(new_auth_context, 'up', '-d', '--no-deps', '--force-recreate', '--wait', '--wait-timeout', '180', 'auth'), logfile=directory / 'apply.log')
        settings = public_json(SUPABASE + '/auth/v1/settings', {'apikey': env['NEXT_PUBLIC_SUPABASE_ANON_KEY']})
        if settings.get('mailer_autoconfirm') is not False:
            raise UpgradeError('GoTrue не применил обязательное подтверждение email.')
        if smtp_ready(smtp):
            print('Для проверки SMTP будет отправлено письмо восстановления; пароль сам по себе не изменится.')
            email = input('Email вашего существующего аккаунта (Enter — письма пока не включать): ').strip()
            if email:
                try:
                    public_json(SUPABASE + '/auth/v1/recover', {'apikey': env['NEXT_PUBLIC_SUPABASE_ANON_KEY'],
                        'Content-Type': 'application/json'}, json.dumps({'email': email}).encode())
                    site_new['services']['web']['environment']['AUTH_EMAIL_ENABLED'] = 'true'
                    print('GoTrue принял запрос письма. Проверьте доставку и ссылку в своём почтовом ящике.')
                except Exception:
                    print('Проверка SMTP не прошла. Письма и новые регистрации останутся выключены; существующий вход работает.')
        auth_new['services']['auth']['environment']['GOTRUE_DISABLE_SIGNUP'] = (
            'false' if site_new['services']['web']['environment']['AUTH_EMAIL_ENABLED'] == 'true' else 'true')
        compose_write(directory / 'auth-new.json', auth_new)
        run(dc(new_auth_context, 'up', '-d', '--no-deps', '--wait', '--wait-timeout', '180', 'auth'), logfile=directory / 'apply.log')
        compose_write(directory / 'site-new.json', site_new)
        run(dc(new_site_context, 'up', '-d', '--no-deps', '--wait', '--wait-timeout', '180', 'web'), logfile=directory / 'apply.log')
        manifest['phase'] = 'web-ready-jobs-stopped'
        private_json(root / 'current.json', manifest)
    except Exception as error:
        print('Обновление не завершено. jobs НЕ запускается. Для отката:')
        print('sudo python3 %s/upgrade.py rollback --state-dir %s' % (root, root))
        if isinstance(error, UpgradeError):
            raise
        raise UpgradeError('Не пройдена HTTPS/health проверка. Подробности смотрите локально в закрытых журналах.')
    print('Сайт обновлён; БД, существующие UUID и история не переустанавливались.')
    print('Backup/журналы (содержат секреты): ' + str(directory))
    print('Далее: отключите 6 старых Actions, завершите их активные запуски и проверьте отсутствие других расписаний.')
    print('Затем: sudo python3 %s/upgrade.py activate-jobs --state-dir %s' % (root, root))
    print('Обычные docker compose команды из старого каталога теперь НЕ использовать: они вернут старую конфигурацию.')

def configure_current_auth(args, root, manifest):
    if manifest['phase'] not in ('web-ready-jobs-stopped', 'active'):
        raise UpgradeError('Настройка auth доступна только после успешного apply.')
    site, auth = compose_read(manifest['site']), compose_read(manifest['auth'])
    old_site, old_auth = copy.deepcopy(site), copy.deepcopy(auth)
    stamp = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + secrets.token_hex(3)
    backup = root / 'auth-changes' / stamp
    compose_write(backup / 'site-before.json', site)
    compose_write(backup / 'auth-before.json', auth)
    previous = auth['services']['auth'].get('environment', {})
    smtp = configure_smtp(previous, force=args.edit_smtp)
    updated = auth_environment(previous, smtp)
    enabled = site['services']['web']['environment'].get('AUTH_EMAIL_ENABLED') == 'true' and (not args.edit_smtp or smtp == previous) and smtp_ready(updated)
    updated['GOTRUE_DISABLE_SIGNUP'] = 'false' if enabled else 'true'
    providers = set(site['services']['web']['environment'].get('AUTH_OAUTH_PROVIDERS', 'discord').split(','))
    for provider in args.provider:
        print('В консоли %s должен быть callback: %s/auth/v1/callback' % (provider, SUPABASE))
        client_id = input('%s OAuth Client ID: ' % provider).strip()
        client_secret = getpass.getpass('%s OAuth Client Secret (не PAT, не пароль аккаунта): ' % provider)
        if not client_id or not client_secret or client_secret.startswith(('ghp_', 'github_pat_', 'gho_', 'ghu_', 'ghs_', 'ghr_')):
            raise UpgradeError('Нужны ключи OAuth-приложения. Токены доступа GitHub не принимаются.')
        prefix = 'GOTRUE_EXTERNAL_' + provider.upper()
        updated.update({prefix + '_ENABLED': 'true', prefix + '_CLIENT_ID': client_id,
                        prefix + '_SECRET': client_secret, prefix + '_REDIRECT_URI': SUPABASE + '/auth/v1/callback'})
        providers.add(provider)
    auth['services']['auth']['environment'] = updated
    site['services']['web']['environment']['AUTH_OAUTH_PROVIDERS'] = ','.join(sorted(providers & {'discord', 'google', 'github'}))
    site_path, auth_path = Path(manifest['site']['files'][0]), Path(manifest['auth']['files'][0])
    try:
        compose_write(auth_path, auth)
        assert_compose_roundtrip(manifest['auth'], auth)
        run(dc(manifest['auth'], 'up', '-d', '--no-deps', '--wait', '--wait-timeout', '180', 'auth'), logfile=backup / 'configure.log')
        anon = site['services']['web']['environment']['NEXT_PUBLIC_SUPABASE_ANON_KEY']
        settings = public_json(SUPABASE + '/auth/v1/settings', {'apikey': anon})
        if settings.get('mailer_autoconfirm') is not False:
            raise UpgradeError('Подтверждение email не применилось.')
        if smtp_ready(updated) and not enabled:
            print('Проверка SMTP: отправим восстановление, не меняя пароль автоматически.')
            email = input('Email вашего существующего аккаунта (Enter — оставить письма выключенными): ').strip()
            if email:
                try:
                    public_json(SUPABASE + '/auth/v1/recover', {'apikey': anon, 'Content-Type': 'application/json'},
                                json.dumps({'email': email}).encode())
                    enabled = True
                    print('Запрос принят GoTrue. Проверьте получение письма и ссылку вручную.')
                except (urllib.error.URLError, UpgradeError, ValueError):
                    print('SMTP-проверка не прошла; отправка писем пока выключена.')
        updated['GOTRUE_DISABLE_SIGNUP'] = 'false' if enabled else 'true'
        site['services']['web']['environment']['AUTH_EMAIL_ENABLED'] = 'true' if enabled else 'false'
        compose_write(auth_path, auth)
        compose_write(site_path, site)
        assert_compose_roundtrip(manifest['site'], site)
        run(dc(manifest['auth'], 'up', '-d', '--no-deps', '--wait', '--wait-timeout', '180', 'auth'), logfile=backup / 'configure.log')
        run(dc(manifest['site'], 'up', '-d', '--no-deps', '--wait', '--wait-timeout', '180', 'web'), logfile=backup / 'configure.log')
    except Exception:
        # Roll back just these settings, never downgrade code or restore a database.
        compose_write(auth_path, old_auth)
        compose_write(site_path, old_site)
        run(dc(manifest['auth'], 'up', '-d', '--no-deps', '--wait', '--wait-timeout', '180', 'auth'), logfile=backup / 'rollback.log')
        run(dc(manifest['site'], 'up', '-d', '--no-deps', '--wait', '--wait-timeout', '180', 'web'), logfile=backup / 'rollback.log')
        raise UpgradeError('Новая настройка не прошла проверку; предыдущая конфигурация возвращена. Журналы: ' + str(backup))
    print('Auth обновлён без пересборки и без изменения UUID/паролей. Письма: ' + ('включены' if enabled else 'выключены'))


def manage(args, root):
    assert_root()
    manifest = saved_manifest(root)
    if args.command == 'configure-auth':
        configure_current_auth(args, root, manifest)
    elif args.command == 'status':
        print('Состояние: ' + manifest['phase'])
        run_output = run(dc(manifest['site'], 'ps'))
        print(run_output)
        print('Backup: ' + manifest['backup'])
    elif args.command == 'activate-jobs':
        if manifest['phase'] not in ('web-ready-jobs-stopped', 'active'):
            raise UpgradeError('Сначала завершите успешное обновление web/auth.')
        try:
            github_schedulers_off()
        except (urllib.error.URLError, OSError):
            if not args.confirm_github_schedulers_stopped:
                raise UpgradeError('GitHub API недоступен. После отдельной проверки отключения workflows И завершения их запусков повторите с --confirm-github-schedulers-stopped.')
            print('GitHub API недоступен; использую явное подтверждение оператора. Оно не отменяет проверку локального cron.')
        managed = cron_check()
        if managed.is_file() and strip_site_cron(managed.read_text())[1]:
            raise UpgradeError('В управляемом cron вновь появились задания сайта. Отключите их, сохранив backup.')
        if not args.confirm_no_other_schedulers:
            raise UpgradeError('Проверьте остальные crontab/systemd/PM2 и повторите с --confirm-no-other-schedulers. Одновременно допустим только один scheduler.')
        run(dc(manifest['site'], 'up', '-d', '--no-deps', 'jobs'))
        # List is side-effect free; never spend translation quota in a health check.
        run(dc(manifest['site'], 'exec', '-T', 'jobs', 'node', 'scripts/server-jobs.mjs', '--list'))
        manifest['phase'] = 'active'
        private_json(root / 'current.json', manifest)
        print('jobs запущен. Проверяйте его логи и lastSuccess; старые Actions повторно не включать.')
    elif args.command == 'logs':
        # This intentionally shows application logs, not docker inspect/config or env.
        subprocess.run(dc(manifest['site'], 'logs', '--tail=100', 'web', 'jobs'), check=True)
    elif args.command == 'rollback':
        if input('Вернуть прежний web/auth без восстановления БД? Введите ROLLBACK: ').strip() != 'ROLLBACK':
            raise UpgradeError('Отменено.')
        run(dc(manifest['site'], 'stop', 'jobs'))
        run(dc(manifest['rollback_auth'], 'up', '-d', '--no-deps', '--pull', 'never', '--wait', '--wait-timeout', '180', 'auth'))
        run(dc(manifest['rollback_site'], 'up', '-d', '--no-deps', '--pull', 'never', '--wait', '--wait-timeout', '180', 'web'))
        manifest['phase'] = 'rolled-back'
        private_json(root / 'current.json', manifest)
        print('Старые образы возвращены; БД/тома не тронуты. Расписание автоматически НЕ восстанавливается.')
        print('Включите только один прежний источник задач. Откат также возвращает старые уязвимости/поведение регистрации.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['plan', 'apply', 'status', 'logs', 'configure-auth', 'activate-jobs', 'rollback'], nargs='?', default='plan')
    parser.add_argument('--source', type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument('--state-dir', type=Path, default=Path(STATE_DEFAULT))
    parser.add_argument('--web-container')
    parser.add_argument('--auth-container')
    parser.add_argument('--site-env')
    parser.add_argument('--supabase-env')
    parser.add_argument('--confirm-no-other-schedulers', action='store_true')
    parser.add_argument('--confirm-github-schedulers-stopped', action='store_true')
    parser.add_argument('--edit-smtp', action='store_true')
    parser.add_argument('--provider', action='append', choices=['discord', 'google', 'github'], default=[])
    args = parser.parse_args()
    os.umask(0o077)
    try:
        if not shutil.which('docker'):
            raise UpgradeError('Нужны уже установленный Docker и Compose v2. Скрипт не переустанавливает работающий стек.')
        endpoint = os.environ.get('DOCKER_HOST') or run(['docker', 'context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']).strip()
        if not endpoint.startswith('unix://'):
            raise UpgradeError('Поддерживается локальный Docker daemon через unix socket, не удалённый DOCKER_HOST.')
        version = run(['docker', 'compose', 'version', '--short']).strip().lstrip('v').split('.')
        if tuple(int(re.match(r'\d+', value).group()) for value in version[:2]) < (2, 20):
            raise UpgradeError('Нужен Docker Compose v2.20 или новее (--wait). Обновите plugin отдельно, не удаляя Docker volumes.')
        lock = None
        if args.command not in ('plan', 'status', 'logs'):
            assert_root()
            args.state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
            lock = open(args.state_dir / 'upgrade.lock', 'a')
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise UpgradeError('Уже выполняется другое обновление/настройка. Дождитесь его завершения.')
        if args.command in ('plan', 'apply'):
            apply(args, args.source.resolve(), args.state_dir.resolve())
        else:
            manage(args, args.state_dir.resolve())
    except (UpgradeError, KeyboardInterrupt, urllib.error.URLError, OSError, ValueError) as error:
        message = str(error) if isinstance(error, (UpgradeError, KeyboardInterrupt)) else 'Ошибка файлов, HTTPS или конфигурации. Проверьте пути/сеть; секреты в вывод не включены.'
        print('ОСТАНОВЛЕНО: ' + message, file=sys.stderr)
        return 1
    return 0

if __name__ == '__main__':
    sys.exit(main())
