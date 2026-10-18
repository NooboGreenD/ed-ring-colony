/**
 * Минорные фракции: импорт дампа EDSM, обновления от пилотов и API — на
 * настоящем PostgreSQL (PGlite) с миграцией `20261019120000_minor_factions.sql`.
 *
 * Маршруты собираются esbuild'ом с подменой `next/server`,
 * `@/lib/supabaseServer`, `@/lib/billing/auth` и `@/lib/helperAuth`; EDSM —
 * подставной `fetch` с настоящим gzip и Range. Проверяется:
 *   * импорт: архив на сервер, разбивка на куски, запись кусков, этапы и
 *     журнал, архив и куски удаляются; тот же дамп второй раз не качается;
 *   * конвейер как у каталога, шаги по очереди: соединения берут куски файла
 *     по порядку, разбивка начинается, когда архив скачан целиком, запись —
 *     когда архив разбит; остановка посреди записи и продолжение без
 *     повторного скачивания (та же метка импорта);
 *   * сеть, «замораживающая» TCP-сессии после нескольких килобайт: замолчавшие
 *     соединения переподключаются, загрузка переходит на короткие запросы;
 *   * архив, загруженный в админке с компьютера (кусками, с продолжением), и
 *     положенный на сервер вручную — пишутся в базу без EDSM;
 *     дамп, пересобранный EDSM посреди скачивания, начинается заново;
 *     запуски по частям (скачать / разбить / записать без EDSM); EDSM
 *     недоступен — запись того, что уже на сервере; прямой Postgres;
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
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
// Подставной EDSM — это `globalThis.fetch`; настоящий сервер — новое соединение на запрос (freshFetch).
process.env.FACTIONS_FRESH_CONNECTIONS = '0';
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
export * as uploadRoute from '@/app/api/admin/factions/upload/route';
export * as cronRoute from '@/app/api/cron/factions-sync/route';
export { state, createServiceClient } from '@/lib/supabaseServer';
export { authState } from '@/lib/billing/auth';
export { helperState } from '@/lib/helperAuth';
export {
  runBgsSync, startBgsSync, cancelBgsSync, isBgsSyncRunning, readBgsSyncState, resetBgsSyncRuntime, getBgsLastRun,
  getBgsLiveRun, bgsArchivePath, bgsArchiveInfo, bgsShardsDir, bgsShardsStatus, decideBgsScheduledSync, nextBgsScheduledRun,
  BGS_SCHEDULE, bgsDownloadSegments, bgsPieceBytes, bgsShardSystems, bgsStallMs, bgsShortRequests, bgsFreshConnections,
} from '@/lib/bgsSync';
export { bgsUploadInfo, bgsUploadFile } from '@/lib/bgsUpload';
export { readBgsShardManifest } from '@/lib/bgsShards';
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
const SHARDS = mod.bgsShardsDir();

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

/**
 * Строки как у EDSM: массив, запись на строку, id64 числом, станции и тела в
 * хвосте. `padding` — случайные байты в станциях: такой архив почти не
 * сжимается и делится на много кусков файла.
 */
function dumpText(records, rawLines = [], { padding = 0 } = {}) {
  const lines = records.map((record) => {
    const head = JSON.stringify(record).replace(/"id64":"(\d+)"/, '"id64":$1').slice(0, -1);
    const port = padding > 0 ? randomBytes(padding).toString('hex') : 'Port';
    return `    ${head},"stations":[{"id":1,"name":"${port}","controllingFaction":{"id":9,"name":"x"}}],"bodies":[{"id":2,"id64":5,"name":"Body A"}],"date":"2026-10-15 08:00:00"}`;
  });
  return `[\n${[...lines, ...rawLines].join(',\n')}\n]`;
}

/** Много населённых систем с общими фракциями. */
function manySystems(count, prefix, extra = {}) {
  return Array.from({ length: count }, (_, i) => system(`${prefix} ${i}`, String((extra.base ?? 5_000_000) + i), { x: i, y: -i, z: i / 2 }, [
    faction(`${prefix} Front ${i % 7}`, 0.6, { lastUpdate: NOW_SEC - DAY }),
    faction(`${prefix} Union ${i % 5}`, 0.4, { lastUpdate: NOW_SEC - DAY, isPlayer: i % 5 === 0 }),
  ]));
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

/**
 * EDSM: HEAD (размер, дата, Range), GET целиком или с Range `от-до`.
 * `delayMs` — задержка ответа на GET (тонкий канал), `unreachable` — сервер не
 * отвечает, `next` + `switchAfterGets` — после N запросов GET (и в HEAD тоже)
 * EDSM отдаёт уже другой, пересобранный дамп.
 */
function edsm(body, {
  etag = '"dump-1"', lastModified = 'Sat, 17 Oct 2026 04:50:00 GMT', stallAfter = null, delayMs = 0, unreachable = false,
  next = null, switchAfterGets = Infinity, onGet = null,
} = {}) {
  let gets = 0;
  return async (url, init = {}) => {
    const headers = new Headers(init.headers || {});
    const method = init.method || 'GET';
    const range = headers.get('range');
    fetchCalls.push({ method, range, ua: headers.get('user-agent'), url: String(url), at: Date.now() });
    if (unreachable) throw new TypeError('fetch failed');
    const current = next && gets >= switchAfterGets ? next : { body, etag, lastModified };
    if (method === 'GET') {
      gets += 1;
      onGet?.(range);
    }
    const common = { etag: current.etag, 'last-modified': current.lastModified, 'accept-ranges': 'bytes', 'content-type': 'application/gzip' };
    if (method === 'HEAD') return new Response(null, { status: 200, headers: { ...common, 'content-length': String(current.body.length) } });
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    let start = 0;
    let end = current.body.length - 1;
    let status = 200;
    if (range) {
      const match = /bytes=(\d+)-(\d*)/.exec(range);
      start = Number(match[1]);
      if (match[2]) end = Math.min(end, Number(match[2]));
      if (start >= current.body.length) {
        return new Response(null, { status: 416, headers: { ...common, 'content-range': `bytes */${current.body.length}` } });
      }
      status = 206;
    }
    const slice = current.body.subarray(start, end + 1);
    const extra = status === 206 ? { 'content-range': `bytes ${start}-${end}/${current.body.length}` } : {};
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
  return { fetchImpl, archivePath: ARCHIVE, segments: 1, keepArchive: false, trigger: 'manual', directDb: false, sleep: async () => {}, ...extra };
}

/** Прямой Postgres поверх того же PGlite. */
const pgliteDirect = async () => ({ query: (text, values) => db.query(text, values), end: async () => {} });

/* ── Импорт ────────────────────────────────────────────────────────────── */

test('импорт дампа EDSM: системы, фракции, присутствие, этапы и журнал, архив и куски удалены', async () => {
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

  assert.deepEqual(fetchCalls.map((call) => call.method), ['HEAD', 'GET'], 'один HEAD: скачивание берёт готовый ответ на запрос');
  assert.ok(fetchCalls.every((call) => /ED-Ring-Colony/.test(call.ua ?? '')), 'свой User-Agent');
  assert.equal(existsSync(ARCHIVE), false, 'архив удалён после импорта');
  assert.equal(existsSync(join(SHARDS, 'manifest.json')), false, 'куски удалены после импорта');
  assert.equal(result.shards, 1);
  assert.equal(result.backend, 'postgrest');

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
  assert.equal(progress.mode, 'full');
  assert.deepEqual(progress.stages.map((stage) => [stage.id, stage.status]),
    [['probe', 'done'], ['download', 'done'], ['split', 'done'], ['import', 'done'], ['finish', 'done']]);
  assert.equal(progress.stages[1].done, V1_GZ.length, 'скачивание в байтах');
  assert.equal(progress.stages[3].done, 1, 'запись — в кусках');
  const text = log.map((line) => line.text).join('\n');
  assert.match(text, /Запуск: вручную · загрузка данных/);
  assert.match(text, /Скачиваю архив на сервер целиком/);
  assert.match(text, /Разбивка: читаю скачанный архив/);
  const order = ['Архив скачан целиком', 'Разбивка: читаю скачанный архив', 'Разбивка завершена', 'Запись в базу: кусок 1'].map((line) => text.indexOf(line));
  assert.ok(order.every((at) => at >= 0) && order.every((at, i) => i === 0 || at > order[i - 1]), `шаги по очереди: ${order}`);
  const [downloadStage, splitStage, importStage] = ['download', 'split', 'import'].map((id) => progress.stages.find((stage) => stage.id === id));
  assert.ok(Date.parse(downloadStage.finishedAt) <= Date.parse(splitStage.startedAt), 'разбивка — после скачивания');
  assert.ok(Date.parse(splitStage.finishedAt) <= Date.parse(importStage.startedAt), 'запись — после разбивки');
  assert.match(text, /Запись в базу: PostgREST — пачками по 250 систем/);
  assert.match(text, /населённых систем с фракциями: 4/);
  assert.match(text, /Архив и куски удалены с сервера/);
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
  const downloadedNow = () => mod.getBgsLiveRun()?.progress.stages.find((stage) => stage.id === 'download')?.done ?? 0;
  await waitFor(() => downloadedNow() >= 40, 'первые байты на диске');
  assert.equal(mod.getBgsLiveRun().progress.stage, 'download');
  assert.equal(mod.bgsArchiveInfo(ARCHIVE).total, v3.length, 'файл выделен целиком, а план кусков уже на диске');
  // Вкладка Atlas видит идущий импорт коротким запросом.
  const watching = await (await get(mod.layerRoute, '/api/factions/systems?meta=1')).json();
  assert.equal(watching.meta.refreshing, true);
  assert.equal(watching.meta.progress.stage, 'download');
  assert.equal(watching.meta.progress.stageLabel, 'Скачивание архива на сервер');
  assert.equal(mod.cancelBgsSync(), true);
  await waitFor(() => !mod.isBgsSyncRunning(), 'импорт остановлен');
  const last = mod.getBgsLastRun();
  assert.equal(last.progress.phase, 'cancelled');
  assert.match(last.log.map((line) => line.text).join('\n'), /продолжит с того же места/);
  const info = mod.bgsArchiveInfo(ARCHIVE);
  assert.equal(info.complete, false);
  assert.equal(info.partial, true);
  assert.equal(info.downloaded, 40);

  fetchCalls.length = 0;
  const resumed = await mod.runBgsSync(svc, runOptions(edsm(v3, { etag: '"dump-3"' })));
  assert.equal(resumed.status, 'ok', resumed.error);
  const get3 = fetchCalls.find((call) => call.method === 'GET');
  assert.equal(get3.range, `bytes=40-${v3.length - 1}`, 'докачка с того же места');
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
    assert.match(last.log.map((line) => line.text).join('\n'), /Запуск: задача планировщика factions-sync/);
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
    assert.deepEqual(await start.json(), { success: true, started: true, force: false, mode: 'full', message: 'Загрузка запущена' });
    const again = await mod.adminRoute.POST(adminRequest('POST', { action: 'start', force: true }));
    assert.equal(again.status, 409);
    const running = await (await mod.adminRoute.GET(adminRequest())).json();
    assert.equal(running.running, true);
    await waitFor(() => (mod.getBgsLiveRun()?.progress.stages.find((stage) => stage.id === 'download')?.done ?? 0) >= 30, 'скачивание пошло');
    const cancel = await (await mod.adminRoute.POST(adminRequest('POST', { action: 'cancel' }))).json();
    assert.deepEqual(cancel, { success: true, cancelled: true });
    await waitFor(() => !mod.isBgsSyncRunning(), 'остановлено');
  } finally {
    globalThis.fetch = realFetch;
  }
  const after = await (await mod.adminRoute.GET(adminRequest())).json();
  assert.equal(after.progress.phase, 'cancelled');
  assert.equal(after.archive.exists, true);
  assert.equal(after.archive.partial, true, 'скачан не полностью');
  assert.equal(after.archive.downloaded, 30);
  assert.equal(after.archive.complete, false);
  assert.equal(after.shards.exists, true, 'манифест кусков этого дампа заведён');
  assert.equal(after.shards.shards, 0, 'в 30 байтах ещё нет ни одной системы');
  assert.equal(after.writer.backend, 'postgrest', 'DATABASE_URL в тесте не задан');

  const cleanup = await (await mod.adminRoute.POST(adminRequest('POST', { action: 'cleanup' }))).json();
  assert.equal(cleanup.success, true);
  assert.equal(cleanup.removed, true);
  assert.ok(cleanup.freed >= 30, `освобождено ${cleanup.freed}`);
  assert.equal(existsSync(ARCHIVE), false);
  assert.equal(existsSync(join(SHARDS, 'manifest.json')), false, 'куски удалены вместе с архивом');
  assert.equal((await mod.adminRoute.POST(adminRequest('POST', { action: 'cancel' }))).status, 200);
  assert.equal((await mod.adminRoute.POST(adminRequest('POST', { action: 'bogus' }))).status, 400);
  assert.equal((await mod.adminRoute.POST(adminRequest('POST', { action: 'download', segments: 99 }))).status, 400, 'соединений — не больше 16');
  assert.equal((await mod.adminRoute.POST(adminRequest('POST', { action: 'split' }))).status, 200, 'запуск принят — ошибка видна в ходе');
  await waitFor(() => !mod.isBgsSyncRunning(), 'разбивка без архива закончилась');
  const noArchive = mod.getBgsLastRun();
  assert.equal(noArchive.progress.mode, 'split');
  assert.equal(noArchive.progress.phase, 'error');
  assert.match(noArchive.progress.result.error, /нет скачанного архива/);
});

/* ── Конвейер как у каталога систем ────────────────────────────────────── */

const PIPE_LM = 'Sun, 18 Oct 2026 04:50:00 GMT';
const PIPE_SYSTEMS = manySystems(60, 'Pipe');
const PIPE_GZ = gzipSync(Buffer.from(dumpText(PIPE_SYSTEMS, [], { padding: 600 }), 'utf8'));

function pipeOptions(fetchImpl, extra = {}) {
  return runOptions(fetchImpl, { segments: 3, pieceBytes: 1024, minSegmentedBytes: 0, shardSystems: 4, ...extra });
}

test('конвейер: соединения берут куски файла по порядку, разбивка и запись — только когда архив скачан целиком', async () => {
  assert.ok(PIPE_GZ.length > 30 * 1024, `архив ${PIPE_GZ.length} байт — много кусков файла`);
  fetchCalls.length = 0;
  let firstApplyAt = null;
  mod.state.rpcGuard = async (name) => {
    if (name === 'bgs_apply_snapshots' && firstApplyAt == null) firstApplyAt = Date.now();
  };
  try {
    const result = await mod.runBgsSync(svc, pipeOptions(edsm(PIPE_GZ, { etag: '"pipe-1"', lastModified: PIPE_LM, delayMs: 25 })));
    assert.equal(result.status, 'ok', result.error);
    assert.equal(result.stats.systems, 60);
    assert.equal(result.shards, 15, '60 систем по 4 в куске');
  } finally {
    mod.state.rpcGuard = null;
  }
  const gets = fetchCalls.filter((call) => call.method === 'GET');
  assert.ok(gets.length >= 20, `кусков файла: ${gets.length}`);
  assert.ok(gets.every((call) => /^bytes=\d+-\d+$/.test(call.range ?? '')), 'каждый запрос — свой кусок «от-до»');
  const starts = gets.map((call) => Number(/bytes=(\d+)-/.exec(call.range)[1]));
  assert.deepEqual([...starts].sort((a, b) => a - b), starts, 'куски берутся по порядку файла');
  assert.equal(starts[0], 0);
  const lastGetAt = Math.max(...gets.map((call) => call.at));
  assert.ok(firstApplyAt && firstApplyAt > lastGetAt, 'первый кусок записан в базу после последнего запроса скачивания');

  assert.equal(await scalar(`SELECT count(*)::int FROM bgs_systems WHERE name LIKE 'Pipe %'`), 60);
  assert.equal(await scalar(`SELECT count(*)::int FROM bgs_systems WHERE source = 'edsm' AND name NOT LIKE 'Pipe %'`), 0, 'системы прошлого дампа удалены');
  const state = await mod.readBgsSyncState(svc);
  assert.equal(state.last_modified, PIPE_LM);
  assert.equal(state.stats.shards, 15);
  assert.equal(state.stats.backend, 'postgrest');
  const text = mod.getBgsLastRun().log.map((line) => line.text).join('\n');
  assert.match(text, /до 3 соединений, куски по 1,0 КБ/);
  assert.match(text, /Скачивание: Архив: 3 параллельных соединений, куски по 1\.0 КБ/);
  assert.match(text, /Разбивка завершена: 15 кусков, 60 систем/);
  assert.equal(existsSync(ARCHIVE), false);
  assert.equal(existsSync(join(SHARDS, 'manifest.json')), false);
});

test('остановка посреди записи: следующий запуск не качает архив заново и пишет только незаписанные куски', async () => {
  const systems = manySystems(40, 'Resume', { base: 7_000_000 });
  const gz = gzipSync(Buffer.from(dumpText(systems, [], { padding: 200 }), 'utf8'));
  const applies = [];
  mod.state.rpcGuard = async (name, args) => {
    if (name !== 'bgs_apply_snapshots') return;
    applies.push(args.p_run);
    await new Promise((resolve) => setTimeout(resolve, 30));
  };
  try {
    const started = mod.startBgsSync(svc, { ...pipeOptions(edsm(gz, { etag: '"resume-1"', lastModified: 'Mon, 19 Oct 2026 04:50:00 GMT' })), trigger: 'admin' });
    assert.equal(started.started, true);
    await waitFor(() => (mod.readBgsShardManifest(SHARDS)?.shards.filter((entry) => entry.imported).length ?? 0) >= 3, 'три куска в базе', 1500);
    assert.equal(mod.cancelBgsSync(), true);
    await waitFor(() => !mod.isBgsSyncRunning(), 'остановлено', 1500);
  } finally {
    mod.state.rpcGuard = null;
  }
  const stopped = mod.readBgsShardManifest(SHARDS);
  const doneBefore = stopped.shards.filter((entry) => entry.imported).length;
  assert.ok(doneBefore >= 3 && doneBefore < 10, `в базе ${doneBefore} из 10 кусков`);
  const runId = stopped.runId;
  assert.equal(mod.getBgsLastRun().progress.phase, 'cancelled');
  assert.match(mod.getBgsLastRun().log.map((line) => line.text).join('\n'), /записанное осталось — следующий запуск продолжит с того же места/);
  assert.equal(mod.bgsShardsStatus(SHARDS).imported, doneBefore);

  fetchCalls.length = 0;
  const appliedAgain = [];
  mod.state.rpcGuard = async (name, args) => {
    if (name === 'bgs_apply_snapshots') appliedAgain.push(args.p_run);
  };
  try {
    const resumed = await mod.runBgsSync(svc, pipeOptions(edsm(gz, { etag: '"resume-1"', lastModified: 'Mon, 19 Oct 2026 04:50:00 GMT' })));
    assert.equal(resumed.status, 'ok', resumed.error);
    assert.equal(resumed.stats.systems, 40);
  } finally {
    mod.state.rpcGuard = null;
  }
  const methods = fetchCalls.map((call) => call.method);
  assert.equal(methods.filter((method) => method === 'HEAD').length, 1);
  const refetched = fetchCalls.filter((call) => call.method === 'GET').length;
  assert.ok(refetched < 12, `докачан только хвост архива (${refetched} запросов), а не весь заново`);
  assert.equal(appliedAgain.length, 10 - doneBefore, 'записаны только незаписанные куски');
  assert.ok(appliedAgain.every((id) => id === runId), 'с той же меткой импорта');
  assert.equal(await scalar(`SELECT count(*)::int FROM bgs_systems WHERE name LIKE 'Resume %'`), 40, 'ни одна система первой половины не удалена как «пропавшая»');
  assert.equal(await scalar(`SELECT count(*)::int FROM bgs_systems WHERE name LIKE 'Resume %' AND sync_run::text = $1`, [runId]), 40);
  assert.equal((await mod.readBgsSyncState(svc)).run_id, runId);
  assert.match(mod.getBgsLastRun().log.map((line) => line.text).join('\n'), new RegExp(`продолжаю — ${doneBefore} кусков этого дампа уже в базе`));
});

test('дамп пересобран посреди скачивания: скачанное выбрасывается, загрузка начинается заново со свежим дампом', async () => {
  const oldSystems = manySystems(20, 'Stale', { base: 8_000_000 });
  const newSystems = manySystems(24, 'Rebuilt', { base: 8_100_000 });
  const oldGz = gzipSync(Buffer.from(dumpText(oldSystems, [], { padding: 300 }), 'utf8'));
  const newGz = gzipSync(Buffer.from(dumpText(newSystems, [], { padding: 300 }), 'utf8'));
  const next = { body: newGz, etag: '"rebuilt"', lastModified: 'Tue, 20 Oct 2026 04:50:00 GMT' };
  fetchCalls.length = 0;
  const result = await mod.runBgsSync(svc, pipeOptions(edsm(oldGz, { etag: '"stale"', lastModified: 'Mon, 19 Oct 2026 05:00:00 GMT', next, switchAfterGets: 3 })));
  assert.equal(result.status, 'ok', result.error);
  assert.equal(result.stats.systems, 24, 'загружен новый дамп');
  const text = mod.getBgsLastRun().log.map((line) => line.text).join('\n');
  assert.match(text, /Дамп на EDSM обновился во время скачивания/);
  assert.match(text, /Новый дамп: /);
  assert.equal(await scalar(`SELECT count(*)::int FROM bgs_systems WHERE name LIKE 'Rebuilt %'`), 24);
  assert.equal(await scalar(`SELECT count(*)::int FROM bgs_systems WHERE name LIKE 'Stale %' AND source = 'edsm'`), 0, 'системы недокачанного дампа не остались «в дампе»');
  assert.equal((await mod.readBgsSyncState(svc)).last_modified, 'Tue, 20 Oct 2026 04:50:00 GMT');
  assert.equal(fetchCalls.filter((call) => call.method === 'HEAD').length, 2, 'новый дамп заново опрошен');
});

test('по частям: «Скачать архив» → «Разбить на куски» → «Загрузить куски в базу» без EDSM', async () => {
  const systems = manySystems(18, 'Steps', { base: 9_000_000 });
  const gz = gzipSync(Buffer.from(dumpText(systems, [], { padding: 120 }), 'utf8'));
  const lm = 'Wed, 21 Oct 2026 04:50:00 GMT';
  const before = await mod.readBgsSyncState(svc);

  fetchCalls.length = 0;
  const downloaded = await mod.runBgsSync(svc, pipeOptions(edsm(gz, { etag: '"steps"', lastModified: lm }), { mode: 'download' }));
  assert.equal(downloaded.status, 'ok', downloaded.error);
  assert.equal(downloaded.mode, 'download');
  assert.equal(downloaded.archiveBytes, gz.length);
  let progress = mod.getBgsLastRun().progress;
  assert.deepEqual(progress.stages.map((stage) => [stage.id, stage.status]),
    [['probe', 'done'], ['download', 'done'], ['split', 'skipped'], ['import', 'skipped'], ['finish', 'skipped']]);
  assert.match(progress.message, /Архив скачан на сервер/);
  assert.equal(mod.bgsArchiveInfo(ARCHIVE).complete, true);
  assert.equal(mod.bgsShardsStatus(SHARDS).shards, 0, 'только скачивание — кусков нет');
  const afterDownload = await mod.readBgsSyncState(svc);
  assert.equal(afterDownload.synced_at, before.synced_at, 'база не тронута');
  assert.equal(afterDownload.status, before.status, 'статус импорта не тронут');

  const offline = edsm(gz, { unreachable: true });
  fetchCalls.length = 0;
  const split = await mod.runBgsSync(svc, pipeOptions(offline, { mode: 'split' }));
  assert.equal(split.status, 'ok', split.error);
  assert.equal(split.shards, 5, '18 систем по 4');
  progress = mod.getBgsLastRun().progress;
  assert.deepEqual(progress.stages.map((stage) => [stage.id, stage.status]),
    [['probe', 'skipped'], ['download', 'skipped'], ['split', 'done'], ['import', 'skipped'], ['finish', 'skipped']]);
  const shardsInfo = mod.bgsShardsStatus(SHARDS);
  assert.deepEqual([shardsInfo.complete, shardsInfo.shards, shardsInfo.imported, shardsInfo.systems], [true, 5, 0, 18]);
  assert.equal(await scalar(`SELECT count(*)::int FROM bgs_systems WHERE name LIKE 'Steps %'`), 0, 'разбивка в базу не пишет');

  const imported = await mod.runBgsSync(svc, pipeOptions(offline, { mode: 'import' }));
  assert.equal(imported.status, 'ok', imported.error);
  assert.equal(fetchCalls.length, 0, 'ни одного запроса к EDSM');
  assert.equal(await scalar(`SELECT count(*)::int FROM bgs_systems WHERE name LIKE 'Steps %'`), 18);
  const state = await mod.readBgsSyncState(svc);
  assert.equal(state.last_modified, lm, 'дата дампа — из архива на сервере');
  assert.equal(state.status, 'ok');
  assert.equal(existsSync(ARCHIVE), false, 'после загрузки архив и куски удалены');

  const again = await mod.runBgsSync(svc, pipeOptions(offline, { mode: 'import' }));
  assert.equal(again.status, 'error', 'на сервере больше ничего нет');
  assert.match(again.error, /нет ни архива, ни кусков/);
});

test('EDSM не отвечает: «Загрузить данные» пишет в базу архив, который уже на сервере', async () => {
  const systems = manySystems(12, 'Offline', { base: 9_500_000 });
  const gz = gzipSync(Buffer.from(dumpText(systems, [], { padding: 64 }), 'utf8'));
  const lm = 'Thu, 22 Oct 2026 04:50:00 GMT';
  const downloaded = await mod.runBgsSync(svc, pipeOptions(edsm(gz, { etag: '"offline"', lastModified: lm }), { mode: 'download' }));
  assert.equal(downloaded.status, 'ok', downloaded.error);

  fetchCalls.length = 0;
  const result = await mod.runBgsSync(svc, pipeOptions(edsm(gz, { unreachable: true })));
  assert.equal(result.status, 'ok', result.error);
  assert.ok(fetchCalls.length <= 2 && fetchCalls.every((call) => call.method === 'HEAD' || call.range === 'bytes=0-0'),
    'только запрос к EDSM (HEAD и однобайтовый GET), архив не качается');
  assert.match(mod.getBgsLastRun().log.map((line) => line.text).join('\n'), /EDSM не ответил .* загружаю в базу то, что уже лежит на сервере/);
  assert.equal(await scalar(`SELECT count(*)::int FROM bgs_systems WHERE name LIKE 'Offline %'`), 12);

  fetchCalls.length = 0;
  const nothing = await mod.runBgsSync(svc, pipeOptions(edsm(gz, { unreachable: true })));
  assert.equal(nothing.status, 'error', 'на сервере ничего нет — честная ошибка');
  assert.match(nothing.error, /EDSM не ответил/);
});

test('прямой Postgres: кусок одним вызовом, завершение одним запросом на шаг', async () => {
  const systems = manySystems(30, 'Direct', { base: 9_700_000 });
  const gz = gzipSync(Buffer.from(dumpText(systems), 'utf8'));
  const result = await mod.runBgsSync(svc, pipeOptions(edsm(gz, { etag: '"direct"', lastModified: 'Fri, 23 Oct 2026 04:50:00 GMT' }), {
    directDb: true, pgClient: pgliteDirect, shardSystems: 10,
  }));
  assert.equal(result.status, 'ok', result.error);
  assert.equal(result.backend, 'pg');
  assert.equal(result.shards, 3);
  assert.equal(await scalar(`SELECT count(*)::int FROM bgs_systems WHERE name LIKE 'Direct %'`), 30);
  assert.equal(await scalar(`SELECT count(*)::int FROM bgs_systems WHERE source = 'edsm' AND name NOT LIKE 'Direct %'`), 0, 'пропавшие удалены');
  assert.equal(await scalar(`SELECT systems_count FROM bgs_factions WHERE name = 'Direct Front 0'`), 5, 'счётчики пересчитаны');
  const state = await mod.readBgsSyncState(svc);
  assert.equal(state.stats.backend, 'pg');
  assert.match(mod.getBgsLastRun().log.map((line) => line.text).join('\n'), /Запись в базу: прямой Postgres — кусок одним вызовом/);
});

test('настройки конвейера: соединения, кусок файла, систем в куске', () => {
  assert.equal(mod.bgsDownloadSegments({}), 8);
  assert.equal(mod.bgsDownloadSegments({ FACTIONS_DOWNLOAD_SEGMENTS: '12' }), 12);
  assert.equal(mod.bgsDownloadSegments({ FACTIONS_DOWNLOAD_SEGMENTS: '99' }), 16);
  assert.equal(mod.bgsDownloadSegments({ FACTIONS_DOWNLOAD_SEGMENTS: 'abc' }), 8);
  assert.equal(mod.bgsPieceBytes({}), 8 * 1024 * 1024);
  assert.equal(mod.bgsPieceBytes({ FACTIONS_PIECE_MB: '2' }), 2 * 1024 * 1024);
  assert.equal(mod.bgsPieceBytes({ FACTIONS_PIECE_MB: '1000' }), 64 * 1024 * 1024);
  assert.equal(mod.bgsShardSystems({}), 1000);
  assert.equal(mod.bgsShardSystems({ FACTIONS_SHARD_SYSTEMS: '5' }), 100);
  assert.equal(mod.bgsStallMs({}), 15_000);
  assert.equal(mod.bgsStallMs({ FACTIONS_STALL_SECONDS: '1' }), 3_000);
  assert.equal(mod.bgsStallMs({ FACTIONS_STALL_SECONDS: '0' }), 0, '0 — ждать, пока сокет закроет система');
  assert.equal(mod.bgsStallMs({ FACTIONS_STALL_SECONDS: 'abc' }), 15_000);
  assert.equal(mod.bgsShortRequests({}), 'auto');
  assert.equal(mod.bgsShortRequests({ FACTIONS_REQUEST_KB: 'off' }), 'off');
  assert.equal(mod.bgsShortRequests({ FACTIONS_REQUEST_KB: '12' }), 12 * 1024);
  assert.equal(mod.bgsShortRequests({ FACTIONS_REQUEST_KB: '1' }), 4 * 1024);
  assert.equal(mod.bgsFreshConnections({}), true);
  assert.equal(mod.bgsFreshConnections({ FACTIONS_FRESH_CONNECTIONS: '0' }), false);
});

test('/api/admin/factions: запуски по частям, ход, оборванный перезапуском сайта, честно помечен', async () => {
  const systems = manySystems(24, 'Admin', { base: 9_900_000 });
  const gz = gzipSync(Buffer.from(dumpText(systems), 'utf8'));
  globalThis.fetch = edsm(gz, { etag: '"admin-steps"', lastModified: 'Sat, 24 Oct 2026 04:50:00 GMT' });
  try {
    const download = await mod.adminRoute.POST(adminRequest('POST', { action: 'download', segments: 4 }));
    assert.equal(download.status, 200);
    assert.deepEqual(await download.json(), { success: true, started: true, force: false, mode: 'download', segments: 4, message: 'Скачивание архива запущено' });
    await waitFor(() => !mod.isBgsSyncRunning(), 'скачивание закончилось');
    let status = await (await mod.adminRoute.GET(adminRequest())).json();
    assert.equal(status.progress.mode, 'download');
    assert.equal(status.progress.phase, 'ok', status.progress.message);
    assert.equal(status.archive.complete, true);
    assert.equal(status.config.segments, 8);
    assert.equal(status.config.maxSegments, 16);
    assert.equal(status.config.shardSystems, 1000);

    const importing = await mod.adminRoute.POST(adminRequest('POST', { action: 'import' }));
    assert.equal(importing.status, 200);
    await waitFor(() => !mod.isBgsSyncRunning(), 'запись закончилась');
    status = await (await mod.adminRoute.GET(adminRequest())).json();
    assert.equal(status.progress.mode, 'import');
    assert.equal(status.progress.phase, 'ok', status.progress.message);
    assert.equal(status.shards.exists, false, 'после записи куски удалены');
  } finally {
    globalThis.fetch = realFetch;
  }

  // Ход «идёт» в базе, а живого запуска нет — сайт перезапустился посреди работы.
  const stale = {
    id: 'lost-run', trigger: 'admin', force: false, mode: 'full', phase: 'running', stage: 'download', percent: 12, message: 'Скачивание…',
    startedAt: new Date(Date.now() - 600_000).toISOString(), updatedAt: new Date(Date.now() - 500_000).toISOString(), finishedAt: null,
    stages: [{ id: 'probe', status: 'done' }, { id: 'download', status: 'running', done: 10, total: 100 }], result: null,
  };
  mod.resetBgsSyncRuntime();
  await db.query(`UPDATE bgs_sync_state SET progress = $1::jsonb, status = 'running', attempt_at = now() - interval '10 minutes'`, [JSON.stringify(stale)]);
  const lost = await (await mod.adminRoute.GET(adminRequest())).json();
  assert.equal(lost.running, false);
  assert.equal(lost.interrupted, true);
  assert.equal(lost.progress.phase, 'cancelled', 'не «идёт»');
  assert.match(lost.progress.result.error, /Прервано перезапуском сайта/);
  assert.equal(lost.progress.stages.find((stage) => stage.id === 'download').status, 'error');
  await db.query(`UPDATE bgs_sync_state SET status = 'ok'`);
});

/* ── Сеть, «замораживающая» TCP-сессии ─────────────────────────────────── */

test('сеть «замораживает» сессии после нескольких КБ: соединения переподключаются, загрузка переходит на короткие запросы', async () => {
  const systems = manySystems(30, 'Frozen', { base: 9_950_000 });
  const gz = gzipSync(Buffer.from(dumpText(systems, [], { padding: 1000 }), 'utf8'));
  assert.ok(gz.length > 20_000, `архив ${gz.length} байт`);
  fetchCalls.length = 0;
  // Каждый ответ отдаёт 6000 байт и замолкает навсегда — как сессия к Cloudflare за ТСПУ.
  const frozen = edsm(gz, { etag: '"frozen"', lastModified: 'Sun, 25 Oct 2026 04:50:00 GMT', stallAfter: 6000 });
  const result = await mod.runBgsSync(svc, pipeOptions(frozen, { segments: 2, pieceBytes: 64 * 1024, stallTimeoutMs: 150, shortRequests: 'auto' }));
  assert.equal(result.status, 'ok', result.error);
  assert.equal(result.stats.systems, 30);
  const text = mod.getBgsLastRun().log.map((line) => line.text).join('\n');
  assert.match(text, /соединение без данных 0\.2 с переподключается \(замирающие соединения → короткие запросы\)/);
  assert.match(text, /соединение замолчало на 0\.2 с, успев передать 5\.9 КБ — переподключаюсь/);
  assert.match(text, /Перехожу на короткие запросы по 4\.1 КБ — каждый в новом соединении/);
  assert.match(text, /коротких запросов: \d+, замолчавших соединений: 2\)/, 'после перехода — ни одной заморозки');
  assert.doesNotMatch(text, /Короткий запрос тоже замер/);
  const ranges = fetchCalls.filter((call) => call.method === 'GET').map((call) => /bytes=(\d+)-(\d+)/.exec(call.range ?? '')).filter(Boolean);
  const short = ranges.filter((match) => Number(match[2]) - Number(match[1]) + 1 <= 4200);
  assert.ok(short.length >= 3, `после заморозок — короткие запросы (${short.length} из ${ranges.length})`);
  assert.equal(await scalar(`SELECT count(*)::int FROM bgs_systems WHERE name LIKE 'Frozen %'`), 30);
});

/* ── Архив с компьютера ────────────────────────────────────────────────── */

function uploadRequest(method, { body, offset, json } = {}) {
  return new Request(`https://edringcolony.ru/api/admin/factions/upload${offset != null ? `?offset=${offset}` : ''}`, {
    method,
    headers: { authorization: 'Bearer test', 'content-type': json ? 'application/json' : 'application/octet-stream' },
    body: json ? JSON.stringify(json) : body,
  });
}

const uploadPost = (json) => mod.uploadRoute.POST(uploadRequest('POST', { json }));
const uploadPut = (offset, body) => mod.uploadRoute.PUT(uploadRequest('PUT', { offset, body }));

test('архив с компьютера: кусками с продолжением, проверка, «Загрузить данные» без EDSM', async () => {
  const systems = manySystems(26, 'Upload', { base: 9_960_000 });
  const gz = gzipSync(Buffer.from(dumpText(systems, [], { padding: 200 }), 'utf8'));
  const file = { name: 'systemsPopulated.json.gz', size: gz.length, lastModified: Date.parse('2026-10-26T06:00:00Z') };

  mod.authState.role = 'user';
  assert.equal((await uploadPost({ action: 'start', ...file })).status, 403, 'только администратор');
  assert.equal((await uploadPut(0, gz)).status, 403);
  mod.authState.role = 'admin';
  const unpacked = await uploadPost({ action: 'start', name: 'systemsPopulated.json', size: 5000 });
  assert.equal(unpacked.status, 400);
  assert.match((await unpacked.json()).error, /Нужен архив \.json\.gz/);
  assert.equal((await uploadPost({ action: 'start', name: 'a.gz', size: 0 })).status, 400, 'пустой файл');
  assert.equal((await uploadPut(0, gz.subarray(0, 10))).status, 409, 'кусок без начатой загрузки');

  let response = await uploadPost({ action: 'start', ...file });
  let body = await response.json();
  assert.equal(response.status, 200, body.error);
  assert.deepEqual([body.offset, body.resumed, body.chunkBytes], [0, false, 8 * 1024 * 1024]);
  const half = Math.floor(gz.length / 2);
  body = await (await uploadPut(0, gz.subarray(0, half))).json();
  assert.deepEqual([body.offset, body.complete], [half, false]);
  // Ответ потерялся, браузер повторил тот же кусок: сервер говорит, сколько у него на самом деле.
  response = await uploadPut(0, gz.subarray(0, half));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).offset, half);
  assert.equal((await uploadPut(half, Buffer.alloc(gz.length))).status, 400, 'кусок за концом файла');

  const status = await (await mod.adminRoute.GET(adminRequest())).json();
  assert.deepEqual([status.upload.active, status.upload.received, status.upload.size, status.upload.name], [true, half, gz.length, 'systemsPopulated.json.gz']);
  assert.equal((await uploadPost({ action: 'finish' })).status, 409, 'файл ещё не весь');

  // Страницу перезагрузили и выбрали тот же файл — загрузка продолжается.
  body = await (await uploadPost({ action: 'start', ...file })).json();
  assert.deepEqual([body.offset, body.resumed], [half, true]);
  body = await (await uploadPut(half, gz.subarray(half))).json();
  assert.deepEqual([body.offset, body.complete], [gz.length, true]);

  // На EDSM сейчас файл ровно такого размера — это тот же дамп: архив получает его ETag и дату.
  globalThis.fetch = edsm(gz, { etag: '"edsm-upload"', lastModified: 'Mon, 26 Oct 2026 04:50:00 GMT' });
  try {
    response = await uploadPost({ action: 'finish' });
    body = await response.json();
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(response.status, 200, body.error);
  assert.deepEqual([body.bytes, body.sameAsEdsm, body.source.etag, body.name], [gz.length, true, '"edsm-upload"', 'systemsPopulated.json.gz']);
  const info = mod.bgsArchiveInfo(ARCHIVE);
  assert.deepEqual([info.complete, info.uploaded, info.uploadName, info.bytes, info.manual], [true, true, 'systemsPopulated.json.gz', gz.length, false]);
  assert.equal(mod.bgsUploadInfo(ARCHIVE).active, false);
  assert.equal(existsSync(mod.bgsUploadFile(ARCHIVE)), false, 'временный файл стал архивом');

  fetchCalls.length = 0;
  const result = await mod.runBgsSync(svc, runOptions(edsm(gz, { unreachable: true })));
  assert.equal(result.status, 'ok', result.error);
  assert.equal(fetchCalls.length, 0, 'EDSM не спрашивали');
  assert.equal(result.stats.systems, 26);
  const { progress, log } = mod.getBgsLastRun();
  assert.match(log.map((line) => line.text).join('\n'), /Архив загружен в админке с компьютера \(systemsPopulated\.json\.gz/);
  assert.deepEqual(progress.stages.map((stage) => [stage.id, stage.status]),
    [['probe', 'skipped'], ['download', 'done'], ['split', 'done'], ['import', 'done'], ['finish', 'done']]);
  assert.equal((await mod.readBgsSyncState(svc)).etag, '"edsm-upload"', 'в базе тот же дамп, что на EDSM: «Загрузить данные» его второй раз не качает');
  assert.equal(await scalar(`SELECT count(*)::int FROM bgs_systems WHERE name LIKE 'Upload %'`), 26);

  fetchCalls.length = 0;
  const again = await mod.runBgsSync(svc, runOptions(edsm(gz, { etag: '"edsm-upload"', lastModified: 'Mon, 26 Oct 2026 04:50:00 GMT' })));
  assert.equal(again.status, 'not_modified');
  assert.deepEqual(fetchCalls.map((call) => call.method), ['HEAD']);
});

test('архив с компьютера: не gzip и не дамп отвергаются, отмена удаляет принятое; файл, положенный вручную, принимается', async () => {
  const send = async (buffer) => {
    assert.equal((await uploadPost({ action: 'start', name: 'systemsPopulated.json.gz', size: buffer.length, lastModified: 1 })).status, 200);
    assert.equal((await uploadPut(0, buffer)).status, 200);
    return uploadPost({ action: 'finish' });
  };
  let response = await send(Buffer.from('это не gzip, а просто текст '.repeat(8)));
  assert.equal(response.status, 422);
  assert.match((await response.json()).error, /не похож на systemsPopulated\.json\.gz с EDSM: это не gzip/);
  assert.equal(existsSync(mod.bgsUploadFile(ARCHIVE)), false, 'отвергнутый файл удалён');
  response = await send(gzipSync(Buffer.from(JSON.stringify({ hello: 'world', padding: 'x'.repeat(100) }))));
  assert.equal(response.status, 422);
  assert.match((await response.json()).error, /не JSON-массив/);
  assert.equal(mod.bgsArchiveInfo(ARCHIVE).exists, false, 'архива не появилось');

  const part = gzipSync(Buffer.from(dumpText(manySystems(5, 'Cancel', { base: 9_965_000 })), 'utf8'));
  assert.equal((await uploadPost({ action: 'start', name: 'systemsPopulated.json.gz', size: part.length, lastModified: 2 })).status, 200);
  assert.equal((await uploadPut(0, part.subarray(0, 50))).status, 200);
  const cancelled = await (await uploadPost({ action: 'cancel' })).json();
  assert.deepEqual([cancelled.success, cancelled.removed, cancelled.freed], [true, true, 50]);
  assert.equal(mod.bgsUploadInfo(ARCHIVE).active, false);
  assert.equal((await uploadPost({ action: 'bogus' })).status, 400);

  // Администратор положил файл в каталог архива сам (scp) — без метки и плана докачки.
  const gz = gzipSync(Buffer.from(dumpText(manySystems(20, 'Manual', { base: 9_970_000 })), 'utf8'));
  writeFileSync(ARCHIVE, gz);
  const info = mod.bgsArchiveInfo(ARCHIVE);
  assert.deepEqual([info.manual, info.partial, info.complete, info.total], [true, false, false, gz.length]);
  fetchCalls.length = 0;
  const result = await mod.runBgsSync(svc, runOptions(edsm(gz, { unreachable: true }), { mode: 'import' }));
  assert.equal(result.status, 'ok', result.error);
  assert.equal(fetchCalls.length, 0);
  assert.match(mod.getBgsLastRun().log.map((line) => line.text).join('\n'), /файл архива без метки .* принят как положенный вручную/);
  assert.equal(await scalar(`SELECT count(*)::int FROM bgs_systems WHERE name LIKE 'Manual %'`), 20);
  assert.equal(existsSync(ARCHIVE), false, 'после загрузки архив удалён');
});
