import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Сквозная проверка deploy/update-project.sh на настоящем git-репозитории.
 *
 * Скрипт меняет прод, поэтому сценарии проверяются целиком, а не «по строкам»:
 * Docker и сеть подменяются заглушками в PATH, а всё остальное — настоящий git.
 *
 * Контракт кнопки «Обновить сейчас»: прогон ВСЕГДА донашивает недостающие
 * миграции (неотмеченные в migrations.mark) и пересобирает стек, даже когда
 * git уже на последней ревизии. Раньше такой прогон отвечал «обновлять
 * нечего» и не трогал ни базу, ни сборку — сорвавшиеся сборки и пропущенные
 * миграции не могли поправиться кнопкой никогда.
 */

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const SCRIPT = join(ROOT, 'deploy', 'update-project.sh');
const hasGit = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
const hasBash = spawnSync('bash', ['--version'], { encoding: 'utf8' }).status === 0;
const skip = hasGit && hasBash ? false : 'нужны git и bash';

function stub(bin, name, body) {
  const file = join(bin, name);
  writeFileSync(file, '#!/usr/bin/env bash\n' + body + '\n');
  chmodSync(file, 0o755);
}

function setup() {
  const work = mkdtempSync(join(tmpdir(), 'edrc-script-'));
  const origin = join(work, 'origin.git');
  const src = join(work, 'src');
  const other = join(work, 'other');
  const bin = join(work, 'bin');
  const state = join(work, 'state');
  const log = join(work, 'calls.log');
  mkdirSync(bin, { recursive: true });
  mkdirSync(state, { recursive: true });
  mkdirSync(src, { recursive: true });
  writeFileSync(log, '');
  // Клон уже работает на базе с базовой схемой: её миграция применена и
  // отмечена — как на сервере, где механизм отметок migrations.mark живёт.
  writeFileSync(join(state, 'migrations.mark'), '20260101000000_base.sql\n');

  // «Докер»: пишет вызовы в лог, на `docker ps` отвечает именем базы, а
  // проверка живости (curl) всегда успешна. Если существует файл fail-on,
  // psql падает на миграции, текст которой там помянут — так проверяется
  // реакция скрипта на сорвавшуюся миграцию. Текст ошибки задаётся через
  // STUB_FAIL_MSG (по умолчанию — синтаксическая ошибка, которую скрипт
  // обязан прервать; «already exists» — напротив, помечается применённой).
  stub(bin, 'docker', [
    'echo "[docker] $*" >> "$STUB_LOG"',
    'case "$*" in',
    // Свежий docker: у builder prune есть бюджет кэша (--keep-storage) —
    // как на реальном сервере, чтобы сценарий гонял именно эту ветку уборки.
    '  *"builder prune --help"*)',
    '    echo "  --keep-storage   keep the specified amount of build cache"',
    '    echo "  --filter        provide filter values"',
    '    exit 0;;',
    // STUB_BUILDX_EXIT=1 — плагина buildx нет, как в Alpine-образе агента
    // обновления до пакета docker-cli-buildx: compose уходит в legacy-билдер.
    '  *"buildx version"*)',
    '    exit "${STUB_BUILDX_EXIT:-0}";;',
    // Страж диска спрашивает корень Docker через info --format; сообщаем
    // фейковый путь — свободное место придёт из стаба df (STUB_DF_FILE).
    '  *info*)',
    '    printf "/var/lib/docker\\n";',
    '    exit 0;;',
    // Освобождение места имитирует только сабстантивная уборка:
    // container/image prune приходят из edrc_cleanup_docker_disk. Бюджетная
    // подрезка builder prune до сборки (edrc_trim_build_cache) файл df не
    // трогает — значит, и заметного места не освобождает.
    // STUB_DF_AFTER_PRUNE — сколько КБ осталось после уборки.
    '  *"container prune"*|*"image prune"*)',
    '    if [ -n "${STUB_DF_FILE:-}" ]; then',
    '      printf "%s" "${STUB_DF_AFTER_PRUNE:-52428800}" > "$STUB_DF_FILE"',
    '    fi',
    '    exit 0;;',
    // STUB_BUILD_FAIL=1 — сборка образа падает так же, как на живом сервере:
    // текст причины уходит в stderr, код возврата 1.
    '  *" build "*)',
    // Окружение, с которым сборка ушла в docker: скрипт обязан выключать
    // provenance-аттестации (BUILDX_NO_DEFAULT_ATTESTATIONS), уважая
    // явное значение оператора.
    '    echo "[build-env] BUILDX_NO_DEFAULT_ATTESTATIONS=${BUILDX_NO_DEFAULT_ATTESTATIONS-unset}" >> "$STUB_LOG"',
    '    if [ "${STUB_BUILD_FAIL:-0}" = "1" ]; then',
    '      echo "#12 42.5 npm ERR! code ENOSPC" >&2',
    '      echo "ERROR: failed to solve: process \\"/bin/sh -c npm ci\\" did not complete successfully: no space left on device" >&2',
    '      exit 1',
    '    fi',
    // STUB_BUILD_FAIL_ONCE=1 — кратковременный сбой, как на проде: первая
    // сборка рвётся дедлайном на ползущем по забитому диску демоне, повтор
    // после уборки уже успешен. Счётчик попыток — файл STUB_COUNT.
    '    if [ "${STUB_BUILD_FAIL_ONCE:-0}" = "1" ]; then',
    '      count="$(cat "$STUB_COUNT" 2>/dev/null || echo 0)"',
    '      printf "%s" "$((count + 1))" > "$STUB_COUNT"',
    '      if [ "$count" = "0" ]; then',
    '        echo "#33 191.2 transferring context stalled" >&2',
    '        echo "ERROR: failed to solve: DeadlineExceeded: context deadline exceeded" >&2',
    '        exit 1',
    '      fi',
    '    fi',
    '    exit 0;;',
    '  *psql*)',
    '    input=$(cat)',
    '    if [ -f "$STUB_FAIL_ON" ] && printf "%s" "$input" | grep -qf "$STUB_FAIL_ON"; then',
    '      echo "${STUB_FAIL_MSG:-ERROR: syntax error at or near}" >&2; exit 3',
    '    fi',
    '    exit 0;;',
    '  ps) printf "supabase-db\\n" ;;',
    'esac',
    'exit 0',
  ].join('\n'));
  stub(bin, 'curl', 'echo "[curl] $*" >> "$STUB_LOG"\nexit 0');
  // Стаб df для стража диска: свободное место (КБ, 4-е поле вывода -Pk)
  // читается из файла STUB_DF_FILE (по умолчанию 51200 МБ — сборке хватает).
  // Так проверка места под Docker детерминирована и не зависит от CI-диска.
  stub(bin, 'df', [
    'printf "Filesystem 1024-blocks Used Available Capacity Mounted on\\n"',
    'free="$(cat "${STUB_DF_FILE:-/edrc-nonexistent}" 2>/dev/null || true)"',
    '[ -n "$free" ] || free=52428800',
    'printf "/dev/sda1 104857600 31457280 %s 30%% /var/lib/docker\\n" "$free"',
    'exit 0',
  ].join('\n'));

  const git = (cwd, ...args) => {
    const run = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
    if (run.status !== 0) throw new Error('git ' + args.join(' ') + ' → ' + run.stderr);
    return run.stdout.trim();
  };
  const env = {
    ...process.env,
    PATH: bin + ':/usr/bin:/bin',
    STUB_LOG: log,
    STUB_COUNT: join(work, 'build-attempts'),
    PROJECT_DIR: src,
    PROJECT_DEPLOY_MODE: 'compose',
    PROJECT_UPDATE_BRANCH: 'main',
    PROJECT_REPOSITORY: 'test/repo',
    UPDATE_STATE_DIR: state,
    UPDATE_BACKUP_DIR: join(work, 'backups'),
    UPDATE_HEALTH_URL: 'http://127.0.0.1:9/api/health',
    ENV_FILE: join(src, '.env.production'),
    HEALTH_TRIES: '2',
    SUPABASE_CONTAINER: 'supabase-db',
    UPDATE_APPLY_MIGRATIONS: '1',
    // Пауза между попытками сборки нужна живому демону, а не тесту.
    UPDATE_BUILD_RETRY_DELAY: '0',
  };

  spawnSync('git', ['init', '-q', '--initial-branch=main', '--bare', origin], { encoding: 'utf8' });
  git(src, 'init', '-q', '--initial-branch=main', src);
  git(src, 'config', 'user.email', 't@t');
  git(src, 'config', 'user.name', 't');
  writeFileSync(join(src, 'docker-compose.yml'), 'services:\n  web:\n    image: busybox\n');
  writeFileSync(join(src, '.env.production'), 'PROJECT_REPOSITORY=test\n');
  mkdirSync(join(src, 'supabase', 'migrations'), { recursive: true });
  writeFileSync(join(src, 'supabase', 'migrations', '20260101000000_base.sql'), '-- base\n');
  // Настоящий compose-lib.sh из репозитория: уборка кэша BuildKit идёт его
  // функцией edrc_cleanup_docker_disk — проверяем реальный код, а не заглушку.
  // Dockerfile и override — чтобы проверялся и запасной путь без BuildKit.
  mkdirSync(join(src, 'deploy'), { recursive: true });
  copyFileSync(join(ROOT, 'deploy', 'compose-lib.sh'), join(src, 'deploy', 'compose-lib.sh'));
  copyFileSync(join(ROOT, 'deploy', 'compose.legacy-build.yml'), join(src, 'deploy', 'compose.legacy-build.yml'));
  copyFileSync(join(ROOT, 'Dockerfile'), join(src, 'Dockerfile'));
  git(src, 'add', '-A');
  git(src, 'commit', '-qm', 'init');
  git(src, 'remote', 'add', 'origin', origin);
  git(src, 'push', '-q', 'origin', 'main');

  // Вторая «рабочая копия» — из неё прилетает новый релиз.
  spawnSync('git', ['clone', '-q', origin, other], { encoding: 'utf8' });
  git(other, 'config', 'user.email', 't@t');
  git(other, 'config', 'user.name', 't');

  const run = (extraEnv = {}) => spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    cwd: src,
    env: { ...env, STUB_FAIL_ON: join(work, 'fail-on'), ...extraEnv },
  });
  const release = (files) => {
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(other, name), content);
    }
    git(other, 'add', '-A');
    git(other, 'commit', '-qm', 'release');
    git(other, 'push', '-q', 'origin', 'main');
  };

  return {
    work, src, state, log, bin, env, run, release, git,
    failOn: join(work, 'fail-on'),
    cleanup: () => rmSync(work, { recursive: true, force: true }),
  };
}

function events(stdout) {
  return stdout
    .split('\n')
    .filter((line) => line.includes('::edrc::{'))
    .map((line) => {
      try { return JSON.parse(line.slice(line.indexOf('::edrc::') + 8)); } catch { return { unparsed: line }; }
    });
}

test('первое обновление: перемотка, применение новых миграций, сохранение правок', { skip }, () => {
  const ctx = setup();
  try {
    ctx.release({
      'supabase/migrations/20260925000000_new_one.sql': '-- one\n',
      'supabase/migrations/20260926000000_new_two.sql': '-- two\n',
      'CHANGELOG.md': '# release\n',
    });
    // Правка админа поверх прода — обязана пережить обновление.
    writeFileSync(join(ctx.src, '.env.production'), readFileSync(join(ctx.src, '.env.production'), 'utf8') + 'LOCAL=keep-me\n');

    const run = ctx.run();
    const list = events(run.stdout);
    assert.equal(run.status, 0, run.stdout + run.stderr);

    const stages = list.map((event) => event.stage).filter(Boolean);
    for (const stage of ['prepare', 'fetch', 'compare', 'backup', 'migrate', 'build', 'verify', 'done']) {
      assert.ok(stages.includes(stage), 'стадия ' + stage + ' должна быть в потоке: ' + stages.join('>'));
    }
    // Миграции применяются ПОСЛЕ перемотки: иначе файлов ещё нет на диске.
    assert.ok(stages.indexOf('migrate') > stages.indexOf('compare'), 'сначала исходники, потом миграции');

    const done = list[list.length - 1];
    assert.equal(done.stage, 'done');
    assert.equal(done.percent, 100);
    assert.equal(done.migrationsApplied, 2, 'должны быть применены ровно две новые миграции');
    assert.ok(run.stdout.includes('применяю 20260925000000_new_one.sql'));

    const applied = readFileSync(join(ctx.state, 'migrations.mark'), 'utf8').trim().split('\n');
    assert.deepEqual(applied, ['20260101000000_base.sql', '20260925000000_new_one.sql', '20260926000000_new_two.sql']);

    // Реальные вызовы: бэкап, psql, пересборка, prune.
    const calls = readFileSync(ctx.log, 'utf8');
    assert.match(calls, /pg_dump/);
    assert.match(calls, /psql -U postgres -d postgres -q -v ON_ERROR_STOP=1/);
    // Сборка и переключение — два отдельных шага: упавший build не трогает
    // работающие контейнеры, а RUN_TESTS уезжает явным --build-arg.
    // Образы собираются по одному (см. отдельный тест про порядок) —
    // проверяем, что каждый из четырёх получил свой вызов с тем же env-file.
    for (const service of ['web', 'jobs', 'monitor-agent', 'update-agent']) {
      assert.match(calls, new RegExp('compose --env-file .* build --build-arg RUN_TESTS=1 ' + service + '\\n'),
        'образ ' + service + ' собран отдельным вызовом');
    }
    assert.match(calls, /compose --env-file .* up -d --no-build web jobs monitor-agent/);
    // Provenance-аттестации выключены по умолчанию: их запись — лишний вызов
    // Docker Hub уже ПОСЛЕ собранных образов («resolving provenance for
    // metadata file»), и на нестабильном канале именно он ронял сборку
    // «failed to solve: DeadlineExceeded: context deadline exceeded».
    assert.match(calls, /\[build-env\] BUILDX_NO_DEFAULT_ATTESTATIONS=1/);
    // Уборка диска после обновления: висячие образы/контейнеры И кэш BuildKit
    // в бюджете (именно он съедал гигабайты после каждой пересборки).
    assert.match(calls, /image prune -f/);
    assert.match(calls, /builder prune -f --keep-storage 8g/);
    assert.match(calls, /container prune -f/);
    // Подрезка кэша ДО старта сборки: сорвавшиеся прогоны больше не копят
    // гигабайты, и следующая сборка не ползёт по забитому диску.
    {
      const logLines = readFileSync(ctx.log, 'utf8').split('\n');
      const trimAt = logLines.findIndex((line) => line.includes('builder prune -f --keep-storage'));
      const buildAt = logLines.findIndex((line) => line.includes(' build ') && line.includes('--build-arg'));
      assert.ok(trimAt >= 0, 'подрезка кэша вызвана');
      assert.ok(buildAt >= 0, 'сборка вызвана');
      assert.ok(trimAt < buildAt, 'кэш подрезается до старта сборки, а не только после');
    }
    // Образ апдейтера пересобирается вместе со всеми (иначе агент навсегда
    // остаётся старым), но контейнер, из которого запущен скрипт, не
    // пересоздаётся: это убило бы обновление на середине.
    assert.equal(/up -d [^\n]*update-agent/.test(calls), false);

    // Прода обновилась, локальная правка вернулась из stash, stash пуст.
    assert.equal(ctx.git(ctx.src, 'log', '--oneline').split('\n').length, 2);
    assert.ok(existsSync(join(ctx.src, 'CHANGELOG.md')));
    assert.match(readFileSync(join(ctx.src, '.env.production'), 'utf8'), /LOCAL=keep-me/);
    assert.equal(ctx.git(ctx.src, 'stash', 'list'), '', 'stash должен быть выгружен обратно');
  } finally {
    ctx.cleanup();
  }
});

test('без BuildKit: web собирается по запасному Dockerfile без кэш-маунтов', { skip }, () => {
  const ctx = setup();
  try {
    // «Сервер» фикстуры: плагина buildx нет (docker buildx version падает) —
    // ровно как в Alpine-образе агента до пакета docker-cli-buildx. Раньше
    // compose уходил в legacy-билдер и падал «the --mount option requires
    // BuildKit» на Step 5/33 — обновление не доходило даже до npm ci.
    const run = ctx.run({ STUB_BUILDX_EXIT: '1' });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const calls = readFileSync(ctx.log, 'utf8');
    assert.match(calls, /-f docker-compose\.yml -f deploy\/compose\.legacy-build\.yml --profile monitoring build --build-arg RUN_TESTS=1 web\n/);
    // Переключение — тот же список -f, образ тот же: контейнеры поднимаются.
    assert.match(calls, /-f docker-compose\.yml -f deploy\/compose\.legacy-build\.yml --profile monitoring up -d --no-build web jobs monitor-agent/);
    assert.match(run.stdout, /BuildKit недоступен/);
    // Запасной Dockerfile сгенерирован из основного: убраны только кэш-маунты.
    const legacy = readFileSync(join(ctx.src, '.edrc-legacy-Dockerfile'), 'utf8');
    assert.doesNotMatch(legacy, /^RUN --mount/m);
    assert.match(legacy, /^RUN npm ci --no-audit --no-fund$/m);
    assert.match(legacy, /^RUN npm run build$/m, 'сборка Next.js идёт, просто без кэш-маунта');
    const list = events(run.stdout);
    assert.equal(list[list.length - 1].stage, 'done', 'обновление дошло до конца');
  } finally {
    ctx.cleanup();
  }
});

test('повторный запуск: пересборка без перемотки, миграции второй раз не накатываются', { skip }, () => {
  const ctx = setup();
  try {
    ctx.release({ 'supabase/migrations/20260927000000_third.sql': '-- third\n' });
    assert.equal(ctx.run().status, 0);

    writeFileSync(ctx.log, '');
    const second = ctx.run();
    assert.equal(second.status, 0, second.stdout + second.stderr);
    // Отсутствие отставания — не повод отвечать «обновлять нечего»: кнопка
    // обязана пересобрать стек (так чинится сорвавшийся прошлый билд).
    assert.match(second.stdout, /перемотка не требуется/);
    const done = events(second.stdout).pop();
    assert.equal(done.stage, 'done');
    assert.equal(done.percent, 100);
    assert.equal(done.migrationsApplied, 0, 'всё уже отмечено — накатывать нечего');
    assert.equal(done.fromSha, done.toSha, 'ревизия не менялась');
    const calls = readFileSync(ctx.log, 'utf8');
    assert.match(calls, /build --build-arg RUN_TESTS=1 web\n/, 'повторный прогон всё равно пересобирает');
    assert.match(calls, /up -d --no-build web jobs monitor-agent/, 'и переключает контейнеры на новый образ');
    assert.equal(calls.includes('psql'), false, 'отмеченная миграция не накатывается второй раз');
    // Дамп больше не привязан к наличию миграций: его решает флажок
    // «с бэкапом БД» (UPDATE_BACKUP_BEFORE), включённый по умолчанию.
    assert.match(calls, /pg_dump/, 'бэкап по умолчанию включён, даже когда миграций нет');

    // Флажок «без бэкапа»: UPDATE_BACKUP_BEFORE=0 — дампа в прогоне нет.
    writeFileSync(ctx.log, '');
    const noBackup = ctx.run({ UPDATE_BACKUP_BEFORE: '0' });
    assert.equal(noBackup.status, 0, noBackup.stdout + noBackup.stderr);
    assert.equal(readFileSync(ctx.log, 'utf8').includes('pg_dump'), false, 'UPDATE_BACKUP_BEFORE=0 — без дампа');
  } finally {
    ctx.cleanup();
  }
});

test('флажок тестов: RUN_TESTS попадает в сборку, по умолчанию тесты включены', { skip }, () => {
  const ctx = setup();
  try {
    ctx.release({ 'CHANGELOG.md': '# release\n' });

    const withTests = ctx.run();
    assert.equal(withTests.status, 0, withTests.stdout + withTests.stderr);
    assert.match(withTests.stdout, /флажки прогона: тесты=1/, 'по умолчанию тесты идут');
    assert.match(readFileSync(ctx.log, 'utf8'), /build --build-arg RUN_TESTS=1 /, 'RUN_TESTS уходит явным build-arg');

    const withoutTests = ctx.run({ UPDATE_RUN_TESTS: '0' });
    assert.equal(withoutTests.status, 0, withoutTests.stdout + withoutTests.stderr);
    assert.match(withoutTests.stdout, /флажки прогона: тесты=0/, 'флажок «без тестов» дошёл до сборки');
    // Значение не зависит от того, что написано в .env.production: оно
    // передаётся аргументом сборки, а не интерполяцией env-файла.
    assert.match(readFileSync(ctx.log, 'utf8'), /build --build-arg RUN_TESTS=0 /, 'без тестов — тоже явным build-arg');
    assert.match(readFileSync(ctx.log, 'utf8'), /up -d --no-build web jobs monitor-agent/);
  } finally {
    ctx.cleanup();
  }
});

test('provenance-аттестации: по умолчанию выключены, явное значение оператора сохраняется', { skip }, () => {
  const ctx = setup();
  try {
    ctx.release({ 'CHANGELOG.md': '# release\n' });

    const fresh = ctx.run();
    assert.equal(fresh.status, 0, fresh.stdout + fresh.stderr);
    assert.match(readFileSync(ctx.log, 'utf8'), /\[build-env\] BUILDX_NO_DEFAULT_ATTESTATIONS=1/, 'без настроек оператора аттестации выключены');

    // Оператор мог вернуть аттестации явным 0 — не перекрываем его выбор.
    writeFileSync(ctx.log, '');
    const keep = ctx.run({ BUILDX_NO_DEFAULT_ATTESTATIONS: '0' });
    assert.equal(keep.status, 0, keep.stdout + keep.stderr);
    assert.match(readFileSync(ctx.log, 'utf8'), /\[build-env\] BUILDX_NO_DEFAULT_ATTESTATIONS=0/, 'явный 0 доезжает до сборки без подмены');
  } finally {
    ctx.cleanup();
  }
});

test('упавшая сборка: в панель уходит причина, контейнеры не переключаются, кэш чистится, идёт автоповтор', { skip }, () => {
  const ctx = setup();
  try {
    ctx.release({ 'CHANGELOG.md': '# release\n' });

    const run = ctx.run({ STUB_BUILD_FAIL: '1' });
    assert.notEqual(run.status, 0, 'сбой сборки обязан завершать скрипт ошибкой');

    // Причина приезжает отдельным полем `error`. Раньше её не было вовсе:
    // ловушка ERR не наследовалась функцией compose(), и панель показывала
    // последнюю подпись стадии — «Пересобираю docker-образы… (код 1)».
    const failures = events(run.stdout).filter((event) => typeof event.error === 'string');
    assert.ok(failures.length > 0, 'должно быть событие с полем error: ' + run.stdout);
    const reason = failures[failures.length - 1].error;
    assert.match(reason, /сборка образов/, 'в ошибке названа стадия');
    assert.match(reason, /no space left on device/, 'в ошибке настоящая причина из вывода сборки');
    assert.equal(/Пересобираю docker-образы/.test(reason), false, 'подпись стадии — не причина сбоя');

    // Живой сайт не трогали: переключения контейнеров не было.
    const calls = readFileSync(ctx.log, 'utf8');
    assert.equal(calls.includes('up -d'), false, 'после падения сборки контейнеры остаются прежними');

    // Новый контракт «кэш failed-сборок не ест диск»: постоянный сбой
    // собирается ДВАЖДЫ (один автоповтор, UPDATE_BUILD_RETRIES=1), а кэш
    // каждой сорвавшейся попытки вычищается сразу, а не после редкого
    // успешного обновления. Раньше серия сорвавшихся сборок забивала диск,
    // и последующие начинали ползать до «DeadlineExceeded: context deadline
    // exceeded» — порочный круг из прод-инцидента.
    const lines = calls.split('\n');
    const buildAt = [];
    const pruneAt = [];
    lines.forEach((line, i) => {
      if (line.includes(' build ') && line.includes('--build-arg')) buildAt.push(i);
      if (line.includes('builder prune -f')) pruneAt.push(i);
    });
    assert.equal(buildAt.length, 3, 'два автоповтора после уборки: всего 3 попытки (UPDATE_BUILD_RETRIES=2)');
    assert.ok(pruneAt.some((i) => i > buildAt[0] && i < buildAt[1]),
      'остатки первой сорвавшейся попытки вычищены до ретрая');
    assert.ok(pruneAt.some((i) => i > buildAt[2]),
      'остатки последней попытки тоже вычищены — кэш failed-сборки не остаётся');
    assert.match(run.stdout, /пробую собрать ещё раз/);
    // Упавший образ не тянет за собой остальные: пока первый не собрался,
    // до следующих дело не доходит (раньше падал весь общий build).
    const attempted = [...new Set(lines
      .filter((line) => line.includes(' build ') && line.includes('--build-arg'))
      .map((line) => line.trim().split(' ').pop()))];
    assert.deepEqual(attempted, ['jobs'], 'все три попытки — один и тот же образ: ' + attempted.join(','));
  } finally {
    ctx.cleanup();
  }
});

test('мигание сборки: автоповтор после уборки доходит до успеха без ручного перезапуска', { skip }, () => {
  const ctx = setup();
  try {
    ctx.release({ 'CHANGELOG.md': '# release\n' });
    // Первая сборка умирает дедлайном (ползущий по забитому диску демон),
    // повторная — после уборки кэша — успешна. Раньше такое требовало
    // ручного перезапуска всего обновления (~час сборки на каждый клик).
    const run = ctx.run({ STUB_BUILD_FAIL_ONCE: '1' });
    assert.equal(run.status, 0, run.stdout + run.stderr);

    const lines = readFileSync(ctx.log, 'utf8').split('\n');
    const buildAt = [];
    lines.forEach((line, i) => {
      if (line.includes(' build ') && line.includes('--build-arg')) buildAt.push(i);
    });
    // Четыре образа по одному + одна повторная попытка сорвавшегося первого.
    assert.equal(buildAt.length, 5, 'повтор ровно один, остальные образы собираются по разу');
    assert.match(run.stdout, /пробую собрать ещё раз \(попытка 2 из 3\) после уборки/);
    const pruneBetween = lines
      .slice(buildAt[0] + 1, buildAt[1])
      .some((line) => line.includes('builder prune -f'));
    assert.ok(pruneBetween, 'между попытками стоит уборка кэша сорвавшейся сборки');
    // Успех доходит до переключения контейнеров и финального done.
    assert.match(readFileSync(ctx.log, 'utf8'), /up -d --no-build web jobs monitor-agent/);
    assert.equal(events(run.stdout).pop().stage, 'done');
  } finally {
    ctx.cleanup();
  }
});

test('сборка идёт по одному образу, web — последним', { skip }, () => {
  const ctx = setup();
  try {
    ctx.release({ 'CHANGELOG.md': '# release\n' });
    const run = ctx.run();
    assert.equal(run.status, 0, run.stdout + run.stderr);

    // Прод-инцидент: общий `compose build web jobs monitor-agent update-agent`
    // запускал все таргеты параллельно, они дрались за диск, и BuildKit ронял
    // сборку по своему дедлайну на СЛУЧАЙНОМ лёгком образе, уже выгруженном
    // в docker («target update-agent: failed to solve: DeadlineExceeded»
    // спустя минуту после его же «exporting to image … DONE»).
    const builds = readFileSync(ctx.log, 'utf8')
      .split('\n')
      .filter((line) => line.includes(' build ') && line.includes('--build-arg'));
    assert.equal(builds.length, 4, 'по одному вызову на образ: ' + builds.join(' | '));

    const services = builds.map((line) => line.trim().split(' ').slice(-1)[0]);
    assert.deepEqual(services.slice().sort(), ['jobs', 'monitor-agent', 'update-agent', 'web'].sort(),
      'собраны все сервисы стека и образ агента обновления');
    assert.equal(services[services.length - 1], 'web',
      'тяжёлый web идёт последним, когда лёгкие образы уже закрыты');
    for (const line of builds) {
      const tail = line.slice(line.indexOf(' build ') + ' build '.length);
      const names = tail.split(' ').filter((word) => !word.startsWith('-') && !word.includes('='));
      assert.equal(names.length, 1, 'в одном вызове ровно один сервис: ' + line);
    }
    // Порядок «сначала лёгкие» виден и человеку в журнале обновления.
    assert.match(run.stdout, /── собираю образ: web ──/);
  } finally {
    ctx.cleanup();
  }
});

test('тесный диск: кэш BuildKit подрезается жёстче, сборка всё равно идёт', { skip }, () => {
  const ctx = setup();
  try {
    ctx.release({ 'CHANGELOG.md': '# release\n' });
    // 5 ГБ свободно: порога UPDATE_DOCKER_MIN_FREE (4g) хватает, но запаса
    // почти нет. Держать 8 ГБ кэша в таких условиях — значит гнать сборку по
    // остаткам диска, где даже передача килобайт занимает десятки секунд
    // (ровно то, чем начинался прод-инцидент с DeadlineExceeded).
    const dfFile = join(ctx.work, 'df-free');
    writeFileSync(dfFile, '5242880');
    const run = ctx.run({ STUB_DF_FILE: dfFile });
    assert.equal(run.status, 0, run.stdout + run.stderr);

    const calls = readFileSync(ctx.log, 'utf8');
    assert.match(calls, /builder prune -f --keep-storage 2g --all/, 'бюджет кэша урезан до 2g');
    assert.match(run.stdout, /подрезаю кэш BuildKit жёстче обычного/);
    assert.match(calls, / build --build-arg /, 'сборка при этом не блокируется');
  } finally {
    ctx.cleanup();
  }
});

test('повтор сборки идёт после паузы: демону дают разгрести прерванную попытку', { skip }, () => {
  const ctx = setup();
  try {
    ctx.release({ 'CHANGELOG.md': '# release\n' });
    const started = Date.now();
    const run = ctx.run({ STUB_BUILD_FAIL_ONCE: '1', UPDATE_BUILD_RETRY_DELAY: '2' });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /жду 2 с, чтобы демон Docker разгрёб остатки/);
    assert.ok(Date.now() - started >= 2000, 'пауза действительно выдержана');
  } finally {
    ctx.cleanup();
  }
});

test('переполненный диск: сборка не стартует, причина — недостаток места, а не обезличенный «код 1»', { skip }, () => {
  const ctx = setup();
  try {
    ctx.release({ 'CHANGELOG.md': '# release\n' });
    // 50 МБ свободных при пороге UPDATE_DOCKER_MIN_FREE=4g, и уборка места
    // не освобождает (STUB_DF_AFTER_PRUNE оставляет то же число). На живом
    // сервере сборка в таких условиях часами ползала до DeadlineExceeded;
    // теперь страж падает ДО старта с понятной причиной.
    const dfFile = join(ctx.work, 'df-free');
    writeFileSync(dfFile, '51200');
    const run = ctx.run({ STUB_DF_FILE: dfFile, STUB_DF_AFTER_PRUNE: '51200' });
    assert.notEqual(run.status, 0, run.stdout + run.stderr);

    const calls = readFileSync(ctx.log, 'utf8');
    assert.equal(calls.includes(' build --build-arg'), false, 'сборка на умирающем диске не запускается');
    assert.match(calls, /builder prune -f/, 'страж всё равно попытался вычистить кэш перед отказом');

    const failures = events(run.stdout).filter((event) => typeof event.error === 'string');
    const reason = failures[failures.length - 1]?.error || '';
    assert.match(reason, /не хватает места|no space/i, 'в панель уходит причина про место: ' + reason);
    assert.match(run.stdout, /docker builder prune -af/, 'журнал подсказывает ручную очистку');
  } finally {
    ctx.cleanup();
  }
});

test('страж диска: автоуборка освободила место — сборка идёт без ручного вмешательства', { skip }, () => {
  const ctx = setup();
  try {
    ctx.release({ 'CHANGELOG.md': '# release\n' });
    // Стартовых 50 МБ не хватает, но чистка кэша освобождает 50 ГБ:
    // страж перепроверяет и продолжает. Это и есть ответ на «диск съедается
    // кэшем неудачных сборок» — кэш срезается сам, до того как диск станет
    // причиной очередного DeadlineExceeded.
    const dfFile = join(ctx.work, 'df-free');
    writeFileSync(dfFile, '51200');
    const run = ctx.run({ STUB_DF_FILE: dfFile, STUB_DF_AFTER_PRUNE: '52428800' });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    // Первый чек видит 50 МБ и бьёт тревогу, уборка освобождает место,
    // второй чек даёт добро — весь прогон без ручного вмешательства.
    // (run_step сливает stderr стадии в stdout, поток здесь один.)
    assert.match(run.stdout, /выполняю уборку и перепроверяю/);
    assert.match(run.stdout, /после уборки свободно \d+ МБ — продолжаю/);
    assert.match(readFileSync(ctx.log, 'utf8'), / build --build-arg /);
    assert.equal(events(run.stdout).pop().stage, 'done');
  } finally {
    ctx.cleanup();
  }
});

test('режим «только миграции»: накатывает базу и завершается до сборки', { skip }, () => {
  const ctx = setup();
  try {
    ctx.release({ 'supabase/migrations/20261001000000_only.sql': '-- only\n' });

    const run = ctx.run({ UPDATE_MIGRATIONS_ONLY: '1' });
    assert.equal(run.status, 0, run.stdout + run.stderr);

    const list = events(run.stdout);
    const stages = list.map((event) => event.stage).filter(Boolean);
    for (const stage of ['prepare', 'fetch', 'compare', 'backup', 'migrate', 'done']) {
      assert.ok(stages.includes(stage), 'стадия ' + stage + ' должна быть в потоке: ' + stages.join('>'));
    }
    assert.equal(stages.includes('build'), false, 'сборка в режиме «только миграции» не запускается');
    assert.equal(stages.includes('switch'), false, 'контейнеры не переключаются');
    assert.equal(stages.includes('verify'), false, 'живой сайт не перезапускался — health не опрашивается');

    const done = list[list.length - 1];
    assert.equal(done.stage, 'done');
    assert.equal(done.percent, 100);
    assert.equal(done.mode, 'migrations', 'панель по mode=migrations показывает свой чек-лист');
    assert.equal(done.migrationsApplied, 1);

    // База накатана (psql был), пересборки не было.
    const calls = readFileSync(ctx.log, 'utf8');
    assert.match(calls, /psql -U postgres -d postgres/);
    assert.match(calls, /pg_dump/, 'бэкап перед миграциями остаётся под флажком');
    assert.equal(calls.includes('up -d'), false, 'compose up не вызывается');
    assert.equal(calls.includes('compose --env-file') && calls.includes(' build --build-arg'), false, 'образы не собираются');
    assert.match(run.stdout, /МИГРАЦИИ ПРИМЕНЕНЫ \(без пересборки\)/);
    assert.match(readFileSync(join(ctx.state, 'migrations.mark'), 'utf8'), /20261001000000_only\.sql/);
  } finally {
    ctx.cleanup();
  }
});

test('пропущенная миграция донашивается следующим прогоном без новых коммитов', { skip }, () => {
  const ctx = setup();
  try {
    ctx.release({ 'supabase/migrations/20260930000000_third.sql': '-- third\n' });
    // Первый прогон пропустил миграции (админ выключил флажок / база была
    // недоступна) — исходники при этом уже перемотаны.
    const skipped = ctx.run({ UPDATE_APPLY_MIGRATIONS: '0' });
    assert.equal(skipped.status, 0, skipped.stdout + skipped.stderr);
    assert.match(skipped.stdout, /НЕ применены/);
    assert.equal(readFileSync(join(ctx.state, 'migrations.mark'), 'utf8').includes('third'), false);

    writeFileSync(ctx.log, '');
    // Второй прогон: отставания от ветки нет, но миграция осталась
    // неприменённой — именно этот случай кнопка раньше объявляла «актуально».
    const second = ctx.run();
    assert.equal(second.status, 0, second.stdout + second.stderr);
    assert.match(second.stdout, /перемотка не требуется/);
    assert.ok(second.stdout.includes('применяю 20260930000000_third.sql'), 'неприменённая миграция обязана доехать: ' + second.stdout);
    assert.ok(second.stdout.includes('не была применена раньше'));
    const done = events(second.stdout).pop();
    assert.equal(done.stage, 'done');
    assert.equal(done.migrationsApplied, 1);
    assert.match(readFileSync(join(ctx.state, 'migrations.mark'), 'utf8'), /20260930000000_third\.sql/);
    assert.match(readFileSync(ctx.log, 'utf8'), /psql -U postgres -d postgres/);
  } finally {
    ctx.cleanup();
  }
});

test('миграция с «already exists» помечается применённой и не блокирует обновление', { skip }, () => {
  const ctx = setup();
  try {
    // База, залитая снимком full_schema.sql, уже содержит объекты старых
    // миграций: повторный накат получает «already exists» — это не ошибка.
    ctx.release({ 'supabase/migrations/20260930000001_legacy.sql': '-- legacy\nCREATE TABLE legacy (id int);\n' });
    writeFileSync(ctx.failOn, 'legacy');
    const run = ctx.run({ STUB_FAIL_MSG: 'ERROR: relation "legacy" already exists' });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /применялась ранее/);
    const done = events(run.stdout).pop();
    assert.equal(done.stage, 'done');
    assert.equal(done.migrationsApplied, 0, 'уже существующая миграция не считается свеженакатанной');
    assert.match(readFileSync(join(ctx.state, 'migrations.mark'), 'utf8'), /20260930000001_legacy\.sql/);
  } finally {
    ctx.cleanup();
  }
});

test('ошибка миграции останавливает обновление до переключения сборки', { skip }, () => {
  const ctx = setup();
  try {
    writeFileSync(ctx.failOn, 'two');
    ctx.release({
      'supabase/migrations/20260928000000_one.sql': '-- one\n',
      'supabase/migrations/20260929000000_two.sql': '-- two\n',
    });
    const run = ctx.run();
    assert.notEqual(run.status, 0, 'падение миграции — ненулевой код возврата');
    const list = events(run.stdout);
    const withMessage = list.filter((event) => event.message);
    assert.match(JSON.stringify(withMessage), /миграция 20260929000000_two\.sql завершилась с ошибкой/);
    assert.equal(run.stdout.includes('"stage":"done"'), false, 'успешным такой прогон считаться не должен');
    // Первая миграция осталась отмеченной — повторный прогон не применит её дважды.
    const applied = readFileSync(join(ctx.state, 'migrations.mark'), 'utf8');
    assert.match(applied, /20260928000000_one\.sql/);
    assert.equal(applied.includes('20260929000000_two.sql'), false);
  } finally {
    ctx.cleanup();
  }
});

test('база с недоступным /api/health — обновление помечается ошибкой, а не успехом', { skip }, () => {
  const ctx = setup();
  try {
    ctx.release({ 'NEW.md': '# release\n' });
    stub(ctx.bin, 'curl', 'echo "[curl] $*" >> "$STUB_LOG"\nexit 22');
    const run = ctx.run();
    assert.notEqual(run.status, 0);
    assert.match(run.stdout, /сайт не ответил/);
    assert.match(run.stdout, /"stage":"verify"/);
  } finally {
    ctx.cleanup();
  }
});

test('локальные коммиты сверх ветки — остановка, а не force push', { skip }, () => {
  const ctx = setup();
  try {
    ctx.release({ 'A.md': '# a\n' });
    writeFileSync(join(ctx.src, 'mine.md'), 'my own commit\n');
    ctx.git(ctx.src, 'add', 'mine.md');
    ctx.git(ctx.src, 'commit', '-qm', 'моя локальная правка');
    const run = ctx.run();
    assert.notEqual(run.status, 0);
    assert.match(run.stdout, /собственных коммитов/);
    assert.ok(existsSync(join(ctx.src, 'mine.md')), 'локальный коммит обязан остаться на месте');
  } finally {
    ctx.cleanup();
  }
});
