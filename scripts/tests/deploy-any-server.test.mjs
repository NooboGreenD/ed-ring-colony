/**
 * Установка «на любой сервер» (`deploy/selfhost/install.sh`).
 *
 * Скрипт запускается один раз на чужой машине, где его некому отлаживать:
 * ошибка здесь стоит часа ожидания сборки и разбирательств «почему не
 * пишется дамп». Поэтому проверяются не команды целиком, а свойства, из-за
 * нарушения которых установка ломается на чистом сервере:
 *
 *  1. всё, что зависит от хостинга (каталог, порт сайта, диск под дампы),
 *     задаётся флагом, а не зашито путём текущего сервера;
 *  2. проверка сервера срабатывает ДО сборки и говорит, что именно не так;
 *  3. каталог дампов принадлежит пользователю сайта (1001), иначе запись в
 *     него запрещена и Spansh не скачивается;
 *  4. стек Supabase закреплён по версии, а не тянется с master;
 *  5. лимит Storage не остаётся жёсткими 50 МиБ — иначе облако точек карты
 *     (64 МиБ) получает 413;
 *  6. неудача certbot не обрывает установку уже собранного сайта;
 *  7. смоук-тест только читает — он не должен ничего менять на сервере.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const INSTALL = join(ROOT, 'deploy', 'selfhost', 'install.sh');
const SMOKE = join(ROOT, 'deploy', 'selfhost', 'smoke-test.sh');
const install = readFileSync(INSTALL, 'utf8');
const smoke = readFileSync(SMOKE, 'utf8');

const bashAvailable = spawnSync('bash', ['-c', 'true']).status === 0;

test('install.sh и smoke-test.sh синтаксически корректны', { skip: !bashAvailable && 'bash недоступен' }, () => {
  for (const file of [INSTALL, SMOKE]) {
    const run = spawnSync('bash', ['-n', file], { encoding: 'utf8' });
    assert.equal(run.status, 0, `${file}: ${run.stderr}`);
  }
});

test('всё, что зависит от хостинга, задаётся флагом', () => {
  for (const flag of ['--root', '--web-port', '--galaxy-dir', '--supabase-ref', '--force']) {
    assert.match(install, new RegExp(`\\s${flag}\\)`), `нет разбора флага ${flag}`);
  }
  // --help печатает шапку файла, а не первые 30 строк: новые флаги должны
  // попадать в справку сами, без правки строки с head.
  assert.doesNotMatch(install, /head -30/, 'справка не должна обрезаться по числу строк');
  assert.match(install, /sed -n '2,\/\^set -euo pipefail\$\/p' "\$0"/, 'справка берётся из шапки файла');
  // Значения по умолчанию совпадают с прежними: без флагов установка ведёт
  // себя как раньше.
  assert.match(install, /EDRC_ROOT="\$\{EDRC_ROOT:-\/opt\/ed-ring-colony\}"/);
  assert.match(install, /WEB_PORT="\$\{WEB_HOST_PORT:-3000\}"/);
});

test('проверка сервера идёт до пакетов и сборки и не молчит', () => {
  const preflight = install.indexOf('step "0/10 Проверка сервера"');
  const packages = install.indexOf('step "1/10 Пакеты, файрвол, swap"');
  const build = install.indexOf('edrc_build_each docker compose');
  assert.ok(preflight > 0, 'нет шага проверки сервера');
  assert.ok(preflight < packages && packages < build, 'проверка должна быть первой');
  for (const check of [/MemTotal/, /df -Pk/, /\/etc\/os-release/, /порт \$port уже занят/]) {
    assert.match(install.slice(preflight, packages), check);
  }
  // С --force установка продолжается, без него — останавливается с подсказкой.
  assert.match(install, /objection\(\) \{ if \[ "\$FORCE" = 1 \]/);
  // Повторный запуск на готовом стенде не должен упираться в свои же порты.
  assert.match(install, /REINSTALL=1/);
});

test('каталог дампов Spansh по умолчанию внутри установки и принадлежит uid 1001', () => {
  // /mnt/sdb есть только на одном конкретном сервере: на новом Docker создаёт
  // этот каталог от root, и web (uid 1001) не может в него писать.
  assert.doesNotMatch(install, /GALAXY_DIR="\/mnt\/sdb/, 'путь к дампам не должен быть зашит');
  assert.match(install, /GALAXY_DIR="\$\{GALAXY_DIR:-\$EDRC_ROOT\/data\/spansh\}"/);
  assert.match(install, /chown -R 1001:1001 "\$GALAXY_DIR"/);
  assert.match(install, /set_env "\$SE" GALAXY_DATA_HOST_DIR "\$GALAXY_DIR"/);
  // Уже заданный в .env.production путь (отдельный диск) переживает перезапуск.
  assert.match(install, /grep -q '\^GALAXY_DATA_HOST_DIR=' "\$SE"/);
});

test('стек Supabase закреплён по версии, а не master', () => {
  assert.match(install, /SUPABASE_REF="\$\{SUPABASE_REF:-v\d+\.\d+\.\d+\}"/, 'версия стека по умолчанию закреплена');
  assert.match(install, /refs\/tags\/\$SUPABASE_REF\.tar\.gz/);
  assert.match(install, /--supabase-ref master/, 'подсказка, как вернуться на master');
  assert.match(install, /grep -qE '\^  db:'/, 'скачанный стек проверяется на ожидаемый сервис db');
});

test('лимит Storage не остаётся 50 МиБ: облако точек карты весит 64 МиБ', () => {
  assert.match(install, /set_env "\$E" FILE_SIZE_LIMIT\s+"73400320"/);
  assert.match(install, /sed -i 's\|FILE_SIZE_LIMIT: 52428800\|FILE_SIZE_LIMIT: \$\{FILE_SIZE_LIMIT:-52428800\}\|'/,
    'значение из .env стека должно попадать в compose, иначе set_env ничего не делает');
  assert.match(install, /if grep -q 'FILE_SIZE_LIMIT: 52428800'/, 'повторный запуск не патчит файл дважды');
});

test('неудача certbot не обрывает установку', () => {
  const https = install.indexOf('step "7a HTTPS (certbot)"');
  const site = install.indexOf('step "8/10 Сайт');
  const block = install.slice(https, site);
  assert.ok(https > 0 && https < site);
  assert.match(block, /if certbot --nginx/, 'certbot вызывается в условии, а не «на убой»');
  assert.match(block, /certbot --nginx -d \$ADDR -d \$SUPA_HOST/, 'в подсказке есть готовая команда повторного выпуска');
});

test('swap создаётся и там, где fallocate не работает (btrfs, ZFS, overlay)', () => {
  assert.match(install, /if ! \{ fallocate -l 2G \/swapfile/, 'нет запасного пути');
  assert.match(install, /dd if=\/dev\/zero of=\/swapfile/);
  assert.match(install, /grep -q '\^\/swapfile ' \/etc\/fstab/, 'повторный запуск не дублирует fstab');
});

test('порт сайта доходит до nginx, compose и проверки', () => {
  assert.match(install, /proxy_pass http:\/\/127\.0\.0\.1:\$WEB_PORT;/, 'nginx должен проксировать на выбранный порт');
  assert.doesNotMatch(install, /proxy_pass http:\/\/127\.0\.0\.1:3000;/, 'жёсткий порт 3000 в nginx');
  assert.match(install, /curl -sf -o \/dev\/null "http:\/\/127\.0\.0\.1:\$WEB_PORT"/, 'ожидание сайта на выбранном порту');
  assert.match(install, /set_env "\$SE" WEB_HOST_PORT\s+"\$WEB_PORT"/, 'порт передаётся в compose через env');
});

test('каталог установки доходит до update-agent (копии БД и стек Supabase)', () => {
  assert.match(install, /set_env "\$SE" UPDATE_BACKUP_DIR\s+"\$UPDATE_BACKUP_DIR"/);
  assert.match(install, /set_env "\$SE" SUPABASE_HOST_DIR\s+"\$\{SUPABASE_HOST_DIR_VAL:-\$SUPA_DIR\}"/);
  assert.match(install, /set_env "\$SE" PROJECT_HOST_DIR\s+"\$SRC_DIR"/);
});

test('смоук-тест только читает и проверяет права от имени сайта', { skip: !bashAvailable && 'bash недоступен' }, () => {
  assert.ok(statSync(SMOKE).mode & 0o111, 'smoke-test.sh должен быть исполняемым');
  for (const forbidden of ['docker run', 'docker rm', 'docker restart', 'compose up', 'compose down', 'psql -c "INSERT']) {
    assert.ok(!smoke.includes(forbidden), `проверка не должна менять сервер: ${forbidden}`);
  }
  // Права проверяются внутри контейнера web (uid 1001), а не от root хоста.
  assert.match(smoke, /docker exec "\$web_id" sh -c "touch \$path\/\.edrc-probe/);
  for (const probe of ['/auth/v1/health', '/storage/v1/version', "schemaname='public'"]) {
    assert.ok(smoke.includes(probe), `нет проверки ${probe}`);
  }
  assert.match(smoke, /exit 1/, 'ошибки дают код возврата 1');
});

test('смоук-тест запускается установщиком и упомянут в сводке', () => {
  assert.match(install, /smoke-test\.sh" "\$\{SMOKE_ARGS\[@\]\}"/);
  assert.match(install, /smoke-test\.sh --root \$EDRC_ROOT/);
  // Падение проверки не отменяет уже состоявшуюся установку.
  const smokeStep = install.indexOf('step "9a/10 Проверка после установки"');
  const done = install.indexOf('step "10/10 ГОТОВО"');
  assert.ok(smokeStep > 0 && smokeStep < done);
  assert.match(install.slice(smokeStep, done), /warn "проверка нашла проблемы/);
});

/**
 * Смоук-тест проверяется целиком, на заглушках: docker и curl отвечают так же,
 * как на здоровом стенде. Так видно, что скрипт не путает «предупреждение» с
 * «ошибкой» и что права на каталоги он проверяет именно внутри контейнера.
 */
function stubBin({ healthy = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'edrc-smoke-'));
  const docker = `#!/usr/bin/env bash
set -u
# ps -q --filter label=com.docker.compose.service=X
if [ "$1" = ps ]; then
  service=""
  for arg in "$@"; do case "$arg" in label=com.docker.compose.service=*) service="\${arg##*=}";; esac; done
  case "$service" in
    web|jobs|monitor-agent|update-agent) echo "id-$service";;
    db|auth|rest|storage) [ ${healthy ? 1 : 0} = 1 ] && echo "id-$service";;
  esac
  exit 0
fi
if [ "$1" = inspect ]; then echo running; exit 0; fi
if [ "$1" = exec ]; then
  shift
  target="$1"; shift
  case "$target" in
    id-db) : ;;
    *) ;;
  esac
  case "$*" in
    *pg_isready*) exit 0;;
    *pg_tables*) echo "120"; exit 0;;
    *edrc-probe*) exit ${healthy ? 0 : 1};;
    *jobs-state.json*) echo '{"lastRun":"2026-11-16T00:00:00Z"}'; exit 0;;
  esac
  exit 0
fi
if [ "$1" = exec ]; then exit 0; fi
exit 0
`;
  const curl = `#!/usr/bin/env bash
for arg in "$@"; do case "$arg" in *"%{http_code}"*) echo 200; exit 0;; esac; done
exit 0
`;
  const file = (name, body) => {
    writeFileSync(join(dir, name), body);
    chmodSync(join(dir, name), 0o755);
  };
  file('docker', docker);
  file('curl', curl);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function fakeRoot({ healthy = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'edrc-root-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'data', 'spansh'), { recursive: true });
  mkdirSync(join(root, 'uploader'), { recursive: true });
  writeFileSync(join(root, 'src', '.env.production'), [
    'WEB_HOST_PORT=3000',
    'NEXT_PUBLIC_SITE_URL=https://ring.example.com',
    `GALAXY_DATA_HOST_DIR=${join(root, 'data', 'spansh')}`,
    `UPLOADER_STORE_HOST_DIR=${join(root, 'uploader')}`,
    'JOBS_ENABLED=a,b',
    'SUPABASE_HOST_DIR=/opt/supabase',
    '',
  ].join('\n'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('смоук-тест на здоровом стенде: 0 ошибок и код 0', { skip: !bashAvailable && 'bash недоступен' }, () => {
  const bins = stubBin();
  const site = fakeRoot();
  try {
    const run = spawnSync('bash', [SMOKE, '--root', site.root], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bins.dir}:${process.env.PATH}` },
    });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /Итого: ✓ \d+ · ✗ 0/);
    assert.match(run.stdout, /\/app\/data\/spansh: запись разрешена/);
    assert.match(run.stdout, /nginx отдаёт сайт на порту 80/);
  } finally {
    bins.cleanup();
    site.cleanup();
  }
});

test('смоук-тест на сломанном стенде: ошибки видны и код 1', { skip: !bashAvailable && 'bash недоступен' }, () => {
  const bins = stubBin({ healthy: false });
  const site = fakeRoot();
  try {
    const run = spawnSync('bash', [SMOKE, '--root', site.root], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bins.dir}:${process.env.PATH}` },
    });
    assert.equal(run.status, 1, 'ошибки должны давать код возврата 1');
    assert.match(run.stderr, /✗ db: нет/);
    assert.match(run.stderr, /запись запрещена/);
    assert.doesNotMatch(run.stdout, /Сервер готов к работе/);
  } finally {
    bins.cleanup();
    site.cleanup();
  }
});

test('смоук-тест не падает, когда каталог установки указан неверно', { skip: !bashAvailable && 'bash недоступен' }, () => {
  const run = spawnSync('bash', [SMOKE, '--root', '/nonexistent-edrc-root'], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /каталог установки не найден/);
});
