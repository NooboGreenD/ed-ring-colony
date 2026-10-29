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
import { readFileSync } from 'node:fs';
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
