/**
 * Диагностика после обновления (`deploy/diag-after-update.sh`).
 *
 * Скрипт запускается на живом сервере, а здесь проверяется его логика без
 * сервера: docker подменяется заглушкой, которая отвечает так же, как настоящий
 * на больном и на здоровом стенде. Это важно, потому что скрипт нужен именно в
 * момент, когда проверять его вручную уже некогда.
 *
 * Держим два свойства:
 *
 *  1. скрипт ТОЛЬКО ЧИТАЕТ — ни одной команды, меняющей базу или контейнеры
 *     (иначе «диагностика» станет ещё одним источником поломок);
 *  2. симптомы различаются: потерянная сеть Supabase, мёртвый PostgREST и
 *     живой стенд дают разные итоги, а не «что-то сломалось».
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(ROOT, 'deploy', 'diag-after-update.sh');

const needsBash = spawnSync('bash', ['--version'], { encoding: 'utf8' }).status === 0
  ? false
  : 'bash is not available in this image';

/**
 * Заглушка docker: отвечает как настоящий на тот или иной стенд.
 * `state`:
 *   network: 'ok' | 'lost'   — резолвится ли `db` внутри web
 *   rest: строка            — ответ шлюза PostgREST (код или ERR:…)
 *   health: строка          — ответ /api/health
 */
function fakeDocker(state) {
  const sha = spawnSync('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' })
    .stdout.trim();
  return [
    '#!/usr/bin/env bash',
    'case "$1" in',
    '  info) exit 0 ;;',
    '  ps)',
    '    if printf \'%s\' "$*" | grep -q -- "{{.Status}}"; then',
    '      echo "supabase-db Up 3 hours"',
    '      echo "supabase-rest Up 3 hours"',
    '      echo "web Up 4 minutes"',
    '    else',
    '      echo supabase-db',
    '      echo supabase-rest',
    '      echo web',
    '    fi',
    '    exit 0 ;;',
    '  inspect)',
    '    case "$*" in',
    `      *Config.Env*) echo "APP_GIT_SHA=${sha}"; echo "NODE_ENV=production" ;;`,
    '      *NetworkSettings.Networks*)',
    state.network === 'ok'
      ? '        echo "edrc_default supabase_default" ;;'
      : '        echo "edrc_default" ;;',
    '      *) echo "{}" ;;',
    '    esac',
    '    exit 0 ;;',
    '  exec)',
    '    if printf \'%s\' "$*" | grep -q "getent hosts db"; then',
    state.network === 'ok'
      ? '      echo "172.18.0.5  db"; exit 0'
      : '      exit 2',
    '    fi',
    '    if printf \'%s\' "$*" | grep -q "fetch("; then',
    `      if printf '%s' "$*" | grep -q "/api/health"; then echo ${state.health}; else echo ${state.rest}; fi`,
    '      exit 0',
    '    fi',
    '    if printf \'%s\' "$*" | grep -q "psql"; then exit 1; fi',
    '    exit 0 ;;',
    '  logs) echo "web  | [error] getaddrinfo EAI_AGAIN db"; exit 0 ;;',
    'esac',
    'exit 0',
    '',
  ].join('\n');
}

/**
 * Заглушка psql: отвечает на те же запросы, что делает скрипт, — как на
 * здоровой базе (`db: 'healthy'`) и на больной после неудачного обновления.
 */
function fakePsql(state) {
  const db = state.db;
  const missing = db === 'healthy' ? '' : 'helper_devices helper_link_codes helper_settings';
  const maintenance = db === 'healthy'
    ? 'false|'
    : db === 'expired' ? 'true|2020-01-01T00:00:00Z' : 'true|2099-01-01T00:00:00Z';
  const staffFunction = db === 'healthy' ? 'ok' : 'missing';
  const policies = db === 'healthy' ? '6' : '0';
  const tables = db === 'healthy' ? '42' : '39';
  return [
    '#!/usr/bin/env bash',
    'for arg in "$@"; do',
    '  if [ "$arg" = "select 1" ]; then echo 1; exit 0; fi',
    'done',
    'sql="$(cat)"',
    'case "$sql" in',
    '  "select 1;") echo 1 ;;',
    `  *"table_schema='public';"*) echo ${tables} ;;`,
    `  *"unnest(array["*) echo "${missing}" ;;`,
    `  *pg_policies*) echo ${policies} ;;`,
    `  *request_is_staff*) echo ${staffFunction} ;;`,
    '  *anon*) echo f ;;',
    '  *authenticated*) echo t ;;',
    '  *"group by role"*) echo "admin:2, user:7" ;;',
    `  *app_flags*) echo "${maintenance}" ;;`,
    '  *) echo "ERROR: unknown query" >&2; exit 1 ;;',
    'esac',
    '',
  ].join('\n');
}

function runDiag(state, extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'edrc-diag-'));
  const docker = join(dir, 'docker');
  writeFileSync(docker, fakeDocker(state));
  chmodSync(docker, 0o755);
  if (state.db) {
    const psql = join(dir, 'psql');
    writeFileSync(psql, fakePsql(state));
    chmodSync(psql, 0o755);
    const envFile = join(dir, 'db.env');
    writeFileSync(envFile, 'DATABASE_URL=postgres://diag@127.0.0.1:5432/postgres\n');
    extraEnv = { ...extraEnv, ENV_FILE: envFile };
  }
  const result = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    cwd: ROOT,
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      PROJECT_DIR: ROOT,
      SUPABASE_CONTAINER: 'supabase-db',
      ENV_FILE: join(dir, 'none.env'),
      ...extraEnv,
    },
  });
  rmSync(dir, { recursive: true, force: true });
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

test('скрипт диагностики синтаксически корректен', { skip: needsBash }, () => {
  const result = spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('диагностика ничего не меняет: ни базы, ни контейнеров, ни git', () => {
  const source = readFileSync(SCRIPT, 'utf8');
  // Подсказки («снимите признак: delete from …») и комментарии — это текст
  // для человека, а не команды. Проверяем только исполняемые строки: всё, что
  // не комментарий и не вывод через critical/warn/ok/bad/say/printf.
  const executed = source
    .split('\n')
    .filter((line) => !/^\s*(#|critical |note |warn |ok |bad |say |printf )/.test(line))
    .join('\n');
  for (const pattern of [
    /\bdrop\s+table\b/i,
    /\bdelete\s+from\b/i,
    /\btruncate\b/i,
    /\bupdate\s+public\./i,
    /\bdocker\s+(rm|rmi|stop|kill|restart|prune|system)\b/,
    /\bdocker\s+compose\s+(down|up|restart|build)\b/,
    /\bgit\s+(reset|checkout|revert|clean)\b/,
    /\bsystemctl\s+(restart|stop|start)\b/,
  ]) {
    assert.doesNotMatch(executed, pattern, `диагностика не должна выполнять ${pattern}`);
  }
  // Единственная разрешённая запись — локальные массивы находок.
  assert.match(source, /Скрипт ничего не менял/);
});

test('потеря сети Supabase названа причиной, а не «что-то сломалось»', { skip: needsBash }, () => {
  const output = runDiag({ network: 'lost', rest: 'ERR:getaddrinfo EAI_AGAIN', health: '200' });
  assert.match(output, /имя db не резолвится/);
  assert.match(output, /EAI_AGAIN/);
  assert.match(output, /не в сети Supabase/);
  assert.match(output, /compose-lib\.sh/);
});

test('мёртвый PostgREST объясняет «нет админских прав»', { skip: needsBash }, () => {
  const output = runDiag({ network: 'ok', rest: '500', health: '200' });
  assert.match(output, /PostgREST не отдаёт схему/);
  assert.match(output, /profiles/, 'видно, почему пропала роль');
  assert.match(output, /supabase-rest/);
});

test('здоровый стенд не даёт ложных тревог', { skip: needsBash }, () => {
  const output = runDiag({ network: 'ok', rest: '401', health: '200' });
  assert.match(output, /образ собран из текущей ревизии/);
  assert.match(output, /имя db резолвится внутри web/);
  assert.match(output, /шлюз PostgREST жив/);
  assert.match(output, /известных поломок не найдено/);
  assert.doesNotMatch(output, /не в сети Supabase/);
});

test('мёртвый сайт назван отдельно от базы', { skip: needsBash }, () => {
  const output = runDiag({ network: 'ok', rest: '502', health: 'ERR:connect ECONNREFUSED' });
  assert.match(output, /веб-процесс не обслуживает запросы/);
  assert.match(output, /docker logs/);
});

test('без docker и без psql скрипт честно говорит, что проверок не было', { skip: needsBash }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'edrc-diag-empty-'));
  // Docker есть, но недоступен (нет прав) — как при запуске не на сервере.
  const docker = join(dir, 'docker');
  writeFileSync(docker, '#!/usr/bin/env bash\nexit 1\n');
  chmodSync(docker, 0o755);
  const result = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    cwd: ROOT,
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      PROJECT_DIR: ROOT,
      ENV_FILE: join(dir, 'none.env'),
    },
  });
  rmSync(dir, { recursive: true, force: true });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  assert.match(output, /сервер не проверен/);
  assert.match(output, /НА СЕРВЕРЕ/);
  assert.doesNotMatch(output, /известных поломок не найдено/);
});

test('здоровая база: ни схемы, ни прав, ни техработ не трогаем', { skip: needsBash }, () => {
  const output = runDiag({ network: 'ok', rest: '401', health: '200', db: 'healthy' });
  assert.match(output, /политик RLS на profiles: 6/);
  assert.match(output, /request_is_staff\(\) есть и работает как SECURITY DEFINER/);
  assert.match(output, /authenticated может читать profiles/);
  assert.match(output, /таблицы привязки лаунчера на месте/);
  assert.match(output, /признак техработ снят/);
  assert.match(output, /известных поломок не найдено/);
});

test('неприменённые миграции и живой флаг техработ названы поимённо', { skip: needsBash }, () => {
  const output = runDiag({ network: 'ok', rest: '401', health: '200', db: 'broken' });
  assert.match(output, /нет таблиц: helper_devices helper_link_codes helper_settings/);
  assert.match(output, /на profiles нет политик RLS/);
  assert.match(output, /request_is_staff\(\) отсутствует/);
  assert.match(output, /включён признак техработ до 2099-01-01/);
  assert.doesNotMatch(output, /известных поломок не найдено/);
});

test('просроченный флаг техработ не выдаётся за поломку', { skip: needsBash }, () => {
  // Прокси сам отпускает сайт по expiresAt: тревогу поднимать нельзя.
  const output = runDiag({ network: 'ok', rest: '401', health: '200', db: 'expired' });
  assert.match(output, /срок истёк/);
  assert.doesNotMatch(output, /заглушку «Ведутся технические работы»/);
});
