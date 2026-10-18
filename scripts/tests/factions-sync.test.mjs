/**
 * Минорные фракции: импорт дампа EDSM, обновления от пилотов и API — на
 * настоящем PostgreSQL (PGlite) с миграцией `20261019120000_minor_factions.sql`.
 *
 * Маршруты собираются esbuild'ом с подменой `next/server`,
 * `@/lib/supabaseServer`, `@/lib/billing/auth` и `@/lib/helperAuth`; EDSM —
 * подставной `fetch` с настоящим gzip. Проверяется:
 *   * импорт: скачивание на диск, разбор потоком, запись пачками, этапы и
 *     журнал, архив удаляется; тот же дамп второй раз не качается;
 *   * API слоя (ETag/304), поиска (экранирование), присутствия, карточки;
 *   * `POST /api/factions/sync`: свежее применяется, старое — нет, новые
 *     системы появляются, состав фракций заменяется, журнал обновлений;
 *   * новый дамп не затирает свежие данные пилотов, удаляет пропавшие системы;
 *   * защита: мало систем, «усохший» дамп (force принимает), битый архив;
 *   * «Остановить» на скачивании и докачка с того же места (Range);
 *   * задача `factions-sync` и `/api/admin/factions`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { PGlite } from '@electric-sql/pglite';
import { TEST_ROOT, bundleFile } from './helpers/bundle.mjs';
import { DEFAULT_JOBS, JOBS } from '../job-schedule.mjs';

const ARCHIVE_DIR = mkdtempSync(join(tmpdir(), 'bgs-archive-'));
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
process.env.CRON_SECRET = 'factions-cron-secret';
process.env.FACTIONS_ARCHIVE_DIR = ARCHIVE_DIR;
process.env.FACTIONS_MIN_SYSTEMS = '2';
process.env.GALAXY_DOWNLOAD_SEGMENTS = '1';
test.after(() => rmSync(ARCHIVE_DIR, { recursive: true, force: true }));

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
`;

const AUTH_STUB = `
export const authState = { role: 'admin' };
const json = (body, status) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
export async function requireAdmin() {
  if (!authState.role) return { response: json({ error: 'Требуется авторизация' }, 401) };
  if (authState.role !== 'admin') return { response: json({ error: 'Access denied: Administrator required' }, 403) };
  return { actor: { userId: 'admin-1', cmdrName: 'CMDR Admin', email: null, role: 'admin', isPreview: false } };
}
`;

// Helper (API-токен) или сайт (сессия): тест выбирает, кто прислал журнал.
const HELPER_AUTH_STUB = `
export const helperState = { user: { userId: '11111111-1111-1111-1111-111111111111', via: 'api_token' } };
export async function resolveRequestUser() { return helperState.user; }
`;

const ENTRY = `
export * as layerRoute from '@/app/api/factions/systems/route';
export * as searchRoute from '@/app/api/factions/search/route';
export * as presenceRoute from '@/app/api/factions/presence/route';
export * as systemRoute from '@/app/api/factions/system/route';
export * as syncRoute from '@/app/api/factions/sync/route';
export * as adminRoute from '@/app/api/admin/factions/route';
export * as cronRoute from '@/app/api/cron/factions-sync/route';
export { state, createServiceClient } from '@/lib/supabaseServer';
export { authState } from '@/lib/billing/auth';
export { helperState } from '@/lib/helperAuth';
export {
  runBgsSync, startBgsSync, cancelBgsSync, isBgsSyncRunning, readBgsSyncState, resetBgsSyncRuntime, getBgsLastRun,
  getBgsLiveRun, bgsArchivePath, bgsArchiveInfo, decideBgsScheduledSync, nextBgsScheduledRun, BGS_SCHEDULE,
} from '@/lib/bgsSync';
export { resetBgsLayerCache } from '@/lib/bgsStore';
export { decodeBgsLayer, decodeFactionPresence, decodeFactionSearch, decodeSystemDetail } from '@/lib/bgs';
`;

const MIGRATION = readFileSync(join(TEST_ROOT, 'supabase', 'migrations', '20261019120000_minor_factions.sql'), 'utf8');
const db = new PGlite();
await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;');
await db.exec(MIGRATION);
// Снимок full_schema.sql и повторный прогон update-project.sh накатывают миграцию ещё раз.
await db.exec(MIGRATION);

const bundle = await bundleFile({
  entrySource: ENTRY,
  stubs: {
    'next/server': NEXT_SERVER_STUB,
    '@/lib/supabaseServer': SUPABASE_STUB,
    '@/lib/billing/auth': AUTH_STUB,
    '@/lib/helperAuth': HELPER_AUTH_STUB,
  },
  platform: 'node',
});
const mod = await import(bundle);
mod.state.db = db;
const svc = mod.createServiceClient();
const ARCHIVE = mod.bgsArchivePath();

/* ── Подставной дамп EDSM ──────────────────────────────────────────────── */

const DAY = 86_400;
const NOW_SEC = Math.floor(Date.now() / 1000);
const BIG_ID64 = '36028797018963971';

function faction(name, influence, extra = {}) {
  return {
    id: extra.id ?? name.length * 97, name, allegiance: extra.allegiance ?? 'Independent', government: extra.government ?? 'Cooperative',
    influence, state: extra.state ?? 'None', activeStates: (extra.active ?? []).map((state) => ({ state })),
    recoveringStates: [], pendingStates: (extra.pending ?? []).map((state) => ({ state, trend: 0 })),
    happiness: 'Happy', isPlayer: extra.isPlayer ?? false, lastUpdate: extra.lastUpdate ?? NOW_SEC - 3 * DAY,
  };
}

function system(name, id64, coords, factions, extra = {}) {
  return {
    id: 1, id64, name, coords, allegiance: extra.allegiance ?? 'Independent', government: extra.government ?? 'Cooperative',
    state: extra.state ?? 'None', economy: extra.economy ?? 'Industrial', security: extra.security ?? 'Medium',
    population: extra.population ?? 100000,
    controllingFaction: extra.controlling === null ? null : { id: 1, name: extra.controlling ?? factions[0]?.name, allegiance: extra.allegiance ?? 'Independent', government: 'Cooperative', isPlayer: false },
    ...(factions.length ? { factions } : {}),
  };
}

/** Строки как у EDSM: массив, запись на строку, id64 числом, станции и тела в хвосте. */
function dumpText(records, rawLines = []) {
  const lines = records.map((record) => {
    const head = JSON.stringify(record).replace(/"id64":"(\d+)"/, '"id64":$1').slice(0, -1);
    return `    ${head},"stations":[{"id":1,"name":"Port","controllingFaction":{"id":9,"name":"x"}}],"bodies":[{"id":2,"id64":5,"name":"Body A"}],"date":"2026-10-15 08:00:00"}`;
  });
  return `[\n${[...lines, ...rawLines].join(',\n')}\n]`;
}

const SOL = system('Sol', '10477373803', { x: 0, y: 0, z: 0 }, [
  faction('Mother Gaia', 0.6, { allegiance: 'Federation', government: 'Democracy', state: 'Boom', active: ['Boom'], lastUpdate: NOW_SEC - 2 * DAY }),
  faction('Sol Workers Party', 0.4, { allegiance: 'Federation', government: 'Democracy', lastUpdate: NOW_SEC - 2 * DAY }),
], { allegiance: 'Federation', government: 'Democracy', state: 'Boom', economy: 'Refinery', security: 'High', population: 22780919531 });
const LAVE = system('Lave', '3932277478106', { x: 75.75, y: 48.75, z: 70.75 }, [
  faction('Sol Workers Party', 0.55, { allegiance: 'Federation', government: 'Democracy' }),
  faction('Brave Pilots Union', 0.45, { isPlayer: true, pending: ['Expansion'] }),
]);
const ONLY_CONTROL = system('Control Only', '1000001', { x: 10, y: 10, z: 10 }, [], { controlling: 'Lonely Rulers' });
const COLONY = system('Col 285 Sector AB-C d14-3', BIG_ID64, { x: -24.53125, y: -33.78125, z: 108.8125 }, [
  faction('Ring Colony Pioneers', 1, { isPlayer: true, lastUpdate: NOW_SEC - DAY }),
]);
const V1 = dumpText([SOL, LAVE, ONLY_CONTROL, COLONY], ['{"broken":']);
const V1_GZ = gzipSync(Buffer.from(V1, 'utf8'));

const fetchCalls = [];

/** EDSM: HEAD (размер, дата, Range), GET целиком или с Range. */
function edsm(body, { etag = '"dump-1"', lastModified = 'Sat, 17 Oct 2026 04:50:00 GMT', stallAfter = null } = {}) {
  return async (url, init = {}) => {
    const headers = new Headers(init.headers || {});
    const method = init.method || 'GET';
    const range = headers.get('range');
    fetchCalls.push({ method, range, ua: headers.get('user-agent'), url: String(url) });
    const common = { etag, 'last-modified': lastModified, 'accept-ranges': 'bytes', 'content-type': 'application/gzip' };
    if (method === 'HEAD') return new Response(null, { status: 200, headers: { ...common, 'content-length': String(body.length) } });
    let start = 0;
    let status = 200;
    if (range) {
      const match = /bytes=(\d+)-(\d*)/.exec(range);
      start = Number(match[1]);
      status = 206;
    }
    const slice = body.subarray(start);
    const extra = status === 206 ? { 'content-range': `bytes ${start}-${body.length - 1}/${body.length}` } : {};
    if (stallAfter != null) {
      const signal = init.signal;
      let sent = false;
      const stream = new ReadableStream({
        pull(controller) {
          if (!sent) {
            sent = true;
            controller.enqueue(slice.subarray(0, stallAfter));
            return undefined;
          }
          return new Promise((_resolve, reject) => {
            if (signal?.aborted) return reject(signal.reason);
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        },
      });
      return new Response(stream, { status, headers: { ...common, ...extra, 'content-length': String(slice.length) } });
    }
    return new Response(slice, { status, headers: { ...common, ...extra, 'content-length': String(slice.length) } });
  };
}

async function waitFor(check, label, attempts = 600) {
  for (let i = 0; i < attempts; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`не дождались: ${label}`);
}

async function scalar(sql, params = []) {
  const { rows } = await db.query(sql, params);
  return rows[0] ? Object.values(rows[0])[0] : null;
}

const get = (route, path, headers = {}) => route.GET(new Request(`https://edringcolony.ru${path}`, { headers }));
const realFetch = globalThis.fetch;
test.after(() => {
  globalThis.fetch = realFetch;
});

function runOptions(fetchImpl, extra = {}) {
  return { fetchImpl, archivePath: ARCHIVE, segments: 1, keepArchive: false, trigger: 'manual', ...extra };
}

/* ── Импорт ────────────────────────────────────────────────────────────── */

test('импорт дампа EDSM: системы, фракции, присутствие, этапы и журнал, архив удалён', async () => {
  mod.resetBgsSyncRuntime();
  fetchCalls.length = 0;
  const result = await mod.runBgsSync(svc, runOptions(edsm(V1_GZ)));
  assert.equal(result.status, 'ok', result.error);
  assert.equal(result.systems, 4);
  assert.equal(result.factions, 5);
  assert.equal(result.presence, 6);
  assert.equal(result.stats.records, 5, 'битая строка посчитана');
  assert.equal(result.stats.skipped.invalid, 1);
  assert.equal(result.stats.playerFactions, 2);

  assert.deepEqual(fetchCalls.map((call) => call.method), ['HEAD', 'GET']);
  assert.ok(fetchCalls.every((call) => /ED-Ring-Colony/.test(call.ua ?? '')), 'свой User-Agent');
  assert.equal(existsSync(ARCHIVE), false, 'архив удалён после импорта');

  const colony = (await db.query('SELECT id64::text, name, source, factions_count, population FROM bgs_systems WHERE name = $1', ['Col 285 Sector AB-C d14-3'])).rows[0];
  assert.equal(colony.id64, BIG_ID64, 'id64 шире 2^53 без потери разрядов');
  assert.equal(colony.source, 'edsm');
  const lonely = (await db.query(`SELECT f.name, p.influence FROM bgs_faction_presence p JOIN bgs_factions f ON f.id = p.faction_id
    JOIN bgs_systems s ON s.id64 = p.system_id64 WHERE s.name = 'Control Only'`)).rows;
  assert.deepEqual(lonely, [{ name: 'Lonely Rulers', influence: null }], 'контролирующая без списка — одна, влияние неизвестно');
  const workers = (await db.query(`SELECT systems_count, controlled_count, is_player FROM bgs_factions WHERE name = 'Sol Workers Party'`)).rows[0];
  assert.deepEqual(workers, { systems_count: 2, controlled_count: 1, is_player: false });
  assert.equal(await scalar(`SELECT is_player FROM bgs_factions WHERE name = 'Brave Pilots Union'`), true);

  const state = await mod.readBgsSyncState(svc);
  assert.equal(state.status, 'ok');
  assert.equal(state.etag, '"dump-1"');
  assert.equal(state.dump_generated_at, '2026-10-17T04:50:00.000Z');
  assert.equal(state.dump_bytes, V1_GZ.length);
  assert.equal(state.systems_total, 4);
  assert.ok(state.synced_at);

  const { progress, log } = mod.getBgsLastRun();
  assert.equal(progress.phase, 'ok');
  assert.equal(progress.percent, 100);
  assert.deepEqual(progress.stages.map((stage) => [stage.id, stage.status]), [['probe', 'done'], ['download', 'done'], ['import', 'done'], ['finish', 'done']]);
  assert.equal(progress.stages[1].done, V1_GZ.length, 'скачивание в байтах');
  const text = log.map((line) => line.text).join('\n');
  assert.match(text, /Запуск импорта: вручную/);
  assert.match(text, /Скачиваю дамп на диск/);
  assert.match(text, /населённых систем с фракциями: 4/);
  assert.match(text, /Архив удалён с диска/);
  assert.equal(state.log.length, log.length, 'журнал — копией в базе');
});

test('тот же дамп второй раз не качается («без изменений»)', async () => {
  fetchCalls.length = 0;
  const result = await mod.runBgsSync(svc, runOptions(edsm(V1_GZ)));
  assert.equal(result.status, 'not_modified');
  assert.deepEqual(fetchCalls.map((call) => call.method), ['HEAD'], 'только HEAD');
  assert.equal(mod.getBgsLastRun().progress.phase, 'not_modified');
});

test('API слоя, поиска, присутствия и карточки системы', async () => {
  mod.resetBgsLayerCache();
  const response = await get(mod.layerRoute, '/api/factions/systems');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control'), /public/);
  const etag = response.headers.get('etag');
  assert.match(etag, /^"bgs-/);
  assert.ok(Number(response.headers.get('x-content-bytes')) > 100);
  const layer = mod.decodeBgsLayer(await response.json());
  assert.equal(layer.status, 'ready');
  assert.equal(layer.systems.length, 4);
  assert.equal(layer.meta.factions, 5);
  assert.equal(layer.meta.dumpGeneratedAt, '2026-10-17T04:50:00.000Z');
  const colony = layer.systems.find((item) => item.name.startsWith('Col 285'));
  assert.equal(colony.id64, BIG_ID64);
  assert.equal(colony.controlling, 'Ring Colony Pioneers');
  assert.equal(layer.systems.find((item) => item.name === 'Sol').government, 'Democracy');
  const cached = await get(mod.layerRoute, '/api/factions/systems', { 'if-none-match': etag });
  assert.equal(cached.status, 304);
  // Короткий ответ — только состояние, без систем.
  const short = await get(mod.layerRoute, '/api/factions/systems?meta=1');
  assert.equal(short.headers.get('cache-control'), 'no-store');
  const shortBody = await short.json();
  assert.deepEqual(Object.keys(shortBody).sort(), ['meta', 'status', 'version']);
  assert.equal(shortBody.status, 'ready');
  assert.equal(shortBody.meta.systems, 4);
  assert.equal(shortBody.meta.refreshing, false);

  const found = mod.decodeFactionSearch(await (await get(mod.searchRoute, '/api/factions/search?q=WORKERS')).json());
  assert.deepEqual(found.map((item) => [item.name, item.systems, item.controlled]), [['Sol Workers Party', 2, 1]]);
  const prefixFirst = mod.decodeFactionSearch(await (await get(mod.searchRoute, '/api/factions/search?q=r')).json());
  assert.equal(prefixFirst[0].name, 'Ring Colony Pioneers', 'начало имени — раньше вхождения');
  const players = mod.decodeFactionSearch(await (await get(mod.searchRoute, '/api/factions/search?player=1')).json());
  assert.deepEqual(players.map((item) => item.name).sort(), ['Brave Pilots Union', 'Ring Colony Pioneers']);
  const wildcard = mod.decodeFactionSearch(await (await get(mod.searchRoute, '/api/factions/search?q=%25')).json());
  assert.deepEqual(wildcard, [], '% в запросе — буква, а не шаблон');
  const top = mod.decodeFactionSearch(await (await get(mod.searchRoute, '/api/factions/search?limit=2')).json());
  assert.equal(top[0].name, 'Sol Workers Party', 'пустой запрос — самые распространённые');
  assert.equal(top.length, 2);

  const workersId = found[0].id;
  const presence = mod.decodeFactionPresence(await (await get(mod.presenceRoute, `/api/factions/presence?ids=${workersId},999999,abc`)).json());
  assert.equal(presence.length, 1);
  assert.deepEqual(presence[0].systems.map((item) => [item.name, item.influence, item.controls]), [['Lave', 0.55, true], ['Sol', 0.4, false]]);
  assert.equal((await get(mod.presenceRoute, '/api/factions/presence?ids=')).status, 400);

  const detail = mod.decodeSystemDetail(await (await get(mod.systemRoute, `/api/factions/system?id64=${BIG_ID64}`)).json());
  assert.equal(detail.id64, BIG_ID64);
  assert.equal(detail.controlling, 'Ring Colony Pioneers');
  assert.equal(detail.factions[0].isPlayer, true);
  const sol = mod.decodeSystemDetail(await (await get(mod.systemRoute, '/api/factions/system?id64=10477373803')).json());
  assert.equal(sol.security, 'High');
  assert.equal(sol.economy, 'Refinery');
  assert.deepEqual(sol.factions.map((item) => item.name), ['Mother Gaia', 'Sol Workers Party'], 'по убыванию влияния');
  assert.deepEqual(sol.factions[0].activeStates, ['Boom']);
  assert.equal((await get(mod.systemRoute, '/api/factions/system?id64=424242')).status, 404);
  assert.equal((await get(mod.systemRoute, '/api/factions/system?id64=abc')).status, 400);
});

/* ── Обновления от пилотов ─────────────────────────────────────────────── */

function journalJump(systemName, address, pos, timestamp, factions, controlling) {
  return {
    event: 'FSDJump', timestamp, StarSystem: systemName, SystemAddress: address, StarPos: pos,
    SystemAllegiance: 'Federation', SystemGovernment: '$government_Democracy;', SystemEconomy: '$economy_Refinery;',
    SystemSecurity: '$SYSTEM_SECURITY_high;', Population: 22780919531,
    SystemFaction: { Name: controlling, FactionState: 'Election' },
    Factions: factions,
  };
}

function postSync(body) {
  return mod.syncRoute.POST(new Request('https://edringcolony.ru/api/factions/sync', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }));
}

test('POST /api/factions/sync: свежее применяется, старое — нет, новая система появляется', async () => {
  const fresh = new Date(Date.now() - 3600_000).toISOString();
  const stale = new Date(Date.now() - 30 * DAY * 1000).toISOString();
  const events = [
    // Sol: свежее дампа — влияние другое, Sol Workers Party ушла, пришла новая фракция.
    journalJump('Sol', '10477373803', [0, 0, 0], fresh, [
      { Name: 'Mother Gaia', Influence: 0.7, FactionState: 'Election', Allegiance: 'Federation', Government: 'Democracy', ActiveStates: [{ State: 'Election' }], MyReputation: 10 },
      { Name: 'New Frontier Party', Influence: 0.3, FactionState: 'None', Allegiance: 'Federation', Government: 'Democracy' },
    ], 'Mother Gaia'),
    // Новая колония, которой нет в дампе.
    journalJump('Fresh Colony', '2222222', [5, 5, 5], fresh, [{ Name: 'Fresh Colony Settlers', Influence: 1, Allegiance: 'Independent', Government: 'Cooperative' }], 'Fresh Colony Settlers'),
    // Lave: журнал старше дампа — не применяется.
    journalJump('Lave', '3932277478106', [75.75, 48.75, 70.75], stale, [{ Name: 'Old Guard', Influence: 1 }], 'Old Guard'),
    // Без адреса — отброшено.
    { ...journalJump('Nowhere', null, [1, 1, 1], fresh, [{ Name: 'X', Influence: 1 }], 'X'), SystemAddress: undefined },
  ];
  const response = await postSync({ token: 'helper-token', events });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.received, 4);
  assert.equal(body.accepted, 3);
  assert.equal(body.applied, 2);
  assert.equal(body.stale, 1);
  assert.equal(body.created, 1);
  assert.equal(body.invalid, 1);
  assert.deepEqual(body.rejected, { address: 1 });
  assert.deepEqual(body.systems.sort(), ['Fresh Colony', 'Sol']);

  const sol = (await db.query(`SELECT source, state, observed_at, factions_count FROM bgs_systems WHERE name = 'Sol'`)).rows[0];
  assert.equal(sol.source, 'helper');
  assert.equal(sol.state, 'Election', 'состояние системы — из SystemFaction');
  assert.equal(sol.factions_count, 2);
  const solFactions = (await db.query(`SELECT f.name, p.influence FROM bgs_faction_presence p JOIN bgs_factions f ON f.id = p.faction_id
    WHERE p.system_id64 = 10477373803 ORDER BY f.name`)).rows;
  assert.deepEqual(solFactions.map((row) => row.name), ['Mother Gaia', 'New Frontier Party'], 'состав системы заменён целиком');
  assert.equal(await scalar(`SELECT systems_count FROM bgs_factions WHERE name = 'Sol Workers Party'`), 1, 'счётчик ушедшей фракции пересчитан');
  assert.equal(await scalar(`SELECT is_player FROM bgs_factions WHERE name = 'Fresh Colony Settlers'`), false);
  assert.equal(await scalar(`SELECT source FROM bgs_systems WHERE name = 'Lave'`), 'edsm', 'старый журнал не затёр дамп');
  assert.equal(await scalar(`SELECT count(*)::int FROM bgs_factions WHERE name = 'Old Guard'`), 1, 'фракция из старого журнала заведена в словаре');

  const update = (await db.query('SELECT user_id::text, source, received, applied, stale, created, invalid, systems FROM bgs_updates')).rows[0];
  assert.deepEqual({ ...update, systems: update.systems.sort() }, {
    user_id: '11111111-1111-1111-1111-111111111111', source: 'helper', received: 4, applied: 2, stale: 1, created: 1, invalid: 1,
    systems: ['Fresh Colony', 'Sol'],
  });

  // Загрузчик на сайте (сессия) — источник «web».
  mod.helperState.user = { userId: '22222222-2222-2222-2222-222222222222', via: 'session' };
  const later = new Date(Date.now() - 600_000).toISOString();
  const webBody = await (await postSync({ events: [journalJump('Fresh Colony', '2222222', [5, 5, 5], later, [{ Name: 'Fresh Colony Settlers', Influence: 0.9 }, { Name: 'Second Wave', Influence: 0.1 }], 'Fresh Colony Settlers')] })).json();
  assert.equal(webBody.applied, 1);
  assert.equal(await scalar(`SELECT source FROM bgs_systems WHERE name = 'Fresh Colony'`), 'web');

  // Повтор той же пачки ничего не меняет.
  const repeat = await (await postSync({ events: [journalJump('Fresh Colony', '2222222', [5, 5, 5], fresh, [{ Name: 'Fresh Colony Settlers', Influence: 1 }], 'Fresh Colony Settlers')] })).json();
  assert.equal(repeat.applied, 0);
  assert.equal(repeat.stale, 1);

  mod.helperState.user = null;
  assert.equal((await postSync({ events: [] })).status, 401);
  mod.helperState.user = { userId: '11111111-1111-1111-1111-111111111111', via: 'api_token' };
  assert.equal((await postSync({ events: 'x' })).status, 400);
  assert.equal((await postSync({ events: Array.from({ length: 501 }, () => ({})) })).status, 413);
  const invalid = await mod.syncRoute.POST(new Request('https://edringcolony.ru/api/factions/sync', { method: 'POST', body: '{' }));
  assert.equal(invalid.status, 400);

  // Слой пересобирается с новой системой.
  mod.resetBgsLayerCache();
  const layer = mod.decodeBgsLayer(await (await get(mod.layerRoute, '/api/factions/systems')).json());
  assert.equal(layer.systems.length, 5);
  assert.ok(layer.meta.pilotUpdateAt, 'время последнего обновления от пилотов');
  assert.equal(layer.systems.find((item) => item.name === 'Fresh Colony').source, 'web');
});

test('новый дамп не затирает свежие данные пилотов и удаляет пропавшие системы', async () => {
  const solOld = system('Sol', '10477373803', { x: 0, y: 0, z: 0 }, [
    faction('Mother Gaia', 0.5, { allegiance: 'Federation', government: 'Democracy', lastUpdate: NOW_SEC - DAY }),
    faction('Sol Workers Party', 0.5, { allegiance: 'Federation', government: 'Democracy', lastUpdate: NOW_SEC - DAY }),
  ], { allegiance: 'Federation', government: 'Democracy' });
  // Control Only и Fresh Colony в дампе нет.
  const v2 = gzipSync(Buffer.from(dumpText([solOld, LAVE, COLONY]), 'utf8'));
  const result = await mod.runBgsSync(svc, runOptions(edsm(v2, { etag: '"dump-2"' })));
  assert.equal(result.status, 'ok', result.error);
  assert.equal(result.stale, 1, 'Sol у пилота свежее — не тронут');
  assert.equal(result.deletedSystems, 1, 'удалена только Control Only');

  const names = (await db.query('SELECT name, source FROM bgs_systems ORDER BY name')).rows;
  assert.deepEqual(names, [
    { name: 'Col 285 Sector AB-C d14-3', source: 'edsm' },
    { name: 'Fresh Colony', source: 'web' },
    { name: 'Lave', source: 'edsm' },
    { name: 'Sol', source: 'helper' },
  ], 'свежая колония пилота живёт, пропавшая из дампа система EDSM удалена');
  assert.equal(await scalar(`SELECT count(*)::int FROM bgs_factions WHERE name IN ('Lonely Rulers', 'Old Guard')`), 0, 'фракции без систем удалены');
  assert.equal(await scalar(`SELECT systems_count FROM bgs_factions WHERE name = 'Sol Workers Party'`), 1);
});

test('защита: мало систем, «усохший» дамп (принудительно — принимается), битый архив', async () => {
  const before = await scalar('SELECT count(*)::int FROM bgs_systems');
  const tiny = gzipSync(Buffer.from(dumpText([LAVE]), 'utf8'));
  const few = await mod.runBgsSync(svc, runOptions(edsm(tiny, { etag: '"tiny"' })));
  assert.equal(few.status, 'error');
  assert.match(few.error, /всего 1 населённых систем/);
  assert.equal(await scalar('SELECT count(*)::int FROM bgs_systems'), before, 'ничего не удалено');
  assert.equal((await mod.readBgsSyncState(svc)).status, 'error');
  assert.equal(existsSync(ARCHIVE), true, 'целый архив остался на диске');

  const extras = [1, 2, 3].map((n) => system(`Extra ${n}`, String(9000 + n), { x: n, y: n, z: n }, [faction(`Extra Faction ${n}`, 1)]));
  const big = gzipSync(Buffer.from(dumpText([LAVE, COLONY, ...extras]), 'utf8'));
  const grown = await mod.runBgsSync(svc, runOptions(edsm(big, { etag: '"big"' })));
  assert.equal(grown.status, 'ok', grown.error);
  assert.match(mod.getBgsLastRun().log.map((line) => line.text).join('\n'), /архив другого дампа/, 'хвост нового дампа не дописан к старому');
  const total = await scalar('SELECT count(*)::int FROM bgs_systems');
  assert.equal(total, 7, 'Sol и Fresh Colony — от пилотов, остальное — дамп');

  const shrunk = gzipSync(Buffer.from(dumpText([LAVE, COLONY]), 'utf8'));
  const guarded = await mod.runBgsSync(svc, runOptions(edsm(shrunk, { etag: '"shrunk"' })));
  assert.equal(guarded.status, 'error');
  assert.match(guarded.error, /подозрительно мал: 2 систем против 7/);
  assert.equal(await scalar('SELECT count(*)::int FROM bgs_systems'), total, 'пропавшие системы не удалены');

  const forced = await mod.runBgsSync(svc, runOptions(edsm(shrunk, { etag: '"shrunk"' }), { force: true }));
  assert.equal(forced.status, 'ok', forced.error);
  assert.equal(forced.deletedSystems, 3, 'принудительно — принят, Extra удалены');
  assert.equal(await scalar(`SELECT count(*)::int FROM bgs_systems WHERE source = 'edsm'`), 2);

  const broken = V1_GZ.subarray(0, Math.floor(V1_GZ.length * 0.6));
  const corrupt = await mod.runBgsSync(svc, runOptions(edsm(broken, { etag: '"broken"' })));
  assert.equal(corrupt.status, 'error');
  assert.equal(existsSync(ARCHIVE), false, 'битый архив удалён — следующий запуск скачает заново');
  assert.match(mod.getBgsLastRun().log.map((line) => line.text).join('\n'), /Архив повреждён/);
});

test('«Остановить» на скачивании: скачанное остаётся, следующий запуск докачивает через Range', async () => {
  const v3 = gzipSync(Buffer.from(dumpText([SOL, LAVE, COLONY]), 'utf8'));
  fetchCalls.length = 0;
  const started = mod.startBgsSync(svc, { ...runOptions(edsm(v3, { etag: '"dump-3"', stallAfter: 40 })), trigger: 'admin' });
  assert.equal(started.started, true);
  assert.equal(mod.startBgsSync(svc, runOptions(edsm(v3))).started, false, 'второй не начинается');
  await waitFor(() => existsSync(ARCHIVE) && statSync(ARCHIVE).size >= 40, 'первые байты на диске');
  assert.equal(mod.getBgsLiveRun().progress.stage, 'download');
  // Вкладка Atlas видит идущий импорт коротким запросом.
  const watching = await (await get(mod.layerRoute, '/api/factions/systems?meta=1')).json();
  assert.equal(watching.meta.refreshing, true);
  assert.equal(watching.meta.progress.stage, 'download');
  assert.equal(watching.meta.progress.stageLabel, 'Скачивание дампа на диск');
  assert.equal(mod.cancelBgsSync(), true);
  await waitFor(() => !mod.isBgsSyncRunning(), 'импорт остановлен');
  const last = mod.getBgsLastRun();
  assert.equal(last.progress.phase, 'cancelled');
  assert.match(last.log.map((line) => line.text).join('\n'), /докачает/);
  assert.equal(statSync(ARCHIVE).size, 40, 'скачанная часть на диске');
  assert.equal(mod.bgsArchiveInfo(ARCHIVE).complete, false);

  fetchCalls.length = 0;
  const resumed = await mod.runBgsSync(svc, runOptions(edsm(v3, { etag: '"dump-3"' })));
  assert.equal(resumed.status, 'ok', resumed.error);
  const get3 = fetchCalls.find((call) => call.method === 'GET');
  assert.equal(get3.range, 'bytes=40-', 'докачка с того же места');
});

/* ── Задача планировщика ───────────────────────────────────────────────── */

test('задача factions-sync: секрет, первый импорт — только из админки, обновление устаревших', async () => {
  const job = JOBS.find((item) => item.name === 'factions-sync');
  assert.ok(job, 'задача есть в планировщике');
  assert.equal(job.path, '/api/cron/factions-sync');
  assert.equal(job.period, mod.BGS_SCHEDULE.periodMs);
  assert.equal(job.offset, mod.BGS_SCHEDULE.offsetMs);
  assert.ok(DEFAULT_JOBS.includes('factions-sync'), 'включена по умолчанию: первый импорт она не делает');
  const next = mod.nextBgsScheduledRun(Date.parse('2026-10-18T08:00:00Z'));
  assert.equal(next, '2026-10-19T07:10:00.000Z');

  const base = { status: 'ok', synced_at: null, attempt_at: null, progress: null };
  assert.deepEqual(mod.decideBgsScheduledSync({ ...base }), { action: 'skip', reason: 'not_initialized' });
  assert.deepEqual(mod.decideBgsScheduledSync({ ...base, synced_at: new Date().toISOString() }), { action: 'skip', reason: 'fresh' });
  assert.deepEqual(mod.decideBgsScheduledSync({ ...base, synced_at: new Date(Date.now() - 8 * DAY * 1000).toISOString() }), { action: 'start', reason: 'stale' });
  assert.deepEqual(mod.decideBgsScheduledSync({ ...base, status: 'running', attempt_at: new Date(Date.now() - 7 * 3600_000).toISOString() }), { action: 'start', reason: 'interrupted' });
  assert.deepEqual(mod.decideBgsScheduledSync({ ...base, status: 'running', attempt_at: new Date().toISOString(), progress: { updatedAt: new Date().toISOString() } }), { action: 'skip', reason: 'running_elsewhere' });
  assert.deepEqual(mod.decideBgsScheduledSync({ ...base }, { force: true }), { action: 'start', reason: 'forced' });

  const url = 'https://edringcolony.ru/api/cron/factions-sync';
  assert.equal((await mod.cronRoute.GET(new Request(url))).status, 401, 'без секрета нельзя');
  const auth = { authorization: `Bearer ${process.env.CRON_SECRET}` };
  const fresh = await (await mod.cronRoute.GET(new Request(url, { headers: auth }))).json();
  assert.deepEqual([fresh.ok, fresh.skipped, fresh.reason], [true, true, 'fresh']);

  await db.query(`UPDATE bgs_sync_state SET synced_at = now() - interval '9 days'`);
  const v4 = gzipSync(Buffer.from(dumpText([SOL, LAVE, COLONY]), 'utf8'));
  globalThis.fetch = edsm(v4, { etag: '"dump-4"' });
  try {
    const started = await (await mod.cronRoute.POST(new Request(url, { method: 'POST', headers: auth }))).json();
    assert.deepEqual([started.ok, started.started, started.reason], [true, true, 'stale']);
    await waitFor(() => !mod.isBgsSyncRunning(), 'фоновый импорт задачи завершился');
    const last = mod.getBgsLastRun();
    assert.equal(last.progress.phase, 'ok', last.progress.message);
    assert.equal(last.progress.trigger, 'cron');
    assert.match(last.log.map((line) => line.text).join('\n'), /Запуск импорта: задача планировщика factions-sync/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

/* ── Короткий statement_timeout PostgREST ──────────────────────────────── */

test('короткий statement_timeout: пачки делятся пополам, завершение — малыми шагами', async () => {
  const timeout = () => Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
  const calls = { apply: 0, recount: [], deleteLimits: [] };
  mod.state.rpcGuard = async (name, args) => {
    if (name === 'bgs_apply_snapshots') {
      calls.apply += 1;
      if (Array.isArray(args.p_rows) && args.p_rows.length > 1) throw timeout();
    }
    if (name === 'bgs_recount_factions_batch') {
      calls.recount.push(args.p_limit);
      if (args.p_limit > 1000) throw timeout();
    }
    if (name === 'bgs_delete_missing') {
      calls.deleteLimits.push(args.p_limit);
      if (args.p_limit > 100) throw timeout();
    }
  };
  try {
    const dump = gzipSync(Buffer.from(dumpText([SOL, LAVE, COLONY]), 'utf8'));
    const result = await mod.runBgsSync(svc, runOptions(edsm(dump, { etag: '"timeouts"' }), { batchSize: 3 }));
    assert.equal(result.status, 'ok', result.error);
    assert.equal(result.systems, 4);
    assert.ok(calls.apply >= 5, 'пачка из трёх систем разделена до одной');
    assert.deepEqual(calls.deleteLimits.slice(0, 6), [2000, 1000, 500, 250, 125, 62], 'удаление — всё меньшими пачками');
    assert.deepEqual(calls.recount.slice(0, 4), [5000, 2500, 1250, 625], 'пересчёт — меньшими пачками');
    assert.match(mod.getBgsLastRun().log.map((line) => line.text).join('\n'), /не уложилась в statement_timeout базы — делю пополам/);
  } finally {
    mod.state.rpcGuard = null;
  }
  assert.equal(await scalar(`SELECT systems_count FROM bgs_factions WHERE name = 'Sol Workers Party'`), 1, 'счётчики пересчитаны');
  // Повторные импорты не сжигают последовательность id: известные фракции не вставляются заново.
  const lastId = Number(await scalar('SELECT last_value FROM bgs_factions_id_seq'));
  assert.ok(lastId < 30, `последовательность id: ${lastId} после десятка импортов`);
});

/* ── Админка ───────────────────────────────────────────────────────────── */

function adminRequest(method = 'GET', body) {
  return new Request('https://edringcolony.ru/api/admin/factions', {
    method,
    headers: { 'content-type': 'application/json', authorization: 'Bearer test' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

test('/api/admin/factions: права, состояние, сводка, обновления пилотов, запуск, 409, остановка, архив', async () => {
  mod.authState.role = null;
  assert.equal((await mod.adminRoute.GET(adminRequest())).status, 401);
  mod.authState.role = 'user';
  assert.equal((await mod.adminRoute.GET(adminRequest())).status, 403);
  mod.authState.role = 'admin';

  const response = await mod.adminRoute.GET(adminRequest());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const status = await response.json();
  assert.equal(status.success, true);
  assert.equal(status.running, false);
  assert.equal(status.interrupted, false);
  assert.equal(status.state.status, 'ok');
  assert.equal(status.summary.systems, 4);
  assert.ok(status.summary.factions >= 4);
  assert.equal(status.summary.playerFactions, 2, 'Brave Pilots Union и Ring Colony Pioneers');
  assert.ok(status.summary.updates7d >= 3);
  assert.equal(status.summary.reporters7d, 2);
  assert.deepEqual(status.summary.sources, { edsm: 2, helper: 1, web: 1 });
  assert.ok(status.updates.length >= 3);
  assert.equal(status.updates.at(-1).source, 'helper');
  assert.deepEqual(status.updates.at(-1).systems.sort(), ['Fresh Colony', 'Sol']);
  assert.equal(status.updates.at(-1).cmdr, null, 'без таблицы профилей — без имени');
  assert.equal(status.progress.phase, 'ok');
  assert.ok(status.log.length > 10);
  assert.equal(status.archive.path, ARCHIVE);
  assert.equal(status.config.minSystems, 2);
  assert.equal(status.config.refreshDays, 7);
  assert.deepEqual(status.config.scheduleDecision, { action: 'skip', reason: 'fresh' });
  assert.match(status.config.dumpUrl, /systemsPopulated\.json\.gz$/);

  const v5 = gzipSync(Buffer.from(dumpText([SOL, LAVE, COLONY]), 'utf8'));
  globalThis.fetch = edsm(v5, { etag: '"dump-5"', stallAfter: 30 });
  try {
    const start = await mod.adminRoute.POST(adminRequest('POST', { action: 'start' }));
    assert.equal(start.status, 200);
    assert.deepEqual(await start.json(), { success: true, started: true, force: false });
    const again = await mod.adminRoute.POST(adminRequest('POST', { action: 'start', force: true }));
    assert.equal(again.status, 409);
    const running = await (await mod.adminRoute.GET(adminRequest())).json();
    assert.equal(running.running, true);
    await waitFor(() => existsSync(ARCHIVE) && statSync(ARCHIVE).size >= 30, 'скачивание пошло');
    const cancel = await (await mod.adminRoute.POST(adminRequest('POST', { action: 'cancel' }))).json();
    assert.deepEqual(cancel, { success: true, cancelled: true });
    await waitFor(() => !mod.isBgsSyncRunning(), 'остановлено');
  } finally {
    globalThis.fetch = realFetch;
  }
  const after = await (await mod.adminRoute.GET(adminRequest())).json();
  assert.equal(after.progress.phase, 'cancelled');
  assert.equal(after.archive.exists, true);
  assert.equal(after.archive.partial, false, 'одним потоком — без плана сегментов');
  assert.equal(after.archive.complete, false);

  const cleanup = await (await mod.adminRoute.POST(adminRequest('POST', { action: 'cleanup' }))).json();
  assert.equal(cleanup.success, true);
  assert.equal(cleanup.removed, true);
  assert.equal(cleanup.freed, 30);
  assert.equal(existsSync(ARCHIVE), false);
  assert.equal((await mod.adminRoute.POST(adminRequest('POST', { action: 'cancel' }))).status, 200);
  assert.equal((await mod.adminRoute.POST(adminRequest('POST', { action: 'bogus' }))).status, 400);
});
