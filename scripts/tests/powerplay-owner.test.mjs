/**
 * PowerPlay: чья система на самом деле (web 2.23.0) — сквозной путь на
 * настоящем PostgreSQL (PGlite) со всеми миграциями слоя.
 *
 * Жалоба: «Nakato Kaine у нас 3144 системы, в игре 1819; Aisling Duval у нас
 * 1580, в игре 3121». Причина — формат дампа EDSM: по записи на каждую
 * державу из поля журнала `Powers` (все, чьи зоны накрывают систему), с одной
 * датой; дамп отсортирован по номеру державы в EDSM (Aisling — 3, Nakato —
 * 13), а прежний разбор оставлял последнюю запись. Здесь проверяется:
 *   * импорт: спорная система не достаётся «последней» державе — владелец
 *     «не определён», державы — списком; у державы считаются только её системы;
 *   * журнал пилота (ControllingPower) называет владельца, и следующий дамп
 *     его сохраняет, пока держава среди перечисленных (`kept`);
 *   * журнал старше дампа, но не больше чем на 7 дней, тоже называет
 *     неопределённого владельца; более старый — нет;
 *   * пропала держава из списка — владелец снова не определён;
 *   * слой карты и сводка админки: «−1»/«?», претенденты, «+N?», основания.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { PGlite } from '@electric-sql/pglite';
import { TEST_ROOT, bundleFile } from './helpers/bundle.mjs';
import { SYSTEM_DATA_MIGRATIONS, SYSTEM_DATA_STUBS, readMigration } from './helpers/systemDataSchema.mjs';

// Архив и куски PowerPlay (web 2.24.0) — во временном каталоге, а не в data/spansh репозитория.
const PP_ARCHIVE_DIR = mkdtempSync(join(tmpdir(), 'pp-owner-archive-'));
process.env.POWERPLAY_ARCHIVE_DIR = PP_ARCHIVE_DIR;
test.after(() => rmSync(PP_ARCHIVE_DIR, { recursive: true, force: true }));
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';

const HELPER = join(TEST_ROOT, 'scripts', 'tests', 'helpers', 'pgliteSupabase.mjs').replace(/\\/g, '/');
const SUPABASE_STUB = `
import { pgliteClient } from '${HELPER}';
export const state = { db: null, userId: null, log: [] };
export function createServiceClient() { return pgliteClient(state); }
export async function createClient() { return pgliteClient(state); }
`;

const ENTRY = `
export { state, createServiceClient } from '@/lib/supabaseServer';
export { runPowerplaySync, readPowerplaySummary, getPowerplayLastRun } from '@/lib/powerplaySync';
export { loadPowerplayLayer, resetPowerplayLayerCache } from '@/lib/powerplayStore';
export { applySystemObservations } from '@/lib/systemObservations';
export { decodePowerplayLayer, countPowerplay, powerplayFilterPowers, POWERPLAY_UNKNOWN_POWER } from '@/lib/powerplay';
`;

const db = new PGlite();
await db.exec(SYSTEM_DATA_STUBS);
for (const file of SYSTEM_DATA_MIGRATIONS) await db.exec(readMigration(TEST_ROOT, file));
// Повторный прогон (снимок full_schema.sql + update-project.sh) — после того, как спорные строки появятся, тоже.
const bundle = await bundleFile({ entrySource: ENTRY, stubs: { '@/lib/supabaseServer': SUPABASE_STUB }, platform: 'node' });
const mod = await import(bundle);
mod.state.db = db;
const svc = mod.createServiceClient();

/* ── Подставной EDSM ───────────────────────────────────────────────────── */

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const at = (offsetMs) => new Date(Date.now() + offsetMs);
const edsmDate = (date) => date.toISOString().slice(0, 19).replace('T', ' ');

const SYSTEMS = {
  'Border A': { id64: 3107442165442, coords: { x: 60, y: -40, z: 12 } },
  'Border B': { id64: 3107442165443, coords: { x: 61, y: -40, z: 12 } },
  'Border C': { id64: 3107442165444, coords: { x: 62, y: -40, z: 12 } },
  'Border D': { id64: 3107442165445, coords: { x: 63, y: -40, z: 12 } },
  'Triple Point': { id64: 3107442165446, coords: { x: 64, y: -40, z: 12 } },
  'Aisling One': { id64: 3107442165447, coords: { x: 80, y: -40, z: 12 } },
  'Aisling Two': { id64: 3107442165448, coords: { x: 81, y: -40, z: 12 } },
  'Aisling Three': { id64: 3107442165449, coords: { x: 82, y: -40, z: 12 } },
  'Nakato One': { id64: 3107442165450, coords: { x: 40, y: -40, z: 12 } },
  'Nakato Two': { id64: 3107442165451, coords: { x: 41, y: -40, z: 12 } },
  'Free Space': { id64: 3107442165452, coords: { x: 50, y: -40, z: 12 } },
};

/** Номера держав в EDSM (EDSM-NET/Alias, System/Power.php): по ним дамп и отсортирован. */
const EDSM_POWER_ID = { 'Aisling Duval': 3, 'Jerome Archer': 12, 'Nakato Kaine': 13 };

/**
 * Дамп как у EDSM: по записи на каждую державу системы, одна дата на все
 * записи события, порядок — номер державы, затем дата.
 */
function edsmDump(systems, date) {
  const records = [];
  for (const [name, { powers, state }] of Object.entries(systems)) {
    for (const power of powers) {
      const { id64, coords } = SYSTEMS[name];
      records.push({ power, powerState: state, id: id64 % 100000, id64, name, coords, allegiance: 'Empire', government: 'Patronage', state: 'None', date: edsmDate(date) });
    }
  }
  records.sort((a, b) => EDSM_POWER_ID[a.power] - EDSM_POWER_ID[b.power] || a.date.localeCompare(b.date));
  return `[\n${records.map((record) => `    ${JSON.stringify(record)}`).join(',\n')}\n]`;
}

function fetchDump(text, lastModified) {
  return async () => new Response(gzipSync(Buffer.from(text, 'utf8')), {
    status: 200,
    headers: { 'Content-Type': 'application/gzip', ETag: `"dump-${lastModified.getTime()}"`, 'Last-Modified': lastModified.toUTCString() },
  });
}

const BOTH = ['Aisling Duval', 'Nakato Kaine'];
const FIRST_DUMP = {
  'Border A': { powers: BOTH, state: 'Exploited' },
  'Border B': { powers: BOTH, state: 'Exploited' },
  'Border C': { powers: BOTH, state: 'Fortified' },
  'Border D': { powers: BOTH, state: 'Exploited' },
  'Triple Point': { powers: ['Aisling Duval', 'Jerome Archer', 'Nakato Kaine'], state: 'Exploited' },
  'Aisling One': { powers: ['Aisling Duval'], state: 'Stronghold' },
  'Aisling Two': { powers: ['Aisling Duval'], state: 'Fortified' },
  'Aisling Three': { powers: ['Aisling Duval'], state: 'Exploited' },
  'Nakato One': { powers: ['Nakato Kaine'], state: 'Stronghold' },
  'Nakato Two': { powers: ['Nakato Kaine'], state: 'Exploited' },
  'Free Space': { powers: ['Aisling Duval', 'Jerome Archer', 'Nakato Kaine'], state: 'Unoccupied' },
};

async function row(name) {
  return (await db.query('SELECT power, power_basis, powers, power_state, source FROM powerplay_systems WHERE name = $1', [name])).rows[0];
}

async function summaryRow(power) {
  return (await mod.readPowerplaySummary(svc)).powers.find((item) => item.power === power);
}

function jump(name, power, state, timestamp) {
  const { id64, coords } = SYSTEMS[name];
  return {
    timestamp: timestamp.toISOString(),
    event: 'FSDJump',
    StarSystem: name,
    SystemAddress: String(id64),
    StarPos: [coords.x, coords.y, coords.z],
    SystemAllegiance: 'Empire',
    SystemGovernment: '$government_Patronage;',
    Population: 1000,
    SystemFaction: { Name: 'Owners' },
    Factions: [{ Name: 'Owners', FactionState: 'None', Government: 'Patronage', Influence: 1, Allegiance: 'Empire' }],
    ControllingPower: power,
    Powers: BOTH,
    PowerplayState: state,
  };
}

/* ── Сценарий ──────────────────────────────────────────────────────────── */

test('импорт: спорная система не достаётся «последней» державе, у державы — только её системы', async () => {
  const dumpAt = at(-2 * DAY);
  const result = await mod.runPowerplaySync(svc, { fetchImpl: fetchDump(edsmDump(FIRST_DUMP, dumpAt), at(-DAY)), minRows: 1 });
  assert.equal(result.status, 'ok', result.error);
  assert.equal(result.total, 10, 'десять систем под контролем, свободная не в счёт');
  assert.equal(result.stats.contested, 5);
  assert.equal(result.stats.sole, 5);
  assert.equal(result.stats.listings, 6, 'шесть записей «ещё одна держава той же системы»');

  const borderA = await row('Border A');
  assert.equal(borderA.power, null, 'раньше здесь стояла Nakato Kaine — последняя в файле');
  assert.equal(borderA.power_basis, 'unknown');
  assert.deepEqual(borderA.powers, BOTH);
  assert.deepEqual((await row('Triple Point')).powers, ['Aisling Duval', 'Jerome Archer', 'Nakato Kaine']);
  assert.equal((await row('Aisling One')).power_basis, 'sole');

  // Прежний разбор: Nakato 2 + 5 спорных = 7, Aisling 3. Теперь — только свои системы и «+5?».
  const nakato = await summaryRow('Nakato Kaine');
  const aisling = await summaryRow('Aisling Duval');
  assert.deepEqual([nakato.total, nakato.contested], [2, 5]);
  assert.deepEqual([aisling.total, aisling.contested], [3, 5]);
  assert.deepEqual([(await summaryRow('Jerome Archer')).total, (await summaryRow('Jerome Archer')).contested], [0, 1]);
  const summary = await mod.readPowerplaySummary(svc);
  assert.equal(summary.unknown.total, 5);
  assert.deepEqual(summary.unknown, { total: 5, Stronghold: 0, Fortified: 1, Exploited: 4 });
  assert.deepEqual(summary.bases, { sole: 5, unknown: 5 });

  const log = mod.getPowerplayLastRun().log.map((line) => line.text).join('\n');
  assert.match(log, /держав несколько — владелец по дампу не определён: 5/);
  assert.match(log, /Владелец системы: по журналам \(ControllingPower\) 0, по дампу \(одна держава\) 5, сохранён из прошлых точных данных 0, не определён 5/);
});

test('журнал пилота называет владельца: свежий — сразу, старше дампа до 7 дней — тоже, старше — нет', async () => {
  const result = await mod.applySystemObservations(svc, [
    // Новее дампа — обычное наблюдение пилота.
    jump('Border A', 'Aisling Duval', 'Exploited', at(-HOUR)),
    // Старше наблюдения дампа на 3 дня: владелец за это время смениться не мог.
    jump('Border B', 'Aisling Duval', 'Exploited', at(-5 * DAY)),
    // Старше на 10 дней — уже не довод.
    jump('Border C', 'Nakato Kaine', 'Fortified', at(-12 * DAY)),
  ], { source: 'helper', userId: null });
  assert.equal(result.powerplay.applied, 2);
  assert.equal(result.powerplay.resolved, 1);
  assert.equal(result.powerplay.stale, 1);

  assert.deepEqual(await row('Border A'), { power: 'Aisling Duval', power_basis: 'journal', powers: BOTH, power_state: 'Exploited', source: 'helper' });
  assert.deepEqual(await row('Border B'), { power: 'Aisling Duval', power_basis: 'kept', powers: BOTH, power_state: 'Exploited', source: 'edsm' });
  assert.equal((await row('Border C')).power, null);
  assert.deepEqual([(await summaryRow('Aisling Duval')).total, (await summaryRow('Aisling Duval')).contested], [5, 3]);
});

test('следующий дамп сохраняет точного владельца, пока он среди держав; пропал — снова «не определён»', async () => {
  const next = {
    ...FIRST_DUMP,
    // Border B: Aisling больше не в списке — прежний владелец не довод.
    'Border B': { powers: ['Jerome Archer', 'Nakato Kaine'], state: 'Exploited' },
    'Border A': { powers: BOTH, state: 'Fortified' },
  };
  const result = await mod.runPowerplaySync(svc, { fetchImpl: fetchDump(edsmDump(next, at(-30 * 60_000)), at(-10 * 60_000)), minRows: 1, force: true });
  assert.equal(result.status, 'ok', result.error);

  assert.deepEqual(await row('Border A'), { power: 'Aisling Duval', power_basis: 'kept', powers: BOTH, power_state: 'Fortified', source: 'edsm' });
  assert.deepEqual(await row('Border B'), { power: null, power_basis: 'unknown', powers: ['Jerome Archer', 'Nakato Kaine'], power_state: 'Exploited', source: 'edsm' });
  const log = mod.getPowerplayLastRun().log.map((line) => line.text).join('\n');
  assert.match(log, /сохранён из прошлых точных данных 1, не определён 4/);
});

test('слой карты: неопределённые — «?» с претендентами, у держав «+N?»; повторная миграция их не ломает', async () => {
  mod.resetPowerplayLayerCache();
  const layer = await mod.loadPowerplayLayer(svc, { refresh: false });
  const wire = JSON.parse(layer.body);
  assert.deepEqual(wire.bases, ['journal', 'sole', 'kept', 'unknown']);
  const decoded = mod.decodePowerplayLayer(wire);
  const byName = Object.fromEntries(decoded.systems.map((system) => [system.name, system]));
  assert.equal(decoded.systems.length, 10, 'спорные системы на карте, свободная — нет');
  assert.equal(byName['Border B'].power, mod.POWERPLAY_UNKNOWN_POWER);
  assert.deepEqual(byName['Border B'].candidates, ['Jerome Archer', 'Nakato Kaine']);
  assert.equal(byName['Border A'].power, 'Aisling Duval');
  assert.equal(byName['Border A'].basis, 'kept');
  assert.equal(byName['Aisling One'].basis, 'sole');

  const counts = mod.countPowerplay(decoded.systems, mod.powerplayFilterPowers(decoded.powers));
  const count = (power) => counts.powers.find((item) => item.power === power);
  assert.equal(counts.unknown, 4);
  assert.deepEqual([count('Aisling Duval').total, count('Aisling Duval').contested], [4, 3]);
  assert.deepEqual([count('Nakato Kaine').total, count('Nakato Kaine').contested], [2, 4]);
  assert.equal(counts.powers.at(-1).power, mod.POWERPLAY_UNKNOWN_POWER);

  // Снимок full_schema.sql и повторный прогон update-project.sh: CHECK прежней
  // миграции пропускает строки без владельца (power NULL, а не '').
  for (const file of SYSTEM_DATA_MIGRATIONS) await db.exec(readMigration(TEST_ROOT, file));
  assert.equal((await db.query('SELECT count(*)::int AS n FROM powerplay_systems WHERE power IS NULL')).rows[0].n, 4);
});
