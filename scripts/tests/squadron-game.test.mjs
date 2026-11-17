import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSquadronReport,
  pilotGameSquadronFromProfile,
  squadronReportFromEvent,
} from '../../src/lib/squadronGame.ts';
import { TelemetryCollector, parseJournalTelemetry } from '../../src/lib/journalTelemetry.ts';

/* Эскадрилья пилота из журнала игры: разбор событий `SquadronStartup` /
   `SquadronPromotion`, состояние «одно на пилота» и его форма для профиля.
   Раскладка по профилю/составу — в БД (squadron-journal-db.test.mjs),
   приём от Helper'а — squadron-route.test.mjs. */

test('SquadronStartup даёт ID, имя и ранг', () => {
  const report = squadronReportFromEvent({
    timestamp: '2026-11-10T18:00:00Z',
    event: 'SquadronStartup',
    SquadronID: 75645,
    SquadronName: 'ENDURANCE EXPLORATION',
    CurrentRank: 4,
  });
  assert.deepEqual(report, {
    gameSquadronId: 75645,
    gameSquadronName: 'ENDURANCE EXPLORATION',
    gameRank: 4,
    gameRankName: null,
    eventAt: '2026-11-10T18:00:00.000Z',
  });
});

test('SquadronPromotion берёт ранг из NewRank, а не из CurrentRank', () => {
  const report = squadronReportFromEvent({
    timestamp: '2026-11-11T10:00:00Z',
    event: 'SquadronPromotion',
    SquadronID: 75645,
    SquadronName: 'ENDURANCE EXPLORATION',
    OldRank: 3,
    NewRank: 5,
    CurrentRank: 3,
  });
  assert.equal(report.gameRank, 5);
});

test('без SquadronID отчёта нет: это не эскадрилья, а мусор', () => {
  assert.equal(squadronReportFromEvent({ event: 'SquadronStartup', SquadronName: 'X' }), null);
  assert.equal(squadronReportFromEvent({ event: 'FSDJump', SquadronID: 1 }), null);
  assert.equal(squadronReportFromEvent({ event: 'SquadronStartup', SquadronID: 0 }), null);
});

test('ранг «-1» (ещё нет ранга) и мусорные значения не сохраняются', () => {
  for (const rank of [-1, 999, 'staff', null]) {
    const report = squadronReportFromEvent({
      event: 'SquadronStartup', SquadronID: 42, SquadronName: 'X', CurrentRank: rank,
    });
    assert.equal(report.gameRank, null, `ранг ${rank} не должен попасть в отчёт`);
  }
  // 0 — законный низший ранг.
  assert.equal(squadronReportFromEvent({ event: 'SquadronStartup', SquadronID: 42, CurrentRank: 0 }).gameRank, 0);
});

test('поля в snake_case и camelCase понимаются одинаково', () => {
  const snake = parseSquadronReport({
    game_squadron_id: 7, game_squadron_name: ' Wing ', game_squadron_rank: 2, event_at: '2026-01-01T00:00:00Z',
  });
  const camel = parseSquadronReport({
    gameSquadronId: '7', gameSquadronName: ' Wing ', gameSquadronRank: '2', eventAt: '2026-01-01T00:00:00Z',
  });
  assert.deepEqual(snake, camel);
  assert.equal(snake.gameSquadronName, 'Wing', 'пробелы по краям обрезаются');
});

test('битое время события не роняет разбор', () => {
  const report = parseSquadronReport({ game_squadron_id: 3, event_at: 'не дата' });
  assert.equal(report.eventAt, null);
  assert.equal(report.gameSquadronId, 3);
});

test('из журнала берётся самое свежее событие, история его не перетирает', () => {
  const collector = new TelemetryCollector();
  const lines = [
    { timestamp: '2026-11-01T10:00:00Z', event: 'SquadronStartup', SquadronID: 1, SquadronName: 'OLD', CurrentRank: 1 },
    { timestamp: '2026-11-10T10:00:00Z', event: 'SquadronStartup', SquadronID: 2, SquadronName: 'NEW', CurrentRank: 3 },
    // Старый файл прочитан позже — состояние не должно откатиться.
    { timestamp: '2026-10-01T10:00:00Z', event: 'SquadronStartup', SquadronID: 1, SquadronName: 'OLD', CurrentRank: 1 },
    { timestamp: '2026-11-11T10:00:00Z', event: 'SquadronPromotion', SquadronID: 2, SquadronName: 'NEW', NewRank: 4 },
  ];
  for (const event of lines) collector.feed(JSON.stringify(event), event);
  const telemetry = collector.finish();
  assert.equal(telemetry.squadron.gameSquadronId, 2);
  assert.equal(telemetry.squadron.gameSquadronName, 'NEW');
  assert.equal(telemetry.squadron.gameRank, 4);
});

test('журнал без эскадрильи не выдумывает её', () => {
  const text = [
    JSON.stringify({ timestamp: '2026-11-01T10:00:00Z', event: 'LoadGame', Commander: 'Nova' }),
    JSON.stringify({ timestamp: '2026-11-01T10:01:00Z', event: 'FSDJump', StarSystem: 'Sol' }),
  ].join('\n');
  const telemetry = parseJournalTelemetry(text);
  assert.equal(telemetry.squadron, null);
  assert.equal(telemetry.cmdrName, 'Nova');
});

test('состояние профиля приводится к одной форме, отсутствие данных — null', () => {
  assert.deepEqual(pilotGameSquadronFromProfile(null), {
    gameSquadronId: null,
    gameSquadronName: null,
    gameRank: null,
    gameRankName: null,
    syncedAt: null,
    siteSquadronId: null,
    siteSquadronName: null,
    source: null,
  });
  const row = pilotGameSquadronFromProfile({
    game_squadron_id: '75645',
    game_squadron_name: '  ENDURANCE EXPLORATION ',
    game_squadron_rank: 4,
    game_squadron_rank_name: 'Офицер',
    game_squadron_at: '2026-11-10T18:00:00Z',
    game_squadron_site_id: 12,
    game_squadron_source: 'helper',
  });
  assert.equal(row.gameSquadronId, 75645);
  assert.equal(row.gameSquadronName, 'ENDURANCE EXPLORATION');
  assert.equal(row.gameRank, 4);
  assert.equal(row.gameRankName, 'Офицер');
  assert.equal(row.siteSquadronId, 12);
  assert.equal(row.source, 'helper');
});
