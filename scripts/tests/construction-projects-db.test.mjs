import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

/* Проекты строительства в БД
   (supabase/migrations/20261106090000_construction_projects.sql).

   Миграция исполняется настоящим PostgreSQL (PGlite): проверяются регистрация
   проекта из Helper, правило «новее побеждает», сохранение уже известных
   значений при частичном обновлении и то, что проект живёт без Raven
   (`build_id` остаётся пустым, `rc_state` — только диагностика). */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRATION = join(ROOT, 'supabase', 'migrations', '20261106090000_construction_projects.sql');

const db = new PGlite();
const USER = '00000000-0000-4000-8000-000000000001';

await db.exec(`
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE TABLE auth.users(id uuid PRIMARY KEY);
INSERT INTO auth.users VALUES ('${USER}');
`);
await db.exec(readFileSync(MIGRATION, 'utf8'));

async function register(project, user = USER) {
  const { rows } = await db.query(
    'SELECT * FROM public.construction_project_register($1::jsonb, $2::uuid)',
    [JSON.stringify(project), user],
  );
  return rows[0];
}

test('регистрация: проект сохраняется с остатком и точными ресурсами', async () => {
  const row = await register({
    project_key: '28682976:128016640',
    system_name: 'Ravenless 1',
    system_address: 28682976,
    market_id: 128016640,
    build_name: 'Первый порт',
    build_type: 'no_truss',
    commodities: { steel: 900 },
    max_need: 5000,
    resources: [{ Name: 'steel', RequiredAmount: 1000, ProvidedAmount: 100 }],
    progress: 40,
    commander: 'Jameson',
    rc_state: 'unavailable',
    // Метка клиента: сравнение идёт по ней, а не по времени сервера.
    updated_at: '2026-11-09T10:00:00Z',
  });

  assert.equal(row.project_key, '28682976:128016640');
  assert.equal(row.build_name, 'Первый порт');
  assert.deepEqual(row.commodities, { steel: 900 });
  assert.equal(row.max_need, 5000);
  assert.equal(row.resources.length, 1);
  assert.equal(Number(row.progress), 40);
  assert.equal(row.status, 'active');
  // Проект существует без Raven — это и есть смысл таблицы.
  assert.equal(row.build_id, null);
  assert.equal(row.rc_state, 'unavailable');
});

test('ручное обновление: более свежая копия побеждает, старая не затирает', async () => {
  const newer = await register({
    project_key: '28682976:128016640',
    commodities: { steel: 500 },
    build_id: 'b-1',
    rc_state: 'ok',
    updated_at: '2026-11-09T12:00:00Z',
  });
  assert.equal(newer.build_id, 'b-1');
  assert.deepEqual(newer.commodities, { steel: 500 });
  assert.equal(newer.rc_state, 'ok');

  // Очередь Helper досылает старую копию (доставка, задержавшаяся в пути).
  const older = await register({
    project_key: '28682976:128016640',
    commodities: { steel: 9999 },
    build_name: 'Устаревшее имя',
    updated_at: '2026-11-09T09:00:00Z',
  });
  assert.deepEqual(older.commodities, { steel: 500 }, 'старый остаток не перезаписал новый');
  assert.equal(older.build_name, 'Первый порт', 'имя тоже осталось свежим');
  assert.equal(older.build_id, 'b-1');
});

test('частичное обновление не стирает известные поля', async () => {
  const row = await register({
    project_key: '28682976:128016640',
    // Пустая карта остатка и пустой список ресурсов — «данных нет», а не «ноль».
    commodities: {},
    resources: [],
    updated_at: '2026-11-09T13:00:00Z',
  });
  assert.deepEqual(row.commodities, { steel: 500 });
  assert.equal(row.max_need, 5000);
  assert.equal(row.build_type, 'no_truss');
});

test('две площадки одной системы — две строки', async () => {
  const second = await register({
    project_key: '28682976:999',
    system_name: 'Ravenless 1',
    market_id: 999,
    build_name: 'Второй аванпост',
    build_type: 'vulcan',
    updated_at: '2026-11-09T10:00:00Z',
  });
  assert.equal(second.project_key, '28682976:999');

  const { rows } = await db.query(
    "SELECT count(*)::int AS n FROM public.construction_projects WHERE system_name_lc = 'ravenless 1'",
  );
  assert.equal(rows[0].n, 2);
});

test('без ключа площадки функция отказывает', async () => {
  await assert.rejects(
    () => register({ project_key: '   ' }),
    /project_key is required/,
  );
});

test('статус и завершённость проекта', async () => {
  const row = await register({
    project_key: '28682976:999',
    status: 'complete',
    progress: 100,
    updated_at: '2026-11-09T14:00:00Z',
  });
  assert.equal(row.status, 'complete');
  assert.equal(Number(row.progress), 100);
});
