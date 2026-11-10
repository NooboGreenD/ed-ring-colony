/**
 * История прыжков авианосцев (вкладка «История» на `/carriers/jumps`).
 *
 * Что проверяется:
 *   1. чистые правила (`src/lib/carrierJumpHistory.ts`): периоды и окна,
 *      гранулярность, корзины графика (включая заполнение пустых), геометрия
 *      столбцов, подписи осей, поиск и разбор строк/сводки;
 *   2. триггеры и SQL настоящей миграции `20261113120000_carrier_jump_history.sql`
 *      на PostgreSQL (PGlite): журнал сайта, поток EDDN, дедупликация одного
 *      прыжка из двух источников, бэкфилл из реестра, RPC корзин и сводки;
 *   3. маршрут `/api/carriers/jumps/history`: окно периода, корзины, сводка,
 *      порядок строк, поиск, ограничение выдачи и `no-store`.
 *
 * Маршрут собирается esbuild'ом с подменой `next/server`, `next/headers` и
 * `@/lib/supabaseServer`; запросы идут в PGlite, поэтому триггеры, CHECK-и и
 * SQL-функции срабатывают по-честному, а не по договорённости заглушки.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { TEST_ROOT, bundleFile } from './helpers/bundle.mjs';
import {
  EMPTY_HISTORY_SUMMARY,
  HISTORY_BUCKET_COUNT,
  HISTORY_GRANULARITY,
  HISTORY_PERIODS,
  fillHistoryBuckets,
  historyBarHeights,
  historyBarWidth,
  historyBars,
  historyBucketIndex,
  historyBucketLabel,
  historyBuckets,
  historyGranularity,
  historyRoute,
  historySince,
  historySummaryFromJson,
  jumpRecordFromRow,
  matchesHistoryQuery,
  parseHistoryPeriod,
} from '../../src/lib/carrierJumpHistory.ts';

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';

const NOW = Date.parse('2026-11-12T12:34:56.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/* ── чистые правила ──────────────────────────────────────────────────────── */

test('периоды: мусор сводится к суткам, у каждого периода своя гранулярность', () => {
  assert.deepEqual([...HISTORY_PERIODS], ['1h', '1d', '1m', '1y']);
  assert.equal(parseHistoryPeriod('1H'), '1h', 'регистр не важен');
  assert.equal(parseHistoryPeriod(' 1m '), '1m', 'пробелы обрезаются');
  assert.equal(parseHistoryPeriod('2h'), '1d', 'неизвестный период — безопасное значение');
  assert.equal(parseHistoryPeriod(null), '1d');
  assert.equal(parseHistoryPeriod(42), '1d');
  assert.equal(parseHistoryPeriod(undefined), '1d');

  assert.equal(historyGranularity('1h'), '5min');
  assert.equal(historyGranularity('1d'), 'hour');
  assert.equal(historyGranularity('1m'), 'day');
  assert.equal(historyGranularity('1y'), 'month');
  assert.deepEqual({ ...HISTORY_GRANULARITY }, { '1h': '5min', '1d': 'hour', '1m': 'day', '1y': 'month' });
});

test('окна: 12 пятиминуток, 24 часа, 30 дней и 12 месяцев, последняя корзина — текущая', () => {
  assert.deepEqual({ ...HISTORY_BUCKET_COUNT }, { '1h': 12, '1d': 24, '1m': 30, '1y': 12 });
  for (const period of HISTORY_PERIODS) {
    const buckets = historyBuckets(period, NOW);
    assert.equal(buckets.length, HISTORY_BUCKET_COUNT[period], `${period}: столько корзин, сколько столбцов`);
    for (let index = 1; index < buckets.length; index += 1) {
      assert.ok(buckets[index] > buckets[index - 1], `${period}: корзины по возрастанию`);
    }
    assert.equal(historySince(period, NOW), buckets[0], 'начало окна — первая корзина');
  }

  // Пятиминутки от эпохи: 12:30 — последняя корзина для 12:34:56.
  const hourly = historyBuckets('1h', NOW);
  assert.equal(new Date(hourly[hourly.length - 1]).toISOString(), '2026-11-12T12:30:00.000Z');
  assert.equal(new Date(hourly[0]).toISOString(), '2026-11-12T11:35:00.000Z');

  // Часы — от начала часа.
  const daily = historyBuckets('1d', NOW);
  assert.equal(new Date(daily[daily.length - 1]).toISOString(), '2026-11-12T12:00:00.000Z');
  assert.equal(new Date(daily[0]).toISOString(), '2026-11-11T13:00:00.000Z');

  // Дни — календарные, от полуночи UTC.
  const monthly = historyBuckets('1m', NOW);
  assert.equal(new Date(monthly[monthly.length - 1]).toISOString(), '2026-11-12T00:00:00.000Z');
  assert.equal(new Date(monthly[0]).toISOString(), '2026-10-14T00:00:00.000Z');

  // Месяцы — первые числа, включая текущий.
  const yearly = historyBuckets('1y', NOW);
  assert.equal(new Date(yearly[yearly.length - 1]).toISOString(), '2026-11-01T00:00:00.000Z');
  assert.equal(new Date(yearly[0]).toISOString(), '2025-12-01T00:00:00.000Z');

  // Переход через год и месяц не должен терять корзины.
  const january = Date.parse('2026-01-15T08:00:00.000Z');
  const months = historyBuckets('1y', january).map((start) => new Date(start).toISOString().slice(0, 7));
  assert.equal(months.length, 12);
  assert.equal(months[0], '2025-02');
  assert.equal(months[11], '2026-01');
});

test('корзина по времени: попадание, границы и выход за окно', () => {
  const hourly = historyBuckets('1h', NOW);
  assert.equal(historyBucketIndex('1h', Date.parse('2026-11-12T12:34:56Z'), NOW), 11, 'текущая пятиминутка');
  assert.equal(historyBucketIndex('1h', Date.parse('2026-11-12T11:35:00Z'), NOW), 0, 'самое начало окна');
  assert.equal(historyBucketIndex('1h', Date.parse('2026-11-12T11:34:59Z'), NOW), -1, 'чуть раньше — вне окна');
  assert.equal(historyBucketIndex('1h', Date.parse('2026-11-12T12:40:00Z'), NOW), -1, 'будущее — вне окна');
  assert.equal(hourly.length, 12);

  assert.equal(historyBucketIndex('1d', Date.parse('2026-11-11T13:00:00Z'), NOW), 0, 'первый час суток');
  assert.equal(historyBucketIndex('1d', Date.parse('2026-11-12T11:59:00Z'), NOW), 22);

  assert.equal(historyBucketIndex('1m', Date.parse('2026-11-12T03:00:00Z'), NOW), 29, 'сегодня — последний день');
  assert.equal(historyBucketIndex('1m', Date.parse('2026-10-31T23:59:00Z'), NOW), 17, 'октябрь: 14-е — 0, 31-е — 17');

  assert.equal(historyBucketIndex('1y', Date.parse('2026-11-05T10:00:00Z'), NOW), 11, 'текущий месяц');
  assert.equal(historyBucketIndex('1y', Date.parse('2025-12-31T23:00:00Z'), NOW), 0, 'первый месяц окна');
  assert.equal(historyBucketIndex('1y', Date.parse('2025-11-30T23:00:00Z'), NOW), -1, 'до окна');
});

test('корзины графика: счётчики раскладываются по сетке, пустые остаются пустыми', () => {
  const buckets = historyBuckets('1h', NOW);
  const rows = [
    { bucket: new Date(buckets[0]).toISOString(), jumps: 2 },
    { bucket: new Date(buckets[0]).toISOString(), jumps: 3 },
    { bucket: new Date(buckets[7]).toISOString(), jumps: '4' },
    { bucket: new Date(buckets[11]).toISOString(), jumps: 1 },
  ];
  const counts = fillHistoryBuckets(buckets, rows);
  assert.equal(counts.length, 12);
  assert.equal(counts[0], 5, 'повторы одной корзины складываются, строка-число разбирается');
  assert.equal(counts[7], 4);
  assert.equal(counts[11], 1);
  assert.equal(counts[3], 0, 'пустая корзина — ноль');

  // Мусор не должен сдвигать сетку: неизвестное время игнорируется.
  assert.deepEqual(fillHistoryBuckets(buckets, [{ bucket: 'не дата', jumps: 9 }]), new Array(12).fill(0));
  assert.deepEqual(fillHistoryBuckets([], rows), []);
});

test('график: высоты столбцов нормируются, ноль остаётся нулём', () => {
  assert.deepEqual(historyBarHeights([0, 0, 0]), [0, 0, 0]);
  assert.deepEqual(historyBarHeights([2, 4, 8]), [0.25, 0.5, 1]);
  assert.deepEqual(historyBarHeights([-3, 6]), [0, 1], 'отрицательный счётчик не рисуется');

  const bars = historyBars([0, 5, 10]);
  assert.equal(bars.length, 3);
  assert.equal(bars[2].height, 1);
  assert.equal(bars[0].height, 0);
  assert.equal(bars[0].value, 0);
  assert.ok(bars[0].x >= 0 && bars[0].x < 1 / 3, 'столбец внутри своей доли');
  assert.ok(bars[2].x < 1, 'последний столбец не выезжает за край');
  assert.ok(bars[1].x > bars[0].x, 'порядок слева направо');

  assert.ok(historyBarWidth(12) > 0);
  assert.ok(historyBarWidth(12) < 1 / 12, 'ширина меньше шага: остаётся зазор');
  assert.equal(historyBarWidth(0), 0);
  assert.deepEqual(historyBars([]), []);
  // Зазор за пределами 0…1 не должен ломать геометрию.
  assert.ok(historyBarWidth(4, 5) > 0);
  assert.ok(historyBarWidth(4, -5) > 0);
});

test('подписи осей: время, дата, месяц — в зависимости от гранулярности', () => {
  const minute = historyBucketLabel('1h', Date.parse('2026-11-12T12:30:00Z'), 'ru');
  assert.match(minute, /^\d{2}:\d{2}$/, 'час — только время');

  const day = historyBucketLabel('1m', Date.parse('2026-11-12T00:00:00Z'), 'ru');
  assert.match(day, /^12[.\/]11$/, 'день — дата без года');

  const month = historyBucketLabel('1y', Date.parse('2026-03-01T00:00:00Z'), 'en');
  assert.match(month, /mar/i, 'месяц — название месяца');
  assert.match(month, /26/, 'месяц — и год');

  // Функция принимает и гранулярность: так её зовёт интерфейс.
  assert.equal(historyBucketLabel('hour', Date.parse('2026-11-12T12:30:00Z'), 'ru'), minute);
});

test('поиск по истории: позывной, имя, система и MarketID, все слова сразу', () => {
  const row = {
    id: '1',
    carrierId: '3800000501',
    callsign: 'K7Q-BQL',
    name: 'Hippione',
    from: 'Sol',
    to: 'Lave',
    jumpedAt: '2026-11-12T11:00:00.000Z',
    source: 'site',
  };
  assert.equal(matchesHistoryQuery(row, ''), true, 'пустой запрос — все строки');
  assert.equal(matchesHistoryQuery(row, '   '), true);
  assert.equal(matchesHistoryQuery(row, 'k7q'), true, 'регистр не важен');
  assert.equal(matchesHistoryQuery(row, 'hippione'), true);
  assert.equal(matchesHistoryQuery(row, 'lave'), true);
  assert.equal(matchesHistoryQuery(row, '3800000501'), true);
  assert.equal(matchesHistoryQuery(row, 'sol lave'), true, 'несколько слов — все должны найтись');
  assert.equal(matchesHistoryQuery(row, 'sol leesti'), false);
  assert.equal(matchesHistoryQuery(row, null), true);

  assert.equal(historyRoute(row), 'Sol → Lave');
});

test('строки и сводка: snake_case базы превращается в поля интерфейса', () => {
  const parsed = jumpRecordFromRow({
    id: '17',
    carrier_id: 3800000501,
    callsign: ' K7Q-BQL ',
    name: '',
    from_system: 'Sol',
    to_system: 'Lave',
    jumped_at: new Date('2026-11-12T11:00:00Z'),
    source: 'eddn',
  });
  assert.equal(parsed.id, '17');
  assert.equal(parsed.carrierId, '3800000501');
  assert.equal(parsed.callsign, 'K7Q-BQL');
  assert.equal(parsed.name, null, 'пустое имя — null, а не пустая строка');
  assert.equal(parsed.jumpedAt, '2026-11-12T11:00:00.000Z');
  assert.equal(parsed.source, 'eddn');

  const junkSource = jumpRecordFromRow({ source: 'что-то' });
  assert.equal(junkSource.source, 'site', 'неизвестный источник — учёт сайта');
  assert.equal(junkSource.jumpedAt, '', 'без времени интерфейс покажет пусто');
  assert.equal(junkSource.from, '');
  assert.equal(junkSource.name, null);

  const summary = historySummaryFromJson({
    total: 12,
    carriers: 4,
    routes: 9,
    source_site: 7,
    source_eddn: 5,
    top: [
      { carrier_id: 1, callsign: 'AAA-111', name: null, jumps: 5 },
      { carrier_id: 2, callsign: null, name: 'Big Ship', jumps: 3 },
      { carrier_id: null, callsign: 'NO-ID', jumps: 2 },
    ],
  });
  assert.equal(summary.total, 12);
  assert.equal(summary.carriers, 4);
  assert.equal(summary.routes, 9);
  assert.deepEqual(summary.bySource, { site: 7, eddn: 5 });
  assert.equal(summary.top.length, 2, 'запись без носителя не показывается');
  assert.equal(summary.top[1].name, 'Big Ship');

  assert.deepEqual(historySummaryFromJson(null), EMPTY_HISTORY_SUMMARY);
  assert.deepEqual(historySummaryFromJson([]), EMPTY_HISTORY_SUMMARY);
  assert.equal(historySummaryFromJson({ total: 'семь' }).total, 0, 'мусор — ноль, а не NaN');
});

/* ── миграция: триггеры, бэкфилл и RPC на PostgreSQL ─────────────────────── */

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

-- Реестр уже знает след прошлого прыжка: миграция должна его перенести.
INSERT INTO public.carrier_directory(carrier_id, callsign, name, system_name, updated_at, previous_system_name, previous_at)
VALUES (3800000900, 'OLD-001', 'Ancient', 'Lave', '2026-11-11T12:00:00Z', 'Sol', '2026-11-11T02:00:00Z');
-- Пара без прыжка: стоянка не менялась, переносить нечего.
INSERT INTO public.carrier_directory(carrier_id, callsign, name, system_name, updated_at, previous_system_name, previous_at)
VALUES (3800000901, 'SAME-01', NULL, 'Sol', '2026-11-11T12:00:00Z', 'Sol', '2026-11-11T02:00:00Z');
`);

await db.exec(readFileSync(
  join(TEST_ROOT, 'supabase', 'migrations', '20261113120000_carrier_jump_history.sql'),
  'utf8',
));

async function historyRows(sql, params = []) {
  const { rows } = await db.query(sql, params);
  return rows;
}

test('миграция: бэкфилл переносит след прошлого прыжка из реестра, но не стоянку без смены', async () => {
  const rows = await historyRows(
    `SELECT carrier_id, callsign, from_system, to_system, source, jumped_at
       FROM public.carrier_jump_history ORDER BY carrier_id`,
  );
  assert.equal(rows.length, 1, 'ровно один прошлый прыжок');
  assert.equal(Number(rows[0].carrier_id), 3800000900);
  assert.equal(rows[0].from_system, 'Sol');
  assert.equal(rows[0].to_system, 'Lave');
  assert.equal(rows[0].source, 'eddn');
  assert.equal(new Date(rows[0].jumped_at).toISOString(), '2026-11-11T02:00:00.000Z',
    'время — наблюдение прежней стоянки, а не момент миграции');
});

test('триггер учёта сайта: смена системы пишет прыжок, время берётся из наблюдения', async () => {
  await db.exec(`INSERT INTO public.fleet_carriers(carrier_id, callsign, name, system_name, location_at)
    VALUES (3800000700, 'SITE-01', 'Site Ship', 'Sol', '2026-11-12T08:00:00Z')`);

  await db.exec(`UPDATE public.fleet_carriers
    SET system_name = 'Lave', location_at = '2026-11-12T09:00:00Z'
    WHERE carrier_id = 3800000700`);

  const rows = await historyRows(
    `SELECT callsign, name, from_system, to_system, source, jumped_at
       FROM public.carrier_jump_history WHERE carrier_id = 3800000700`,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].callsign, 'SITE-01');
  assert.equal(rows[0].name, 'Site Ship');
  assert.equal(rows[0].from_system, 'Sol');
  assert.equal(rows[0].to_system, 'Lave');
  assert.equal(rows[0].source, 'site');
  assert.equal(new Date(rows[0].jumped_at).toISOString(), '2026-11-12T09:00:00.000Z');

  // Тот же прыжок повторно (наблюдение обновилось, система та же) — не пишется.
  await db.exec(`UPDATE public.fleet_carriers SET location_at = '2026-11-12T09:10:00Z'
    WHERE carrier_id = 3800000700`);
  assert.equal((await historyRows(
    `SELECT 1 FROM public.carrier_jump_history WHERE carrier_id = 3800000700`,
  )).length, 1, 'смена только времени наблюдения — не прыжок');

  // Обратный прыжок в Sol — настоящее событие, а повторный прыжок в Lave через
  // полчаса — тот же самый: цель уже есть в пределах двух часов.
  await db.exec(`UPDATE public.fleet_carriers
    SET system_name = 'Sol', location_at = '2026-11-12T09:20:00Z' WHERE carrier_id = 3800000700`);
  await db.exec(`UPDATE public.fleet_carriers
    SET system_name = 'Lave', location_at = '2026-11-12T09:30:00Z' WHERE carrier_id = 3800000700`);
  const repeated = await historyRows(
    `SELECT to_system FROM public.carrier_jump_history
      WHERE carrier_id = 3800000700 ORDER BY jumped_at`,
  );
  assert.deepEqual(repeated.map((row) => row.to_system), ['Lave', 'Sol'],
    'тот же носитель и цель в пределах 2 часов — дубль');

  // Другая цель — другой прыжок.
  await db.exec(`UPDATE public.fleet_carriers
    SET system_name = 'Leesti', location_at = '2026-11-12T10:00:00Z' WHERE carrier_id = 3800000700`);
  const after = await historyRows(
    `SELECT to_system, jumped_at FROM public.carrier_jump_history
      WHERE carrier_id = 3800000700 ORDER BY jumped_at`,
  );
  assert.equal(after.length, 3);
  assert.equal(after[2].to_system, 'Leesti');
});

test('триггер EDDN: изменение реестра пишет прыжок с источником eddn', async () => {
  await db.exec(`INSERT INTO public.carrier_directory(carrier_id, callsign, name, system_name, updated_at)
    VALUES (3800000800, 'EDDN-01', NULL, 'Sol', '2026-11-12T08:00:00Z')`);

  await db.exec(`UPDATE public.carrier_directory
    SET system_name = 'Shinrarta Dezhra', updated_at = '2026-11-12T10:15:00Z'
    WHERE carrier_id = 3800000800`);

  const rows = await historyRows(
    `SELECT from_system, to_system, source, jumped_at, callsign
       FROM public.carrier_jump_history WHERE carrier_id = 3800000800`,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].from_system, 'Sol');
  assert.equal(rows[0].to_system, 'Shinrarta Dezhra');
  assert.equal(rows[0].source, 'eddn');
  assert.equal(rows[0].callsign, 'EDDN-01');
  assert.equal(new Date(rows[0].jumped_at).toISOString(), '2026-11-12T10:15:00.000Z');

  // Пустая система в реестре — не повод писать «прыжок в никуда».
  await db.exec(`UPDATE public.carrier_directory
    SET system_name = '   ', updated_at = '2026-11-12T10:30:00Z' WHERE carrier_id = 3800000800`);
  assert.equal((await historyRows(
    `SELECT 1 FROM public.carrier_jump_history WHERE carrier_id = 3800000800`,
  )).length, 1);
});

test('дедупликация: один прыжок из журнала и EDDN считается один раз', async () => {
  // Журнал записал прибытие в Lave в 11:00.
  await db.exec(`INSERT INTO public.fleet_carriers(carrier_id, callsign, system_name, location_at)
    VALUES (3800000850, 'BOTH-01', 'Sol', '2026-11-12T10:00:00Z')`);
  await db.exec(`UPDATE public.fleet_carriers SET system_name = 'Lave', location_at = '2026-11-12T11:00:00Z'
    WHERE carrier_id = 3800000850`);

  // EDDN увидел тот же прыжок на 25 минут позже.
  await db.exec(`INSERT INTO public.carrier_directory(carrier_id, callsign, system_name, updated_at)
    VALUES (3800000850, 'BOTH-01', 'Lave', '2026-11-12T11:25:00Z')`);
  await db.exec(`UPDATE public.carrier_directory SET previous_system_name = 'Sol', previous_at = '2026-11-12T10:00:00Z'
    WHERE carrier_id = 3800000850`);
  await db.exec(`UPDATE public.carrier_directory SET system_name = 'Leesti', updated_at = '2026-11-12T12:00:00Z'
    WHERE carrier_id = 3800000850`);

  const rows = await historyRows(
    `SELECT to_system, source FROM public.carrier_jump_history WHERE carrier_id = 3800000850 ORDER BY jumped_at`,
  );
  assert.equal(rows.length, 2, 'журнал (Lave) + EDDN (Leesti); Lave из EDDN — дубль');
  assert.equal(rows[0].to_system, 'Lave');
  assert.equal(rows[0].source, 'site');
  assert.equal(rows[1].to_system, 'Leesti');
  assert.equal(rows[1].source, 'eddn');
});

test('RPC корзин: гранулярность UTC и только строки после начала окна', async () => {
  const since = '2026-11-12T09:00:00Z';
  const byHour = await historyRows(
    `SELECT bucket, jumps FROM public.carrier_jump_history_buckets($1, 'hour') ORDER BY bucket`,
    [since],
  );
  assert.ok(byHour.length >= 2, 'несколько часовых корзин');
  for (const row of byHour) {
    const at = new Date(row.bucket);
    assert.equal(at.getUTCMinutes(), 0, 'граница часа');
    assert.equal(at.getUTCSeconds(), 0);
    assert.ok(at.toISOString() >= '2026-11-12T09:00:00.000Z', 'окно не раньше since');
    assert.ok(Number(row.jumps) > 0);
  }
  const totalHour = byHour.reduce((sum, row) => sum + Number(row.jumps), 0);
  const expected = Number((await historyRows(
    `SELECT count(*) AS n FROM public.carrier_jump_history WHERE jumped_at >= $1`, [since],
  ))[0].n);
  assert.equal(totalHour, expected, 'сумма корзин равна числу прыжков в окне');

  const byDay = await historyRows(
    `SELECT bucket FROM public.carrier_jump_history_buckets($1, 'day')`, [since],
  );
  for (const row of byDay) {
    const at = new Date(row.bucket);
    assert.equal(at.getUTCHours(), 0, 'граница суток — полночь UTC');
  }

  const byMonth = await historyRows(
    `SELECT bucket FROM public.carrier_jump_history_buckets($1, 'month')`, [since],
  );
  for (const row of byMonth) {
    assert.equal(new Date(row.bucket).getUTCDate(), 1, 'граница месяца — первое число');
  }

  // Пятиминутки — сетка от эпохи, шаг ровно 300 секунд.
  const byFive = await historyRows(
    `SELECT bucket FROM public.carrier_jump_history_buckets($1, '5min') ORDER BY bucket`, [since],
  );
  assert.ok(byFive.length > 0);
  for (const row of byFive) {
    assert.equal(new Date(row.bucket).getUTCSeconds(), 0);
    assert.equal(new Date(row.bucket).getUTCMinutes() % 5, 0, 'пятиминутная сетка');
  }
});

test('RPC сводки: всего, носителей, маршрутов, источники и топ', async () => {
  const since = '2026-11-12T00:00:00Z';
  const summary = (await historyRows(
    `SELECT public.carrier_jump_history_summary($1, 3) AS value`, [since],
  ))[0].value;

  const rows = await historyRows(
    `SELECT carrier_id, from_system, to_system, source FROM public.carrier_jump_history WHERE jumped_at >= $1`,
    [since],
  );
  assert.equal(summary.total, rows.length);
  assert.equal(summary.carriers, new Set(rows.map((row) => String(row.carrier_id))).size);
  assert.equal(summary.routes, new Set(rows.map((row) => `${row.from_system}→${row.to_system}`.toLowerCase())).size);
  assert.equal(summary.source_site, rows.filter((row) => row.source === 'site').length);
  assert.equal(summary.source_eddn, rows.filter((row) => row.source === 'eddn').length);
  assert.ok(Array.isArray(summary.top));
  assert.ok(summary.top.length <= 3, 'p_top соблюдается');
  const jumps = summary.top.map((item) => Number(item.jumps));
  assert.deepEqual(jumps, [...jumps].sort((a, b) => b - a), 'топ по убыванию');
  for (const item of summary.top) assert.ok(item.callsign, 'у топа есть позывной');

  const empty = (await historyRows(
    `SELECT public.carrier_jump_history_summary('2099-01-01T00:00:00Z', 3) AS value`,
  ))[0].value;
  assert.equal(empty.total, 0);
  assert.deepEqual(empty.top, []);
});

/* ── маршрут на PostgreSQL ───────────────────────────────────────────────── */

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
export * as history from '@/app/api/carriers/jumps/history/route';
export { state } from '@/lib/supabaseServer';
`;

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

async function api(url) {
  const response = await mod.history.GET(new Request(`http://localhost${url}`));
  const body = await response.json();
  return { response, body };
}

test('маршрут: период задаёт окно и число корзин, строки идут от свежих', async () => {
  const now = Date.now();
  const at = (minutesAgo) => new Date(now - minutesAgo * MINUTE).toISOString();
  // Фикстуры триггеров жили в тех же сутках: маршрут проверяем на чистом окне.
  await db.exec(`DELETE FROM public.carrier_jump_history;
    DELETE FROM public.fleet_carriers;
    DELETE FROM public.carrier_directory;`);
  await db.exec(`INSERT INTO public.fleet_carriers(carrier_id, callsign, name, system_name, location_at)
    VALUES
      (3800001001, 'API-001', 'Api One', 'Sol', '${at(200)}'),
      (3800001002, 'API-002', NULL, 'Sol', '${at(200)}'),
      (3800001003, 'API-003', 'Api Three', 'Sol', '${at(200)}')`);
  await db.exec(`UPDATE public.fleet_carriers SET system_name = 'Lave', location_at = '${at(40)}'
    WHERE carrier_id = 3800001001`);
  await db.exec(`UPDATE public.fleet_carriers SET system_name = 'Leesti', location_at = '${at(12)}'
    WHERE carrier_id = 3800001002`);
  await db.exec(`UPDATE public.fleet_carriers SET system_name = 'Lave', location_at = '${at(3)}'
    WHERE carrier_id = 3800001003`);

  const hour = await api('/api/carriers/jumps/history?period=1h');
  assert.equal(hour.response.status, 200);
  assert.equal(hour.response.headers.get('cache-control'), 'no-store');
  assert.equal(hour.body.period, '1h');
  assert.equal(hour.body.granularity, '5min');
  assert.equal(hour.body.chart.length, 12, '12 пятиминуток');
  assert.equal(hour.body.summary.total, 3);
  assert.equal(hour.body.jumps.length, 3);
  assert.equal(hour.body.total, 3);
  assert.equal(hour.body.truncated, false);
  const sum = hour.body.chart.reduce((total, bucket) => total + bucket.jumps, 0);
  assert.equal(sum, 3, 'сумма столбцов равна числу прыжков');
  for (const bucket of hour.body.chart) {
    assert.equal(Date.parse(bucket.start) % (5 * MINUTE), 0, 'границы пятиминуток');
  }
  const times = hour.body.jumps.map((row) => Date.parse(row.jumpedAt));
  assert.deepEqual(times, [...times].sort((a, b) => b - a), 'свежие сверху');
  assert.equal(hour.body.jumps[0].callsign, 'API-003');
  assert.equal(hour.body.jumps[0].to, 'Lave');
  assert.equal(hour.body.jumps[0].source, 'site');
  assert.deepEqual(hour.body.summary.bySource, { site: 3, eddn: 0 });
  assert.ok(hour.body.summary.top.length >= 1);

  const day = await api('/api/carriers/jumps/history?period=1d');
  assert.equal(day.body.period, '1d');
  assert.equal(day.body.granularity, 'hour');
  assert.equal(day.body.chart.length, 24);
  assert.equal(day.body.chart.reduce((total, bucket) => total + bucket.jumps, 0), 3);

  const month = await api('/api/carriers/jumps/history?period=1m');
  assert.equal(month.body.chart.length, 30);
  assert.equal(month.body.granularity, 'day');

  const year = await api('/api/carriers/jumps/history?period=1y');
  assert.equal(year.body.chart.length, 12);
  assert.equal(year.body.granularity, 'month');
  assert.ok(Date.parse(year.body.since) < now - 300 * DAY, 'год назад — не на этой неделе');

  // Неизвестный период не должен открывать «всё время».
  const fallback = await api('/api/carriers/jumps/history?period=all');
  assert.equal(fallback.body.period, '1d');
  assert.equal(fallback.body.chart.length, 24);
});

test('маршрут: поиск, ограничение выдачи и пустое окно', async () => {
  const found = await api('/api/carriers/jumps/history?period=1d&q=api-003');
  assert.equal(found.body.jumps.length, 1);
  assert.equal(found.body.jumps[0].callsign, 'API-003');
  assert.equal(found.body.summary.total, 3, 'сводка считается по всему окну, а не по найденному');

  const route = await api('/api/carriers/jumps/history?period=1d&q=lave');
  assert.equal(route.body.jumps.length, 2, 'поиск по системе назначения');

  const nothing = await api('/api/carriers/jumps/history?period=1d&q=zzz-nothing');
  assert.equal(nothing.body.jumps.length, 0);
  assert.equal(nothing.body.shown, 0);
  assert.equal(nothing.body.truncated, false);

  const limited = await api('/api/carriers/jumps/history?period=1d&limit=1');
  assert.equal(limited.body.jumps.length, 1);
  assert.equal(limited.body.shown, 1);
  assert.equal(limited.body.truncated, true, 'обрезанная выдача помечается');
  assert.equal(limited.body.total, 3, 'всего по-прежнему три');

  // Вчерашние прыжки не попадают в часовое окно.
  const hour = await api('/api/carriers/jumps/history?period=1h');
  assert.ok(hour.body.jumps.every((row) => Date.now() - Date.parse(row.jumpedAt) <= HOUR));
});

// Закрываем базу последним: в файле есть запросы и после импорта маршрута.
test.after(async () => { await db.close(); });
