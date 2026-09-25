/**
 * Запись в `colonisation_events` — устойчивый ключ состояния стройки.
 *
 * Таблицу кормят три клиента: браузерный загрузчик журнала, десктопный
 * Colonial Helper и синхронизация CAPI. Раньше каждый путь строил строки сам и
 * вставлял их своим способом, поэтому одни и те же события журнала попадали в
 * базу по несколько раз:
 *
 *   * `ColonisationContribution` пишется с пустым `construction_id`, а
 *     уникальный ключ схемы в PostgreSQL NULL'ы не сравнивает — ограничение
 *     такие строки не останавливало;
 *   * `ColonisationConstructionDepot` повторяется в журнале каждые несколько
 *     секунд с новой меткой времени, поэтому «ключ схемы + timestamp» считает
 *     повтором только полную копию строки, а не то же состояние стройки.
 *
 * Здесь закреплены: одинаковый отпечаток одного состояния из разных клиентов,
 * отсев повторов (в том числе внутри пачки) и поведение, пока миграция
 * `source_hash` не приехала на прод.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collapseRowsByHash,
  colonisationSourceHash,
  contributionEventRow,
  depotEventRow,
  depotStateFingerprint,
  latestDepotEvents,
  persistColonisationEvents,
  resetColonisationWriteMode,
  telemetryConstructionRow,
} from '../../src/lib/colonisationEvents.ts';

const TIMESTAMP = '2026-09-14T10:00:00Z';

/** Строка в формате Colonial Helper'а / браузерной телеметрии. */
const telemetryEvent = (overrides = {}) => ({
  timestamp: TIMESTAMP,
  system_name: 'Delta Velorum',
  market_id: 3951663874,
  construction_id: 1,
  construction_name: 'A 1',
  construction_progress: 0.5,
  resources_total: [
    { Name: '$steel_name;', Name_Localised: 'Steel', RequiredAmount: 5000, ProvidedAmount: 1200 },
  ],
  raw_event: { timestamp: TIMESTAMP, event: 'ColonisationConstructionDepot' },
  ...overrides,
});

/** То же событие после парсера сайта (`parseColonisationEvents`): проценты. */
const parsedDepot = (overrides = {}) => ({
  timestamp: TIMESTAMP,
  systemName: 'Delta Velorum',
  marketId: '3951663874',
  constructionName: 'A 1',
  constructionId: '1',
  constructionProgress: 50,
  resourcesRequired: [
    { name: '$steel_name;', nameLocalised: 'Сталь', requiredAmount: 5000, providedAmount: 1200, payment: 0 },
  ],
  ...overrides,
});

/* ── отпечаток ── */

test('одно состояние стройки из разных клиентов даёт один отпечаток', () => {
  const fromHelper = telemetryConstructionRow('user-1', telemetryEvent());
  const fromSite = depotEventRow('user-1', parsedDepot());

  assert.ok(fromHelper && fromSite);
  assert.equal(fromHelper.source_hash, fromSite.source_hash,
    'строки одного события разошлись по отпечаткам: в таблице появятся дубли');
  // И в колонках они тоже обязаны совпасть — по ним считают прогресс проекта.
  assert.equal(fromHelper.construction_progress, fromSite.construction_progress);
  assert.equal(fromHelper.market_id, fromSite.market_id);
  assert.equal(fromHelper.construction_id, fromSite.construction_id);
});

test('локальный язык журнала не влияет на отпечаток', () => {
  const english = telemetryConstructionRow('user-1', telemetryEvent());
  const russian = telemetryConstructionRow('user-1', telemetryEvent({
    resources_total: [
      { Name: '$steel_name;', Name_Localised: 'Сталь', RequiredAmount: 5000, ProvidedAmount: 1200 },
    ],
  }));

  assert.equal(english.source_hash, russian.source_hash,
    'перевод названия ресурса создал «новое» состояние стройки');
});

test('состояние стройки не зависит от метки времени, а вклад командира — зависит', () => {
  const first = telemetryConstructionRow('user-1', telemetryEvent());
  const later = telemetryConstructionRow('user-1', telemetryEvent({ timestamp: '2026-09-14T10:00:05Z' }));
  assert.equal(first.source_hash, later.source_hash, 'неизменившееся состояние снова считается новым');

  const changed = telemetryConstructionRow('user-1', telemetryEvent({ construction_progress: 0.52 }));
  assert.notEqual(first.source_hash, changed.source_hash, 'изменение прогресса потеряно');

  const contribution = (timestamp, amount) => contributionEventRow('user-1', {
    timestamp,
    systemName: 'Delta Velorum',
    marketId: '3951663874',
    commodity: 'steel',
    amount,
  });

  // Вклад — отдельный факт: два одинаковых вклада в разное время не повторы.
  assert.notEqual(contribution(TIMESTAMP, 100).source_hash, contribution('2026-09-14T10:05:00Z', 100).source_hash);
  // А повторная отправка той же строки журнала — повтор.
  assert.equal(contribution(TIMESTAMP, 100).source_hash, contribution(TIMESTAMP, 100).source_hash);
  assert.notEqual(contribution(TIMESTAMP, 100).source_hash, contribution(TIMESTAMP, 250).source_hash);
});

test('строки без системы или метки времени не строятся', () => {
  assert.equal(depotEventRow('user-1', parsedDepot({ systemName: '' })), null);
  assert.equal(depotEventRow('user-1', parsedDepot({ timestamp: '' })), null);
  assert.equal(telemetryConstructionRow('user-1', telemetryEvent({ system_name: '  ' })), null);
  assert.equal(telemetryConstructionRow('user-1', telemetryEvent({ timestamp: null })), null);
});

test('отпечаток состояния стройки различает изменения ресурсов', () => {
  const base = depotStateFingerprint(50, [{ name: 'steel', requiredAmount: 10, providedAmount: 1 }]);
  const provided = depotStateFingerprint(50, [{ name: 'steel', requiredAmount: 10, providedAmount: 2 }]);
  const required = depotStateFingerprint(50, [{ name: 'steel', requiredAmount: 20, providedAmount: 1 }]);
  assert.notEqual(base, provided);
  assert.notEqual(base, required);
  assert.equal(base, depotStateFingerprint(50, [{ name: 'steel', requiredAmount: 10, providedAmount: 1 }]));
});

test('повторы внутри пачки схлопываются до обращения к базе', () => {
  const rows = [
    telemetryConstructionRow('user-1', telemetryEvent()),
    telemetryConstructionRow('user-1', telemetryEvent({ timestamp: '2026-09-14T10:00:05Z' })),
    telemetryConstructionRow('user-1', telemetryEvent({ construction_progress: 0.9 })),
  ].filter(Boolean);

  const collapsed = collapseRowsByHash(rows);
  assert.equal(collapsed.rows.length, 2);
  assert.equal(collapsed.duplicates, 1);
});

test('latestDepotEvents оставляет последнее состояние каждой стройки', () => {
  const events = [
    { timestamp: '2026-09-14T10:00:00Z', systemName: 'Delta Velorum', constructionId: 1, constructionProgress: 10 },
    { timestamp: '2026-09-14T11:00:00Z', systemName: 'Delta Velorum', constructionId: 1, constructionProgress: 20 },
    { timestamp: '2026-09-14T10:30:00Z', systemName: 'Delta Velorum', constructionId: 2, constructionProgress: 5 },
    { timestamp: '2026-09-14T10:30:00Z', systemName: 'Sol', constructionId: 1, constructionProgress: 7 },
  ];

  const latest = latestDepotEvents(events);
  assert.equal(latest.length, 3);
  assert.equal(latest.find((event) => event.constructionId === 1 && event.systemName === 'Delta Velorum').constructionProgress, 20);
});

/* ── запись ── */

/**
 * Мок базы с уникальным ключом `(user_id, source_hash)`: повторная строка не
 * пишется и не возвращается (как `ON CONFLICT DO NOTHING ... RETURNING id`).
 */
function hashIndexClient() {
  const written = [];
  const hashes = new Set();
  return {
    written,
    client: {
      from: () => ({
        upsert: (rows) => ({
          select: async () => {
            const fresh = rows.filter((row) => !hashes.has(row.source_hash));
            for (const row of fresh) hashes.add(row.source_hash);
            written.push(...fresh);
            return {
              data: fresh.map((row, index) => ({ id: index + 1, source_hash: row.source_hash })),
              error: null,
            };
          },
        }),
      }),
    },
  };
}

test('повторное состояние не пишется второй раз', async () => {
  resetColonisationWriteMode();
  const { client, written } = hashIndexClient();

  const first = await persistColonisationEvents(client, [telemetryConstructionRow('user-1', telemetryEvent())]);
  const second = await persistColonisationEvents(client, [
    telemetryConstructionRow('user-1', telemetryEvent({ timestamp: '2026-09-14T10:00:05Z' })),
  ]);

  assert.equal(first.inserted, 1);
  assert.equal(first.duplicates, 0);
  assert.equal(second.inserted, 0, 'неизменившееся состояние стройки записано повторно');
  assert.equal(second.duplicates, 1, 'повтор не учтён в счётчике');
  assert.equal(written.length, 1);
  assert.equal(second.warnings.length, 0);
});

test('до миграции строки пишутся прежним путём, а не теряются', async () => {
  // Колонки `source_hash` на сервере ещё нет: первая же пачка получает 42703,
  // и запись обязана продолжиться без неё (rolling deploy).
  resetColonisationWriteMode();
  const written = [];
  const client = {
    from: () => ({
      upsert: (rows) => ({
        select: async () => {
          if (rows.some((row) => 'source_hash' in row)) {
            return { data: null, error: { code: '42703', message: 'column "source_hash" does not exist' } };
          }
          written.push(...rows);
          return { data: rows.map((_row, index) => ({ id: index + 1 })), error: null };
        },
      }),
    }),
  };

  const outcome = await persistColonisationEvents(client, [
    telemetryConstructionRow('user-1', telemetryEvent()),
    telemetryConstructionRow('user-1', telemetryEvent({ construction_progress: 0.9 })),
  ]);

  assert.equal(written.length, 2, 'строки не записаны без колонки source_hash');
  assert.equal(outcome.inserted, 2);
  assert.ok(outcome.warnings.some((w) => /source_hash/.test(w)), 'деградация записи не видна в warnings');
});

test('когда колонка есть, а индекса нет — пишется только недостающее', async () => {
  resetColonisationWriteMode();
  const existing = telemetryConstructionRow('user-1', telemetryEvent());
  const rows = [];   // «таблица»: там уже лежит одна строка
  const inserted = [];

  const conflict = (candidate) => rows.some((row) =>
    row.user_id === candidate.user_id && row.source_hash === candidate.source_hash);

  const client = {
    from: () => ({
      select: () => {
        const filters = { userId: null, hashes: [] };
        const api = {
          eq: (column, value) => { if (column === 'user_id') filters.userId = value; return api; },
          not: () => api,
          in: (column, values) => { if (column === 'source_hash') filters.hashes = values; return api; },
          then: (resolve) => resolve({
            data: rows.filter((row) => row.user_id === filters.userId && filters.hashes.includes(row.source_hash)),
            error: null,
          }),
        };
        return api;
      },
      // Вставка без конфликтного ключа — путь «колонка есть, индекса нет»:
      // строки, которые уже лежат в таблице, туда не должны попадать вовсе
      // (их отфильтровала сверка выше), остальные вставляются.
      insert: (payload) => ({
        select: async () => {
          const fresh = payload.filter((row) => !conflict(row));
          for (const row of fresh) rows.push(row);
          inserted.push(...fresh);
          return { data: fresh.map((_row, index) => ({ id: index + 1, source_hash: _row.source_hash })), error: null };
        },
      }),
      upsert: (payload, options) => ({
        select: async () => {
          if (options.onConflict === 'user_id,source_hash') {
            return {
              data: null,
              error: {
                code: '42P10',
                message: 'there is no unique or exclusion constraint matching the ON CONFLICT specification',
              },
            };
          }
          const fresh = payload.filter((row) => !conflict(row));
          for (const row of fresh) rows.push(row);
          inserted.push(...fresh);
          return { data: fresh.map((_row, index) => ({ id: index + 1, source_hash: _row.source_hash })), error: null };
        },
      }),
    }),
  };

  rows.push({ ...existing });

  const outcome = await persistColonisationEvents(client, [
    telemetryConstructionRow('user-1', telemetryEvent()),
    telemetryConstructionRow('user-1', telemetryEvent({ construction_progress: 0.9 })),
  ]);

  assert.equal(inserted.length, 1, 'записано то, что уже было в таблице');
  assert.equal(outcome.inserted, 1);
  assert.equal(outcome.duplicates, 1);
  assert.ok(outcome.warnings.some((w) => /без source_hash/.test(w)), 'режим без индекса не виден в warnings');
});

test('таймаут базы делит пачку, а не теряет её', async () => {
  resetColonisationWriteMode();
  const written = [];
  const client = {
    from: () => ({
      upsert: (rows) => ({
        select: async () => {
          if (rows.length > 2) {
            return { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } };
          }
          written.push(...rows);
          return { data: rows.map((row, index) => ({ id: index + 1, source_hash: row.source_hash })), error: null };
        },
      }),
    }),
  };

  const rows = Array.from({ length: 6 }, (_unused, index) => telemetryConstructionRow('user-1', telemetryEvent({
    construction_id: index + 1,
    construction_progress: 0.1 * (index + 1),
  })));

  const outcome = await persistColonisationEvents(client, rows);
  assert.equal(outcome.inserted, 6, 'часть строк потеряна при таймауте');
  assert.equal(written.length, 6);
  assert.equal(outcome.warnings.length, 0);
});

test('ошибка записи попадает в warnings, а не роняет импорт', async () => {
  resetColonisationWriteMode();
  const client = {
    from: () => ({
      upsert: () => ({ select: async () => ({ data: null, error: { message: 'permission denied' } }) }),
    }),
  };

  const outcome = await persistColonisationEvents(client, [telemetryConstructionRow('user-1', telemetryEvent())]);
  assert.equal(outcome.inserted, 0);
  assert.equal(outcome.warnings.length, 1);
  assert.match(outcome.warnings[0], /permission denied/);
});

test('отпечаток версионирован: смена формулы видна в самом ключе', () => {
  const hash = colonisationSourceHash({
    eventKind: 'ColonisationConstructionDepot',
    systemName: 'Delta Velorum',
    marketId: 1,
    constructionId: 2,
    progress: 50,
    resources: [],
  });
  assert.match(hash, /^colony-v\d+-/);
});
