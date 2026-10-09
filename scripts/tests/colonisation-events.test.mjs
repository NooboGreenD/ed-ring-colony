/**
 * Запись состояний стройплощадок в `colonisation_sites` (src/lib/colonisationEvents.ts).
 *
 * Таблица хранит одну строку на площадку — текущее состояние. Здесь закреплено:
 * одно состояние из разных клиентов даёт одну и ту же строку, лишние поля журнала
 * (Payment, сырое событие, вклады) в базу не попадают, повторы и устаревшие
 * состояния не меняют площадку, а снимки прогресса пишутся только при реальном
 * изменении. Отдельно — контракт миграции и maintenance-скрипта: права на
 * функции и правило «новее побеждает», без которых код выше работает неверно.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SITE_WRITE_BATCH,
  compactResources,
  depotStateFingerprint,
  latestDepotEvents,
  persistColonisationSites,
  progressPercent,
  siteRowFromDepot,
  siteRowFromTelemetry,
  snapshotRowsForChangedSites,
} from '../../src/lib/colonisationEvents.ts';

const ROOT = new URL('../..', import.meta.url).pathname;
const TIMESTAMP = '2026-09-14T10:00:00Z';
const USER = 'user-1';

/** Строка в формате Colonial Helper'а / браузерной телеметрии (доля прогресса). */
const telemetryEvent = (overrides = {}) => ({
  timestamp: TIMESTAMP,
  system_name: 'Delta Velorum',
  market_id: 3951663874,
  construction_id: 1,
  construction_name: 'A 1',
  construction_progress: 0.5,
  resources_total: [
    { Name: '$steel_name;', Name_Localised: 'Steel', RequiredAmount: 5000, ProvidedAmount: 1200, Payment: 900 },
  ],
  raw_event: { timestamp: TIMESTAMP, event: 'ColonisationConstructionDepot', Big: 'x'.repeat(50) },
  ...overrides,
});

/** Тот же объект после парсера сайта (`parseColonisationEvents`): проценты, camelCase. */
const parsedDepot = (overrides = {}) => ({
  timestamp: TIMESTAMP,
  systemName: 'Delta Velorum',
  marketId: '3951663874',
  constructionName: 'A 1',
  constructionId: '1',
  constructionProgress: 50,
  resourcesRequired: [
    { name: '$steel_name;', nameLocalised: 'Сталь', requiredAmount: 5000, providedAmount: 1200, payment: 900 },
  ],
  ...overrides,
});

/* ── построение строк ── */

test('одно состояние стройки из разных клиентов даёт одну и ту же строку площадки', () => {
  const fromHelper = siteRowFromTelemetry(USER, telemetryEvent());
  const fromSite = siteRowFromDepot(USER, parsedDepot());

  assert.ok(fromHelper && fromSite);
  assert.equal(fromHelper.market_id, fromSite.market_id);
  assert.equal(fromHelper.construction_id, fromSite.construction_id);
  assert.equal(fromHelper.construction_progress, fromSite.construction_progress,
    'доля журнала и проценты парсера дали разный прогресс');
  // Название для показа зависит от языка клиента; состояние (имя и суммы) — нет.
  const state = (rows) => rows.map(({ Name_Localised: _localised, ...rest }) => rest);
  assert.deepEqual(state(fromHelper.resources_total), state(fromSite.resources_total));
});

test('строка площадки содержит только нужные поля — без сырого события и служебных ключей', () => {
  const row = siteRowFromTelemetry(USER, telemetryEvent());
  assert.deepEqual(Object.keys(row).sort(), [
    'construction_id', 'construction_name', 'construction_progress', 'event_timestamp',
    'market_id', 'resources_total', 'system_name', 'user_id',
  ]);
  assert.equal(row.event_timestamp, '2026-09-14T10:00:00.000Z', 'метка времени не нормализована');
  assert.equal(typeof row.market_id, 'string', 'MarketID должен уходить строкой (64-битный)');
});

test('Payment не хранится, Name_Localised — только если есть', () => {
  const row = siteRowFromTelemetry(USER, telemetryEvent());
  assert.deepEqual(row.resources_total, [
    { Name: '$steel_name;', Name_Localised: 'Steel', RequiredAmount: 5000, ProvidedAmount: 1200 },
  ]);

  const bare = compactResources([{ Name: 'a', RequiredAmount: 1, ProvidedAmount: 0, Payment: 3 }]);
  assert.deepEqual(bare, [{ Name: 'a', RequiredAmount: 1, ProvidedAmount: 0 }]);
});

test('компактный список сортируется и отбрасывает мусор', () => {
  const out = compactResources([
    { Name: 'zeta', RequiredAmount: 1, ProvidedAmount: 0 },
    null,
    'text',
    { Name: '', RequiredAmount: 1, ProvidedAmount: 0 },
    { Name: 'no-provided', RequiredAmount: 1 },
    { Name: 'text-amount', RequiredAmount: 'abc', ProvidedAmount: 1 },
    { Name: 'null-amount', RequiredAmount: null, ProvidedAmount: 1 },
    { Name: 'empty-amount', RequiredAmount: '', ProvidedAmount: 1 },
    { Name: 'alpha', RequiredAmount: -4, ProvidedAmount: '2' },
  ]);
  assert.deepEqual(out, [
    { Name: 'alpha', RequiredAmount: 0, ProvidedAmount: 2 },
    { Name: 'zeta', RequiredAmount: 1, ProvidedAmount: 0 },
  ]);
  assert.deepEqual(compactResources('не массив'), []);
});

test('строки без системы, метки времени или MarketID не строятся', () => {
  assert.equal(siteRowFromDepot(USER, parsedDepot({ systemName: '' })), null);
  assert.equal(siteRowFromDepot(USER, parsedDepot({ timestamp: '' })), null);
  assert.equal(siteRowFromDepot(USER, parsedDepot({ timestamp: 'не дата' })), null);
  assert.equal(siteRowFromDepot(USER, parsedDepot({ marketId: null })), null);
  assert.equal(siteRowFromDepot(USER, parsedDepot({ marketId: '0' })), null);
  assert.equal(siteRowFromTelemetry(USER, telemetryEvent({ system_name: '  ' })), null);
  assert.equal(siteRowFromTelemetry(USER, telemetryEvent({ timestamp: null })), null);
  assert.equal(siteRowFromTelemetry(USER, telemetryEvent({ market_id: null })), null);
});

test('прогресс: доля журнала переводится в проценты один раз, а проценты парсера — не переводятся снова', () => {
  assert.equal(progressPercent(0.5), 50, 'доля журнала');
  assert.equal(progressPercent(50), 50, 'уже проценты');
  assert.equal(progressPercent(0.5, true), 100, 'завершённая стройка');
  assert.equal(siteRowFromDepot(USER, parsedDepot({ constructionProgress: 0.5 })).construction_progress, 0.5,
    'парсер сайта уже отдал проценты: повторный перевод исказил бы 0,5 % в 50 %');
  assert.equal(siteRowFromDepot(USER, parsedDepot({ constructionComplete: true })).construction_progress, 100);
  assert.equal(siteRowFromTelemetry(USER, telemetryEvent({ construction_progress: 0.123456 })).construction_progress, 12.35,
    'прогресс округляется до сотых, как NUMERIC(5,2)');
});

/* ── отпечаток и «что изменилось» ── */

test('локальный язык журнала и цена не меняют состояние стройки', () => {
  const english = depotStateFingerprint(50, [{ name: 'steel', nameLocalised: 'Steel', requiredAmount: 5, providedAmount: 1, payment: 1 }]);
  const russian = depotStateFingerprint(50, [{ name: 'steel', nameLocalised: 'Сталь', requiredAmount: 5, providedAmount: 1, payment: 999 }]);
  assert.equal(english, russian);
});

test('отпечаток состояния различает прогресс и поставки', () => {
  const base = depotStateFingerprint(50, [{ name: 'steel', requiredAmount: 10, providedAmount: 1 }]);
  assert.notEqual(base, depotStateFingerprint(50, [{ name: 'steel', requiredAmount: 10, providedAmount: 2 }]));
  assert.notEqual(base, depotStateFingerprint(50, [{ name: 'steel', requiredAmount: 20, providedAmount: 1 }]));
  assert.notEqual(base, depotStateFingerprint(51, [{ name: 'steel', requiredAmount: 10, providedAmount: 1 }]));
  assert.equal(base, depotStateFingerprint(50, [{ name: 'steel', requiredAmount: 10, providedAmount: 1 }]));
});

test('снимки пишутся только по изменившимся площадкам, по одному на стройку', () => {
  const rows = [
    siteRowFromDepot(USER, parsedDepot({ constructionId: '7', constructionProgress: 10, timestamp: '2026-09-14T10:00:00Z' })),
    siteRowFromDepot(USER, parsedDepot({ constructionId: '7', constructionProgress: 30, timestamp: '2026-09-14T10:05:00Z' })),
    siteRowFromDepot(USER, parsedDepot({ marketId: '555', constructionId: '8', constructionProgress: 90, timestamp: '2026-09-14T10:00:00Z' })),
  ];
  const snapshots = snapshotRowsForChangedSites(rows, new Set(['3951663874']));
  assert.equal(snapshots.length, 1, 'не изменившаяся площадка попала в снимки');
  assert.equal(snapshots[0].progress, 30, 'в снимке не самое новое состояние стройки');
  assert.equal(snapshots[0].source, 'journal');
  assert.equal(snapshots[0].snapshot_at, '2026-09-14T10:05:00.000Z');
});

test('latestDepotEvents оставляет последнее состояние каждой стройки', () => {
  const events = [
    { systemName: 'A', constructionId: '1', timestamp: '2026-09-14T10:00:00Z', tag: 'old' },
    { systemName: 'a', constructionId: '1', timestamp: '2026-09-14T10:09:00Z', tag: 'new' },
    { systemName: 'A', constructionId: '2', timestamp: '2026-09-14T10:01:00Z', tag: 'other' },
  ];
  const latest = latestDepotEvents(events);
  assert.deepEqual(latest.map((event) => event.tag).sort(), ['new', 'other']);
});

/* ── запись через RPC ── */

/** Мок RPC `colonisation_sites_write` — только вызовы и ответ, без логики базы. */
function rpcClient(respond = (rows) => rows.map((row) => ({ market_id: row.market_id, changed: true }))) {
  const calls = [];
  return {
    calls,
    rpc: async (fn, args) => {
      calls.push({ fn, rows: args.p_rows });
      return { data: respond(args.p_rows), error: null };
    },
  };
}

test('запись идёт через RPC пачками по SITE_WRITE_BATCH и считает изменившиеся состояния', async () => {
  const rows = Array.from({ length: 250 }, (_, index) => siteRowFromDepot(USER, parsedDepot({
    marketId: String(1000 + index),
  })));
  const client = rpcClient((batch) => batch.map((row, index) => ({
    market_id: row.market_id,
    changed: index % 2 === 0,
  })));

  const outcome = await persistColonisationSites(client, rows);

  assert.equal(SITE_WRITE_BATCH, 100);
  assert.deepEqual(client.calls.map((call) => call.rows.length), [100, 100, 50]);
  assert.ok(client.calls.every((call) => call.fn === 'colonisation_sites_write'));
  assert.equal(outcome.changed + outcome.unchanged, 250);
  assert.equal(outcome.changed, 125);
  assert.equal(outcome.changedMarkets.size, 125);
  assert.equal(outcome.failed, 0);
});

test('в базу уходят только нужные поля: без Payment, сырого события и источника', async () => {
  const client = rpcClient();
  await persistColonisationSites(client, [siteRowFromTelemetry(USER, telemetryEvent())]);
  const sent = JSON.stringify(client.calls[0].rows);
  assert.ok(!sent.includes('Payment'), 'Payment ушёл в базу');
  assert.ok(!sent.includes('raw_event'), 'сырое событие ушло в базу');
  assert.ok(!sent.includes('source_hash'), 'служебный ключ старой схемы ушёл в базу');
});

test('повтор состояния не засчитывается как изменение', async () => {
  const client = rpcClient((rows) => rows.map((row) => ({ market_id: row.market_id, changed: false })));
  const outcome = await persistColonisationSites(client, [siteRowFromTelemetry(USER, telemetryEvent())]);
  assert.equal(outcome.changed, 0);
  assert.equal(outcome.unchanged, 1);
  assert.equal(outcome.changedMarkets.size, 0);
});

test('таймаут базы делит пачку пополам, а не теряет её', async () => {
  const rows = Array.from({ length: 4 }, (_, index) => siteRowFromDepot(USER, parsedDepot({ marketId: String(2000 + index) })));
  const calls = [];
  const svc = {
    rpc: async (_fn, args) => {
      calls.push(args.p_rows.length);
      if (args.p_rows.length > 2) return { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } };
      return { data: args.p_rows.map((row) => ({ market_id: row.market_id, changed: true })), error: null };
    },
  };
  const outcome = await persistColonisationSites(svc, rows);
  assert.deepEqual(calls, [4, 2, 2], 'пачка не разделилась на половины');
  assert.equal(outcome.changed, 4);
  assert.equal(outcome.failed, 0);
  assert.deepEqual(outcome.warnings, []);
});

test('ошибка записи попадает в warnings и не бросается наружу', async () => {
  const svc = {
    rpc: async () => ({ data: null, error: { code: '42883', message: 'function colonisation_sites_write does not exist' } }),
  };
  const outcome = await persistColonisationSites(svc, [siteRowFromTelemetry(USER, telemetryEvent())]);
  assert.equal(outcome.changed, 0);
  assert.equal(outcome.failed, 1, 'неуспешная строка не учтена как потерянная');
  assert.ok(outcome.warnings.some((w) => /does not exist/.test(w)), 'ошибка не видна в warnings');
});

test('пустой набор ничего не отправляет', async () => {
  const client = rpcClient();
  const outcome = await persistColonisationSites(client, []);
  assert.equal(client.calls.length, 0);
  assert.equal(outcome.changed, 0);
});

/* ── контракт SQL: то, без чего код выше работает неверно ── */

const migration = readFileSync(
  join(ROOT, 'supabase', 'migrations', '20261009010000_colonisation_sites.sql'), 'utf8');
const cutover = readFileSync(
  join(ROOT, 'supabase', 'maintenance', 'colonisation_sites_cutover.sql'), 'utf8');

test('миграция закрывает функции записи и чистки от клиентов (anon/authenticated)', () => {
  for (const fn of [
    'colonisation_sites_write(jsonb)',
    'colonisation_retention_prune(integer)',
    'colonisation_compact_resources(jsonb)',
    'colonisation_resources_state(jsonb)',
  ]) {
    const name = fn.replace(/\(.*/, '');
    assert.match(migration, new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}\\(.*FROM PUBLIC, anon, authenticated`),
      `${fn}: EXECUTE не закрыт от клиентов`);
    assert.match(migration, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\(.*TO service_role`),
      `${fn}: service_role не получил EXECUTE`);
  }
  assert.match(migration, /REVOKE ALL ON public\.colonisation_sites FROM anon, authenticated/);
});

test('запись «новее побеждает»: строка обновляется только при более новой метке времени', () => {
  assert.match(migration, /ON CONFLICT \(market_id\) DO UPDATE SET/);
  assert.match(migration, /WHERE EXCLUDED\.event_timestamp > s\.event_timestamp/);
  // изменение состояния считается без локализации: иначе смена языка даёт снимок
  assert.match(migration, /colonisation_resources_state\(b\.resources_total\)\s+IS DISTINCT FROM/);
});

test('перенос исключает вклады и пустые площадки и проверяет полноту до переименования', () => {
  assert.match(cutover, /ColonisationContribution/);
  assert.match(cutover, /WHERE EXCLUDED\.event_timestamp > s\.event_timestamp/);
  const check = cutover.indexOf('перенос неполный');
  const rename = cutover.indexOf('RENAME TO colonisation_events_legacy');
  assert.ok(check > 0 && rename > check, 'переименование стоит раньше проверки полноты');
  // DROP — только закомментирован: удаление не должно выполняться без ручного решения.
  assert.match(cutover, /^-- DROP TABLE IF EXISTS public\.colonisation_events_legacy;/m);
});
