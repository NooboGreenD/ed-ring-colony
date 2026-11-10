/**
 * Расписания прыжков авианосцев (вкладка «Расписание» на `/carriers/jumps`).
 *
 * Что проверяется:
 *   1. чистые правила (`src/lib/carrierJumpSchedule.ts`): проверка формы,
 *      календарная сетка месяца, группировка по дням, ближайший вылет,
 *      повторы, порядок списка и ссылка на расписание;
 *   2. маршруты на настоящем PostgreSQL (`/api/carriers/jumps/schedules` и
 *      `/api/carriers/jumps/schedules/:id`): создание, список «свои + публичные»,
 *      приватность (гость не видит чужое приватное, публичное читает),
 *      права на правку, добавление и удаление прыжка, повтор — 409.
 *
 * Маршруты собираются esbuild'ом с подменой `next/server`, `next/headers` и
 * `@/lib/supabaseServer`; запросы идут в PGlite с настоящими миграциями, так
 * что CHECK-и, уникальные индексы и каскадное удаление срабатывают по-честному.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { TEST_ROOT, bundleFile } from './helpers/bundle.mjs';
import {
  ENTRY_MAX_AHEAD_MS,
  SCHEDULE_NOTE_MAX,
  SCHEDULE_TITLE_MAX,
  buildMonthGrid,
  compareSchedules,
  entriesForDay,
  entriesForMonth,
  entryDay,
  entryFromBoardRow,
  entryFromRow,
  groupEntriesByDay,
  isDuplicateEntry,
  monthKey,
  nextEntryAt,
  normalizeSchedule,
  normalizeScheduleEntry,
  parseVisibility,
  scheduleFromRow,
  scheduleHref,
  shiftMonth,
} from '../../src/lib/carrierJumpSchedule.ts';

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';

const OWNER = '00000000-0000-4000-8000-0000000000c1';
const OTHER = '00000000-0000-4000-8000-0000000000c2';
const NOW = Date.parse('2026-11-10T12:00:00.000Z');

function entry(overrides = {}) {
  return {
    id: 'e-1',
    scheduleId: 's-1',
    carrierId: '3800000501',
    callsign: 'K7Q-BQL',
    name: 'Hippione',
    from: 'Sol',
    to: 'Lave',
    departureAt: '2026-11-10T18:00:00.000Z',
    note: null,
    ...overrides,
  };
}

/* ── чистые правила ──────────────────────────────────────────────────────── */

test('шапка расписания: название обязательно, видимость по умолчанию приватная', () => {
  assert.equal(normalizeSchedule({}).ok, false);
  assert.equal(normalizeSchedule({ title: '   ' }).ok, false);

  const created = normalizeSchedule({ title: '  Среда,   снабжение Lave ', visibility: 'public' });
  assert.ok(created.ok);
  assert.equal(created.value.title, 'Среда, снабжение Lave', 'лишние пробелы схлопнуты');
  assert.equal(created.value.visibility, 'public');

  const long = normalizeSchedule({ title: 'x'.repeat(SCHEDULE_TITLE_MAX + 20), note: 'n'.repeat(SCHEDULE_NOTE_MAX + 10) });
  assert.ok(long.ok);
  assert.equal(long.value.title.length, SCHEDULE_TITLE_MAX, 'название обрезается, а не отвергается');
  assert.equal(long.value.note.length, SCHEDULE_NOTE_MAX);
  assert.equal(long.value.visibility, 'private', 'без явного значения — приватное');

  assert.equal(parseVisibility('PUBLIC'), 'public');
  assert.equal(parseVisibility('что угодно'), 'private', 'мусор не делает расписание публичным');
});

test('прыжок в расписании: нужны системы и время, мусор в носителе отбрасывается', () => {
  assert.equal(normalizeScheduleEntry({ to: 'Lave', departureAt: '2026-11-11T10:00:00Z' }, NOW).ok, false);
  assert.equal(normalizeScheduleEntry({ from: 'Sol', departureAt: '2026-11-11T10:00:00Z' }, NOW).ok, false);
  assert.equal(normalizeScheduleEntry({ from: 'Sol', to: 'Lave' }, NOW).ok, false);
  assert.equal(normalizeScheduleEntry({ from: 'Sol', to: 'Lave', departureAt: 'не дата' }, NOW).ok, false);

  const far = new Date(NOW + ENTRY_MAX_AHEAD_MS + 60_000).toISOString();
  assert.equal(normalizeScheduleEntry({ from: 'Sol', to: 'Lave', departureAt: far }, NOW).ok, false, 'год вперёд — опечатка');

  const ok = normalizeScheduleEntry({
    carrierId: ' 3800000501 ',
    callsign: ' K7Q-BQL ',
    name: '',
    from: ' Sol ',
    to: 'Lave',
    departureAt: '2026-11-11T10:00:00Z',
    note: 'x'.repeat(600),
  }, NOW);
  assert.ok(ok.ok);
  assert.equal(ok.value.carrierId, '3800000501');
  assert.equal(ok.value.callsign, 'K7Q-BQL');
  assert.equal(ok.value.name, null);
  assert.equal(ok.value.from, 'Sol');
  assert.equal(ok.value.departureAt, '2026-11-11T10:00:00.000Z');
  assert.equal(ok.value.note.length, 500);

  // Ручной план без носителя допустим: пилот знает только системы.
  const manual = normalizeScheduleEntry({ carrierId: 'K7Q-BQL', from: 'Sol', to: 'Lave', departureAt: '2026-11-11T10:00:00Z' }, NOW);
  assert.ok(manual.ok);
  assert.equal(manual.value.carrierId, null, 'позывной — не MarketID');
});

test('календарь: сетка месяца с понедельника, хвосты соседних месяцев помечены', () => {
  const grid = buildMonthGrid('2026-11-01', [], NOW);
  assert.equal(grid.month, '2026-11-01');
  assert.equal(grid.weeks.length, 6, 'ноябрь 2026 начинается в воскресенье: 6 недель сетки');
  for (const week of grid.weeks) assert.equal(week.length, 7);
  // 1 ноября 2026 — воскресенье, значит первая ячейка — понедельник 26 октября.
  assert.equal(grid.weeks[0][0].date, '2026-10-26');
  assert.equal(grid.weeks[0][0].inMonth, false);
  assert.equal(grid.weeks[0][0].day, 26);
  const first = grid.weeks.flat().find((cell) => cell.date === '2026-11-01');
  assert.equal(first.inMonth, true);
  assert.equal(first.day, 1);
  const today = grid.weeks.flat().find((cell) => cell.date === '2026-11-10');
  assert.equal(today.today, true, 'день отсчёта помечен');
  assert.equal(grid.weeks.flat().filter((cell) => cell.inMonth).length, 30);

  assert.equal(monthKey('2026-11-10T12:00:00Z'), '2026-11-01');
  assert.equal(shiftMonth('2026-11-01', 1), '2026-12-01');
  assert.equal(shiftMonth('2026-01-01', -1), '2025-12-01');
  assert.equal(shiftMonth('2026-12-01', 1), '2027-01-01');
  // 31-е в коротком месяце не должно «переползти» на март.
  assert.equal(shiftMonth('2026-01-01', 1), '2026-02-01');
});

test('календарь: счётчики по дням, прыжки дня и месяца', () => {
  const entries = [
    entry({ id: 'a', departureAt: '2026-11-10T18:00:00.000Z' }),
    entry({ id: 'b', departureAt: '2026-11-10T20:00:00.000Z', carrierId: '3800000502', callsign: 'STE-777' }),
    entry({ id: 'c', departureAt: '2026-11-12T06:00:00.000Z' }),
    entry({ id: 'd', departureAt: '2026-12-01T00:30:00.000Z' }),
  ];
  const grid = buildMonthGrid('2026-11-01', entries, NOW);
  const day10 = grid.weeks.flat().find((cell) => cell.date === '2026-11-10');
  assert.equal(day10.count, 2, 'в один день два прыжка — счётчик два');
  assert.equal(grid.weeks.flat().find((cell) => cell.date === '2026-11-12').count, 1);
  assert.equal(grid.weeks.flat().find((cell) => cell.date === '2026-11-11').count, 0);

  assert.deepEqual(entriesForDay(entries, '2026-11-10').map((row) => row.id), ['a', 'b'], 'порядок по времени');
  assert.deepEqual(entriesForMonth(entries, '2026-11-01').map((row) => row.id), ['a', 'b', 'c']);
  assert.equal(entriesForDay(entries, '').length, 0);
  assert.equal(entryDay('2026-11-10T23:59:59.000Z'), '2026-11-10', 'день считается по UTC');
  assert.equal(groupEntriesByDay(entries).get('2026-11-10').length, 2);

  assert.equal(nextEntryAt(entries, NOW), '2026-11-10T18:00:00.000Z');
  assert.equal(nextEntryAt([entry({ departureAt: '2026-11-01T00:00:00.000Z' })], NOW), null, 'прошедшие не считаются');
});

test('повтор и порядок: тот же носитель в то же время — дубль', () => {
  const entries = [entry()];
  assert.equal(isDuplicateEntry(entries, { carrierId: '3800000501', departureAt: '2026-11-10T18:00:00Z' }), true);
  assert.equal(isDuplicateEntry(entries, { carrierId: '3800000501', departureAt: '2026-11-10T19:00:00Z' }), false);
  assert.equal(isDuplicateEntry(entries, { carrierId: '3800000502', departureAt: '2026-11-10T18:00:00Z' }), false);
  assert.equal(isDuplicateEntry(entries, { carrierId: null, departureAt: '2026-11-10T18:00:00Z' }), false,
    'у ручного плана носителя нет — дублем не считается');

  const schedules = [
    { id: 's-2', title: 'Чужое', mine: false, nextEntryAt: '2026-11-10T15:00:00.000Z' },
    { id: 's-1', title: 'Моё', mine: true, nextEntryAt: '2026-11-12T15:00:00.000Z' },
    { id: 's-3', title: 'Без прыжков', mine: true, nextEntryAt: null },
  ];
  assert.deepEqual([...schedules].sort(compareSchedules).map((item) => item.id), ['s-1', 's-3', 's-2'],
    'свои сверху, внутри — по ближайшему вылету, без прыжков в конце');
});

test('строки базы и ссылка: приватность и владелец видны интерфейсу', () => {
  const parsed = scheduleFromRow({
    id: 's-1',
    owner_id: OWNER,
    title: 'Среда',
    note: null,
    visibility: 'public',
    created_at: new Date(NOW),
    updated_at: new Date(NOW),
  }, { viewerId: OWNER, entryCount: 2, nextEntryAt: '2026-11-11T10:00:00.000Z', ownerName: 'Pilot One' });
  assert.equal(parsed.mine, true);
  assert.equal(parsed.visibility, 'public');
  assert.equal(parsed.entryCount, 2);
  assert.equal(parsed.createdAt, new Date(NOW).toISOString(), 'драйвер может вернуть Date');

  const foreign = scheduleFromRow({ id: 's-2', owner_id: OTHER, title: 'Чужое', visibility: 'public' }, { viewerId: OWNER });
  assert.equal(foreign.mine, false);

  const row = entryFromRow({
    id: 'e-1', schedule_id: 's-1', carrier_id: '42', from_system: 'Sol', to_system: 'Lave',
    departure_at: new Date('2026-11-11T10:00:00Z'), callsign: null, name: null, note: null,
  });
  assert.equal(row.departureAt, '2026-11-11T10:00:00.000Z');
  assert.equal(row.carrierId, '42');

  assert.equal(scheduleHref('s-1'), '/carriers/jumps?tab=calendar&schedule=s-1');

  const fromBoard = entryFromBoardRow({
    id: '3800000501', callsign: 'K7Q-BQL', from: 'Sol', to: 'Lave',
    departureAt: '2026-11-11T10:00:00.000Z', carrier: { name: 'Hippione' },
  });
  assert.deepEqual(fromBoard, {
    carrierId: '3800000501', callsign: 'K7Q-BQL', name: 'Hippione',
    from: 'Sol', to: 'Lave', departureAt: '2026-11-11T10:00:00.000Z',
  });
  assert.equal(entryFromBoardRow({
    id: '1', callsign: null, from: 'Sol', to: 'Lave', departureAt: null, carrier: { name: null },
  }), null, 'без времени брать нечего');
});

/* ── маршруты на PostgreSQL ──────────────────────────────────────────────── */

const NEXT_SERVER_STUB = `
export const NextResponse = {
  json: (body, init) => new Response(JSON.stringify(body), {
    status: (init && init.status) || 200,
    headers: { 'content-type': 'application/json', ...((init && init.headers) || {}) },
  }),
};
`;

const NEXT_HEADERS_STUB = `
export async function cookies() {
  throw new Error('no request scope');
}
`;

const HELPER = join(TEST_ROOT, 'scripts', 'tests', 'helpers', 'pgliteSupabase.mjs').replace(/\\/g, '/');
const SUPABASE_STUB = `
import { pgliteClient } from '${HELPER}';
export const state = { db: null, userId: null, log: [] };
export function createServiceClient() { return pgliteClient(state); }
export async function createClient() { return pgliteClient(state); }
export async function authFromRequest() {
  return { user: state.userId ? { id: state.userId } : null, supabase: pgliteClient(state) };
}
`;

const ENTRY = `
export * as list from '@/app/api/carriers/jumps/schedules/route';
export * as one from '@/app/api/carriers/jumps/schedules/[id]/route';
export { state } from '@/lib/supabaseServer';
`;

const db = new PGlite();
await db.exec(`
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE TABLE auth.users(id uuid PRIMARY KEY);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
INSERT INTO auth.users VALUES ('${OWNER}'), ('${OTHER}');
CREATE TABLE public.profiles(
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE, cmdr_name text, role text DEFAULT 'user', privacy_settings jsonb);
INSERT INTO public.profiles(id, cmdr_name, privacy_settings) VALUES
  ('${OWNER}', 'Pilot One', NULL), ('${OTHER}', 'Pilot Two', NULL);
`);
await db.exec(readFileSync(join(TEST_ROOT, 'supabase', 'migrations', '20261112120000_carrier_jump_schedule.sql'), 'utf8'));

const bundle = await bundleFile({
  entrySource: ENTRY,
  stubs: {
    'next/server': NEXT_SERVER_STUB,
    'next/headers': NEXT_HEADERS_STUB,
    '@/lib/supabaseServer': SUPABASE_STUB,
  },
});
const mod = await import(bundle);
mod.state.db = db;

test.after(async () => { await db.close(); });

async function api(method, url, { body, userId = OWNER } = {}) {
  mod.state.userId = userId;
  const request = new Request(`http://localhost${url}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const id = url.match(/\/schedules\/([0-9a-f-]+)/i)?.[1] ?? 'x';
  const response = url.includes('/schedules/')
    ? await mod.one[method](request, { params: Promise.resolve({ id }) })
    : await mod.list[method](request);
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) };
}

const DEPARTURE = new Date(NOW + 26 * 60 * 60 * 1000).toISOString();

test('расписание: гость не создаёт, пилот создаёт приватное по умолчанию', async () => {
  const guest = await api('POST', '/api/carriers/jumps/schedules', { body: { title: 'Гость' }, userId: null });
  assert.equal(guest.status, 401);

  const empty = await api('POST', '/api/carriers/jumps/schedules', { body: { title: '  ' } });
  assert.equal(empty.status, 400, 'без названия не создаём');

  const created = await api('POST', '/api/carriers/jumps/schedules', { body: { title: 'Среда, снабжение Lave' } });
  assert.equal(created.status, 201, created.text);
  assert.equal(created.body.schedule.visibility, 'private', 'по умолчанию приватное');
  assert.equal(created.body.schedule.mine, true);
  assert.equal(created.body.schedule.ownerName, 'Pilot One');
  assert.equal(created.body.schedule.entryCount, 0);
});

test('расписание: список «свои + публичные», чужое приватное не видно', async () => {
  const secret = await api('POST', '/api/carriers/jumps/schedules', { body: { title: 'Мой секрет' } });
  const shared = await api('POST', '/api/carriers/jumps/schedules', { body: { title: 'План эскадрильи', visibility: 'public' } });
  assert.equal(shared.body.schedule.visibility, 'public');

  const mine = await api('GET', '/api/carriers/jumps/schedules');
  const mineIds = mine.body.schedules.map((row) => row.id);
  assert.ok(mineIds.includes(secret.body.schedule.id));
  assert.ok(mineIds.includes(shared.body.schedule.id));
  assert.equal(mine.body.viewer.signedIn, true);

  // Гость видит только публичное — и заголовок приватного ему тоже не отдаётся.
  const guest = await api('GET', '/api/carriers/jumps/schedules', { userId: null });
  const guestIds = guest.body.schedules.map((row) => row.id);
  assert.ok(guestIds.includes(shared.body.schedule.id));
  assert.ok(!guestIds.includes(secret.body.schedule.id), 'чужое приватное не показывается даже в списке');
  assert.equal(guest.body.viewer.signedIn, false);

  // Второй пилот — тоже только публичное.
  const other = await api('GET', '/api/carriers/jumps/schedules', { userId: OTHER });
  const otherIds = other.body.schedules.map((row) => row.id);
  assert.ok(otherIds.includes(shared.body.schedule.id));
  assert.ok(!otherIds.includes(secret.body.schedule.id));
});

test('расписание: приватное чужому — 403, публичное читается без входа', async () => {
  const secret = await api('POST', '/api/carriers/jumps/schedules', { body: { title: 'Только для меня' } });
  const id = secret.body.schedule.id;

  const mine = await api('GET', `/api/carriers/jumps/schedules/${id}`);
  assert.equal(mine.status, 200);
  assert.equal(mine.body.schedule.mine, true);

  const foreign = await api('GET', `/api/carriers/jumps/schedules/${id}`, { userId: OTHER });
  assert.equal(foreign.status, 403, 'чужое приватное закрыто');

  const guest = await api('GET', `/api/carriers/jumps/schedules/${id}`, { userId: null });
  assert.equal(guest.status, 403);

  const shared = await api('POST', '/api/carriers/jumps/schedules', { body: { title: 'Для логистов', visibility: 'public' } });
  const publicId = shared.body.schedule.id;
  const publicAsGuest = await api('GET', `/api/carriers/jumps/schedules/${publicId}`, { userId: null });
  assert.equal(publicAsGuest.status, 200, 'публичное читается без входа');
  assert.equal(publicAsGuest.body.schedule.mine, false);

  const missing = await api('GET', '/api/carriers/jumps/schedules/00000000-0000-4000-8000-0000000000ff');
  assert.equal(missing.status, 404);
});

test('расписание: видимость меняет только владелец, заметка при этом не теряется', async () => {
  const created = await api('POST', '/api/carriers/jumps/schedules', { body: { title: 'Смена', note: 'возит сталь' } });
  const id = created.body.schedule.id;

  const foreign = await api('PATCH', `/api/carriers/jumps/schedules/${id}`, { body: { visibility: 'public' }, userId: OTHER });
  assert.equal(foreign.status, 403);

  const opened = await api('PATCH', `/api/carriers/jumps/schedules/${id}`, { body: { visibility: 'public' } });
  assert.equal(opened.status, 200, opened.text);
  assert.equal(opened.body.schedule.visibility, 'public');
  assert.equal(opened.body.schedule.note, 'возит сталь', 'переключатель видимости не затирает заметку');

  const guest = await api('GET', `/api/carriers/jumps/schedules/${id}`, { userId: null });
  assert.equal(guest.status, 200, 'после публикации видно без входа');

  const closed = await api('PATCH', `/api/carriers/jumps/schedules/${id}`, { body: { visibility: 'private' } });
  assert.equal(closed.body.schedule.visibility, 'private');
  const guestAfter = await api('GET', `/api/carriers/jumps/schedules/${id}`, { userId: null });
  assert.equal(guestAfter.status, 403);
});

test('прыжок: добавляется владельцем, повтор — 409, чужой — 403', async () => {
  const created = await api('POST', '/api/carriers/jumps/schedules', { body: { title: 'С прыжками' } });
  const id = created.body.schedule.id;

  const invalid = await api('POST', `/api/carriers/jumps/schedules/${id}`, { body: { from: 'Sol' } });
  assert.equal(invalid.status, 400, 'нужны обе системы и время');

  const added = await api('POST', `/api/carriers/jumps/schedules/${id}`, {
    body: { carrierId: '3800000501', callsign: 'K7Q-BQL', name: 'Hippione', from: 'Sol', to: 'Lave', departureAt: DEPARTURE, note: 'груз' },
  });
  assert.equal(added.status, 201, added.text);
  assert.equal(added.body.entry.departureAt, DEPARTURE);
  assert.equal(added.body.entry.carrierId, '3800000501');
  assert.equal(added.body.entry.note, 'груз');

  const duplicate = await api('POST', `/api/carriers/jumps/schedules/${id}`, {
    body: { carrierId: '3800000501', callsign: 'K7Q-BQL', from: 'Sol', to: 'Lave', departureAt: DEPARTURE },
  });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.duplicate, true);

  const foreign = await api('POST', `/api/carriers/jumps/schedules/${id}`, {
    body: { from: 'Sol', to: 'Alioth', departureAt: DEPARTURE },
    userId: OTHER,
  });
  assert.equal(foreign.status, 403, 'чужое расписание не правится');

  const loaded = await api('GET', `/api/carriers/jumps/schedules/${id}`);
  assert.equal(loaded.body.entries.length, 1);
  assert.equal(loaded.body.schedule.entryCount, 1, 'счётчик прыжков в шапке');
  assert.equal(loaded.body.schedule.nextEntryAt, DEPARTURE);

  const listed = await api('GET', '/api/carriers/jumps/schedules');
  const summary = listed.body.schedules.find((row) => row.id === id);
  assert.equal(summary.entryCount, 1, 'список считает прыжки без загрузки всех строк');
  assert.equal(summary.nextEntryAt, DEPARTURE);

  const removed = await api('DELETE', `/api/carriers/jumps/schedules/${id}?entry=${added.body.entry.id}`);
  assert.equal(removed.status, 200);
  const after = await api('GET', `/api/carriers/jumps/schedules/${id}`);
  assert.equal(after.body.entries.length, 0, 'прыжок убран');
});

test('прыжок: без носителя тоже можно — ручной план', async () => {
  const created = await api('POST', '/api/carriers/jumps/schedules', { body: { title: 'Планы руками' } });
  const id = created.body.schedule.id;
  const added = await api('POST', `/api/carriers/jumps/schedules/${id}`, {
    body: { from: 'Sol', to: 'Alioth', departureAt: DEPARTURE, note: 'ждём груз' },
  });
  assert.equal(added.status, 201, added.text);
  assert.equal(added.body.entry.carrierId, null);
  // Два ручных плана «туда же и тогда же» — не дубль: носителей у них нет.
  const second = await api('POST', `/api/carriers/jumps/schedules/${id}`, {
    body: { from: 'Sol', to: 'Alioth', departureAt: DEPARTURE },
  });
  assert.equal(second.status, 201);
});

test('расписание: удаление владельцем, каскад и отказ чужому', async () => {
  const created = await api('POST', '/api/carriers/jumps/schedules', { body: { title: 'Под снос' } });
  const id = created.body.schedule.id;
  await api('POST', `/api/carriers/jumps/schedules/${id}`, {
    body: { carrierId: '3800000502', callsign: 'STE-777', from: 'Lave', to: 'Sol', departureAt: DEPARTURE },
  });

  const foreign = await api('DELETE', `/api/carriers/jumps/schedules/${id}`, { userId: OTHER });
  assert.equal(foreign.status, 403);

  const removed = await api('DELETE', `/api/carriers/jumps/schedules/${id}`);
  assert.equal(removed.status, 200);
  assert.equal((await api('GET', `/api/carriers/jumps/schedules/${id}`)).status, 404);

  const left = await db.query('SELECT count(*)::int AS total FROM carrier_jump_schedule_entries WHERE schedule_id = $1', [id]);
  assert.equal(left.rows[0].total, 0, 'строки ушли вместе с расписанием (ON DELETE CASCADE)');
});
