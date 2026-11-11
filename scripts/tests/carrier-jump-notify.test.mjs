/**
 * Уведомления о прыжках подписанных авианосцев.
 *
 * Что проверяется:
 *   1. ссылки в Атлас (`carrierAtlasHref` / `carrierAtlasTargetFromParams`):
 *      MarketID, запасная система и координаты камеры, мусор в адресе;
 *   2. выбор системы слоя по ссылке (`carrierGroupForTarget`): сначала
 *      MarketID, потом имя системы;
 *   3. правила уведомлений страницы (`collectJumpAlerts`): первое заполнение
 *      памяти молчит, повтор состояния не будит, перенос/прибытие/снятый
 *      заказ дают ровно одно событие, память переживает перезагрузку;
 *   4. миграция `20261114100000_carrier_jump_notify.sql` на PostgreSQL
 *      (PGlite): прыжок из истории пишет `user_notifications` только тем, кто
 *      подписан на прыжок именно этого носителя, текст и ссылка понятны без
 *      перевода, а снятая подписка уведомлений больше не приносит.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { TEST_ROOT } from './helpers/bundle.mjs';
import {
  JUMP_ALERT_MEMORY_LIMIT,
  JUMP_ALERT_STORAGE_KEY,
  collectJumpAlerts,
  jumpAlertPrint,
  parseJumpAlertMemory,
} from '../../src/lib/carrierJumps.ts';
import { carrierAtlasHref, carrierAtlasTargetFromParams } from '../../src/lib/systemIdentity.ts';
import { carrierGroupForTarget } from '../../src/lib/carrierMap.ts';

/* ── ссылки в Атлас ──────────────────────────────────────────────────────── */

const params = (href) => new URLSearchParams(href.slice(href.indexOf('?') + 1));

test('ссылка в Атлас: вкладка «Авианосцы», MarketID и координаты камеры', () => {
  const href = carrierAtlasHref('3800000501', { system: 'Sol', point: { x: 0, y: 1.5, z: -2 } });
  assert.ok(href.startsWith('/atlas?'), 'ведёт в Атлас');
  const query = params(href);
  assert.equal(query.get('tab'), 'carriers');
  assert.equal(query.get('carrier'), '3800000501');
  assert.equal(query.get('carrier_system'), 'Sol');
  assert.equal(query.get('focus_system'), 'Sol', 'камера летит сразу, не дожидаясь слоя');
  assert.deepEqual([query.get('x'), query.get('y'), query.get('z')], ['0', '1.5', '-2']);
  assert.equal(query.get('from'), 'system');

  // Без координат камера не задаётся: Атлас выберет систему слоя по носителю.
  const bare = params(carrierAtlasHref('3800000501', { system: ' Sol ' }));
  assert.equal(bare.get('carrier'), '3800000501');
  assert.equal(bare.get('carrier_system'), 'Sol', 'имя системы обрезается');
  assert.equal(bare.get('focus_system'), null);
  assert.equal(bare.get('x'), null);
});

test('ссылка в Атлас: мусор вместо MarketID не превращается в параметр', () => {
  const query = params(carrierAtlasHref('K7Q-BQL'));
  assert.equal(query.get('tab'), 'carriers');
  assert.equal(query.get('carrier'), null, 'позывной — не MarketID');
  assert.ok(!query.get('carrier_system'));
  const long = params(carrierAtlasHref('1'.repeat(21)));
  assert.equal(long.get('carrier'), null, 'слишком длинный идентификатор — мусор');
});

test('разбор адреса Атласа: носитель, система и координаты; не про носителя — null', () => {
  const target = carrierAtlasTargetFromParams(new URLSearchParams(
    'tab=carriers&carrier=3800000501&carrier_system=Lave&x=10&y=-20&z=30',
  ));
  assert.deepEqual(target, {
    carrierId: '3800000501',
    system: 'Lave',
    point: { x: 10, y: -20, z: 30 },
  });

  const bySystem = carrierAtlasTargetFromParams(new URLSearchParams('carrier=abc&carrier_system=Sol'));
  assert.deepEqual(bySystem, { carrierId: null, system: 'Sol', point: null },
    'без MarketID остаётся ориентир по системе');

  const outOfRange = carrierAtlasTargetFromParams(new URLSearchParams('carrier=1&x=1&y=2&z=999999'));
  assert.equal(outOfRange.point, null, 'координаты вне галактики не принимаются');
  assert.equal(outOfRange.carrierId, '1');

  assert.equal(carrierAtlasTargetFromParams(new URLSearchParams('tab=carriers')), null);
  assert.equal(carrierAtlasTargetFromParams(new URLSearchParams('')), null);
});

test('система слоя по ссылке: MarketID точнее имени, имя — запасной ориентир', () => {
  const groups = [
    { key: 'sol', system: 'Sol', position: { x: 0, y: 0, z: 0 }, carriers: [{ id: '3800000501' }, { id: '3800000502' }] },
    { key: 'lave', system: 'Lave', position: { x: 1, y: 1, z: 1 }, carriers: [{ id: '3800000503' }] },
  ];
  assert.equal(carrierGroupForTarget(groups, { carrierId: '3800000503' })?.system, 'Lave');
  assert.equal(carrierGroupForTarget(groups, { carrierId: '999', system: 'lave' })?.system, 'Lave',
    'носителя в слое нет — ведём по системе, регистр не важен');
  assert.equal(carrierGroupForTarget(groups, { carrierId: '999', system: 'Alioth' }), null);
  assert.equal(carrierGroupForTarget(groups, {}), null);
});

/* ── правила уведомлений страницы ────────────────────────────────────────── */

function watchRow({ id = '3800000601', state = 'same', from = null, at = null, live = null } = {}) {
  const target = live?.to ?? null;
  return {
    watch: { carrierId: id, callsign: 'K7Q-BQL', name: 'Hippione', system: 'Sol' },
    live,
    plan: { state, from, at, to: target, toAt: live?.departureAt ?? null },
  };
}

const liveRow = (to, departureAt = '2026-11-12T12:00:00.000Z') => ({
  id: '3800000601',
  to,
  departureAt,
  carrier: { system: 'Sol' },
});

test('память уведомлений: пустая память молчит и запоминает текущее состояние', () => {
  const rows = [watchRow({ state: 'same' })];
  const { alerts, next } = collectJumpAlerts(rows, {});
  assert.deepEqual(alerts, [], 'первый показ ничего не рассылает');
  assert.deepEqual(next, { '3800000601': jumpAlertPrint(rows[0]) });
});

test('перенос плана — одно уведомление, повтор того же состояния — тишина', () => {
  const before = watchRow({ state: 'same' });
  const memory = { '3800000601': jumpAlertPrint(before) };

  const after = watchRow({ state: 'changed', from: 'Lave', live: liveRow('Alioth') });
  const first = collectJumpAlerts([after], memory);
  assert.equal(first.alerts.length, 1);
  assert.deepEqual(first.alerts[0], {
    carrierId: '3800000601',
    label: 'Hippione',
    kind: 'changed',
    system: 'Alioth',
  });

  const second = collectJumpAlerts([after], first.next);
  assert.deepEqual(second.alerts, [], 'обновление таблицы не повторяет уведомление');
});

test('прибытие и снятый заказ: разные тексты, цель — из снимка подписки', () => {
  const arrived = collectJumpAlerts(
    [watchRow({ state: 'arrived', from: 'Lave', live: null })],
    { '3800000601': 'same|lave|2026-11-12T12:00:00.000Z' },
  );
  assert.deepEqual(arrived.alerts.map((alert) => [alert.kind, alert.system]), [['arrived', 'Lave']],
    'прибыл туда, куда собирался');

  const gone = collectJumpAlerts(
    [watchRow({ state: 'gone', from: null, live: null })],
    { '3800000601': 'same|lave|2026-11-12T12:00:00.000Z' },
  );
  assert.deepEqual(gone.alerts.map((alert) => alert.kind), ['gone']);
  assert.equal(gone.alerts[0].system, null, 'при снятом заказе цели может не быть');

  // Запись без подписи: подпись — MarketID, чтобы уведомление не было пустым.
  const nameless = collectJumpAlerts(
    [{
      watch: { carrierId: '3800000777', callsign: null, name: null, system: 'Sol' },
      live: null,
      plan: { state: 'changed', from: 'Lave', at: null, to: 'Alioth', toAt: null },
    }],
    { '3800000777': 'same|lave|' },
  );
  assert.equal(nameless.alerts[0].label, '3800000777');
  assert.equal(nameless.alerts[0].system, 'Alioth');
});

test('память: мусор в localStorage не ломает страницу, запись ограничена', () => {
  assert.equal(JUMP_ALERT_STORAGE_KEY, 'carrierJumpAlerts:v1');
  assert.deepEqual(parseJumpAlertMemory(null), {});
  assert.deepEqual(parseJumpAlertMemory('не json'), {});
  assert.deepEqual(parseJumpAlertMemory('[1,2,3]'), {});
  assert.deepEqual(parseJumpAlertMemory('{"abc":"x","3800000601":"same|sol|"}'), { '3800000601': 'same|sol|' },
    'ключ — только MarketID');
  const many = Object.fromEntries(
    Array.from({ length: JUMP_ALERT_MEMORY_LIMIT + 20 }, (_, index) => [String(3800000000 + index), 'same|sol|']),
  );
  assert.equal(Object.keys(parseJumpAlertMemory(JSON.stringify(many))).length, JUMP_ALERT_MEMORY_LIMIT);
});

/* ── миграция на PostgreSQL ──────────────────────────────────────────────── */

const PILOT = '00000000-0000-4000-8000-0000000000b1';
const FAVORITE = '00000000-0000-4000-8000-0000000000b2';
const OTHER_SHIP = '00000000-0000-4000-8000-0000000000b3';
const NO_PROFILE = '00000000-0000-4000-8000-0000000000b4';

const db = new PGlite();
await db.exec(`
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role BYPASSRLS;
CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE TABLE auth.users(id uuid PRIMARY KEY);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

CREATE TABLE public.profiles(id uuid PRIMARY KEY);
CREATE TABLE public.user_notifications(
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  href TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  is_read BOOLEAN NOT NULL DEFAULT false,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Минимальные слепки таблиц, к которым цепляются триггеры истории.
CREATE TABLE public.fleet_carriers(
  carrier_id BIGINT PRIMARY KEY,
  callsign TEXT,
  name TEXT,
  system_name TEXT,
  location_at TIMESTAMPTZ
);
CREATE TABLE public.carrier_directory(
  carrier_id BIGINT PRIMARY KEY,
  callsign TEXT,
  name TEXT,
  system_name TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  previous_system_name TEXT,
  previous_at TIMESTAMPTZ
);

INSERT INTO auth.users(id) VALUES ('${PILOT}'), ('${FAVORITE}'), ('${OTHER_SHIP}'), ('${NO_PROFILE}');
INSERT INTO public.profiles(id) VALUES ('${PILOT}'), ('${FAVORITE}'), ('${OTHER_SHIP}');
`);

for (const file of [
  '20261107090000_atlas_carrier_watch.sql',
  '20261110190000_carrier_watch_jump.sql',
  '20261113120000_carrier_jump_history.sql',
  '20261114100000_carrier_jump_notify.sql',
]) {
  await db.exec(readFileSync(join(TEST_ROOT, 'supabase', 'migrations', file), 'utf8'));
}

async function notifications(sql = 'SELECT * FROM public.user_notifications ORDER BY id', params = []) {
  const { rows } = await db.query(sql, params);
  return rows;
}

await db.exec(`
INSERT INTO public.fleet_carriers(carrier_id, callsign, name, system_name, location_at)
VALUES (3800000601, 'K7Q-BQL', 'Hippione', 'Sol', '2026-11-12T08:00:00Z'),
       (3800000602, NULL, 'Big Ship', 'Sol', '2026-11-12T08:00:00Z');

-- Подписчик на прыжок первого носителя.
INSERT INTO public.atlas_carrier_watch(user_id, carrier_id, callsign, name, system_name,
  favorite, jump_system_name, jump_departure_at, jump_seen_at)
VALUES ('${PILOT}', '3800000601', 'K7Q-BQL', 'Hippione', 'Sol', false, 'Lave', '2026-11-12T09:00:00Z', '2026-11-12T08:30:00Z');

-- Просто избранное Атласа: носитель в списке, но прыжок не заказан.
INSERT INTO public.atlas_carrier_watch(user_id, carrier_id, callsign, system_name, favorite)
VALUES ('${FAVORITE}', '3800000601', 'K7Q-BQL', 'Sol', true);

-- Подписка на другой носитель.
INSERT INTO public.atlas_carrier_watch(user_id, carrier_id, callsign, system_name,
  favorite, jump_system_name, jump_departure_at, jump_seen_at)
VALUES ('${OTHER_SHIP}', '3800000602', NULL, 'Sol', false, 'Lave', '2026-11-12T09:00:00Z', '2026-11-12T08:30:00Z');

-- Подписка пилота без профиля: уведомление не должно ронять запись истории.
INSERT INTO public.atlas_carrier_watch(user_id, carrier_id, callsign, system_name,
  favorite, jump_system_name, jump_departure_at, jump_seen_at)
VALUES ('${NO_PROFILE}', '3800000601', 'K7Q-BQL', 'Sol', false, 'Lave', '2026-11-12T09:00:00Z', '2026-11-12T08:30:00Z');
`);

test('прыжок из истории уведомляет только подписчиков этого носителя', async () => {
  await db.exec(`UPDATE public.fleet_carriers
    SET system_name = 'Lave', location_at = '2026-11-12T09:00:00Z'
    WHERE carrier_id = 3800000601`);

  const rows = await notifications();
  assert.equal(rows.length, 1, 'избранное и чужая подписка уведомлений не получают');
  const note = rows[0];
  assert.equal(note.user_id, PILOT);
  assert.equal(note.type, 'carrier_jump');
  assert.equal(note.title, 'K7Q-BQL', 'заголовок — позывной носителя');
  assert.equal(note.body, 'Sol → Lave', 'тело — маршрут, без перевода');
  assert.equal(note.href, '/atlas?tab=carriers&carrier=3800000601');
  assert.equal(note.metadata.carrier_id, 3800000601);
  assert.equal(note.metadata.from_system, 'Sol');
  assert.equal(note.metadata.to_system, 'Lave');
  assert.equal(note.metadata.source, 'site');
  assert.equal(note.is_read, false);
});

test('повтор наблюдения той же стоянки не дублирует уведомление', async () => {
  await db.exec(`UPDATE public.fleet_carriers SET location_at = '2026-11-12T09:05:00Z'
    WHERE carrier_id = 3800000601`);
  assert.equal((await notifications()).length, 1, 'история не выросла — уведомление тоже');
});

test('без позывного заголовок берётся из имени, ссылка та же', async () => {
  await db.exec(`UPDATE public.fleet_carriers
    SET system_name = 'Alioth', location_at = '2026-11-12T10:00:00Z'
    WHERE carrier_id = 3800000602`);

  const rows = await notifications('SELECT * FROM public.user_notifications WHERE user_id = $1', [OTHER_SHIP]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'Big Ship');
  assert.equal(rows[0].body, 'Sol → Alioth');
  assert.equal(rows[0].href, '/atlas?tab=carriers&carrier=3800000602');
});

test('снятая подписка уведомлений не приносит', async () => {
  await db.exec(`UPDATE public.atlas_carrier_watch
    SET jump_system_name = NULL, jump_departure_at = NULL, jump_seen_at = NULL
    WHERE user_id = '${PILOT}' AND carrier_id = '3800000601'`);

  await db.exec(`UPDATE public.fleet_carriers
    SET system_name = 'Sol', location_at = '2026-11-12T11:00:00Z'
    WHERE carrier_id = 3800000601`);

  const rows = await notifications('SELECT * FROM public.user_notifications WHERE user_id = $1', [PILOT]);
  assert.equal(rows.length, 1, 'осталось только уведомление о первом прыжке');
});

test('миграция идемпотентна: повторный прогон не плодит триггеров и уведомлений', async () => {
  await db.exec(readFileSync(
    join(TEST_ROOT, 'supabase', 'migrations', '20261114100000_carrier_jump_notify.sql'),
    'utf8',
  ));
  const triggers = await db.query(
    `SELECT tgname FROM pg_trigger
      WHERE tgrelid = 'public.carrier_jump_history'::regclass AND NOT tgisinternal`,
  );
  assert.deepEqual(triggers.rows.map((row) => row.tgname), ['carrier_jump_notify_watchers']);
  assert.equal((await notifications()).length, 2, 'старые уведомления не пересоздаются');

  // Новый прыжок другого носителя после повторного прогона всё ещё уведомляет.
  await db.exec(`UPDATE public.fleet_carriers
    SET system_name = 'Leesti', location_at = '2026-11-12T12:00:00Z'
    WHERE carrier_id = 3800000602`);
  const after = await notifications('SELECT title, body FROM public.user_notifications WHERE user_id = $1', [OTHER_SHIP]);
  assert.equal(after.length, 2);
  assert.equal(after[1].body, 'Alioth → Leesti');
});

test.after(async () => {
  await db.close();
});

/* ── подключение в страницах ─────────────────────────────────────────────── */

test('Атлас: ссылка на носитель включает слой и выбирает его систему', () => {
  const page = readFileSync(join(TEST_ROOT, 'src', 'app', 'atlas', 'page.tsx'), 'utf8');
  assert.match(page, /carrierAtlasTargetFromParams\(searchParams\)/);
  assert.match(page, /carrierGroupForTarget\(carrierLayer\.groups, carrierTarget\)/);
  assert.match(page, /setCarrierLayerShown\(true\)/, 'слой «Авианосцы» включается по ссылке');
  assert.match(page, /selectCarrierGroup\(group\)/, 'система носителя выбирается на карте');

  const bell = readFileSync(join(TEST_ROOT, 'src', 'components', 'NotificationBell.tsx'), 'utf8');
  assert.match(bell, /type:[\s\S]*carrier_jump|carrier_jump/, 'колокольчик знает тип уведомления');
  assert.match(bell, /nbell\.typeCarrierJump/);
});
