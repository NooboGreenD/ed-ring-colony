/**
 * Слой «PowerPlay» карты Atlas: чистые функции.
 *
 *   * `powerplayDump.ts` — разбор ночного дампа EDSM `powerPlay.json.gz`
 *     (формат строк — как в настоящем дампе 17.10.2026): отбор систем под
 *     контролем, id64 без потери точности, повторы, битые строки;
 *   * `powerplay.ts` — имена держав и состояния, компактный формат ответа API
 *     и его разбор в браузере, фильтр вкладки, счётчики, поиск, зоны влияния.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  POWERPLAY_PARSER_VERSION,
  edsmDateToIso,
  edsmRecordToRow,
  parseEdsmPowerplayDump,
} from '../../src/lib/powerplayDump.ts';
import {
  DEFAULT_POWERPLAY_FILTER,
  EMPTY_POWERPLAY_META,
  POWERPLAY_POWERS,
  POWERPLAY_STATE_RANGE_LY,
  countPowerplay,
  decodePowerplayLayer,
  distanceLy,
  encodePowerplayLayer,
  filterPowerplaySystems,
  findPowerplaySystem,
  formatLy,
  formatPowerplayDate,
  hexToRgbUnit,
  hideAllPowers,
  isDefaultPowerplayFilter,
  isPowerVisible,
  normalizePowerName,
  normalizePowerplayState,
  orderPowerplaySystems,
  parsePowerplayFilter,
  powerColor,
  powerInfo,
  powerLabel,
  powerplayAge,
  powerplayInfluenceAt,
  searchPowerplaySystems,
  showAllPowers,
  soloPower,
  togglePowerVisible,
  togglePowerplayState,
  POWERPLAY_ACTIVE_POWERS,
  POWERPLAY_BASES,
  POWERPLAY_UNKNOWN_POWER,
  isAllegianceSolo,
  isUnknownPower,
  powerplayBasisText,
  powerplayFilterPowers,
  soloAllegiance,
} from '../../src/lib/powerplay.ts';
import {
  POWERPLAY_LOG_LIMIT,
  POWERPLAY_SYNC_STAGES,
  computePowerplayPercent,
  createPowerplayProgress,
  finishPowerplayProgress,
  finishPowerplayStage,
  formatPowerplayBytes,
  formatPowerplayDuration,
  publicPowerplayProgress,
  pushPowerplayLog,
  sanitizePowerplayLog,
  sanitizePowerplayProgress,
  sanitizePublicPowerplayProgress,
  startPowerplayStage,
  updatePowerplayStage,
} from '../../src/lib/powerplayProgress.ts';

/* ── Дамп EDSM ─────────────────────────────────────────────────────────── */

// Строки — дословно из дампа EDSM (кроме последних, придуманных для краёв).
const DUMP = [
  '[',
  ' {"power":"Edmund Mahon","powerState":"Exploited","id":1330197,"id64":2008065118922,"name":"Col 285 Sector UZ-N c7-7","coords":{"x":39.125,"y":157.71875,"z":-25.125},"allegiance":"Independent","government":"Corporate","state":"Expansion","date":"2026-09-17 00:46:16"},',
  ' {"power":"Edmund Mahon","powerState":"Unoccupied","id":1010732,"id64":5069270099361,"name":"Col 285 Sector OP-A b16-2","coords":{"x":23.0625,"y":196.9375,"z":-18.34375},"allegiance":"Alliance","government":"Democracy","state":"None","date":"2026-09-17 01:01:17"},',
  ' {"power":"Edmund Mahon","powerState":"Stronghold","id":12273,"id64":2557888041682,"name":"Prajan","coords":{"x":56.59375,"y":139.59375,"z":10.78125},"allegiance":"Independent","government":"Corporate","state":"None","date":"2026-10-16 05:04:59"},',
  ' {"power":"Li Yong-Rui","powerState":"Fortified","id":916,"id64":671222801825,"name":"LHS 154a","coords":{"x":15.03125,"y":-42.8125,"z":-7.0625},"allegiance":"Independent","government":"Cooperative","state":"None","date":"2026-10-16 15:19:57"},',
  ' {"power":"Nakato Kaine","powerState":"Stronghold","id":6584,"id64":2656194005355,"name":"LTT 4428","coords":{"x":75.15625,"y":15.1875,"z":33.34375},"allegiance":"Federation","government":"Corporate","state":"Expansion","date":"2026-10-16 23:55:50"},',
  // Та же система у другой державы и с более старой датой — запись от старого события, побеждает свежая выше.
  ' {"power":"Zemina Torval","powerState":"Exploited","id":6584,"id64":2656194005355,"name":"LTT 4428","coords":{"x":75.15625,"y":15.1875,"z":33.34375},"allegiance":"Federation","government":"Corporate","state":"None","date":"2026-10-01 10:00:00"},',
  // id64 шире 2^53: JSON.parse потерял бы младшие разряды.
  ' {"power":"Arissa Lavigny-Duval","powerState":"fortified","id":1,"id64":36028797018963971,"name":"Huge Address","coords":{"x":1,"y":2,"z":3},"allegiance":null,"government":null,"state":null,"date":"2026-10-15 12:00:00"},',
  ' {"power":"Yuri Grom","powerState":"Control","id":2,"id64":12345,"name":"Legacy State","coords":{"x":1,"y":2,"z":3},"date":"2026-10-15 12:00:00"},',
  ' {"power":"Yuri Grom","powerState":"Exploited","id":3,"id64":12346,"name":"No Coords","coords":{"x":1,"y":null,"z":3},"date":"2026-10-15 12:00:00"},',
  ' {"power":"Yuri Grom","powerState":"Exploited","id":4,"id64":12347,"name":"",',
  ' {"power":"Jerome Archer","powerState":"Exploited","id":5,"id64":12348,"name":"Last Line","coords":{"x":-1.5,"y":0,"z":2.25},"allegiance":"Federation","government":"Democracy","state":"None","date":"2026-10-16 23:59:03"}',
  ']',
].join('\n');

test('дамп EDSM: под контролем — только Stronghold/Fortified/Exploited, остальное посчитано по причинам', () => {
  const { rows, stats } = parseEdsmPowerplayDump(DUMP);
  const byName = Object.fromEntries(rows.map((row) => [row.name, row]));

  assert.deepEqual(rows.map((row) => row.name).sort(), [
    'Col 285 Sector UZ-N c7-7', 'Huge Address', 'LHS 154a', 'LTT 4428', 'Last Line', 'Prajan',
  ]);
  assert.equal(stats.records, 11, 'каждая строка-запись посчитана, включая битую');
  assert.equal(stats.parser, POWERPLAY_PARSER_VERSION);
  assert.equal(stats.kept, 6);
  assert.equal(stats.sole, 6, 'у каждой системы фикстуры одна держава');
  assert.equal(stats.contested, 0);
  assert.deepEqual(stats.skipped, { unoccupied: 1, unknown_state: 1, invalid: 2, duplicate: 0, stale: 1 });
  assert.deepEqual(stats.states, { Stronghold: 2, Fortified: 2, Exploited: 2 });
  assert.equal(stats.powers['Edmund Mahon'], 2);
  assert.equal(stats.powers['A. Lavigny-Duval'], 1, 'Арисса приведена к имени из журнала');
  assert.equal(stats.presence['Zemina Torval'], undefined, 'запись старого события не делает державу присутствующей');
  assert.equal(stats.oldestObservation, '2026-09-17T00:46:16.000Z');
  assert.equal(stats.newestObservation, '2026-10-16T23:59:03.000Z');

  assert.deepEqual(byName['Prajan'], {
    id64: '2557888041682', name: 'Prajan', x: 56.59375, y: 139.59375, z: 10.78125, power: 'Edmund Mahon', powers: ['Edmund Mahon'],
    state: 'Stronghold', allegiance: 'Independent', government: 'Corporate', observedAt: '2026-10-16T05:04:59.000Z',
  });
  assert.equal(byName['LTT 4428'].power, 'Nakato Kaine', 'запись старого события отброшена, остаётся свежее наблюдение');
  assert.equal(byName['LTT 4428'].state, 'Stronghold');
  assert.equal(byName['Huge Address'].id64, '36028797018963971', 'id64 из текста строки, без округления до 2^53');
  assert.equal(byName['Huge Address'].state, 'Fortified', 'регистр состояния не важен');
  assert.equal(byName['Huge Address'].allegiance, null);
  assert.equal(byName['Last Line'].x, -1.5, 'последняя строка без запятой и скобка на своей строке');
});

/*
 * Настоящая причина расхождения с игрой. EDSM пишет по записи на каждую
 * державу из поля журнала `Powers` (все, чьи зоны накрывают систему) с одним
 * состоянием и датой, а дамп сортирует записи по номеру державы в EDSM:
 * Aisling Duval — 3, Nakato Kaine — 13. Прежний разбор оставлял последнюю
 * запись, и спорная система всегда доставалась Nakato.
 */
const CONTESTED_DUMP = [
  '[',
  // Пограничье Aisling и Nakato: две записи одной системы, одна дата.
  ' {"power":"Aisling Duval","powerState":"Exploited","id":77,"id64":3107442165442,"name":"Border One","coords":{"x":60.1,"y":-40.2,"z":12.5},"allegiance":"Empire","government":"Patronage","state":"None","date":"2026-10-17 11:22:33"},',
  ' {"power":"Aisling Duval","powerState":"Fortified","id":78,"id64":3107442165443,"name":"Border Two","coords":{"x":61.1,"y":-40.2,"z":12.5},"allegiance":"Empire","government":"Patronage","state":"None","date":"2026-10-17 12:00:00"},',
  ' {"power":"Aisling Duval","powerState":"Exploited","id":79,"id64":3107442165444,"name":"Aisling Only","coords":{"x":70,"y":-40,"z":12},"allegiance":"Empire","government":"Patronage","state":"None","date":"2026-10-17 13:00:00"},',
  // Свободная система с тремя претендентами — не под контролем.
  ' {"power":"Aisling Duval","powerState":"Unoccupied","id":80,"id64":3107442165445,"name":"Free Border","coords":{"x":65,"y":-41,"z":12},"date":"2026-10-17 14:00:00"},',
  ' {"power":"Jerome Archer","powerState":"Fortified","id":78,"id64":3107442165443,"name":"Border Two","coords":{"x":61.1,"y":-40.2,"z":12.5},"allegiance":"Empire","government":"Patronage","state":"None","date":"2026-10-17 12:00:00"},',
  ' {"power":"Jerome Archer","powerState":"Unoccupied","id":80,"id64":3107442165445,"name":"Free Border","coords":{"x":65,"y":-41,"z":12},"date":"2026-10-17 14:00:00"},',
  ' {"power":"Nakato Kaine","powerState":"Exploited","id":77,"id64":3107442165442,"name":"Border One","coords":{"x":60.1,"y":-40.2,"z":12.5},"allegiance":"Empire","government":"Patronage","state":"None","date":"2026-10-17 11:22:33"},',
  ' {"power":"Nakato Kaine","powerState":"Fortified","id":78,"id64":3107442165443,"name":"Border Two","coords":{"x":61.1,"y":-40.2,"z":12.5},"allegiance":"Empire","government":"Patronage","state":"None","date":"2026-10-17 12:00:00"},',
  ' {"power":"Nakato Kaine","powerState":"Unoccupied","id":80,"id64":3107442165445,"name":"Free Border","coords":{"x":65,"y":-41,"z":12},"date":"2026-10-17 14:00:00"},',
  ' {"power":"Nakato Kaine","powerState":"Stronghold","id":81,"id64":3107442165446,"name":"Nakato Only","coords":{"x":50,"y":-40,"z":12},"allegiance":"Alliance","government":"Democracy","state":"None","date":"2026-10-17 15:00:00"}',
  ']',
].join('\n');

test('дамп EDSM: система у нескольких держав — владелец не определён, а не «последняя в файле» (Nakato против Aisling)', () => {
  const { rows, stats } = parseEdsmPowerplayDump(CONTESTED_DUMP);
  const byName = Object.fromEntries(rows.map((row) => [row.name, row]));
  assert.deepEqual(Object.keys(byName).sort(), ['Aisling Only', 'Border One', 'Border Two', 'Nakato Only']);

  assert.equal(byName['Border One'].power, null, 'две державы — владелец по дампу неизвестен');
  assert.deepEqual(byName['Border One'].powers, ['Aisling Duval', 'Nakato Kaine']);
  assert.equal(byName['Border One'].state, 'Exploited');
  assert.equal(byName['Border One'].observedAt, '2026-10-17T11:22:33.000Z');
  assert.equal(byName['Border Two'].power, null);
  assert.deepEqual(byName['Border Two'].powers, ['Aisling Duval', 'Jerome Archer', 'Nakato Kaine']);
  assert.equal(byName['Aisling Only'].power, 'Aisling Duval', 'одна держава — она и владелец');
  assert.equal(byName['Nakato Only'].power, 'Nakato Kaine');

  assert.equal(stats.records, 10);
  assert.equal(stats.kept, 4);
  assert.equal(stats.sole, 2);
  assert.equal(stats.contested, 2);
  assert.equal(stats.listings, 3, 'записи «ещё одна держава той же системы» — не повторы');
  assert.equal(stats.skipped.duplicate, 0);
  assert.equal(stats.skipped.unoccupied, 3, 'у свободной системы три претендента — три записи');
  assert.deepEqual(stats.powers, { 'Aisling Duval': 1, 'Nakato Kaine': 1 }, 'владельцем держава считается только там, где она одна');
  assert.deepEqual(stats.presence, { 'Aisling Duval': 3, 'Jerome Archer': 1, 'Nakato Kaine': 3 });

  // Порядок записей не важен: раньше победителя решал именно он.
  const lines = CONTESTED_DUMP.split('\n');
  const reversed = ['[', ...lines.slice(1, -1).map((line) => line.replace(/,$/, '')).reverse().map((line, i, all) => (i < all.length - 1 ? `${line},` : line)), ']'].join('\n');
  const again = parseEdsmPowerplayDump(reversed);
  assert.deepEqual(
    again.rows.map((row) => [row.name, row.power, row.powers.join('|')]).sort(),
    rows.map((row) => [row.name, row.power, row.powers.join('|')]).sort(),
  );

  // Повтор той же державы у той же системы (в настоящем дампе не бывает).
  const dup = parseEdsmPowerplayDump(['[', lines[1], lines[1].replace(/,$/, ''), ']'].join('\n'));
  assert.equal(dup.stats.skipped.duplicate, 1);
  assert.equal(dup.rows[0].power, 'Aisling Duval');
});

test('дамп EDSM: не построчный JSON и мусор', () => {
  const compact = JSON.stringify([
    { power: 'Pranav Antal', powerState: 'Stronghold', id64: 1001, name: 'Polevnic', coords: { x: -79.9, y: -2.1, z: -40.3 }, date: '2026-10-10 10:10:10' },
    { power: 'Pranav Antal', powerState: 'Unoccupied', id64: 1002, name: 'Free', coords: { x: 0, y: 0, z: 0 } },
  ]);
  const one = parseEdsmPowerplayDump(compact);
  assert.deepEqual(one.rows.map((row) => row.name), ['Polevnic'], 'массив в одну строку тоже разбирается');
  assert.equal(one.rows[0].id64, '1001');

  const pretty = JSON.stringify([{ power: 'Yuri Grom', powerState: 'Exploited', id64: 77, name: 'Pretty', coords: { x: 1, y: 2, z: 3 } }], null, 2);
  assert.deepEqual(parseEdsmPowerplayDump(pretty).rows.map((row) => row.name), ['Pretty'], 'многострочный JSON');

  assert.throws(() => parseEdsmPowerplayDump('<html>503 Service Unavailable</html>'), /не похож/);
  assert.throws(() => parseEdsmPowerplayDump('{"not":"an array"}'), /не похож/);
  assert.equal(parseEdsmPowerplayDump('[\n]').rows.length, 0, 'пустой массив — пустой результат, решение принимает импорт');
});

test('запись дампа: проверки полей и даты EDSM', () => {
  const base = { power: 'Felicia Winters', powerState: 'Exploited', id64: 42, name: 'Rhea', coords: { x: 58.1, y: 22.6, z: -28.6 } };
  assert.equal(edsmRecordToRow(base).row.name, 'Rhea');
  assert.deepEqual(edsmRecordToRow({ ...base, coords: { x: 1e6, y: 0, z: 0 } }), { skip: 'invalid' }, 'координаты за пределами галактики');
  assert.deepEqual(edsmRecordToRow({ ...base, id64: -5 }), { skip: 'invalid' });
  assert.deepEqual(edsmRecordToRow({ ...base, id64: 2 ** 60 }), { skip: 'invalid' }, 'небезопасное число без исходной строки');
  assert.equal(edsmRecordToRow({ ...base, id64: '1152921504606846976' }).row.id64, '1152921504606846976', 'строковый id64');
  assert.deepEqual(edsmRecordToRow({ ...base, power: '   ' }), { skip: 'invalid' });
  assert.deepEqual(edsmRecordToRow({ ...base, powerState: undefined }), { skip: 'invalid' });
  assert.deepEqual(edsmRecordToRow({ ...base, powerState: 'HomeSystem' }), { skip: 'unknown_state' });
  assert.deepEqual(edsmRecordToRow(null), { skip: 'invalid' });
  assert.deepEqual(edsmRecordToRow([]), { skip: 'invalid' });

  assert.equal(edsmDateToIso('2026-09-17 01:49:46'), '2026-09-17T01:49:46.000Z', 'даты EDSM — UTC');
  assert.equal(edsmDateToIso('2026-09-17T01:49:46+03:00'), '2026-09-16T22:49:46.000Z');
  assert.equal(edsmDateToIso('2026-09-17T01:49:46.123Z'), '2026-09-17T01:49:46.000Z');
  assert.equal(edsmDateToIso('вчера'), null);
  assert.equal(edsmDateToIso(null), null);
});

/* ── Державы и состояния ───────────────────────────────────────────────── */

test('имена держав: как в журнале, варианты написания сводятся, новые не теряются', () => {
  assert.equal(normalizePowerName('Arissa Lavigny-Duval'), 'A. Lavigny-Duval');
  assert.equal(normalizePowerName('a. lavigny duval'), 'A. Lavigny-Duval');
  assert.equal(normalizePowerName('LI YONG RUI'), 'Li Yong-Rui');
  assert.equal(normalizePowerName('  Jerome   Archer '), 'Jerome Archer');
  assert.equal(normalizePowerName('Brand New Power'), 'Brand New Power', 'неизвестная держава остаётся как есть');
  assert.equal(normalizePowerName(''), null);
  assert.equal(normalizePowerName('1234'), null);
  assert.equal(normalizePowerName(42), null);
  assert.equal(normalizePowerName('x'.repeat(65)), null);

  assert.equal(normalizePowerplayState('STRONGHOLD'), 'Stronghold');
  assert.equal(normalizePowerplayState(' fortified '), 'Fortified');
  assert.equal(normalizePowerplayState('Exploited'), 'Exploited');
  assert.equal(normalizePowerplayState('Unoccupied'), null);
  assert.equal(normalizePowerplayState('Control'), null);

  assert.equal(POWERPLAY_POWERS.filter((power) => power.name !== 'Zachary Hudson').length, 12, 'двенадцать держав PowerPlay 2.0');
  const colors = POWERPLAY_POWERS.map((power) => power.color.toLowerCase());
  assert.equal(new Set(colors).size, colors.length, 'цвета держав не повторяются');
  assert.equal(powerLabel('A. Lavigny-Duval'), 'Arissa Lavigny-Duval');
  assert.equal(powerInfo('Edmund Mahon').allegiance, 'Alliance');
  const stranger = powerInfo('Brand New Power');
  assert.equal(stranger.label, 'Brand New Power');
  assert.match(stranger.color, /^#[0-9a-f]{6}$/);
  assert.equal(powerColor('Brand New Power'), stranger.color, 'цвет новой державы стабилен');
  assert.deepEqual(hexToRgbUnit('#ff8000'), [1, 128 / 255, 0]);
  assert.deepEqual(hexToRgbUnit('bad'), [0.8, 0.8, 0.8]);
  assert.equal(POWERPLAY_STATE_RANGE_LY.Stronghold, 30);
  assert.equal(POWERPLAY_STATE_RANGE_LY.Fortified, 20);
  assert.equal(POWERPLAY_STATE_RANGE_LY.Exploited, 0);
});

/* ── Формат ответа API ─────────────────────────────────────────────────── */

const ROWS = [
  { id64: '10', name: 'Alpha', x: 0, y: 0, z: 0, power: 'Yuri Grom', state: 'Stronghold', observedAt: '2026-10-16T00:00:00.000Z' },
  { id64: '11', name: 'Beta', x: 10, y: 0, z: 0, power: 'Yuri Grom', state: 'Exploited', observedAt: null },
  { id64: '12', name: 'Gamma', x: 25, y: 0, z: 0, power: 'Archon Delaine', state: 'Fortified', observedAt: '2026-10-15T12:00:00.000Z' },
  { id64: '13', name: 'Delta', x: 0, y: 18, z: 0, power: 'Archon Delaine', state: 'Exploited', observedAt: null },
  { id64: '36028797018963971', name: 'Epsilon', x: 100, y: 0, z: 0, power: 'Yuri Grom', state: 'Fortified', observedAt: null },
];

test('ответ API: кортежи со словарём держав, разбор в браузере пропускает битое', () => {
  const meta = { ...EMPTY_POWERPLAY_META, syncedAt: '2026-10-17T05:20:00.000Z' };
  const encoded = encodePowerplayLayer(ROWS, meta, 'run-1');
  assert.equal(encoded.status, 'ready');
  assert.equal(encoded.version, 'run-1');
  assert.deepEqual(encoded.powers, ['Yuri Grom', 'Archon Delaine'], 'крупные державы первыми');
  assert.deepEqual(encoded.states, ['Stronghold', 'Fortified', 'Exploited']);
  assert.deepEqual(encoded.bases, ['journal', 'sole', 'kept', 'unknown']);
  assert.deepEqual(encoded.systems[0], ['10', 'Alpha', 0, 0, 0, 0, 0, 1792108800], 'без основания и списка держав — прежний кортеж');
  assert.deepEqual(encoded.systems[1], ['11', 'Beta', 10, 0, 0, 0, 2, null]);
  assert.equal(encodePowerplayLayer([], meta, 'run-2').status, 'empty');

  const wire = JSON.parse(JSON.stringify(encoded));
  wire.systems.push(['x', 'Broken', 'nan', 0, 0, 0, 0, null], ['y', 'No power', 1, 2, 3, 99, 0, null], 'junk');
  const decoded = decodePowerplayLayer(wire);
  assert.equal(decoded.status, 'ready');
  assert.equal(decoded.systems.length, ROWS.length, 'битые кортежи пропущены');
  assert.deepEqual(decoded.systems[0], {
    id64: '10', name: 'Alpha', nameLc: 'alpha', x: 0, y: 0, z: 0, power: 'Yuri Grom', state: 'Stronghold', observedAt: Date.parse('2026-10-16T00:00:00Z'),
    basis: null, candidates: [],
  });
  assert.equal(decoded.systems[4].id64, '36028797018963971', 'id64 строкой — без потери точности');
  assert.equal(decoded.meta.syncedAt, '2026-10-17T05:20:00.000Z');
  assert.equal(decodePowerplayLayer(null).status, 'empty');
  assert.equal(decodePowerplayLayer({ status: 'ready', systems: [] }).status, 'empty', 'ready без систем — пусто');
});

const OWNER_ROWS = [
  { id64: '20', name: 'Known', x: 0, y: 0, z: 0, power: 'Aisling Duval', state: 'Fortified', observedAt: null, basis: 'journal', powers: ['Aisling Duval', 'Nakato Kaine'] },
  { id64: '21', name: 'Sole', x: 5, y: 0, z: 0, power: 'Aisling Duval', state: 'Exploited', observedAt: null, basis: 'sole', powers: ['Aisling Duval'] },
  { id64: '22', name: 'Contested', x: 10, y: 0, z: 0, power: null, state: 'Exploited', observedAt: null, basis: 'unknown', powers: ['Jerome Archer', 'Nakato Kaine'] },
  { id64: '23', name: 'Contested Fort', x: 12, y: 0, z: 0, power: null, state: 'Fortified', observedAt: null, basis: 'unknown', powers: ['Aisling Duval', 'Nakato Kaine'] },
  { id64: '24', name: 'Kept', x: 15, y: 0, z: 0, power: 'Nakato Kaine', state: 'Stronghold', observedAt: null, basis: 'kept', powers: ['Aisling Duval', 'Nakato Kaine'] },
];

test('ответ API: неопределённый владелец — индекс −1, основание и претенденты; старый клиент такую систему пропускает', () => {
  const encoded = encodePowerplayLayer(OWNER_ROWS, EMPTY_POWERPLAY_META, 'v2');
  assert.deepEqual(encoded.powers, ['Aisling Duval', 'Nakato Kaine', 'Jerome Archer'], 'держава только из списков претендентов — в конце');
  const [known, sole, contested] = encoded.systems;
  assert.deepEqual(known, ['20', 'Known', 0, 0, 0, 0, 1, null, POWERPLAY_BASES.indexOf('journal'), [0, 1]]);
  assert.deepEqual(sole, ['21', 'Sole', 5, 0, 0, 0, 2, null, POWERPLAY_BASES.indexOf('sole')], 'одна держава — без списка');
  assert.deepEqual(contested, ['22', 'Contested', 10, 0, 0, -1, 2, null, POWERPLAY_BASES.indexOf('unknown'), [2, 1]]);
  assert.equal(encoded.powers[contested[5]], undefined, 'старый клиент берёт powers[-1] → undefined и пропускает кортеж');

  const decoded = decodePowerplayLayer(JSON.parse(JSON.stringify(encoded)));
  const byName = Object.fromEntries(decoded.systems.map((system) => [system.name, system]));
  assert.equal(decoded.systems.length, OWNER_ROWS.length, 'неопределённые видны на карте');
  assert.equal(byName['Contested'].power, POWERPLAY_UNKNOWN_POWER);
  assert.equal(byName['Contested'].basis, 'unknown');
  assert.deepEqual(byName['Contested'].candidates, ['Jerome Archer', 'Nakato Kaine']);
  assert.equal(byName['Known'].basis, 'journal');
  assert.deepEqual(byName['Known'].candidates, ['Aisling Duval', 'Nakato Kaine']);
  assert.deepEqual(byName['Sole'].candidates, []);
  assert.equal(byName['Kept'].basis, 'kept');
  assert.deepEqual(decoded.powers, ['Aisling Duval', 'Nakato Kaine', POWERPLAY_UNKNOWN_POWER], '«не определена» — в конце фильтра');

  assert.ok(isUnknownPower(POWERPLAY_UNKNOWN_POWER) && isUnknownPower(null) && !isUnknownPower('Nakato Kaine'));
  assert.equal(powerInfo(POWERPLAY_UNKNOWN_POWER).label, 'Держава не определена');
  assert.equal(powerInfo(POWERPLAY_UNKNOWN_POWER).allegiance, null);
  assert.match(powerplayBasisText(byName['Contested']), /не определена/);
  assert.match(powerplayBasisText(byName['Known']), /ControllingPower/);
  assert.equal(powerplayBasisText({ power: 'Yuri Grom', basis: null }), null, 'старый импорт — без подписи');

  // Счётчики: у державы — свои системы и «+N?» претендента; «не определена» последней.
  const counts = countPowerplay(decoded.systems, powerplayFilterPowers(decoded.powers));
  const row = (power) => counts.powers.find((item) => item.power === power);
  assert.equal(counts.unknown, 2);
  assert.equal(row('Aisling Duval').total, 2);
  assert.equal(row('Aisling Duval').contested, 1);
  assert.equal(row('Nakato Kaine').total, 1);
  assert.equal(row('Nakato Kaine').contested, 2);
  assert.equal(row('Jerome Archer').total, 0);
  assert.equal(row('Jerome Archer').contested, 1);
  assert.equal(counts.powers.at(-1).power, POWERPLAY_UNKNOWN_POWER, 'строка «не определена» — последняя, сколько бы систем в ней ни было');
  assert.equal(row(POWERPLAY_UNKNOWN_POWER).total, 2);

  // Фильтр: «не определена» скрывается и показывается как держава; переживает localStorage.
  const hidden = togglePowerVisible(DEFAULT_POWERPLAY_FILTER, POWERPLAY_UNKNOWN_POWER);
  assert.deepEqual(filterPowerplaySystems(decoded.systems, hidden).map((system) => system.name), ['Known', 'Sole', 'Kept']);
  assert.deepEqual(parsePowerplayFilter(JSON.parse(JSON.stringify(hidden))).hiddenPowers, [POWERPLAY_UNKNOWN_POWER]);
  assert.ok(!soloAllegiance(DEFAULT_POWERPLAY_FILTER, 'Empire', powerplayFilterPowers(decoded.powers)).hiddenPowers.includes('Aisling Duval'));
  assert.ok(soloAllegiance(DEFAULT_POWERPLAY_FILTER, 'Empire', powerplayFilterPowers(decoded.powers)).hiddenPowers.includes(POWERPLAY_UNKNOWN_POWER));

  // Зоны неопределённой укреплённой системы тоже видны — под «не определена».
  const zones = powerplayInfluenceAt({ x: 20, y: 0, z: 0 }, decoded.systems);
  assert.ok(zones.some((zone) => zone.power === POWERPLAY_UNKNOWN_POWER && zone.nearest.name === 'Contested Fort'));
});

function decodedSystems() {
  return decodePowerplayLayer(encodePowerplayLayer(ROWS, EMPTY_POWERPLAY_META, 'v')).systems;
}

test('фильтр вкладки: скрытые державы, состояния, «только эта», чтение из localStorage', () => {
  const systems = decodedSystems();
  assert.equal(filterPowerplaySystems(systems, DEFAULT_POWERPLAY_FILTER), systems, 'фильтр по умолчанию — тот же массив');
  assert.ok(isDefaultPowerplayFilter(DEFAULT_POWERPLAY_FILTER));

  const noGrom = togglePowerVisible(DEFAULT_POWERPLAY_FILTER, 'Yuri Grom');
  assert.equal(isPowerVisible(noGrom, 'Yuri Grom'), false);
  assert.deepEqual(filterPowerplaySystems(systems, noGrom).map((s) => s.name), ['Gamma', 'Delta']);
  assert.deepEqual(togglePowerVisible(noGrom, 'Yuri Grom').hiddenPowers, []);

  const solo = soloPower(DEFAULT_POWERPLAY_FILTER, 'Archon Delaine', ['Yuri Grom', 'Archon Delaine']);
  assert.deepEqual(solo.hiddenPowers, ['Yuri Grom']);
  assert.ok(isPowerVisible(solo, 'Brand New Power'), 'держава, появившаяся позже, видна и при «только»');
  assert.deepEqual(hideAllPowers(DEFAULT_POWERPLAY_FILTER, ['A', 'B']).hiddenPowers, ['A', 'B']);
  assert.deepEqual(showAllPowers(solo).hiddenPowers, []);

  const noExploited = togglePowerplayState(DEFAULT_POWERPLAY_FILTER, 'Exploited');
  assert.equal(noExploited.states.Exploited, false);
  assert.deepEqual(filterPowerplaySystems(systems, noExploited).map((s) => s.name), ['Alpha', 'Gamma', 'Epsilon']);
  assert.equal(togglePowerplayState(noExploited, 'Exploited').states.Exploited, true);

  assert.deepEqual(parsePowerplayFilter({ hiddenPowers: ['Yuri Grom', 'Yuri Grom', 5, ''], states: { Exploited: false, Fortified: 'no' } }), {
    hiddenPowers: ['Yuri Grom'],
    states: { Stronghold: true, Fortified: true, Exploited: false },
  });
  assert.deepEqual(parsePowerplayFilter('garbage'), DEFAULT_POWERPLAY_FILTER);
});

test('счётчики, порядок списка, поиск по имени', () => {
  const systems = decodedSystems();
  const counts = countPowerplay(systems, ['Archon Delaine', 'Yuri Grom', 'Nakato Kaine']);
  assert.equal(counts.total, 5);
  assert.deepEqual(counts.states, { Stronghold: 1, Fortified: 2, Exploited: 2 });
  assert.deepEqual(counts.powers.map((p) => [p.power, p.total]), [['Yuri Grom', 3], ['Archon Delaine', 2], ['Nakato Kaine', 0]]);
  assert.equal(counts.unknown, 0);
  assert.ok(counts.powers.every((p) => p.contested === 0));
  assert.deepEqual(counts.powers[0].states, { Stronghold: 1, Fortified: 1, Exploited: 1 });

  assert.deepEqual(orderPowerplaySystems(systems).map((s) => s.name), ['Alpha', 'Gamma', 'Epsilon', 'Beta', 'Delta'], 'оплоты, укреплённые, эксплуатируемые');
  assert.deepEqual(searchPowerplaySystems(systems, 'ta').map((s) => s.name), ['Beta', 'Delta'], 'вхождение в середине имени, порядок входа сохранён');
  assert.deepEqual(searchPowerplaySystems(systems, 'GAMMA').map((s) => s.name), ['Gamma']);
  assert.deepEqual(searchPowerplaySystems(systems, 'e').map((s) => s.name).slice(0, 1), ['Epsilon'], 'совпадение с начала имени выше');
  assert.equal(searchPowerplaySystems(systems, '  ').length, 5);
  assert.equal(findPowerplaySystem(systems, '  delta ')?.id64, '13');
  assert.equal(findPowerplaySystem(systems, 'Nope'), null);
});

test('зоны влияния: оплот — 30 св. лет, укреплённая — 20, ближайшая система державы и число зон', () => {
  const systems = decodedSystems();
  // Точка между Alpha (оплот Grom, 0) и Gamma (укреплённая Delaine, 25).
  const at = powerplayInfluenceAt({ x: 12, y: 0, z: 0 }, systems);
  assert.deepEqual(at.map((item) => [item.power, item.nearest.name, item.nearest.state, Number(item.nearest.distance.toFixed(2)), item.sources]), [
    ['Yuri Grom', 'Alpha', 'Stronghold', 12, 1],
    ['Archon Delaine', 'Gamma', 'Fortified', 13, 1],
  ]);
  // На 29 св. лет от оплота Grom, но 54 от Gamma — Delaine не дотягивается.
  assert.deepEqual(powerplayInfluenceAt({ x: -29, y: 0, z: 0 }, systems).map((item) => item.power), ['Yuri Grom']);
  // Эксплуатируемые зоны не дают; сама система исключается.
  assert.deepEqual(powerplayInfluenceAt({ x: 0, y: 0, z: 0 }, systems, { excludeId64: '10' }).map((item) => item.power), []);
  assert.equal(powerplayInfluenceAt({ x: 5000, y: 0, z: 0 }, systems).length, 0);
  // Две зоны одной державы: ближайшая и счётчик.
  const both = powerplayInfluenceAt({ x: 85, y: 0, z: 0 }, [
    ...systems,
    { id64: '99', name: 'Zeta', nameLc: 'zeta', x: 95, y: 0, z: 0, power: 'Yuri Grom', state: 'Stronghold', observedAt: null, basis: null, candidates: [] },
  ]);
  assert.equal(both[0].power, 'Yuri Grom');
  assert.equal(both[0].nearest.name, 'Zeta');
  assert.equal(both[0].sources, 2);
  assert.equal(distanceLy({ x: 0, y: 3, z: 4 }, { x: 0, y: 0, z: 0 }), 5);
});

test('подписи: расстояния, даты по UTC и возраст наблюдения', () => {
  assert.equal(formatLy(4.5), '4,50 св. лет');
  assert.equal(formatLy(12.345), '12,3 св. лет');
  assert.equal(formatPowerplayDate('2026-10-16T23:59:03Z'), '16.10.2026');
  assert.equal(formatPowerplayDate(Date.parse('2026-01-02T00:00:00Z')), '02.01.2026');
  assert.equal(formatPowerplayDate(null), '—');
  assert.equal(formatPowerplayDate('nope'), '—');
  const now = Date.parse('2026-10-18T12:00:00Z');
  assert.equal(powerplayAge(now - 3600_000, now), 'сегодня');
  assert.equal(powerplayAge(now - 30 * 3600_000, now), 'вчера');
  assert.equal(powerplayAge(now - 5 * 86_400_000, now), '5 дн. назад');
  assert.equal(powerplayAge(null, now), 'дата наблюдения неизвестна');
});


/* ── Фильтр по державам: все державы и фракции ─────────────────────────── */

test('фильтр по державам: двенадцать держав до загрузки, встреченные в данных — в конец, фракции', () => {
  const powers = powerplayFilterPowers([]);
  assert.equal(powers.length, 12, 'все державы PowerPlay 2.0');
  assert.equal(POWERPLAY_ACTIVE_POWERS.length, 12);
  assert.ok(!powers.includes('Zachary Hudson'), 'наследие PowerPlay 1.0 — только если встретится в данных');
  assert.deepEqual(powerplayFilterPowers(['Jerome Archer', 'New Power']).slice(-1), ['New Power'], 'новая держава не теряется');
  assert.equal(powerplayFilterPowers(['Jerome Archer']).length, 12, 'известные не дублируются');

  const empire = soloAllegiance(DEFAULT_POWERPLAY_FILTER, 'Empire', powers);
  const shown = powers.filter((power) => isPowerVisible(empire, power));
  assert.deepEqual(shown.sort(), ['A. Lavigny-Duval', 'Aisling Duval', 'Denton Patreus', 'Zemina Torval']);
  assert.equal(isAllegianceSolo(empire, 'Empire', powers), true);
  assert.equal(isAllegianceSolo(empire, 'Federation', powers), false);
  assert.equal(isAllegianceSolo(DEFAULT_POWERPLAY_FILTER, 'Empire', powers), false, 'все показаны — ни одна фракция не «только»');
  const fed = soloAllegiance(DEFAULT_POWERPLAY_FILTER, 'Federation', powers);
  assert.deepEqual(powers.filter((power) => isPowerVisible(fed, power)).sort(), ['Felicia Winters', 'Jerome Archer']);
});

/* ── Ход импорта: этапы, проценты, журнал ──────────────────────────────── */

test('ход импорта: проценты по весам этапов, 304 — сразу 100 %, ошибка оставляет этап с ошибкой', () => {
  assert.equal(POWERPLAY_SYNC_STAGES.reduce((sum, stage) => sum + stage.weight, 0), 100, 'веса этапов — ровно сто');
  const at = '2026-10-18T10:00:00.000Z';
  const progress = createPowerplayProgress({ id: 'run-a', trigger: 'admin', force: true, now: at });
  assert.equal(progress.percent, 0);
  assert.equal(progress.phase, 'running');
  assert.deepEqual(progress.stages.map((stage) => stage.status), ['pending', 'pending', 'pending', 'pending', 'pending', 'pending']);

  startPowerplayStage(progress, 'request', { now: at });
  finishPowerplayStage(progress, 'request', { now: at });
  assert.equal(progress.percent, 4);
  startPowerplayStage(progress, 'download', { total: 1000, detail: 'начало', now: at });
  updatePowerplayStage(progress, 'download', { done: 500, detail: '500 из 1000' });
  assert.equal(progress.percent, 22, 'половина скачивания: 4 + 36/2');
  assert.equal(progress.message, 'Скачивание дампа: 500 из 1000');
  assert.equal(progress.stage, 'download');

  // Дамп не менялся: остальные этапы «не нужны», итог — 100 %.
  const notModified = createPowerplayProgress({ id: 'run-b', now: at });
  startPowerplayStage(notModified, 'request', { now: at });
  finishPowerplayStage(notModified, 'request', { now: at });
  finishPowerplayProgress(notModified, 'not_modified', { message: 'без изменений', now: at });
  assert.equal(notModified.percent, 100);
  assert.deepEqual(notModified.stages.map((stage) => stage.status), ['done', 'skipped', 'skipped', 'skipped', 'skipped', 'skipped']);

  // Ошибка посреди записи: этап с ошибкой, процент — сколько успели.
  startPowerplayStage(progress, 'write', { total: 100, now: at });
  updatePowerplayStage(progress, 'write', { done: 40 });
  finishPowerplayProgress(progress, 'error', { message: 'сбой', result: { error: 'сбой' }, now: at });
  const write = progress.stages.find((stage) => stage.id === 'write');
  assert.equal(write.status, 'error');
  assert.equal(progress.stages.find((stage) => stage.id === 'finish').status, 'pending', 'до завершения не дошли');
  assert.ok(progress.percent > 0 && progress.percent < 100);
  assert.equal(progress.percent, computePowerplayPercent(progress));
  assert.equal(publicPowerplayProgress(progress), null, 'закончившийся прогон во вкладку не отдаётся');
});

test('журнал импорта: обрезка по длине и количеству, разбор сохранённого хода и журнала', () => {
  const log = [];
  for (let i = 0; i < POWERPLAY_LOG_LIMIT + 15; i++) pushPowerplayLog(log, 'info', `строка ${i}`, { now: '2026-10-18T10:00:00.000Z' });
  assert.equal(log.length, POWERPLAY_LOG_LIMIT);
  assert.equal(log[0].text, 'строка 15', 'старые строки уходят сверху');
  const long = pushPowerplayLog(log, 'error', 'x'.repeat(1000));
  assert.equal(long.text.length, 400);

  assert.deepEqual(sanitizePowerplayLog([{ at: '2026-10-18T10:00:00Z', level: 'nope', text: 'ok' }, { at: 'bad', text: 'x' }, null, 'str']), [
    { at: '2026-10-18T10:00:00Z', level: 'info', text: 'ok' },
  ]);
  assert.deepEqual(sanitizePowerplayLog('junk'), []);

  const running = createPowerplayProgress({ id: 'run-c', trigger: 'cron', now: '2026-10-18T10:00:00.000Z' });
  startPowerplayStage(running, 'write', { total: 10, detail: 'пачка 1 из 5' });
  updatePowerplayStage(running, 'write', { done: 2 });
  const restored = sanitizePowerplayProgress(JSON.parse(JSON.stringify(running)));
  assert.equal(restored.trigger, 'cron');
  assert.equal(restored.stage, 'write');
  assert.equal(restored.percent, running.percent);
  assert.equal(restored.stages.length, POWERPLAY_SYNC_STAGES.length);
  assert.equal(sanitizePowerplayProgress({ id: 'x' }), null, 'без времени старта — не ход импорта');
  assert.equal(sanitizePowerplayProgress(null), null);
  const hostile = sanitizePowerplayProgress({ id: 'h', startedAt: '2026-10-18T10:00:00Z', phase: 'evil', trigger: 'root', stages: [{ id: 'write', status: 'boom', done: -5 }] });
  assert.equal(hostile.phase, 'error');
  assert.equal(hostile.trigger, 'manual');
  assert.equal(hostile.stages.find((stage) => stage.id === 'write').status, 'pending');
  assert.equal(hostile.stages.find((stage) => stage.id === 'write').done, 0);

  const pub = publicPowerplayProgress(running);
  assert.deepEqual(Object.keys(pub).sort(), ['message', 'percent', 'stage', 'stageLabel', 'startedAt'], 'наружу — без триггера и журнала');
  assert.equal(pub.stageLabel, 'Запись в базу');
  assert.equal(sanitizePublicPowerplayProgress({ stage: 'write', percent: 250, message: 'm' }).percent, 100);
  assert.equal(sanitizePublicPowerplayProgress('x'), null);

  // В ответе API слоя ход импорта переживает разбор в браузере.
  const decoded = decodePowerplayLayer({ status: 'empty', powers: [], systems: [], meta: { refreshing: true, progress: pub } });
  assert.equal(decoded.meta.progress.stage, 'write');
  assert.equal(decoded.meta.refreshing, true);
  assert.equal(decodePowerplayLayer({ status: 'empty', systems: [] }).meta.progress, null);
});

test('подписи хода импорта: байты и длительность', () => {
  assert.equal(formatPowerplayBytes(0), '0 Б');
  assert.equal(formatPowerplayBytes(512), '512 Б');
  assert.equal(formatPowerplayBytes(3_774_873), '3,6 МБ');
  assert.equal(formatPowerplayDuration(12_400), '12,4 с');
  assert.equal(formatPowerplayDuration(125_000), '2 мин 05 с');
  assert.equal(formatPowerplayDuration(-1), '—');
});
