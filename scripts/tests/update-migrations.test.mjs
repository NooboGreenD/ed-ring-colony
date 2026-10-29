/**
 * Обновление не должно оставлять базу «наполовину применённой».
 *
 * Симптом, ради которого появились эти проверки: «после обновления отвалилась
 * часть проекта, прав админа нет, а в базе всё в порядке». Самая неприятная
 * причина такого вида — миграция, которая упала в середине файла: psql без
 * `--single-transaction` фиксирует всё, что успел выполнить, скрипт видит
 * «already exists», помечает файл применённым, и база остаётся в состоянии,
 * которого не ждёт ни старый код, ни новый.
 *
 * Здесь проверяется устройство `deploy/update-project.sh` (shell-интеграцию с
 * docker/git не запускаем — для этого есть живой сервер и deploy/diag-*):
 *
 *  1. каждый файл миграции идёт одной транзакцией;
 *  2. после миграций и ДО переключения контейнеров есть сверка схемы с кодом;
 *  3. сверка знает про новые таблицы привязки лаунчера и про обязательные
 *     колонки профиля — то, из-за чего пропадает админка;
 *  4. скрипт остаётся синтаксически корректным.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(ROOT, 'deploy', 'update-project.sh');
const source = readFileSync(SCRIPT, 'utf8');

test('скрипт обновления синтаксически корректен', () => {
  const result = spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf8' });
  if (result.error) return; // bash недоступен в этом образе
  assert.equal(result.status, 0, result.stderr);
});

test('каждый файл миграции применяется одной транзакцией', () => {
  const line = source.split('\n').find((row) => row.includes('run_sql --single-transaction < "$f"'));
  assert.ok(line, 'миграции должны идти через run_sql --single-transaction');
  // Без этого флага ошибка в середине файла оставляла частичные изменения.
  assert.doesNotMatch(source, /psql_out="\$\(run_sql < "\$f"/);
});

test('сверка схемы идёт после миграций и до переключения контейнеров', () => {
  const migrate = source.indexOf('# ── 4b. применяю миграции');
  const audit = source.indexOf('if ! schema_audit; then');
  const switchStep = source.indexOf('# ── 5. сборка и переключение');
  assert.ok(migrate > 0 && audit > 0 && switchStep > 0, 'секции должны существовать');
  assert.ok(audit > migrate, 'сверка должна идти после применения миграций');
  assert.ok(audit < switchStep, 'сверка должна идти до сборки и переключения');
  assert.match(source, /die "схема базы не совпадает с кодом/, 'несовпадение схемы должно останавливать обновление');
});

test('сверка схемы знает про привязку лаунчера и колонки профиля', () => {
  assert.match(source, /REQUIRED_TABLES="[^"]*helper_devices/);
  assert.match(source, /REQUIRED_TABLES="[^"]*helper_link_codes/);
  assert.match(source, /REQUIRED_TABLES="[^"]*helper_settings/);
  assert.match(source, /REQUIRED_COLUMNS="[^"]*profiles\.role/);
  assert.match(source, /REQUIRED_COLUMNS="[^"]*helper_settings\.payload/);
  // Сверка сравнивает и таблицы, и колонки — иначе «половина проекта» живёт.
  assert.match(source, /information_schema\.tables/);
  assert.match(source, /information_schema\.columns/);
});

test('сверка не мешает обновлению, когда базы под рукой нет', () => {
  // Без psql/контейнера шаг обязан молча пропуститься: иначе обновление
  // сломается там, где миграции сознательно отключены (UPDATE_APPLY_MIGRATIONS=0).
  assert.match(source, /schema_audit\(\) \{\n  \[ -n "\$DB_PSQL" \] \|\| return 0/);
});

/* ── сеть Supabase: главная причина «браузер не видит базу» ─────────── */

/**
 * Достаёт функцию из скрипта и запускает её: проверяем настоящее поведение,
 * а не наличие строки в файле.
 */
function runFunction(name, envFileContent, args = []) {
  const start = source.indexOf(`\n${name}() {`);
  assert.ok(start >= 0, `функция ${name} должна быть в скрипте`);
  const body = source.slice(start + 1, source.indexOf('\n}\n', start) + 2);
  const dir = mkdtempSync(join(tmpdir(), 'edrc-net-'));
  const envFile = join(dir, '.env.production');
  writeFileSync(envFile, envFileContent);
  const script = `${body}\nENV_FILE="${envFile}"\n${name} ${args.join(' ')}\n`;
  const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  rmSync(dir, { recursive: true, force: true });
  return { out: (result.stdout ?? '').trim(), status: result.status };
}

test('внутренний адрес Supabase распознаётся, публичный — нет', () => {
  if (spawnSync('bash', ['--version'], { encoding: 'utf8' }).status !== 0) return;

  assert.equal(runFunction('supabase_internal_host', 'SUPABASE_INTERNAL_URL=http://kong:8000\n').out, 'kong');
  assert.equal(runFunction('supabase_internal_host', 'DATABASE_URL=postgres://postgres:pw@db:5432/postgres\n').out, 'db');
  assert.equal(runFunction('supabase_internal_host', 'SUPABASE_INTERNAL_URL=http://supabase-db:8000/\n').out, 'supabase-db');
  // Публичное имя и localhost — общая docker-сеть не нужна, гейт не срабатывает.
  assert.equal(runFunction('supabase_internal_host', 'SUPABASE_INTERNAL_URL=https://supabase.example.com\n').out, '');
  assert.equal(runFunction('supabase_internal_host', 'SUPABASE_INTERNAL_URL=http://127.0.0.1:8000\n').out, '');
  assert.equal(runFunction('supabase_internal_host', 'SUPABASE_INTERNAL_URL=\n').out, '');
});

test('обновление не собирает и не переключает код вне сети Supabase', () => {
  // Гейт до сборки: вместо «сайт поднялся, но базы не видит» — остановка.
  assert.match(source, /сеть Supabase не определилась/);
  assert.match(source, /Обновление остановлено ДО сборки и переключения/);
  // И это происходит до `docker compose build`, а не после.
  const gate = source.indexOf('Обновление остановлено ДО сборки');
  const build = source.indexOf('run_step "сборка образов"');
  assert.ok(gate > 0 && build > 0 && gate < build, 'гейт должен стоять до сборки');
});

test('после переключения сеть проверяется по факту и восстанавливается', () => {
  assert.match(source, /supabase_net_ready/);
  assert.match(source, /переключение с сетью Supabase/);
  assert.match(source, /web по-прежнему не видит Supabase/);
  // Контейнер ищется по метке compose: имя <проект>-web-1, а не `web`.
  assert.match(source, /filter label=com\.docker\.compose\.service=web/);
  assert.doesNotMatch(source, /docker exec web getent/, 'имя `web` не резолвится docker exec');
});
