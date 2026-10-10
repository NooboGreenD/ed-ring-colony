/**
 * Защита источника сводки пилота и единое слияние статистики досье.
 *
 * Что закрепляется:
 *
 *  1. `persistJournalTelemetry` с `source: 'helper'` НЕ перетирает строку
 *     `pilot_stats`, последним источником которой была загрузка журналов на
 *     сайте (`stats_source = 'web'`) — данные программы не задают данные
 *     с логов, загруженных через сайт.
 *  2. Запись от сайта всегда принимается и снимает защиту; запись самой
 *     программы помечается `stats_source = 'helper'`.
 *  3. На отставшей схеме (нет колонки `stats_source`) защита не мешает записи.
 *  4. `mergePilotStats` — единое для `/api/cmdr/stats` и `/cmdr/[name]`
 *     слияние: ранги и положение берутся из `pilot_stats` с fallback на
 *     `capi_profiles`, счётчики — максимум из источников.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { persistJournalTelemetry } from '../../src/lib/journalTelemetry.ts';
import { mergePilotStats } from '../../src/lib/pilotDossier.ts';

/* ── заглушка Supabase ─────────────────────────────────────────────── */

function statsStoreStub({ stored = null, selectError = null } = {}) {
  const upserts = [];
  const state = { row: stored };
  return {
    upserts,
    state,
    from(table) {
      assert.equal(table, 'pilot_stats');
      return {
        select() {
          return {
            eq() {
              return {
                maybeSingle: async () => (
                  selectError
                    ? { data: null, error: { message: selectError } }
                    : { data: state.row, error: null }
                ),
              };
            },
          };
        },
        upsert(row) {
          upserts.push(row);
          state.row = { ...(state.row ?? {}), ...row };
          return Promise.resolve({ error: null });
        },
      };
    },
  };
}

const PAYLOAD = { pilotStats: { credits: 777, mercenary_rank: 4, bio_samples_count: 9 } };

/* ── защита источника ──────────────────────────────────────────────── */

test('программа не перетирает сводку, загруженную через сайт', async () => {
  const svc = statsStoreStub({ stored: { user_id: 'u1', credits: 555, stats_source: 'web' } });
  const outcome = await persistJournalTelemetry(svc, 'u1', PAYLOAD, 'Cmdr Web', { source: 'helper' });

  assert.equal(outcome.pilotStatsUpdated, false);
  assert.equal(outcome.pilotStatsSkipped, 'web_source');
  assert.equal(svc.upserts.length, 0, 'записи в pilot_stats не было вовсе');
  assert.equal(svc.state.row.credits, 555, 'данные сайта на месте');
  assert.match(outcome.warnings.join(' '), /защищена загрузкой журналов на сайте/);
});

test('программа пишет сводку, если последним источником была она сама', async () => {
  const svc = statsStoreStub({ stored: { user_id: 'u1', credits: 100, stats_source: 'helper' } });
  const outcome = await persistJournalTelemetry(svc, 'u1', PAYLOAD, 'Cmdr Helper', { source: 'helper' });

  assert.equal(outcome.pilotStatsUpdated, true);
  assert.equal(outcome.pilotStatsSkipped, null);
  assert.equal(svc.upserts.length, 1);
  assert.equal(svc.state.row.credits, 777);
  assert.equal(svc.state.row.stats_source, 'helper');
  assert.ok(svc.state.row.stats_source_at, 'метка времени источника записана');
});

test('программа пишет сводку, если у строки нет источника (старая запись)', async () => {
  const svc = statsStoreStub({ stored: { user_id: 'u1', credits: 100 } });
  const outcome = await persistJournalTelemetry(svc, 'u1', PAYLOAD, 'Cmdr Old', { source: 'helper' });

  assert.equal(outcome.pilotStatsUpdated, true);
  assert.equal(svc.state.row.credits, 777);
  assert.equal(svc.state.row.stats_source, 'helper');
});

test('сайт всегда пишет и снимает защиту', async () => {
  const svc = statsStoreStub({ stored: { user_id: 'u1', credits: 100, stats_source: 'helper' } });
  const outcome = await persistJournalTelemetry(svc, 'u1', PAYLOAD, 'Cmdr Web', { source: 'web' });

  assert.equal(outcome.pilotStatsUpdated, true);
  assert.equal(outcome.pilotStatsSkipped, null);
  assert.equal(svc.state.row.credits, 777);
  assert.equal(svc.state.row.stats_source, 'web');
});

test('повторная загрузка через сайт обновляет защищённую строку', async () => {
  const svc = statsStoreStub({ stored: { user_id: 'u1', credits: 100, stats_source: 'web' } });
  const outcome = await persistJournalTelemetry(
    svc,
    'u1',
    { pilotStats: { credits: 999 } },
    'Cmdr Web',
    { source: 'web' },
  );

  assert.equal(outcome.pilotStatsUpdated, true);
  assert.equal(svc.state.row.credits, 999);
});

test('защита не действует, пока в базе нет источника (записи до миграции)', async () => {
  const svc = statsStoreStub({ stored: null });
  const outcome = await persistJournalTelemetry(svc, 'u1', PAYLOAD, 'Cmdr New', { source: 'helper' });

  assert.equal(outcome.pilotStatsUpdated, true);
  assert.equal(svc.state.row.credits, 777);
});

test('отставшая схема (нет колонки stats_source) не роняет запись программы', async () => {
  // Чтение источника падает с PGRST204 — защита не должна мешать записи,
  // а upsert без stats_source* тоже не должен падать (resilient-запись).
  const svc = statsStoreStub({
    stored: { user_id: 'u1', credits: 100 },
    selectError: "Could not find the 'stats_source' column of 'pilot_stats' in the schema cache",
  });
  const outcome = await persistJournalTelemetry(svc, 'u1', PAYLOAD, 'Cmdr Helper', { source: 'helper' });

  assert.equal(outcome.pilotStatsUpdated, true);
  assert.equal(outcome.pilotStatsSkipped, null);
  assert.equal(svc.state.row.credits, 777);
});

test('без источника (старый вызов) запись ведёт себя как раньше', async () => {
  const svc = statsStoreStub();
  const outcome = await persistJournalTelemetry(svc, 'u1', PAYLOAD, 'Cmdr Legacy');

  assert.equal(outcome.pilotStatsUpdated, true);
  assert.equal(svc.upserts.length, 1);
  assert.equal(svc.upserts[0].stats_source, undefined, 'источник не навязывается старым клиентам');
  assert.equal(svc.upserts[0].credits, 777);
});

test('мусорные «монеты наёмников» не пишутся и при защите источника', async () => {
  const svc = statsStoreStub();
  const outcome = await persistJournalTelemetry(
    svc,
    'u1',
    { pilotStats: { credits: 5, mercenary_coins: 943153188 } },
    'Cmdr',
    { source: 'helper' },
  );

  assert.equal(outcome.pilotStatsUpdated, true);
  assert.equal(svc.state.row.mercenary_coins, undefined);
  assert.equal(svc.state.row.credits, 5);
});

/* ── единое слияние статистики досье ───────────────────────────────── */

test('слияние: ранги и положение из pilot_stats, если capi_profiles пуст', () => {
  const merged = mergePilotStats({
    pilotStats: {
      credits: 1000,
      combat_rank: 8,
      trade_rank: 3,
      current_ship: 'Python (Mule)',
      current_system: 'Colonia',
      current_station: 'Jaques Station',
      first_discoveries_count: 40,
      bio_value_cr: 500,
      exploration_stats: { efficiency: 90 },
    },
    capiProfile: null,
  });

  assert.equal(merged.combat_rank, 8);
  assert.equal(merged.trade_rank, 3);
  assert.equal(merged.current_ship, 'Python (Mule)');
  assert.equal(merged.current_system, 'Colonia');
  assert.equal(merged.current_station, 'Jaques Station');
  assert.equal(merged.credits, 1000);
  assert.deepEqual(merged.exploration_stats, { efficiency: 90 });
});

test('слияние: fallback на capi_profiles, когда в pilot_stats нет данных', () => {
  const merged = mergePilotStats({
    pilotStats: { credits: 1000 },
    capiProfile: {
      credits: 4200000,
      combat_rank: 5,
      explore_rank: 6,
      empire_rank: 2,
      federation_rank: 1,
      current_ship: 'Mule',
      current_system: 'Sol',
      current_station: null,
      exploration_stats: { systems_scanned: 10 },
    },
  });

  // Кредиты: приоритет у pilot_stats (как в прежнем /api/cmdr/stats).
  assert.equal(merged.credits, 1000);
  assert.equal(merged.combat_rank, 5);
  assert.equal(merged.explore_rank, 6);
  assert.equal(merged.empire_rank, 2);
  assert.equal(merged.federation_rank, 1);
  assert.equal(merged.current_ship, 'Mule');
  assert.equal(merged.current_system, 'Sol');
  assert.equal(merged.current_station, null);
  assert.deepEqual(merged.exploration_stats, { systems_scanned: 10 });
});

test('слияние: счётчики — максимум из таблиц и прямого подсчёта по сканам', () => {
  const merged = mergePilotStats({
    pilotStats: { first_discoveries_count: 40, first_mapped_count: 12, bio_samples_count: 7 },
    capiProfile: { first_discoveries_count: 55, first_mapped_count: 3, bio_samples_count: 2 },
    firstDiscoveredCount: 61,
    firstMappedCount: 20,
  });

  assert.equal(merged.first_discoveries_count, 61);
  assert.equal(merged.first_mapped_count, 20);
  assert.equal(merged.bio_samples_count, 7);
});

test('слияние: exploration_stats склеивается, приоритет у pilot_stats', () => {
  const merged = mergePilotStats({
    pilotStats: { exploration_stats: { efficiency: 90, highest_payout: 5 } },
    capiProfile: { exploration_stats: { efficiency: 10, systems_scanned: 3 } },
  });

  assert.deepEqual(merged.exploration_stats, { efficiency: 90, highest_payout: 5, systems_scanned: 3 });
});

test('слияние: пустые входы дают нули, а не undefined', () => {
  const merged = mergePilotStats({ pilotStats: null, capiProfile: null });

  assert.equal(merged.credits, 0);
  assert.equal(merged.combat_rank, 0);
  assert.equal(merged.current_ship, null);
  assert.equal(merged.first_discoveries_count, 0);
  assert.deepEqual(merged.exploration_stats, {});
  assert.equal(merged.last_updated, null);
});

test('слияние: имя из запроса имеет приоритет над именами таблиц', () => {
  const merged = mergePilotStats({
    cmdrName: 'Cmdr From Query',
    pilotStats: { cmdr_name: 'Stats Name' },
    capiProfile: { cmdr_name: 'Capi Name' },
  });
  assert.equal(merged.cmdr_name, 'Cmdr From Query');
});
