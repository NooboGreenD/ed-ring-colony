/**
 * Минорные фракции (вкладка «Фракции» Atlas): чистые функции.
 *
 *   * `bgs.ts` — приведение названий журнала и EDSM к одному виду, формат
 *     слоя карты и его разбор, ответы поиска / присутствия / карточки,
 *     выбранные фракции, точки карты (цвет, форма, фон), фильтр;
 *   * `bgsDump.ts` — строки дампа EDSM `systemsPopulated` (обрезка станций и
 *     тел, id64 шире 2^53, контролирующая фракция без списка, битые строки);
 *   * `bgsJournal.ts` — проекция FSDJump / Location / CarrierJump совпадает с
 *     эталоном, с которым сверяется и Colonial Helper (uploader/bgs_sync.py),
 *     и наблюдение системы из неё;
 *   * `bgsProgress.ts` — этапы, проценты, журнал.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BGS_ALLEGIANCE_COLOR,
  BGS_MAX_SELECTED,
  BGS_POINT_SIZE,
  BGS_SELECTION_COLORS,
  DEFAULT_BGS_FILTER,
  bgsAge,
  buildBgsMapPoints,
  countBgsAllegiances,
  decodeBgsLayer,
  decodeFactionPresence,
  decodeFactionSearch,
  decodeSystemDetail,
  encodeBgsLayer,
  filterBgsSystems,
  formatInfluence,
  formatPopulation,
  id64FromAny,
  nextSelectionColor,
  normalizeAllegiance,
  normalizeEconomy,
  normalizeGovernment,
  normalizeHappiness,
  normalizeInfluence,
  normalizeSecurity,
  normalizeState,
  normalizeStateList,
  observationTime,
  orderBgsPoints,
  parseBgsFilter,
  parseBgsSelection,
  searchBgsSystems,
  snapshotToRpcRow,
  soloAllegiance,
  stateLabel,
  toggleAllegiance,
} from '../../src/lib/bgs.ts';
import { BgsDumpCounter, edsmPopulatedRecord, parseEdsmPopulatedLine, trimEdsmPopulatedLine } from '../../src/lib/bgsDump.ts';
import { BGS_FACTION_FIELDS, BGS_SYSTEM_FIELDS, BgsSnapshotCollector, journalEventToSnapshot, projectBgsEvent } from '../../src/lib/bgsJournal.ts';
import {
  BGS_SYNC_STAGES,
  computeBgsPercent,
  createBgsProgress,
  finishBgsProgress,
  finishBgsStage,
  formatBgsDuration,
  publicBgsProgress,
  pushBgsLog,
  sanitizeBgsLog,
  sanitizeBgsProgress,
  startBgsStage,
  updateBgsStage,
} from '../../src/lib/bgsProgress.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const FIXTURES = join(ROOT, 'scripts', 'tests', 'fixtures');
const NOW = Date.parse('2026-10-18T12:00:00Z');

/* ── Справочники ───────────────────────────────────────────────────────── */

test('названия журнала и EDSM приводятся к одним ключам', () => {
  assert.equal(normalizeAllegiance('Federation'), 'Federation');
  assert.equal(normalizeAllegiance('Pilots Federation'), 'PilotsFederation');
  assert.equal(normalizeAllegiance('PilotsFederation'), 'PilotsFederation');
  assert.equal(normalizeAllegiance(''), 'None');
  assert.equal(normalizeAllegiance(null), 'None');
  assert.equal(normalizeAllegiance('$faction_Empire;'), 'None', 'неизвестное — без принадлежности');

  assert.equal(normalizeGovernment('$government_Corporate;'), 'Corporate');
  assert.equal(normalizeGovernment('Prison colony'), 'PrisonColony');
  assert.equal(normalizeGovernment('$government_PrisonColony;'), 'PrisonColony');
  assert.equal(normalizeGovernment('$government_Carrier;'), 'PrivateOwnership');
  assert.equal(normalizeGovernment('$government_Futuristic;'), 'Futuristic', 'неизвестное сохраняется как есть');
  assert.equal(normalizeGovernment(''), null);

  assert.equal(normalizeEconomy('$economy_HighTech;'), 'HighTech');
  assert.equal(normalizeEconomy('High Tech'), 'HighTech');
  assert.equal(normalizeEconomy('$economy_Agri;'), 'Agriculture');
  assert.equal(normalizeEconomy('Agriculture'), 'Agriculture');
  assert.equal(normalizeEconomy('$economy_Colony;'), 'Colony');

  assert.equal(normalizeSecurity('$SYSTEM_SECURITY_medium;'), 'Medium');
  assert.equal(normalizeSecurity('$GAlAXY_MAP_INFO_state_anarchy;'), 'Anarchy');
  assert.equal(normalizeSecurity('$GALAXY_MAP_INFO_state_lawless;'), 'Lawless');
  assert.equal(normalizeSecurity('High'), 'High');

  assert.equal(normalizeState('CivilWar'), 'CivilWar');
  assert.equal(normalizeState('Civil war'), 'CivilWar');
  assert.equal(normalizeState('Terrorist Attack'), 'Terrorism');
  assert.equal(normalizeState('None'), 'None');
  assert.equal(stateLabel('CivilWar'), 'Гражданская война');
  assert.deepEqual(normalizeStateList([{ State: 'Boom' }, { state: 'Civil unrest' }, 'War', { State: 'None' }, { State: 'Boom' }]), ['Boom', 'CivilUnrest', 'War']);

  assert.equal(normalizeHappiness('$Faction_HappinessBand1;'), 'Elated');
  assert.equal(normalizeHappiness('$Faction_HappinessBand5;'), 'Despondent');
  assert.equal(normalizeHappiness('Happy'), 'Happy');
  assert.equal(normalizeHappiness(''), null);

  assert.equal(normalizeInfluence(0.4526), 0.4526);
  assert.equal(normalizeInfluence(45.26), 0.4526, 'проценты → доля');
  assert.equal(normalizeInfluence(-1), null);
  assert.equal(normalizeInfluence(150), null);
  assert.equal(normalizeInfluence('0.5'), 0.5);
});

test('id64 и время наблюдения: без потери разрядов и без будущего', () => {
  assert.equal(id64FromAny('36028797018963971'), '36028797018963971');
  assert.equal(id64FromAny(10477373803), '10477373803');
  assert.equal(id64FromAny(2 ** 60), null, 'небезопасное число не принимается');
  assert.equal(id64FromAny('0'), null);
  assert.equal(id64FromAny('9223372036854775808'), null, 'шире bigint');
  assert.equal(id64FromAny('abc'), null);
  assert.equal(observationTime('2026-10-17T10:00:00Z', NOW), '2026-10-17T10:00:00.000Z');
  assert.equal(observationTime('2026-10-18T12:10:00Z', NOW), '2026-10-18T12:10:00.000Z', 'часы пилота могут спешить');
  assert.equal(observationTime('2026-10-19T12:00:00Z', NOW), null, 'сутки вперёд — нет');
  assert.equal(observationTime('2010-01-01T00:00:00Z', NOW), null);
  assert.equal(observationTime('garbage', NOW), null);
});

/* ── Дамп EDSM ─────────────────────────────────────────────────────────── */

const BODY = JSON.stringify({ id: 1, id64: 99, bodyId: 0, name: 'Big Body', type: 'Star', rings: [{ name: 'x' }], updateTime: '2020-01-01 00:00:00' });
const STATION = JSON.stringify({ id: 5, marketId: 3229189888, type: 'Outpost', name: 'Hangar', controllingFaction: { id: 1, name: 'Elsewhere' }, updateTime: { information: '2017-11-07 10:08:35' } });

/** Строка дампа как у EDSM: id64 печатается числом без кавычек (в тесте он строкой, чтобы не терять разряды). */
function edsmLine(record, { stations = [STATION], bodies = [BODY] } = {}) {
  const head = JSON.stringify(record).replace(/"id64":"(\d+)"/, '"id64":$1').slice(0, -1);
  return `    ${head},"stations":[${stations.join(',')}],"bodies":[${bodies.join(',')}],"date":"2026-10-15 08:00:00"}`;
}

const SYSTEM_RECORD = {
  id: 8713,
  id64: '36028797018963971',
  name: '4 Sextantis',
  coords: { x: 87.25, y: 96.84375, z: -65 },
  allegiance: 'Federation',
  government: 'Corporate',
  state: 'Boom',
  economy: 'High Tech',
  security: 'Low',
  population: 14455,
  controllingFaction: { id: 13949, name: '4 Sextantis Inc', allegiance: 'Federation', government: 'Corporate', isPlayer: false },
  factions: [
    { id: 13949, name: '4 Sextantis Inc', allegiance: 'Federation', government: 'Corporate', influence: 0.612, state: 'Boom',
      activeStates: [{ state: 'Boom' }], recoveringStates: [{ state: 'Civil war', trend: 0 }], pendingStates: [],
      happiness: 'Happy', isPlayer: false, lastUpdate: 1792040000 },
    { id: 777, name: 'Brave Pilots Union', allegiance: 'Independent', government: 'Cooperative', influence: 0.388, state: 'None',
      activeStates: [], recoveringStates: [], pendingStates: [{ state: 'Expansion', trend: 1 }], happiness: 'Discontented',
      isPlayer: true, lastUpdate: 1792050000 },
  ],
};

test('строка дампа EDSM: станции и тела обрезаются, id64 шире 2^53 — из текста', () => {
  const line = edsmLine(SYSTEM_RECORD);
  const trimmed = trimEdsmPopulatedLine(line.trim());
  assert.ok(!trimmed.includes('"stations"') && !trimmed.includes('"bodies"'), 'обрезано');
  assert.ok(trimmed.endsWith('"date":"2026-10-15 08:00:00"}'));

  const result = parseEdsmPopulatedLine(`${line},`);
  assert.equal(result.kind, 'system');
  const s = result.snapshot;
  assert.equal(s.id64, '36028797018963971', 'id64 без потери разрядов');
  assert.equal(s.name, '4 Sextantis');
  assert.deepEqual([s.x, s.y, s.z], [87.25, 96.84375, -65]);
  assert.equal(s.allegiance, 'Federation');
  assert.equal(s.government, 'Corporate');
  assert.equal(s.economy, 'HighTech');
  assert.equal(s.security, 'Low');
  assert.equal(s.state, 'Boom');
  assert.equal(s.population, 14455);
  assert.equal(s.controlling, '4 Sextantis Inc');
  assert.equal(s.observedAt, new Date(1792050000 * 1000).toISOString(), 'наблюдение — самое свежее обновление влияния');
  assert.equal(s.factions.length, 2);
  assert.deepEqual(s.factions[0], {
    name: '4 Sextantis Inc', allegiance: 'Federation', government: 'Corporate', isPlayer: false, edsmId: 13949, influence: 0.612,
    state: 'Boom', activeStates: ['Boom'], pendingStates: [], recoveringStates: ['CivilWar'], happiness: 'Happy',
  });
  assert.equal(s.factions[1].isPlayer, true);
  assert.deepEqual(s.factions[1].pendingStates, ['Expansion']);

  const row = snapshotToRpcRow(s);
  assert.equal(row.id64, '36028797018963971');
  assert.equal(row.second_economy, null);
  assert.equal(row.factions[1].is_player, true);
  assert.equal(row.factions[0].edsm_id, 13949);
  assert.deepEqual(row.factions[0].recovering_states, ['CivilWar']);
});

test('строка дампа EDSM: скобки массива, без фракций, только контролирующая, битые строки', () => {
  assert.deepEqual(parseEdsmPopulatedLine('['), { kind: 'empty' });
  assert.deepEqual(parseEdsmPopulatedLine(']'), { kind: 'empty' });
  assert.deepEqual(parseEdsmPopulatedLine('   '), { kind: 'empty' });
  assert.deepEqual(parseEdsmPopulatedLine('{"broken":'), { kind: 'skip', reason: 'invalid' });
  assert.deepEqual(parseEdsmPopulatedLine('<html>'), { kind: 'skip', reason: 'invalid' });

  // Последняя запись: запятой нет, «]» на той же строке.
  const last = parseEdsmPopulatedLine(`${edsmLine(SYSTEM_RECORD)}]`);
  assert.equal(last.kind, 'system');

  // Контролирующая фракция без списка влияния — она одна, влияние неизвестно.
  const onlyControl = edsmPopulatedRecord({ ...SYSTEM_RECORD, id64: 5, factions: undefined });
  assert.equal(onlyControl.kind, 'system');
  assert.equal(onlyControl.snapshot.factions.length, 1);
  assert.equal(onlyControl.snapshot.factions[0].name, '4 Sextantis Inc');
  assert.equal(onlyControl.snapshot.factions[0].influence, null);
  assert.equal(onlyControl.snapshot.observedAt, null, 'без влияния и даты — неизвестно');

  const none = edsmPopulatedRecord({ ...SYSTEM_RECORD, id64: 6, factions: [], controllingFaction: null });
  assert.deepEqual(none, { kind: 'skip', reason: 'no_factions' });
  assert.deepEqual(edsmPopulatedRecord({ ...SYSTEM_RECORD, coords: {} }), { kind: 'skip', reason: 'invalid' });

  // Обрезка сломала бы строку (нет ключа date) — разбирается целиком.
  const noDate = `{"id":1,"id64":77,"name":"No Date","coords":{"x":1,"y":2,"z":3},"factions":[{"name":"F","influence":1}],"stations":[]}`;
  assert.equal(parseEdsmPopulatedLine(noDate).kind, 'system');

  const counter = new BgsDumpCounter();
  for (const item of [parseEdsmPopulatedLine('['), parseEdsmPopulatedLine(edsmLine(SYSTEM_RECORD)), parseEdsmPopulatedLine('{"x":'), { kind: 'skip', reason: 'no_factions' }]) {
    counter.add(item);
  }
  assert.equal(counter.stats.records, 3);
  assert.equal(counter.stats.systems, 1);
  assert.equal(counter.stats.factions, 2);
  assert.equal(counter.stats.playerFactions, 1);
  assert.equal(counter.stats.presence, 2);
  assert.deepEqual(counter.stats.skipped, { invalid: 1, no_factions: 1 });
  assert.deepEqual(counter.stats.allegiances, { Federation: 1 });
});

/* ── Журнал пилота ─────────────────────────────────────────────────────── */

const JOURNAL_LINES = readFileSync(join(FIXTURES, 'bgs-journal.jsonl'), 'utf8').split('\n').filter(Boolean);
const EXPECTED = JSON.parse(readFileSync(join(FIXTURES, 'bgs-journal.expected.json'), 'utf8'));

test('проекция журнала совпадает с эталоном Colonial Helper (uploader/bgs_sync.py)', () => {
  const actual = JOURNAL_LINES.map((line) => projectBgsEvent(JSON.parse(line), line));
  assert.deepEqual(actual, EXPECTED);
  // Без исходной строки SystemAddress шире 2^53 восстановить нельзя.
  const lossy = projectBgsEvent(JSON.parse(JOURNAL_LINES[0]));
  assert.equal(typeof lossy.SystemAddress, 'number');
  // Списки полей — те же, что у Helper'а.
  const python = readFileSync(join(ROOT, 'uploader', 'bgs_sync.py'), 'utf8');
  for (const field of [...BGS_SYSTEM_FIELDS, ...BGS_FACTION_FIELDS]) assert.ok(python.includes(`"${field}"`), `${field} есть в bgs_sync.py`);
});

test('наблюдение из журнала: поля системы, фракции, старый формат, отказы', () => {
  const modern = journalEventToSnapshot(EXPECTED[0], NOW);
  assert.ok('snapshot' in modern);
  const s = modern.snapshot;
  assert.equal(s.id64, '36028797018963971');
  assert.equal(s.name, 'Col 285 Sector AB-C d14-3');
  assert.equal(s.allegiance, 'Independent');
  assert.equal(s.government, 'Cooperative');
  assert.equal(s.economy, 'Colony');
  assert.equal(s.secondEconomy, 'Industrial');
  assert.equal(s.security, 'Low');
  assert.equal(s.population, 18457);
  assert.equal(s.controlling, 'Ring Colony Pioneers');
  assert.equal(s.state, 'Expansion');
  assert.equal(s.observedAt, '2026-10-17T18:20:05.000Z');
  assert.equal(s.factions.length, 3);
  assert.deepEqual(s.factions[0], {
    name: 'Ring Colony Pioneers', allegiance: 'Independent', government: 'Cooperative', isPlayer: null, edsmId: null,
    influence: 0.612, state: 'Expansion', activeStates: ['Expansion', 'Boom'], pendingStates: ['Investment'],
    recoveringStates: ['Election'], happiness: 'Happy',
  });
  assert.equal(s.factions[2].allegiance, 'PilotsFederation');
  assert.equal(s.factions[2].influence, 0);

  const old = journalEventToSnapshot(EXPECTED[1], NOW).snapshot;
  assert.equal(old.controlling, 'Mother Gaia', 'SystemFaction строкой — старый журнал');
  assert.equal(old.state, 'Boom', 'состояние системы — FactionState верхнего уровня');
  assert.equal(old.security, 'High');

  const carrier = journalEventToSnapshot(EXPECTED[2], NOW).snapshot;
  assert.equal(carrier.security, 'Anarchy');
  assert.equal(carrier.factions[0].happiness, 'Despondent');

  assert.deepEqual(journalEventToSnapshot({ ...EXPECTED[0], event: 'Docked' }, NOW), { reject: 'event' });
  assert.deepEqual(journalEventToSnapshot({ ...EXPECTED[0], timestamp: '2026-10-20T00:00:00Z' }, NOW), { reject: 'timestamp' });
  assert.deepEqual(journalEventToSnapshot({ ...EXPECTED[0], StarSystem: '' }, NOW), { reject: 'system' });
  assert.deepEqual(journalEventToSnapshot({ ...EXPECTED[0], SystemAddress: 2 ** 60 }, NOW), { reject: 'address' });
  assert.deepEqual(journalEventToSnapshot({ ...EXPECTED[0], StarPos: [1, 2] }, NOW), { reject: 'position' });
  assert.deepEqual(journalEventToSnapshot({ ...EXPECTED[0], Factions: [{ Name: '' }] }, NOW), { reject: 'factions' });
  assert.deepEqual(journalEventToSnapshot(null, NOW), { reject: 'event' });
});

test('сборщик загрузчика на сайте: одна свежая запись на систему', () => {
  const collector = new BgsSnapshotCollector();
  const base = JSON.parse(JOURNAL_LINES[1]);
  const later = { ...base, timestamp: '2017-03-15T09:12:00Z', Factions: [{ ...base.Factions[0], Influence: 0.5 }] };
  const earlier = { ...base, timestamp: '2017-03-13T09:12:00Z' };
  collector.feed(JSON.stringify(base), base);
  collector.feed(JSON.stringify(later), later);
  collector.feed(JSON.stringify(earlier), earlier);
  collector.feed(JOURNAL_LINES[0], JSON.parse(JOURNAL_LINES[0]));
  collector.feed(JOURNAL_LINES[3], JSON.parse(JOURNAL_LINES[3]));
  collector.feed('garbage', null);
  assert.equal(collector.size, 2);
  const drained = collector.drain();
  assert.deepEqual(drained.map((item) => item.timestamp), ['2017-03-15T09:12:00Z', '2026-10-17T18:20:05Z'], 'по времени');
  assert.equal(drained[0].Factions[0].Influence, 0.5);
  assert.equal(drained[1].SystemAddress, '36028797018963971');
  assert.equal(collector.size, 0);
});

/* ── Слой карты ────────────────────────────────────────────────────────── */

const LAYER_ROWS = [
  { id64: '10477373803', name: 'Sol', x: 0, y: 0, z: 0, allegiance: 'Federation', government: 'Democracy', controllingId: 1, controlling: 'Mother Gaia', population: 22780919531, factionsCount: 6, observedSec: 1792040000, source: 'helper' },
  { id64: '3932277478106', name: 'Lave', x: 75.75, y: 48.75, z: 70.75, allegiance: 'Independent', government: 'Dictatorship', controllingId: 2, controlling: 'Lave Radio', population: 1000000, factionsCount: 5, observedSec: null, source: 'edsm' },
  { id64: '36028797018963971', name: 'Col 285 Sector AB-C d14-3', x: -24.5, y: -33.8, z: 108.8, allegiance: 'Independent', government: 'Cooperative', controllingId: 3, controlling: 'Ring Colony Pioneers', population: 18457, factionsCount: 3, observedSec: 1792050000, source: 'web' },
  { id64: '5', name: 'Achenar', x: 67.5, y: -119.5, z: 24.8, allegiance: 'Empire', government: 'Patronage', controllingId: 1, controlling: 'Mother Gaia', population: null, factionsCount: 1, observedSec: null, source: 'weird' },
];

test('формат слоя: кортежи туда и обратно, словари без повторов', () => {
  const encoded = encodeBgsLayer(LAYER_ROWS);
  assert.equal(encoded.systems.length, 4);
  assert.deepEqual(encoded.factions, [[1, 'Mother Gaia'], [2, 'Lave Radio'], [3, 'Ring Colony Pioneers']], 'фракция в словаре один раз');
  assert.equal(encoded.systems[0][0], '10477373803');
  assert.equal(encoded.systems[3][7], 0, 'Achenar ссылается на Mother Gaia');
  const decoded = decodeBgsLayer({ status: 'ready', version: 'v1', meta: { refreshing: true, factions: 7, progress: { stage: 'download', stageLabel: 'Скачивание', percent: 140, message: 'x' } }, ...encoded });
  assert.equal(decoded.status, 'ready');
  assert.equal(decoded.version, 'v1');
  assert.equal(decoded.meta.refreshing, true);
  assert.equal(decoded.meta.factions, 7);
  assert.equal(decoded.meta.progress.percent, 100, 'процент ограничен');
  const sol = decoded.systems[0];
  assert.deepEqual(
    { id64: sol.id64, nameLc: sol.nameLc, allegiance: sol.allegiance, government: sol.government, controlling: sol.controlling, controllingId: sol.controllingId, population: sol.population, factionsCount: sol.factionsCount, observedAt: sol.observedAt, source: sol.source },
    { id64: '10477373803', nameLc: 'sol', allegiance: 'Federation', government: 'Democracy', controlling: 'Mother Gaia', controllingId: 1, population: 22780919531, factionsCount: 6, observedAt: 1792040000 * 1000, source: 'helper' },
  );
  assert.equal(decoded.systems[3].source, 'edsm', 'неизвестный источник — EDSM');
  assert.equal(decoded.systems[1].observedAt, null);
  assert.equal(decodeBgsLayer({ status: 'ready', systems: [['1', '', 0, 0, 0, 0]] }).status, 'empty', 'битые кортежи пропускаются');
  assert.equal(decodeBgsLayer(null).systems.length, 0);
});

test('поиск, присутствие и карточка системы — разбор ответов API', () => {
  const found = decodeFactionSearch({ results: [{ id: 3, name: 'Ring Colony Pioneers', allegiance: 'Independent', government: 'Cooperative', is_player: true, systems: 4, controlled: 2 }, { id: 'x' }] });
  assert.deepEqual(found, [{ id: 3, name: 'Ring Colony Pioneers', allegiance: 'Independent', government: 'Cooperative', isPlayer: true, systems: 4, controlled: 2 }]);

  const presence = decodeFactionPresence({
    factions: [{
      id: 3, name: 'Ring Colony Pioneers', allegiance: 'Independent', government: 'Cooperative', is_player: true, systems_count: 2, controlled_count: 1,
      systems: [
        ['36028797018963971', 'Col 285 Sector AB-C d14-3', -24.5, -33.8, 108.8, 0.612, 'Expansion', true, 1792050000, ['Expansion'], [], ['Election'], 'Happy', 18457, 'Independent'],
        ['5', 'Achenar', 67.5, -119.5, 24.8, 0.1, 'None', false, null, [], [], [], null, null, 'Empire'],
        ['bad'],
      ],
    }],
  });
  assert.equal(presence.length, 1);
  assert.equal(presence[0].isPlayer, true);
  assert.equal(presence[0].systems.length, 2);
  assert.equal(presence[0].systems[0].controls, true);
  assert.equal(presence[0].systems[0].influence, 0.612);
  assert.deepEqual(presence[0].systems[0].recoveringStates, ['Election']);
  assert.equal(presence[0].systems[1].allegiance, 'Empire');

  const detail = decodeSystemDetail({
    system: { id64: '10477373803', name: 'Sol', x: 0, y: 0, z: 0, allegiance: 'Federation', government: 'Democracy', economy: 'Refinery', second_economy: 'Service', security: 'High', state: 'Boom', population: 22780919531, controlling_faction_id: 1, controlling_faction: 'Mother Gaia', observed_at: '2026-10-12T10:00:00+00:00', source: 'helper' },
    factions: [{ id: 1, name: 'Mother Gaia', allegiance: 'Federation', government: 'Democracy', is_player: false, influence: 0.7, state: 'Boom', active_states: ['Boom'], pending_states: [], recovering_states: [], happiness: 'Happy', systems_count: 3, controlled_count: 2 }],
  });
  assert.equal(detail.controlling, 'Mother Gaia');
  assert.equal(detail.controllingId, 1);
  assert.equal(detail.secondEconomy, 'Service');
  assert.equal(detail.source, 'helper');
  assert.equal(detail.factions[0].systemsCount, 3);
  assert.deepEqual(detail.factions[0].activeStates, ['Boom']);
  assert.equal(decodeSystemDetail({ system: null }), null);
});

test('фильтр и выбранные фракции: цвета, дубли, предел, принадлежность', () => {
  assert.deepEqual(parseBgsFilter({ hiddenAllegiances: ['Empire', 'bogus', 'Federation'], controlsOnly: true, background: 'yes' }), {
    hiddenAllegiances: ['Federation', 'Empire'], controlsOnly: true, background: false,
  });
  assert.deepEqual(parseBgsFilter(null), DEFAULT_BGS_FILTER);
  const hidden = toggleAllegiance(DEFAULT_BGS_FILTER, 'Empire');
  assert.deepEqual(hidden.hiddenAllegiances, ['Empire']);
  assert.deepEqual(toggleAllegiance(hidden, 'Empire').hiddenAllegiances, []);
  assert.equal(soloAllegiance(DEFAULT_BGS_FILTER, 'Alliance').hiddenAllegiances.length, 7);

  const many = Array.from({ length: 20 }, (_, index) => ({ id: index + 1, name: `F${index}`, color: index === 1 ? 'red' : BGS_SELECTION_COLORS[0] }));
  const parsed = parseBgsSelection([...many, { id: 1, name: 'dup' }]);
  assert.equal(parsed.length, BGS_MAX_SELECTED, 'не больше дюжины');
  assert.equal(parsed[1].color, BGS_SELECTION_COLORS[1], 'битый цвет заменён свободным');
  assert.equal(nextSelectionColor([{ color: BGS_SELECTION_COLORS[0] }]), BGS_SELECTION_COLORS[1]);
  assert.equal(nextSelectionColor(BGS_SELECTION_COLORS.map((color) => ({ color }))), BGS_SELECTION_COLORS[0], 'цвета по кругу');
});

test('точки карты: все населённые системы, выбранные фракции, «у власти», фон', () => {
  const layer = decodeBgsLayer({ status: 'ready', ...encodeBgsLayer(LAYER_ROWS) });
  const systems = layer.systems;
  assert.deepEqual(countBgsAllegiances(systems).Independent, 2);

  // Без выбранных фракций — все системы под фильтром принадлежности.
  const base = buildBgsMapPoints({ systems, filter: DEFAULT_BGS_FILTER, selection: [], presence: new Map() });
  assert.equal(base.length, 4);
  assert.equal(base[0].color, BGS_ALLEGIANCE_COLOR.Federation);
  assert.equal(base[0].size, BGS_POINT_SIZE.base);
  assert.equal(base[0].system.controlling, 'Mother Gaia');
  const noEmpire = buildBgsMapPoints({ systems, filter: toggleAllegiance(DEFAULT_BGS_FILTER, 'Empire'), selection: [], presence: new Map() });
  assert.deepEqual(noEmpire.map((point) => point.name), ['Sol', 'Lave', 'Col 285 Sector AB-C d14-3']);
  assert.equal(filterBgsSystems(systems, soloAllegiance(DEFAULT_BGS_FILTER, 'Empire')).length, 1);

  const presence = new Map([
    [1, { id: 1, name: 'Mother Gaia', allegiance: 'Federation', government: 'Democracy', isPlayer: false, systemsCount: 2, controlledCount: 1, systems: [
      { id64: '10477373803', name: 'Sol', nameLc: 'sol', x: 0, y: 0, z: 0, influence: 0.7, state: 'Boom', controls: true, observedAt: null, activeStates: [], pendingStates: [], recoveringStates: [], happiness: null, population: null, allegiance: 'Federation' },
      { id64: '5', name: 'Achenar', nameLc: 'achenar', x: 67.5, y: -119.5, z: 24.8, influence: 0.2, state: 'None', controls: false, observedAt: null, activeStates: [], pendingStates: [], recoveringStates: [], happiness: null, population: null, allegiance: 'Empire' },
    ] }],
    [3, { id: 3, name: 'Ring Colony Pioneers', allegiance: 'Independent', government: 'Cooperative', isPlayer: true, systemsCount: 2, controlledCount: 1, systems: [
      { id64: '5', name: 'Achenar', nameLc: 'achenar', x: 67.5, y: -119.5, z: 24.8, influence: 0.6, state: 'War', controls: false, observedAt: null, activeStates: [], pendingStates: [], recoveringStates: [], happiness: null, population: null, allegiance: 'Empire' },
      { id64: '36028797018963971', name: 'Col 285 Sector AB-C d14-3', nameLc: 'col 285 sector ab-c d14-3', x: -24.5, y: -33.8, z: 108.8, influence: 0.612, state: 'Expansion', controls: true, observedAt: null, activeStates: [], pendingStates: [], recoveringStates: [], happiness: null, population: null, allegiance: 'Independent' },
    ] }],
  ]);
  const selection = [
    { id: 1, name: 'Mother Gaia', color: '#111111', allegiance: 'Federation', hidden: false },
    { id: 3, name: 'Ring Colony Pioneers', color: '#333333', allegiance: 'Independent', hidden: false },
  ];
  const picked = buildBgsMapPoints({ systems, filter: DEFAULT_BGS_FILTER, selection, presence });
  const byName = Object.fromEntries(picked.map((point) => [point.name, point]));
  assert.equal(picked.length, 3, 'только системы выбранных фракций');
  assert.equal(byName.Sol.shape, 2, 'у власти — звезда');
  assert.equal(byName.Sol.color, '#111111');
  assert.equal(byName.Sol.system.controlling, 'Mother Gaia', 'данные общего слоя подшиты');
  assert.equal(byName.Achenar.shape, 1, 'две выбранные фракции — кольцо');
  assert.equal(byName.Achenar.color, '#333333', 'цвет — сильнейшая из выбранных');
  assert.deepEqual(byName.Achenar.entries.map((entry) => entry.name), ['Ring Colony Pioneers', 'Mother Gaia']);
  assert.equal(byName.Achenar.influence, 0.6);
  assert.deepEqual(orderBgsPoints(picked).map((point) => point.name), ['Sol', 'Col 285 Sector AB-C d14-3', 'Achenar'], 'сначала «у власти», затем по влиянию');

  const controls = buildBgsMapPoints({ systems, filter: { ...DEFAULT_BGS_FILTER, controlsOnly: true }, selection, presence });
  assert.deepEqual(controls.map((point) => point.name).sort(), ['Col 285 Sector AB-C d14-3', 'Sol']);

  const hiddenOne = buildBgsMapPoints({ systems, filter: DEFAULT_BGS_FILTER, selection: [selection[0], { ...selection[1], hidden: true }], presence });
  assert.deepEqual(hiddenOne.map((point) => point.name), ['Sol', 'Achenar']);
  assert.equal(hiddenOne[1].shape, 0, 'одна выбранная без власти — точка');

  const withBackground = buildBgsMapPoints({ systems, filter: { ...DEFAULT_BGS_FILTER, background: true }, selection, presence });
  assert.equal(withBackground.length, 4);
  const lave = withBackground.find((point) => point.name === 'Lave');
  assert.equal(lave.background, true);
  assert.equal(lave.size, BGS_POINT_SIZE.background);
  assert.equal(orderBgsPoints(withBackground).length, 3, 'фон не попадает в список');

  assert.deepEqual(searchBgsSystems(picked, 'ach').map((point) => point.name), ['Achenar']);
  assert.deepEqual(searchBgsSystems(systems, 'sector').map((point) => point.name), ['Col 285 Sector AB-C d14-3']);
});

test('подписи: влияние, население, возраст данных', () => {
  assert.equal(formatInfluence(0.4526), '45,3 %');
  assert.equal(formatInfluence(null), '—');
  assert.equal(formatPopulation(22780919531), '22,8 млрд');
  assert.equal(formatPopulation(4_100_000), '4,1 млн');
  assert.equal(formatPopulation(15_000), '15 тыс.');
  assert.equal(formatPopulation(0), '—');
  assert.equal(bgsAge(NOW - 3600_000, NOW), 'сегодня');
  assert.equal(bgsAge('2026-10-13T12:00:00Z', NOW), '5 дн. назад');
});

/* ── Ход импорта ───────────────────────────────────────────────────────── */

test('ход импорта: веса этапов, проценты, завершение, журнал, разбор из JSON', () => {
  assert.equal(BGS_SYNC_STAGES.reduce((sum, stage) => sum + stage.weight, 0), 100);
  const progress = createBgsProgress({ id: 'run-1', trigger: 'admin', now: NOW });
  startBgsStage(progress, 'probe', { now: NOW });
  finishBgsStage(progress, 'probe', { now: NOW });
  startBgsStage(progress, 'download', { total: 1000, now: NOW });
  updateBgsStage(progress, 'download', { done: 500, detail: '500 Б из 1000 Б', now: NOW });
  assert.equal(progress.percent, 3 + 57 / 2);
  assert.equal(progress.message, 'Скачивание дампа на диск: 500 Б из 1000 Б');
  assert.equal(computeBgsPercent(progress), progress.percent);
  assert.equal(publicBgsProgress(progress).stageLabel, 'Скачивание дампа на диск');

  const restored = sanitizeBgsProgress(JSON.parse(JSON.stringify(progress)));
  assert.deepEqual(restored, progress, 'JSON туда и обратно без потерь');
  assert.equal(sanitizeBgsProgress({ id: 'x' }), null);
  assert.equal(sanitizeBgsProgress({ id: 'x', startedAt: '2026-10-18T00:00:00Z', stages: [{ id: 'download', status: 'running', done: 'NaN' }], percent: 'x' }).stages[1].done, 0);

  finishBgsProgress(progress, 'ok', { result: { systems: 10, factions: 20, durationMs: 1500 }, now: NOW });
  assert.equal(progress.percent, 100);
  assert.deepEqual(progress.stages.map((stage) => stage.status), ['done', 'done', 'skipped', 'skipped']);
  assert.equal(publicBgsProgress(progress), null, 'закончившийся прогон не публикуется');

  const log = [];
  for (let index = 0; index < 300; index++) pushBgsLog(log, 'info', `строка ${index}`, { now: NOW });
  assert.equal(log.length, 250);
  assert.equal(log[0].text, 'строка 50');
  assert.equal(sanitizeBgsLog([{ at: 'bad', text: 'x' }, { at: '2026-10-18T00:00:00Z', level: 'odd', text: 'ok' }]).length, 1);
  assert.equal(formatBgsDuration(3_725_000), '1 ч 02 мин');
  assert.equal(formatBgsDuration(65_000), '1 мин 05 с');
});
