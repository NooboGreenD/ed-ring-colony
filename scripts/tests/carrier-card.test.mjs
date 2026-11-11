/**
 * Карточка авианосца (`/carriers/<MarketID>`) и носители в карточке системы.
 *
 * Что проверяется:
 *   1. чистые правила (`src/lib/carrierCard.ts`): адрес карточки, разбор строк
 *      истории, окна графика, сводка прыжков (окна, направления, темп),
 *      службы из обоих источников, заголовок;
 *   2. `GET /api/carriers/{id}/card` на настоящем PostgreSQL (PGlite) с
 *      миграциями авианосцев: место и тело, заказ прыжка, службы, приватность
 *      владельца, эскадрилья, история за год, 404 на неизвестный MarketID,
 *      отсутствие груза и финансов в ответе;
 *   3. носители системы для карточки системы (`loadSystemCarriers`):
 *      реестр EDDN подмешивается к учёту сайта, дубли не появляются, записи
 *      из реестра помечены `origin: 'eddn'` и несут тело.
 *
 * Маршрут собирается esbuild'ом с подменой `next/server` и
 * `@/lib/supabaseServer`; запросы идут в PGlite по настоящим миграциям.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { TEST_ROOT, bundleFile } from './helpers/bundle.mjs';
import {
  CARRIER_CARD_DAILY_BUCKETS,
  CARRIER_CARD_JUMPS_LIMIT,
  CARRIER_CARD_MONTHLY_BUCKETS,
  CARRIER_CARD_WINDOW_DAYS,
  carrierCardBucketIndex,
  carrierCardBuckets,
  carrierCardHref,
  carrierCardId,
  carrierCardJumpFromRow,
  carrierCardServiceSummary,
  carrierCardServices,
  carrierCardSince,
  carrierCardStats,
  carrierCardTitle,
  orderCarrierCardJumps,
} from '../../src/lib/carrierCard.ts';

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-13T12:00:00.000Z');

function jump(id, from, to, at, source = 'site') {
  return { id: String(id), from, to, jumpedAt: at, source };
}

/* ── чистые правила ──────────────────────────────────────────────────────── */

test('адрес карточки: только MarketID, мусор — null', () => {
  assert.equal(carrierCardId('3800000501'), '3800000501');
  assert.equal(carrierCardId(' 3800000501 '), '3800000501');
  assert.equal(carrierCardId('K7Q-BQL'), null);
  assert.equal(carrierCardId(''), null);
  assert.equal(carrierCardId(null), null);
  assert.equal(carrierCardId('1'.repeat(21)), null);

  assert.equal(carrierCardHref('3800000501'), '/carriers/3800000501');
  assert.equal(carrierCardHref('K7Q-BQL'), null);
});

test('окно истории — год: то, что попадает в запрос `gte(jumped_at)`', () => {
  assert.equal(CARRIER_CARD_WINDOW_DAYS, 365);
  assert.equal(CARRIER_CARD_JUMPS_LIMIT, 120);
  assert.equal(CARRIER_CARD_DAILY_BUCKETS, 30);
  assert.equal(CARRIER_CARD_MONTHLY_BUCKETS, 12);
  assert.equal(carrierCardSince(NOW), '2025-11-13T12:00:00.000Z');
});

test('разбор строки истории: битые строки отбрасываются', () => {
  assert.deepEqual(
    carrierCardJumpFromRow({ id: 7, from_system: 'Sol', to_system: 'Lave', jumped_at: '2026-11-12T10:00:00Z', source: 'eddn' }),
    { id: '7', from: 'Sol', to: 'Lave', jumpedAt: '2026-11-12T10:00:00.000Z', source: 'eddn' },
  );
  assert.equal(carrierCardJumpFromRow({ id: 1, from_system: '', to_system: 'Lave', jumped_at: '2026-11-12' }), null);
  assert.equal(carrierCardJumpFromRow({ id: 1, from_system: 'Sol', to_system: 'Lave', jumped_at: 'не дата' }), null);
  assert.equal(carrierCardJumpFromRow({ id: 1, from_system: 'Sol', to_system: 'Lave', jumped_at: '2026-11-12T00:00:00Z' }).source, 'site');
});

test('порядок истории: свежие сверху, повтор по id не удваивает строку', () => {
  const ordered = orderCarrierCardJumps([
    jump(1, 'Sol', 'Lave', '2026-11-10T10:00:00.000Z'),
    jump(2, 'Lave', 'Alioth', '2026-11-12T10:00:00.000Z'),
    jump(1, 'Sol', 'Lave', '2026-11-10T10:00:00.000Z'),
  ]);
  assert.deepEqual(ordered.map((item) => item.id), ['2', '1']);
});

test('корзины: 30 дней и 12 месяцев, последняя — текущая, время вне окна — -1', () => {
  const days = carrierCardBuckets('day', 30, NOW);
  assert.equal(days.length, 30);
  assert.equal(new Date(days[29]).toISOString(), '2026-11-13T00:00:00.000Z', 'последняя корзина — сегодня (UTC)');
  assert.equal(carrierCardBucketIndex('day', Date.parse('2026-11-13T23:59:00Z'), days), 29);
  assert.equal(carrierCardBucketIndex('day', Date.parse('2026-10-01T00:00:00Z'), days), -1, 'вне окна');

  const months = carrierCardBuckets('month', 12, NOW);
  assert.equal(months.length, 12);
  assert.equal(new Date(months[11]).toISOString(), '2026-11-01T00:00:00.000Z');
  assert.equal(new Date(months[0]).toISOString(), '2025-12-01T00:00:00.000Z');
  assert.equal(carrierCardBucketIndex('month', Date.parse('2026-11-30T00:00:00Z'), months), 11);
  assert.equal(carrierCardBucketIndex('month', Date.parse('2025-01-01T00:00:00Z'), months), -1);
});

test('сводка прыжков: окна, темп, направления и графики', () => {
  const jumps = [
    jump(1, 'Sol', 'Lave', new Date(NOW - 1 * DAY).toISOString()),
    jump(2, 'Lave', 'Alioth', new Date(NOW - 3 * DAY).toISOString(), 'eddn'),
    jump(3, 'Alioth', 'Lave', new Date(NOW - 20 * DAY).toISOString()),
    jump(4, 'Lave', 'Sol', new Date(NOW - 100 * DAY).toISOString()),
    jump(5, 'Sol', 'Lave', new Date(NOW - 300 * DAY).toISOString()),
  ];
  const stats = carrierCardStats(jumps, { now: NOW });
  assert.equal(stats.total, 5);
  assert.equal(stats.last7, 2, 'два прыжка за неделю');
  assert.equal(stats.last30, 3);
  assert.equal(stats.site, 4);
  assert.equal(stats.eddn, 1);
  assert.equal(stats.uniqueDestinations, 3, 'Lave, Alioth и Sol');
  assert.equal(stats.perWeek, Math.round((5 / 365) * 7 * 100) / 100);
  assert.deepEqual(stats.top[0], { system: 'Lave', jumps: 3, share: 0.6 });
  assert.equal(stats.top[1].system, 'Alioth');
  assert.equal(stats.daily.length, 30);
  assert.equal(stats.monthly.length, 12);
  assert.equal(stats.daily.reduce((sum, bucket) => sum + bucket.jumps, 0), 3, 'в дневной график попадают только 30 дней');
  assert.equal(stats.monthly.reduce((sum, bucket) => sum + bucket.jumps, 0), 5, 'все пять прыжков года попадают в 12 месяцев');
  assert.equal(stats.lastAt, new Date(NOW - 1 * DAY).toISOString());
  assert.equal(stats.firstAt, new Date(NOW - 300 * DAY).toISOString());

  const empty = carrierCardStats([], { now: NOW });
  assert.equal(empty.total, 0);
  assert.deepEqual(empty.top, []);
  assert.equal(empty.firstAt, null);
  assert.equal(empty.perWeek, 0);
});

test('службы: учёт сайта (activated/enabled) и реестр EDDN (просто роли) в одном списке', () => {
  const services = carrierCardServices([
    { role: 'Commodities', activated: true, enabled: true },
    { role: 'Refuel', activated: true, enabled: false },
    { role: 'Shipyard', activated: false, enabled: true },
  ]);
  assert.deepEqual(services.map((service) => [service.role, service.active]), [
    ['Commodities', true],
    ['Shipyard', false],
    ['Refuel', false],
  ], 'работает только установленная и включённая; дальше по алфавиту подписи');
  assert.equal(services[0].label, 'Рынок товаров', 'подпись из словаря служб');

  const registry = carrierCardServices(['commodities', 'pioneersupplies', 'unknownrole']);
  assert.deepEqual(registry.map((service) => service.active), [true, true, true], 'EDDN передаёт только работающие');
  assert.equal(registry.find((service) => service.role === 'unknownrole').label, 'unknownrole',
    'неизвестная роль показывается как есть');
  assert.deepEqual(carrierCardServiceSummary(carrierCardServices(['refuel', 'repair'])), { active: 2, total: 2 });
  assert.deepEqual(carrierCardServices(null), []);
  assert.deepEqual(carrierCardServices([{ role: '' }, 42, null]), []);
});

test('заголовок карточки: имя, позывной, MarketID — в порядке убывания подробности', () => {
  assert.equal(carrierCardTitle({ id: '3800000501', callsign: 'K7Q-BQL', name: 'Hippione' }), 'Hippione');
  assert.equal(carrierCardTitle({ id: '3800000501', callsign: 'K7Q-BQL', name: '  ' }), 'K7Q-BQL');
  assert.equal(carrierCardTitle({ id: '3800000501' }), '#3800000501');
  assert.equal(carrierCardTitle({}), '—');
});

/* ── маршрут и хранилище на PostgreSQL ───────────────────────────────────── */

const OWNER = '00000000-0000-4000-8000-0000000000d1';
const SHY = '00000000-0000-4000-8000-0000000000d2';
const MEMBER = '00000000-0000-4000-8000-0000000000d3';
const VIEWER = '00000000-0000-4000-8000-0000000000d4';

const FC = {
  card: '3800000701',
  shy: '3800000702',
  squad: '3800000703',
  registry: '3800000704',
};

const NEXT_SERVER_STUB = `
export const NextResponse = {
  json: (body, init) => new Response(JSON.stringify(body), {
    status: (init && init.status) || 200,
    headers: { 'content-type': 'application/json', ...((init && init.headers) || {}) },
  }),
};
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
export * as cardRoute from '@/app/api/carriers/[id]/card/route';
export { state } from '@/lib/supabaseServer';
export { loadSystemCarriers } from '@/lib/carrierMapStore';
export { createServiceClient } from '@/lib/supabaseServer';
`;

const db = new PGlite();
await db.exec(`
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE TABLE auth.users(id uuid PRIMARY KEY);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
INSERT INTO auth.users VALUES ('${OWNER}'), ('${SHY}'), ('${MEMBER}'), ('${VIEWER}');
CREATE TABLE public.profiles(
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE, cmdr_name text, role text DEFAULT 'user', privacy_settings jsonb);
INSERT INTO public.profiles(id, cmdr_name, privacy_settings) VALUES
  ('${OWNER}', 'Owner Pilot', NULL),
  ('${SHY}', 'Shy Pilot', '{"location": false}'),
  ('${MEMBER}', 'Member Pilot', NULL),
  ('${VIEWER}', 'Viewer Pilot', NULL);
CREATE TABLE public.squadrons(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name text, tag text, created_by uuid);
INSERT INTO public.squadrons(name, tag, created_by) VALUES ('Alpha Wing', 'ALP', '${OWNER}');
CREATE TABLE public.squadron_ranks(id bigint PRIMARY KEY, squadron_id bigint, can_edit_squadron boolean);
CREATE TABLE public.squadron_members(squadron_id bigint, user_id uuid, rank_id bigint);
INSERT INTO public.squadron_members VALUES (1, '${MEMBER}', 10);
CREATE TABLE public.galaxy_systems(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name text, name_lc text UNIQUE, x float8 NOT NULL, y float8 NOT NULL, z float8 NOT NULL);
INSERT INTO public.galaxy_systems(name, name_lc, x, y, z) VALUES ('Sol', 'sol', 0, 0, 0), ('Lave', 'lave', 75.75, 48.75, -12.5);
`);

for (const file of [
  '20261017000000_fleet_carriers.sql',
  '20261108120000_carrier_directory.sql',
  '20261110090000_carrier_directory_route.sql',
  '20261113120000_carrier_jump_history.sql',
]) {
  await db.exec(readFileSync(join(TEST_ROOT, 'supabase', 'migrations', file), 'utf8'));
}

const at = (minutes) => `now() + interval '${minutes} minutes'`;
await db.exec(`
INSERT INTO fleet_carriers(carrier_id, carrier_type, callsign, name, owner_id, squadron_id, system_name, body_name, x, y, z, location_at,
    docking_access, allow_notorious, services, space_usage, jump_system_name, jump_body_name, jump_departure_at) VALUES
  (${FC.card}, 'FleetCarrier', 'CRD-701', 'Hippione', '${OWNER}', NULL, 'Sol', 'Earth', 0, 0, 0, ${at(-30)},
    'all', false,
    '[{"role":"Commodities","activated":true,"enabled":true},{"role":"Refuel","activated":true,"enabled":true},{"role":"Shipyard","activated":false,"enabled":false}]',
    '{"cargo": 1234, "free_space": 26000}', 'Lave', 'Lave 2', ${at(45)}),
  (${FC.shy}, 'FleetCarrier', 'SHY-702', 'Shy Depot', '${SHY}', NULL, 'Sol', NULL, 0, 0, 0, ${at(-20)},
    'friends', NULL, '[]', NULL, NULL, NULL, NULL),
  (${FC.squad}, 'SquadronCarrier', 'SQD-703', 'Wing Bank', NULL, 1, 'Sol', 'Moon', 0, 0, 0, ${at(-15)},
    'squadron', true, '[{"role":"SquadronBank","activated":true,"enabled":true}]', NULL, NULL, NULL, NULL);
INSERT INTO carrier_directory(carrier_id, callsign, name, carrier_type, system_name, body_name, x, y, z, services, updated_at, last_seen_at, sightings)
VALUES (${FC.registry}, 'REG-704', NULL, 'FleetCarrier', 'Sol', 'Mars', 0, 0, 0, '["commodities","pioneersupplies"]', now(), now(), 12);
`);

// История прыжков: год назад тоже есть, чтобы окно проверялось по-настоящему.
await db.exec(`
INSERT INTO carrier_jump_history(carrier_id, callsign, name, from_system, to_system, jumped_at, source) VALUES
  (${FC.card}, 'CRD-701', 'Hippione', 'Sol', 'Lave', ${at(-60 * 24 * 2)}, 'site'),
  (${FC.card}, 'CRD-701', 'Hippione', 'Lave', 'Sol', ${at(-60 * 24 * 10)}, 'eddn'),
  (${FC.card}, 'CRD-701', 'Hippione', 'Sol', 'Leesti', ${at(-60 * 24 * 40)}, 'site'),
  (${FC.card}, 'CRD-701', 'Hippione', 'Sol', 'Shinrarta Dezhra', ${at(-60 * 24 * 400)}, 'site');
`);

const bundle = await bundleFile({
  entrySource: ENTRY,
  stubs: {
    'next/server': NEXT_SERVER_STUB,
    '@/lib/supabaseServer': SUPABASE_STUB,
  },
});
const mod = await import(bundle);
mod.state.db = db;

test.after(async () => {
  await db.close();
});

async function card(userId, id) {
  mod.state.userId = userId;
  const response = await mod.cardRoute.GET(
    new Request(`http://localhost/api/carriers/${id}/card`),
    { params: Promise.resolve({ id }) },
  );
  const text = await response.text();
  return { status: response.status, headers: response.headers, text, body: JSON.parse(text) };
}

test('карточка носителя: место, тело, заказ прыжка, службы и владелец', async () => {
  const response = await card(null, FC.card);
  assert.equal(response.status, 200, response.text);
  assert.equal(response.headers.get('cache-control'), 'no-store');

  const value = response.body.card;
  assert.equal(value.id, FC.card);
  assert.equal(value.callsign, 'CRD-701');
  assert.equal(value.name, 'Hippione');
  assert.equal(value.type, 'FleetCarrier');
  assert.equal(value.location.system, 'Sol');
  assert.equal(value.location.body, 'Earth', 'тело, у которого стоит носитель');
  assert.deepEqual(value.location.position, { x: 0, y: 0, z: 0 });
  assert.equal(value.location.source, 'site');

  assert.equal(value.jump.system, 'Lave');
  assert.equal(value.jump.body, 'Lave 2');
  assert.equal(value.jump.state, 'scheduled');

  assert.deepEqual(value.services.map((service) => [service.role, service.active]), [
    ['Refuel', true],
    ['Commodities', true],
    ['Shipyard', false],
  ], 'работающие сверху: «Заправка» стоит раньше «Рынка товаров» по подписи');
  assert.deepEqual(carrierCardServiceSummary(value.services), { active: 2, total: 3 });
  assert.equal(value.docking, 'все пилоты');
  assert.equal(value.notorious, false);
  assert.equal(value.owner.name, 'Owner Pilot');
  assert.equal(value.owner.hidden, false);
  assert.equal(value.relation, 'other', 'гостю всё чужое');

  for (const secret of ['1234', '26000', 'space_usage', 'finance', 'balance']) {
    assert.ok(!response.text.includes(secret), `в карточке есть «${secret}» — это данные капитана`);
  }
});

test('карточка носителя: история за год, статистика и предупреждения', async () => {
  const value = (await card(null, FC.card)).body.card;
  assert.equal(value.jumps.length, 3, 'прыжок 400-дневной давности в год не попадает');
  assert.deepEqual(value.jumps.map((item) => item.to), ['Lave', 'Sol', 'Leesti']);
  assert.equal(value.stats.total, 3);
  assert.equal(value.stats.last7, 1);
  assert.equal(value.stats.eddn, 1);
  assert.equal(value.stats.uniqueDestinations, 3);
  assert.equal(value.stats.daily.length, 30);
  assert.equal(value.stats.monthly.length, 12);
  assert.deepEqual(value.warnings, []);
});

test('приватность владельца и эскадрилья: как на карте, без исключений', async () => {
  const shy = (await card(null, FC.shy)).body.card;
  assert.equal(shy.owner.name, null, 'владелец скрыл местоположение');
  assert.equal(shy.owner.hidden, true);
  assert.equal(shy.location.body, null, 'тело не передавалось');
  assert.equal(shy.jump, null);
  assert.ok(shy.warnings.includes('noJumpHistory'), 'пустая история — предупреждение, а не ошибка');

  const squad = (await card(null, FC.squad)).body.card;
  assert.equal(squad.type, 'SquadronCarrier');
  assert.deepEqual(squad.squadron, { id: 1, name: 'Alpha Wing', tag: 'ALP', member: false });
  assert.equal(squad.location.body, 'Moon');

  const member = (await card(MEMBER, FC.squad)).body.card;
  assert.equal(member.relation, 'squadron', 'участник эскадрильи видит отношение');
  assert.equal(member.squadron.member, true);

  const owner = (await card(OWNER, FC.card)).body.card;
  assert.equal(owner.relation, 'own');
});

test('только реестр EDDN: носителя нет в учёте сайта, но карточка работает', async () => {
  const response = await card(null, FC.registry);
  assert.equal(response.status, 200, response.text);
  const value = response.body.card;
  assert.equal(value.callsign, 'REG-704');
  assert.equal(value.name, null, 'имя из реестра не выдумывается');
  assert.equal(value.location.system, 'Sol');
  assert.equal(value.location.body, 'Mars');
  assert.equal(value.location.source, 'eddn');
  assert.equal(value.sightings, 12);
  assert.deepEqual(value.services.map((service) => service.role), ['commodities', 'pioneersupplies']);
  assert.equal(value.owner.name, null);
  assert.equal(value.jump, null);
});

test('неизвестный или мусорный MarketID: 404 и 400, без пустой карточки', async () => {
  const missing = await card(null, '3800009999');
  assert.equal(missing.status, 404);

  const bad = await card(null, 'K7Q-BQL');
  assert.equal(bad.status, 400);
});

test('носители системы: реестр EDDN подмешивается к учёту сайта без дублей', async () => {
  const svc = mod.createServiceClient();
  const carriers = await mod.loadSystemCarriers(svc, null, 'Sol', {
    point: { x: 0, y: 0, z: 0 },
    now: new Date(),
  });
  const byId = new Map(carriers.map((carrier) => [carrier.id, carrier]));
  assert.ok(byId.has(FC.card), 'носитель сайта на месте');
  assert.ok(byId.has(FC.registry), 'носитель из реестра тоже');
  assert.equal(byId.get(FC.registry).origin, 'eddn');
  assert.equal(byId.get(FC.registry).body, 'Mars', 'карточка системы показывает тело');
  assert.equal(byId.get(FC.card).origin, 'site');
  assert.equal(byId.get(FC.card).body, 'Earth');
  assert.equal(new Set(carriers.map((carrier) => carrier.id)).size, carriers.length, 'дублей нет');

  const withoutRegistry = await mod.loadSystemCarriers(svc, null, 'Sol', {
    point: { x: 0, y: 0, z: 0 },
    now: new Date(),
    includeDirectory: false,
  });
  assert.ok(!withoutRegistry.some((carrier) => carrier.id === FC.registry), 'реестр можно выключить');
});
