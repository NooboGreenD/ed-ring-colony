/**
 * Слой «PowerPlay»: импорт дампа EDSM и API на настоящем PostgreSQL (PGlite)
 * с миграцией `20261018120000_powerplay_systems.sql`.
 *
 * Маршруты собираются esbuild'ом с подменой `next/server` и
 * `@/lib/supabaseServer`; service-role клиент — `helpers/pgliteSupabase.mjs`.
 * EDSM — подставной `fetch` с настоящим gzip. Проверяется:
 *   * импорт: отбор систем, id64 шире 2^53, состояние, условный запрос (304),
 *     пересборка с удалением пропавших систем;
 *   * защита данных: HTTP-ошибка, обрезанный gzip, пустой и «усохший» дамп
 *     таблицу не трогают, `force` принимает усохший дамп;
 *   * `GET /api/powerplay/systems`: формат, ETag/304, кэш-заголовки, пустая
 *     таблица запускает импорт фоном, ошибки источника — понятным текстом;
 *   * `/api/cron/powerplay-sync`: секрет, отчёт, 502 при сбое.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { PGlite } from '@electric-sql/pglite';
import { TEST_ROOT, bundleFile } from './helpers/bundle.mjs';

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
process.env.CRON_SECRET = 'powerplay-cron-secret';

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

const ENTRY = `
export * as layerRoute from '@/app/api/powerplay/systems/route';
export * as cronRoute from '@/app/api/cron/powerplay-sync/route';
export { state } from '@/lib/supabaseServer';
export { createServiceClient } from '@/lib/supabaseServer';
export {
  runPowerplaySync, isPowerplaySyncRunning, powerplayNeedsRefresh, readPowerplaySyncState, decodePowerplayDump,
  powerplayDumpUrl, DEFAULT_POWERPLAY_DUMP_URL, POWERPLAY_STALE_AFTER_MS, POWERPLAY_RETRY_AFTER_MS,
} from '@/lib/powerplaySync';
export { resetPowerplayLayerCache, loadPowerplayLayer } from '@/lib/powerplayStore';
export { decodePowerplayLayer } from '@/lib/powerplay';
`;

const db = new PGlite();
await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;');
const MIGRATION = readFileSync(join(TEST_ROOT, 'supabase', 'migrations', '20261018120000_powerplay_systems.sql'), 'utf8');
await db.exec(MIGRATION);
// Снимок full_schema.sql и повторный прогон update-project.sh накатывают миграцию ещё раз.
await db.exec(MIGRATION);

const bundle = await bundleFile({
  entrySource: ENTRY,
  stubs: { 'next/server': NEXT_SERVER_STUB, '@/lib/supabaseServer': SUPABASE_STUB },
  platform: 'node',
});
const mod = await import(bundle);
mod.state.db = db;
const svc = mod.createServiceClient();

/* ── Подставной EDSM ───────────────────────────────────────────────────── */

const LAST_MODIFIED = 'Sat, 17 Oct 2026 02:46:06 GMT';

function record(name, power, state, extra = {}) {
  return { power, powerState: state, id: 1, id64: extra.id64 ?? 1000 + name.length * 7 + name.charCodeAt(0), name, coords: extra.coords ?? { x: 10, y: 5, z: -20 }, allegiance: 'Independent', government: 'Corporate', state: 'None', date: extra.date ?? '2026-10-16 12:00:00' };
}

/** Строки дампа как у EDSM: массив, запись на строку, id64 печатается числом без кавычек. */
function dumpText(records, rawLines = []) {
  const lines = records.map((item) => ` ${JSON.stringify(item)}`);
  return `[\n${[...lines, ...rawLines].join(',\n')}\n]`;
}

const HUGE_LINE = ' {"power":"Arissa Lavigny-Duval","powerState":"Stronghold","id":9,"id64":36028797018963971,"name":"Kamadhenu Test","coords":{"x":-12,"y":3,"z":-40},"allegiance":"Empire","government":"Patronage","state":"None","date":"2026-10-16 23:00:00"}';

const BASE = [
  record('Prajan', 'Edmund Mahon', 'Stronghold', { id64: 2557888041682, coords: { x: 56.59375, y: 139.59375, z: 10.78125 } }),
  record('Fedmich', 'Edmund Mahon', 'Fortified', { id64: 2518755068267, coords: { x: 23.875, y: 75.1875, z: 35.75 } }),
  record('Seedi', 'Edmund Mahon', 'Exploited', { id64: 3657332560586, coords: { x: 30.46875, y: 140.25, z: -38.0625 } }),
  record('LHS 154a', 'Li Yong-Rui', 'Fortified', { id64: 671222801825 }),
  record('Wolf 1061', 'Li Yong-Rui', 'Exploited', { id64: 16064117286313 }),
  record('LTT 4428', 'Nakato Kaine', 'Stronghold', { id64: 2656194005355 }),
  record('Antevorta', 'Nakato Kaine', 'Exploited', { id64: 1458309206738 }),
  record('Ross 1015', 'Nakato Kaine', 'Exploited', { id64: 670686127529 }),
  record('Malina', 'Nakato Kaine', 'Exploited', { id64: 670149256617 }),
  record('Surya', 'Nakato Kaine', 'Exploited', { id64: 2869441013161 }),
  record('Eleu', 'Nakato Kaine', 'Fortified', { id64: 2557686616810 }),
  record('Free World', 'Yuri Grom', 'Unoccupied', { id64: 5069270099361 }),
];
const BASE_TEXT = dumpText(BASE, [HUGE_LINE]);
const CONTROLLED = 12; // 11 из BASE (без Unoccupied) + Kamadhenu Test

const requests = [];

/** fetch EDSM: ответы по очереди; каждый — функция от заголовков запроса. */
function edsm(...replies) {
  const queue = [...replies];
  return async (url, init = {}) => {
    const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([key, value]) => [key.toLowerCase(), value]));
    requests.push({ url: String(url), headers });
    const reply = queue.shift();
    if (!reply) throw new Error('unexpected EDSM request');
    return reply(headers);
  };
}

const gzipReply = (text, headers = {}) => () => new Response(gzipSync(Buffer.from(text, 'utf8')), {
  status: 200,
  headers: { 'Content-Type': 'application/gzip', ETag: '"dump-1"', 'Last-Modified': LAST_MODIFIED, ...headers },
});

async function rows() {
  const { rows: list } = await db.query('SELECT id64::text AS id64, name, power, power_state, observed_at, sync_run, updated_at FROM powerplay_systems ORDER BY name');
  return list;
}

async function syncState() {
  return mod.readPowerplaySyncState(svc);
}

async function resetDb() {
  await db.exec(`DELETE FROM powerplay_systems; UPDATE powerplay_sync_state SET status = 'idle', etag = NULL, last_modified = NULL,
    dump_generated_at = NULL, run_id = NULL, rows_total = 0, stats = '{}'::jsonb, error = NULL, attempt_at = NULL, checked_at = NULL,
    synced_at = NULL, source_url = NULL;`);
  mod.resetPowerplayLayerCache();
  requests.length = 0;
}

async function waitIdle() {
  for (let i = 0; i < 200 && mod.isPowerplaySyncRunning(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(mod.isPowerplaySyncRunning(), false, 'фоновый импорт завершился');
}

function layerRequest(headers = {}) {
  return new Request('https://edringcolony.ru/api/powerplay/systems', { headers });
}

const realFetch = globalThis.fetch;
test.after(() => {
  globalThis.fetch = realFetch;
});

/* ── Импорт ────────────────────────────────────────────────────────────── */

test('импорт: системы под контролем, точный id64, состояние источника', async () => {
  await resetDb();
  const result = await mod.runPowerplaySync(svc, { fetchImpl: edsm(gzipReply(BASE_TEXT)), minRows: 1 });
  assert.equal(result.status, 'ok', result.error);
  assert.equal(result.rows, CONTROLLED);
  assert.equal(result.total, CONTROLLED);
  assert.equal(result.deleted, 0);
  assert.equal(result.dumpGeneratedAt, '2026-10-17T02:46:06.000Z');
  assert.equal(result.stats.skipped.unoccupied, 1);

  const list = await rows();
  assert.equal(list.length, CONTROLLED);
  assert.ok(!list.some((row) => row.name === 'Free World'), 'Unoccupied не хранится');
  const huge = list.find((row) => row.name === 'Kamadhenu Test');
  assert.equal(huge.id64, '36028797018963971', 'id64 шире 2^53 дошёл до BIGINT без округления');
  assert.equal(huge.power, 'A. Lavigny-Duval');
  assert.equal(huge.power_state, 'Stronghold');
  assert.equal(new Set(list.map((row) => row.sync_run)).size, 1, 'все строки одного импорта');

  const state = await syncState();
  assert.equal(state.status, 'ok');
  assert.equal(state.rows_total, CONTROLLED);
  assert.equal(state.etag, '"dump-1"');
  assert.equal(state.last_modified, LAST_MODIFIED);
  assert.equal(state.dump_generated_at, '2026-10-17T02:46:06.000Z');
  assert.equal(state.run_id, list[0].sync_run);
  assert.equal(state.source_url, mod.DEFAULT_POWERPLAY_DUMP_URL);
  assert.equal(state.stats.kept, CONTROLLED);
  assert.equal(state.stats.deleted, 0);
  assert.ok(state.synced_at && state.checked_at && state.attempt_at);
  assert.equal(requests[0].url, 'https://www.edsm.net/dump/powerPlay.json.gz');
  assert.equal(requests[0].headers['if-none-match'], undefined, 'первый импорт — безусловный');
  assert.match(requests[0].headers['user-agent'], /ED-Ring-Colony/);
});

test('импорт: повтор с ETag получает 304 и ничего не переписывает', async () => {
  const before = await rows();
  const runBefore = (await syncState()).run_id;
  requests.length = 0;
  const result = await mod.runPowerplaySync(svc, { fetchImpl: edsm(() => new Response(null, { status: 304 })), minRows: 1 });
  assert.equal(result.status, 'not_modified');
  assert.equal(result.total, CONTROLLED);
  assert.equal(requests[0].headers['if-none-match'], '"dump-1"');
  assert.equal(requests[0].headers['if-modified-since'], LAST_MODIFIED);
  assert.deepEqual(await rows(), before);
  const state = await syncState();
  assert.equal(state.status, 'ok');
  assert.equal(state.run_id, runBefore, 'версия набора не сменилась');
});

test('импорт: новый дамп пересобирает таблицу — пропавшие удаляются, изменённые обновляются', async () => {
  const before = Object.fromEntries((await rows()).map((row) => [row.name, row]));
  const next = BASE
    .filter((item) => item.name !== 'Surya')
    .map((item) => (item.name === 'Wolf 1061' ? { ...item, power: 'Felicia Winters', date: '2026-10-17 01:00:00' } : item));
  await new Promise((resolve) => setTimeout(resolve, 5));
  const result = await mod.runPowerplaySync(svc, {
    fetchImpl: edsm(gzipReply(dumpText(next, [HUGE_LINE]), { ETag: '"dump-2"' })),
    minRows: 1,
  });
  assert.equal(result.status, 'ok', result.error);
  assert.equal(result.deleted, 1);
  assert.equal(result.total, CONTROLLED - 1);
  const after = Object.fromEntries((await rows()).map((row) => [row.name, row]));
  assert.equal(after.Surya, undefined, 'системы, которой нет в дампе, больше нет и на карте');
  assert.equal(after['Wolf 1061'].power, 'Felicia Winters');
  assert.notEqual(after['Wolf 1061'].updated_at.getTime?.() ?? after['Wolf 1061'].updated_at, before['Wolf 1061'].updated_at.getTime?.() ?? before['Wolf 1061'].updated_at, 'смена державы двигает updated_at');
  assert.equal(String(after.Prajan.updated_at), String(before.Prajan.updated_at), 'неизменная система updated_at не трогает');
  assert.equal((await syncState()).etag, '"dump-2"');
});

test('защита: HTTP-ошибка, обрезанный gzip и пустой дамп таблицу не трогают', async () => {
  const before = await rows();

  const http = await mod.runPowerplaySync(svc, { fetchImpl: edsm(() => new Response('busy', { status: 503 })), minRows: 1 });
  assert.equal(http.status, 'error');
  assert.match(http.error, /HTTP 503/);
  let state = await syncState();
  assert.equal(state.status, 'error');
  assert.match(state.error, /HTTP 503/);

  const gz = gzipSync(Buffer.from(BASE_TEXT));
  const cut = await mod.runPowerplaySync(svc, {
    fetchImpl: edsm(() => new Response(gz.subarray(0, Math.floor(gz.length / 2)), { status: 200 })),
    minRows: 1,
    force: true,
  });
  assert.equal(cut.status, 'error', 'обрезанный архив — ошибка, а не половина карты');

  const empty = await mod.runPowerplaySync(svc, { fetchImpl: edsm(gzipReply(dumpText([BASE.at(-1)]))), minRows: 1, force: true });
  assert.equal(empty.status, 'error');
  assert.match(empty.error, /всего 0 систем/);

  const html = await mod.runPowerplaySync(svc, { fetchImpl: edsm(() => new Response('<html>maintenance</html>', { status: 200 })), minRows: 1, force: true });
  assert.equal(html.status, 'error');
  assert.match(html.error, /не похож/);

  assert.deepEqual(await rows(), before, 'данные прошлого импорта на месте');
  state = await syncState();
  assert.equal(state.rows_total, CONTROLLED - 1);
});

test('защита: «усохший» дамп отклоняется, ручной запуск с force его принимает', async () => {
  const small = dumpText(BASE.slice(0, 2));
  const guarded = await mod.runPowerplaySync(svc, { fetchImpl: edsm(gzipReply(small, { ETag: '"dump-small"' })), minRows: 1 });
  assert.equal(guarded.status, 'error');
  assert.match(guarded.error, /подозрительно мал: 2 систем против 11/);
  assert.equal((await rows()).length, CONTROLLED - 1);

  const forced = await mod.runPowerplaySync(svc, { fetchImpl: edsm(gzipReply(small, { ETag: '"dump-small"' })), minRows: 1, force: true });
  assert.equal(forced.status, 'ok', forced.error);
  assert.equal(forced.total, 2);
  assert.equal(forced.deleted, CONTROLLED - 3);
  assert.equal(requests.at(-1).headers['if-none-match'], undefined, 'force качает без условных заголовков');
});

test('импорт: тело уже распаковано прокси (Content-Encoding) — читается как JSON', async () => {
  await resetDb();
  const result = await mod.runPowerplaySync(svc, {
    fetchImpl: edsm(() => new Response(BASE_TEXT, { status: 200, headers: { 'Content-Type': 'application/json' } })),
    minRows: 1,
  });
  assert.equal(result.status, 'ok', result.error);
  assert.equal(result.total, CONTROLLED);
  const text = await mod.decodePowerplayDump(gzipSync(Buffer.from('[\n]')));
  assert.equal(text, '[\n]');
});

test('настройка источника: POWERPLAY_DUMP_URL проверяется', () => {
  assert.equal(mod.powerplayDumpUrl({}), mod.DEFAULT_POWERPLAY_DUMP_URL);
  assert.equal(mod.powerplayDumpUrl({ POWERPLAY_DUMP_URL: 'https://mirror.example/pp.json.gz' }), 'https://mirror.example/pp.json.gz');
  assert.equal(mod.powerplayDumpUrl({ POWERPLAY_DUMP_URL: 'file:///etc/passwd' }), mod.DEFAULT_POWERPLAY_DUMP_URL);
  assert.equal(mod.powerplayDumpUrl({ POWERPLAY_DUMP_URL: 'not a url' }), mod.DEFAULT_POWERPLAY_DUMP_URL);
});

test('ленивое обновление: когда данные устарели и когда можно пробовать снова', () => {
  const now = Date.parse('2026-10-18T12:00:00Z');
  const iso = (ms) => new Date(now - ms).toISOString();
  const fresh = { status: 'ok', rows_total: 100, checked_at: iso(3600_000), attempt_at: iso(3600_000) };
  assert.deepEqual(mod.powerplayNeedsRefresh(fresh, now), { stale: false, allowed: true });
  assert.equal(mod.powerplayNeedsRefresh({ ...fresh, rows_total: 0 }, now).stale, true, 'пустая таблица — устарела');
  assert.equal(mod.powerplayNeedsRefresh({ ...fresh, checked_at: iso(mod.POWERPLAY_STALE_AFTER_MS + 1000) }, now).stale, true);
  assert.equal(mod.powerplayNeedsRefresh({ ...fresh, checked_at: null }, now).stale, true);
  assert.equal(mod.powerplayNeedsRefresh({ ...fresh, attempt_at: iso(60_000) }, now).allowed, false, 'неудача минуту назад — ждём');
  assert.equal(mod.powerplayNeedsRefresh({ ...fresh, attempt_at: iso(mod.POWERPLAY_RETRY_AFTER_MS + 1000) }, now).allowed, true);
  assert.equal(mod.powerplayNeedsRefresh({ ...fresh, status: 'running', attempt_at: iso(5 * 60_000) }, now).allowed, false, 'идёт в другом процессе');
  assert.equal(mod.powerplayNeedsRefresh({ ...fresh, status: 'running', attempt_at: iso(2 * 3600_000) }, now).allowed, true, 'зависший running не блокирует');
});

/* ── API слоя ──────────────────────────────────────────────────────────── */

test('GET /api/powerplay/systems: компактный набор, ETag и 304', async () => {
  // Таблица заполнена прошлым тестом; источник свежий — фоновый импорт не нужен.
  globalThis.fetch = async () => {
    throw new Error('свежие данные не должны вызывать EDSM');
  };
  mod.resetPowerplayLayerCache();
  const response = await mod.layerRoute.GET(layerRequest());
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/json/);
  assert.match(response.headers.get('cache-control'), /public, max-age=300/);
  const etag = response.headers.get('etag');
  assert.match(etag, /^"pp-[0-9a-f]{20}"$/);
  const body = await response.json();

  assert.equal(body.status, 'ready');
  assert.equal(body.version, (await syncState()).run_id);
  assert.deepEqual(body.states, ['Stronghold', 'Fortified', 'Exploited']);
  assert.equal(body.powers[0], 'Nakato Kaine', 'держава с наибольшим числом систем первая');
  assert.equal(body.systems.length, CONTROLLED);
  const names = body.systems.map((tuple) => tuple[1]);
  assert.deepEqual(names, [...names].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase(), 'en')), 'по имени');
  const huge = body.systems.find((tuple) => tuple[1] === 'Kamadhenu Test');
  assert.equal(huge[0], '36028797018963971');
  assert.equal(body.powers[huge[5]], 'A. Lavigny-Duval');
  assert.equal(body.states[huge[6]], 'Stronghold');
  assert.equal(huge[7], Date.parse('2026-10-16T23:00:00Z') / 1000);
  assert.equal(body.meta.source, 'edsm');
  assert.equal(body.meta.dumpGeneratedAt, null, 'ответ без Last-Modified');
  assert.ok(body.meta.syncedAt);
  assert.equal(body.meta.refreshing, false);
  assert.equal(body.meta.lastError, null);
  assert.equal(body.meta.oldestObservation, '2026-10-16T12:00:00.000Z');
  assert.equal(body.meta.newestObservation, '2026-10-16T23:00:00.000Z');

  const decoded = mod.decodePowerplayLayer(body);
  assert.equal(decoded.systems.length, CONTROLLED, 'браузер разбирает ответ целиком');

  const again = await mod.layerRoute.GET(layerRequest({ 'If-None-Match': etag }));
  assert.equal(again.status, 304);
  assert.equal(await again.text(), '');
  const weak = await mod.layerRoute.GET(layerRequest({ 'If-None-Match': `W/${etag}, "other"` }));
  assert.equal(weak.status, 304, 'слабый ETag из списка тоже совпадает');
});

test('GET /api/powerplay/systems: пустая таблица запускает импорт фоном, потом отдаёт набор', async () => {
  await resetDb();
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls += 1;
    assert.equal(String(url), mod.DEFAULT_POWERPLAY_DUMP_URL);
    return gzipReply(BASE_TEXT)();
  };
  const first = await mod.layerRoute.GET(layerRequest());
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('cache-control'), 'no-store');
  const body = await first.json();
  assert.equal(body.status, 'empty');
  assert.equal(body.meta.refreshing, true);
  assert.deepEqual(body.systems, []);

  await waitIdle();
  assert.equal(calls, 1);
  // В PGlite минимальное число систем по умолчанию (100) не набрать — фоновый
  // импорт честно отказал; карта показывает это понятным текстом.
  const state = await syncState();
  assert.equal(state.status, 'error');
  const refused = await (await mod.layerRoute.GET(layerRequest())).json();
  assert.equal(refused.status, 'empty');
  assert.equal(refused.meta.refreshing, false, 'после неудачи повтор не раньше чем через полчаса');
  assert.equal(refused.meta.lastError, 'Свежий дамп источника выглядит неполным — импорт отложен');
  assert.equal(calls, 1, 'неудачная попытка не повторяется на каждый запрос');

  // Нормальный объём (или ручной импорт) — и следующий запрос видит данные.
  const done = await mod.runPowerplaySync(svc, { fetchImpl: edsm(gzipReply(BASE_TEXT)), minRows: 1 });
  assert.equal(done.status, 'ok', done.error);
  const ready = await (await mod.layerRoute.GET(layerRequest())).json();
  assert.equal(ready.status, 'ready');
  assert.equal(ready.systems.length, CONTROLLED);
});

test('GET /api/powerplay/systems: ошибка источника — коротко и без адресов', async () => {
  await db.query(`UPDATE powerplay_sync_state SET status = 'error', error = 'EDSM ответил HTTP 503', attempt_at = now()`);
  let body = await (await mod.layerRoute.GET(layerRequest())).json();
  assert.equal(body.status, 'ready', 'прошлые данные остаются на карте');
  assert.equal(body.meta.lastError, 'Источник недоступен (HTTP 503)');

  await db.query(`UPDATE powerplay_sync_state SET error = 'fetch failed: getaddrinfo ENOTFOUND www.edsm.net'`);
  body = await (await mod.layerRoute.GET(layerRequest())).json();
  assert.equal(body.meta.lastError, 'Нет связи с источником данных');

  await db.query(`UPDATE powerplay_sync_state SET status = 'ok', error = NULL`);
  body = await (await mod.layerRoute.GET(layerRequest())).json();
  assert.equal(body.meta.lastError, null);
});

test('GET /api/powerplay/systems: сбой базы — 503 без подробностей', async () => {
  const saved = mod.state.db;
  mod.state.db = { query: async () => { throw new Error('connection refused to 10.0.0.5'); } };
  try {
    const response = await mod.layerRoute.GET(layerRequest());
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.error, 'Не удалось загрузить системы PowerPlay');
  } finally {
    mod.state.db = saved;
  }
});

/* ── Задача планировщика ───────────────────────────────────────────────── */

test('/api/cron/powerplay-sync: секрет обязателен, отчёт и 502 при сбое', async () => {
  const url = 'https://edringcolony.ru/api/cron/powerplay-sync';
  const anonymous = await mod.cronRoute.GET(new Request(url));
  assert.equal(anonymous.status, 401);

  const auth = { Authorization: `Bearer ${process.env.CRON_SECRET}` };
  globalThis.fetch = async () => new Response(null, { status: 304 });
  const unchanged = await mod.cronRoute.POST(new Request(url, { method: 'POST', headers: auth }));
  assert.equal(unchanged.status, 200);
  const report = await unchanged.json();
  assert.equal(report.ok, true);
  assert.equal(report.status, 'not_modified');

  globalThis.fetch = async () => new Response('down', { status: 500 });
  const failed = await mod.cronRoute.GET(new Request(`${url}?force=1`, { headers: auth }));
  assert.equal(failed.status, 502);
  const failure = await failed.json();
  assert.equal(failure.ok, false);
  assert.match(failure.error, /HTTP 500/);
  assert.equal((await rows()).length, CONTROLLED, 'сбой задачи не стёр карту');
});
