/**
 * Слой «PowerPlay»: импорт дампа EDSM и API на настоящем PostgreSQL (PGlite)
 * с миграцией `20261018120000_powerplay_systems.sql`.
 *
 * С web 2.24.0 импорт устроен как у минорных фракций: архив скачивается на
 * сервер целиком → разбивается на куски → куски пишутся в базу, шаги по
 * очереди. Маршруты собираются esbuild'ом с подменой `next/server` и
 * `@/lib/supabaseServer`; service-role клиент — `helpers/pgliteSupabase.mjs`.
 * EDSM — подставной `fetch` с настоящим gzip, HEAD и Range. Проверяется:
 *   * импорт: отбор систем, id64 шире 2^53, состояние, архив и куски
 *     удалены после записи; тот же дамп второй раз не качается («без
 *     изменений»); импорт прежним разбором перечитывается; новый дамп
 *     пересобирает таблицу;
 *   * защита данных: HTTP-ошибка, обрезанный gzip, пустой и «усохший» дамп,
 *     HTML вместо дампа таблицу не трогают, `force` принимает усохший;
 *   * по частям (скачать / разбить / записать без EDSM), остановка посреди
 *     скачивания и посреди записи с продолжением, дамп, пересобранный посреди
 *     скачивания, EDSM недоступен, сеть, «замораживающая» соединения,
 *     прямой Postgres, короткий statement_timeout PostgREST;
 *   * `GET /api/powerplay/systems`: формат, ETag/304, кэш-заголовки, пустая
 *     таблица запускает импорт фоном, ошибки источника — понятным текстом;
 *   * `/api/cron/powerplay-sync`: секрет, отчёт, 502 при сбое.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { PGlite } from '@electric-sql/pglite';
import { TEST_ROOT, bundleFile } from './helpers/bundle.mjs';

const ARCHIVE_DIR = mkdtempSync(join(tmpdir(), 'pp-archive-'));
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
process.env.CRON_SECRET = 'powerplay-cron-secret';
process.env.POWERPLAY_ARCHIVE_DIR = ARCHIVE_DIR;
// Подставной EDSM — это `globalThis.fetch`; настоящий сервер — новое соединение на запрос (freshFetch).
process.env.POWERPLAY_FRESH_CONNECTIONS = '0';
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

const ENTRY = `
export * as layerRoute from '@/app/api/powerplay/systems/route';
export * as cronRoute from '@/app/api/cron/powerplay-sync/route';
export { state } from '@/lib/supabaseServer';
export { createServiceClient } from '@/lib/supabaseServer';
export {
  runPowerplaySync, startPowerplaySync, cancelPowerplaySync, isPowerplaySyncRunning, powerplayNeedsRefresh, powerplayParserCurrent,
  readPowerplaySyncState, decodePowerplayDump, getPowerplayLastRun, getPowerplayLiveRun, resetPowerplaySyncRuntime,
  powerplayDumpUrl, DEFAULT_POWERPLAY_DUMP_URL, POWERPLAY_STALE_AFTER_MS, POWERPLAY_RETRY_AFTER_MS,
  powerplayArchivePath, powerplayArchiveDir, powerplayShardsDir, powerplayArchiveInfo, powerplayShardsStatus,
  powerplayDownloadSegments, powerplayPieceBytes, powerplayShardSystems, powerplayStallMs, powerplayShortRequests,
  powerplayFreshConnections, powerplayArchiveKeep, cleanupPowerplayArchive, POWERPLAY_CANCEL_MESSAGE,
} from '@/lib/powerplaySync';
export { readPowerplayShardManifest } from '@/lib/powerplayShards';
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
const ARCHIVE = mod.powerplayArchivePath();
const SHARDS = mod.powerplayShardsDir();

/* ── Подставной дамп EDSM ──────────────────────────────────────────────── */

const LAST_MODIFIED = 'Sat, 17 Oct 2026 02:46:06 GMT';

function record(name, power, state, extra = {}) {
  return { power, powerState: state, id: 1, id64: extra.id64 ?? 1000 + name.length * 7 + name.charCodeAt(0), name, coords: extra.coords ?? { x: 10, y: 5, z: -20 }, allegiance: extra.allegiance ?? 'Independent', government: 'Corporate', state: 'None', date: extra.date ?? '2026-10-16 12:00:00' };
}

/** Строки дампа как у EDSM: массив, запись на строку, id64 печатается числом без кавычек. */
function dumpText(records, rawLines = []) {
  const lines = records.map((item) => ` ${JSON.stringify(item)}`);
  return `[\n${[...lines, ...rawLines].join(',\n')}\n]`;
}

const gz = (text) => gzipSync(Buffer.from(text, 'utf8'));

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
const BASE_GZ = gz(BASE_TEXT);
const CONTROLLED = 12; // 11 из BASE (без Unoccupied) + Kamadhenu Test

/** Много систем под контролем; `noise` — несжимаемое имя: такой архив делится на много кусков файла. */
function manySystems(count, prefix, { base = 7_000_000, noise = 0 } = {}) {
  return Array.from({ length: count }, (_, i) => record(`${prefix} ${i}${noise ? ` ${randomBytes(noise).toString('hex')}` : ''}`, i % 3 ? 'Aisling Duval' : 'Zemina Torval', i % 5 ? 'Exploited' : 'Fortified', {
    id64: base + i,
    coords: { x: i, y: -i, z: i / 2 },
  }));
}

const fetchCalls = [];

/**
 * EDSM: HEAD (размер, дата, Range), GET целиком или с Range `от-до`.
 * `status` — ответ на всё (сбой сервера), `unreachable` — сервер не отвечает,
 * `stallAfter` — каждый ответ отдаёт столько байт и замолкает, `delayMs` —
 * задержка ответа на GET, `next` + `switchAfterGets` — после N запросов GET
 * EDSM отдаёт уже другой, пересобранный дамп.
 */
function edsm(body, {
  etag = '"dump-1"', lastModified = LAST_MODIFIED, status = null, unreachable = false, stallAfter = null, delayMs = 0,
  next = null, switchAfterGets = Infinity, contentType = 'application/gzip',
} = {}) {
  let gets = 0;
  return async (url, init = {}) => {
    const headers = new Headers(init.headers || {});
    const method = init.method || 'GET';
    const range = headers.get('range');
    fetchCalls.push({ method, range, ua: headers.get('user-agent'), url: String(url) });
    if (unreachable) throw new TypeError('fetch failed');
    if (status) return new Response('busy', { status });
    const current = next && gets >= switchAfterGets ? next : { body, etag, lastModified };
    if (method === 'GET') gets += 1;
    const common = { etag: current.etag, 'accept-ranges': 'bytes', 'content-type': contentType, ...(current.lastModified ? { 'last-modified': current.lastModified } : {}) };
    if (method === 'HEAD') return new Response(null, { status: 200, headers: { ...common, 'content-length': String(current.body.length) } });
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    let start = 0;
    let end = current.body.length - 1;
    let code = 200;
    if (range) {
      const match = /bytes=(\d+)-(\d*)/.exec(range);
      start = Number(match[1]);
      if (match[2]) end = Math.min(end, Number(match[2]));
      if (start >= current.body.length) {
        return new Response(null, { status: 416, headers: { ...common, 'content-range': `bytes */${current.body.length}` } });
      }
      code = 206;
    }
    const slice = current.body.subarray(start, end + 1);
    const extra = code === 206 ? { 'content-range': `bytes ${start}-${end}/${current.body.length}` } : {};
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
      return new Response(stream, { status: code, headers: { ...common, ...extra, 'content-length': String(slice.length) } });
    }
    return new Response(slice, { status: code, headers: { ...common, ...extra, 'content-length': String(slice.length) } });
  };
}

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
  mod.cleanupPowerplayArchive(ARCHIVE);
  fetchCalls.length = 0;
}

async function waitFor(check, label, attempts = 600) {
  for (let i = 0; i < attempts; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`не дождались: ${label}`);
}

async function waitIdle() {
  await waitFor(() => !mod.isPowerplaySyncRunning(), 'фоновый импорт завершился');
}

function layerRequest(headers = {}) {
  return new Request('https://edringcolony.ru/api/powerplay/systems', { headers });
}

function runOptions(fetchImpl, extra = {}) {
  return { fetchImpl, archivePath: ARCHIVE, segments: 1, minRows: 1, keepArchive: false, directDb: false, sleep: async () => {}, ...extra };
}

const logText = () => mod.getPowerplayLastRun().log.map((line) => line.text).join('\n');
const methods = () => fetchCalls.map((call) => call.method);

const realFetch = globalThis.fetch;
test.after(() => {
  globalThis.fetch = realFetch;
});

/* ── Импорт ────────────────────────────────────────────────────────────── */

test('импорт: архив на сервер → куски → база; системы под контролем, точный id64, состояние источника', async () => {
  await resetDb();
  mod.resetPowerplaySyncRuntime();
  const result = await mod.runPowerplaySync(svc, runOptions(edsm(BASE_GZ)));
  assert.equal(result.status, 'ok', result.error);
  assert.equal(result.mode, 'full');
  assert.equal(result.rows, CONTROLLED);
  assert.equal(result.total, CONTROLLED);
  assert.equal(result.deleted, 0);
  assert.equal(result.shards, 1);
  assert.equal(result.backend, 'postgrest');
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
  assert.equal(state.stats.parser, 2);
  assert.equal(state.stats.dump_bytes, BASE_GZ.length, 'размер дампа — для «тот же дамп»');
  assert.equal(state.stats.shards, 1);
  assert.equal(state.stats.deleted, 0);
  assert.ok(state.synced_at && state.checked_at && state.attempt_at);

  assert.deepEqual(methods(), ['HEAD', 'GET'], 'один HEAD: скачивание берёт готовый ответ на запрос');
  assert.equal(fetchCalls[0].url, 'https://www.edsm.net/dump/powerPlay.json.gz');
  assert.match(fetchCalls[1].range ?? '', /^bytes=0-/, 'архив — Range-запросами (докачка после обрыва)');
  assert.ok(fetchCalls.every((call) => /ED-Ring-Colony/.test(call.ua ?? '')), 'свой User-Agent');
  assert.equal(existsSync(ARCHIVE), false, 'архив удалён после импорта');
  assert.equal(existsSync(join(SHARDS, 'manifest.json')), false, 'куски удалены после импорта');

  const { progress } = mod.getPowerplayLastRun();
  assert.deepEqual(progress.stages.map((stage) => [stage.id, stage.status]),
    [['probe', 'done'], ['download', 'done'], ['split', 'done'], ['import', 'done'], ['finish', 'done']]);
  const text = logText();
  assert.match(text, /Запуск импорта: вручную · загрузка данных \(скачать архив целиком → разбить на куски → записать в базу, по очереди\)/);
  const order = ['Скачиваю архив на сервер целиком', 'Архив скачан целиком', 'Разбивка: читаю архив', 'Разбивка завершена', 'Запись в базу: кусок 1 из 1']
    .map((line) => text.indexOf(line));
  assert.ok(order.every((at) => at >= 0) && order.every((at, i) => i === 0 || at > order[i - 1]), `шаги по очереди: ${order}`);
  const [download, split, imported] = ['download', 'split', 'import'].map((id) => progress.stages.find((stage) => stage.id === id));
  assert.ok(Date.parse(download.finishedAt) <= Date.parse(split.startedAt), 'разбивка — после скачивания');
  assert.ok(Date.parse(split.finishedAt) <= Date.parse(imported.startedAt), 'запись — после разбивки');
  assert.match(text, /Запись в базу: PostgREST — пачками по 2 000 систем/);
  assert.match(text, /Архив и куски удалены с сервера/);
});

test('тот же дамп второй раз не качается («без изменений»)', async () => {
  const before = await rows();
  const runBefore = (await syncState()).run_id;
  const checkedBefore = (await syncState()).checked_at;
  fetchCalls.length = 0;
  await new Promise((resolve) => setTimeout(resolve, 5));
  const result = await mod.runPowerplaySync(svc, runOptions(edsm(BASE_GZ)));
  assert.equal(result.status, 'not_modified');
  assert.equal(result.total, CONTROLLED);
  assert.deepEqual(methods(), ['HEAD'], 'только HEAD');
  assert.deepEqual(await rows(), before);
  const state = await syncState();
  assert.equal(state.status, 'ok');
  assert.equal(state.run_id, runBefore, 'версия набора не сменилась');
  assert.notEqual(String(state.checked_at), String(checkedBefore), 'проверку источника видно');
  assert.match(logText(), /Дамп не менялся с прошлой загрузки — данные актуальны \(12 систем\)/);
});

test('импорт прежним разбором: тот же файл EDSM качается и перечитывается', async () => {
  // Так база выглядит после обновления сайта: импорт записан до web 2.23.0 (stats без parser).
  await db.exec(`UPDATE powerplay_sync_state SET stats = '{"kept": 12}'::jsonb WHERE id = 1`);
  assert.equal((await syncState()).etag, '"dump-1"', 'заголовки прошлой загрузки на месте');
  fetchCalls.length = 0;
  const result = await mod.runPowerplaySync(svc, runOptions(edsm(BASE_GZ)));
  assert.equal(result.status, 'ok', 'тот же дамп не сочтён «без изменений» — иначе остался бы старый разбор');
  assert.deepEqual(methods(), ['HEAD', 'GET']);
  const state = await syncState();
  assert.equal(state.stats.parser, 2, 'теперь данные записаны текущим разбором');
  assert.equal(mod.powerplayParserCurrent(state), true);
  // Без миграции хода импорта журнал живёт в памяти процесса.
  assert.match(logText(), /записаны прежним разбором дампа/);
});

test('импорт: новый дамп пересобирает таблицу — пропавшие удаляются, изменённые обновляются', async () => {
  const before = Object.fromEntries((await rows()).map((row) => [row.name, row]));
  const next = BASE
    .filter((item) => item.name !== 'Surya')
    .map((item) => (item.name === 'Wolf 1061' ? { ...item, power: 'Felicia Winters', date: '2026-10-17 01:00:00' } : item));
  await new Promise((resolve) => setTimeout(resolve, 5));
  const result = await mod.runPowerplaySync(svc, runOptions(edsm(gz(dumpText(next, [HUGE_LINE])), { etag: '"dump-2"' })));
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

/* ── Защита данных ─────────────────────────────────────────────────────── */

test('защита: HTTP-ошибка, обрезанный gzip, пустой дамп и HTML таблицу не трогают', async () => {
  const before = await rows();

  const http = await mod.runPowerplaySync(svc, runOptions(edsm(BASE_GZ, { status: 503 })));
  assert.equal(http.status, 'error');
  assert.match(http.error, /EDSM не ответил: .*HTTP 503/);
  let state = await syncState();
  assert.equal(state.status, 'error');
  assert.match(state.error, /HTTP 503/);

  const whole = gz(BASE_TEXT.replace('Prajan', 'Prajan Cut'));
  const cut = await mod.runPowerplaySync(svc, runOptions(edsm(whole.subarray(0, Math.floor(whole.length / 2)), { etag: '"cut"' }), { force: true }));
  assert.equal(cut.status, 'error', 'обрезанный архив — ошибка, а не половина карты');
  assert.match(cut.error, /Архив не разбирается/);
  assert.equal(existsSync(ARCHIVE), false, 'битый архив удалён — следующий запуск скачает заново');
  assert.match(logText(), /Архив повреждён или внутри не дамп PowerPlay — удалён с сервера вместе с кусками/);

  const empty = await mod.runPowerplaySync(svc, runOptions(edsm(gz(dumpText([BASE.at(-1)])), { etag: '"empty"' }), { force: true }));
  assert.equal(empty.status, 'error');
  assert.match(empty.error, /всего 0 систем под контролем .* данные не тронуты/);

  const html = await mod.runPowerplaySync(svc, runOptions(edsm(Buffer.from('<html>maintenance</html>'), { etag: '"html"', contentType: 'text/html' }), { force: true }));
  assert.equal(html.status, 'error');
  assert.match(html.error, /не похож/);

  assert.deepEqual(await rows(), before, 'данные прошлого импорта на месте');
  state = await syncState();
  assert.equal(state.rows_total, CONTROLLED - 1);
});

test('защита: «усохший» дамп отклоняется до записи, ручной запуск с force его принимает', async () => {
  const small = gz(dumpText(BASE.slice(0, 2)));
  const guarded = await mod.runPowerplaySync(svc, runOptions(edsm(small, { etag: '"dump-small"' }), { minRows: 1 }));
  assert.equal(guarded.status, 'error');
  assert.match(guarded.error, /подозрительно мал: 2 систем против 11/);
  assert.equal((await rows()).length, CONTROLLED - 1);
  const untouched = await db.query(`SELECT count(*)::int AS n FROM powerplay_systems WHERE sync_run IS DISTINCT FROM (SELECT run_id FROM powerplay_sync_state)`);
  assert.equal(untouched.rows[0].n, 0, 'ни одна строка не перезаписана «усохшим» дампом');

  fetchCalls.length = 0;
  const forced = await mod.runPowerplaySync(svc, runOptions(edsm(small, { etag: '"dump-small"' }), { force: true }));
  assert.equal(forced.status, 'ok', forced.error);
  assert.equal(forced.total, 2);
  assert.equal(forced.deleted, CONTROLLED - 3);
  assert.deepEqual(methods(), ['HEAD'], 'архив и куски того же дампа уже на сервере — не качаются второй раз');
});

test('архив, распакованный по пути (Content-Encoding), читается как JSON', async () => {
  await resetDb();
  const result = await mod.runPowerplaySync(svc, runOptions(edsm(Buffer.from(BASE_TEXT, 'utf8'), { contentType: 'application/json' })));
  assert.equal(result.status, 'ok', result.error);
  assert.equal(result.total, CONTROLLED);
  const text = await mod.decodePowerplayDump(gzipSync(Buffer.from('[\n]')));
  assert.equal(text, '[\n]');
});

test('настройки: адрес дампа, каталог архива, соединения, кусок файла, систем в куске, короткие запросы', () => {
  assert.equal(mod.powerplayDumpUrl({}), mod.DEFAULT_POWERPLAY_DUMP_URL);
  assert.equal(mod.powerplayDumpUrl({ POWERPLAY_DUMP_URL: 'https://mirror.example/pp.json.gz' }), 'https://mirror.example/pp.json.gz');
  assert.equal(mod.powerplayDumpUrl({ POWERPLAY_DUMP_URL: 'file:///etc/passwd' }), mod.DEFAULT_POWERPLAY_DUMP_URL);
  assert.equal(mod.powerplayDumpUrl({ POWERPLAY_DUMP_URL: 'not a url' }), mod.DEFAULT_POWERPLAY_DUMP_URL);
  assert.equal(mod.powerplayArchiveDir({ GALAXY_ARCHIVE_DIR: '/mnt/spansh' }), join('/mnt/spansh', 'powerplay'), 'рядом с дампами каталога и фракций');
  assert.equal(mod.powerplayArchiveDir({ POWERPLAY_ARCHIVE_DIR: '/data/pp' }), '/data/pp');
  assert.equal(mod.powerplayDownloadSegments({}), 4);
  assert.equal(mod.powerplayDownloadSegments({ POWERPLAY_DOWNLOAD_SEGMENTS: '40' }), 16);
  assert.equal(mod.powerplayPieceBytes({}), 256 * 1024);
  assert.equal(mod.powerplayPieceBytes({ POWERPLAY_PIECE_KB: '4' }), 16 * 1024);
  assert.equal(mod.powerplayShardSystems({}), 2000);
  assert.equal(mod.powerplayShardSystems({ POWERPLAY_SHARD_SYSTEMS: '5' }), 100);
  assert.equal(mod.powerplayStallMs({}), 15_000);
  assert.equal(mod.powerplayStallMs({ POWERPLAY_STALL_SECONDS: 'off' }), 0);
  assert.equal(mod.powerplayShortRequests({}), 'auto');
  assert.equal(mod.powerplayShortRequests({ POWERPLAY_REQUEST_KB: 'off' }), 'off');
  assert.equal(mod.powerplayShortRequests({ POWERPLAY_REQUEST_KB: '12' }), 12 * 1024);
  assert.equal(mod.powerplayFreshConnections({}), true);
  assert.equal(mod.powerplayFreshConnections({ POWERPLAY_FRESH_CONNECTIONS: '0' }), false);
  assert.equal(mod.powerplayArchiveKeep({}), false);
  assert.equal(mod.powerplayArchiveKeep({ POWERPLAY_ARCHIVE_KEEP: '1' }), true);
});

test('ленивое обновление: когда данные устарели и когда можно пробовать снова', () => {
  const now = Date.parse('2026-10-18T12:00:00Z');
  const iso = (ms) => new Date(now - ms).toISOString();
  const fresh = { status: 'ok', rows_total: 100, checked_at: iso(3600_000), attempt_at: iso(3600_000), stats: { parser: 2 } };
  assert.deepEqual(mod.powerplayNeedsRefresh(fresh, now), { stale: false, allowed: true });
  // Импорт прежним разбором приписывал спорные системы одной державе — данные устарели, даже свежие.
  assert.equal(mod.powerplayParserCurrent(fresh), true);
  assert.equal(mod.powerplayParserCurrent({ stats: null }), false);
  assert.equal(mod.powerplayNeedsRefresh({ ...fresh, stats: {} }, now).stale, true, 'импорт до web 2.23.0 — перезагрузить');
  assert.equal(mod.powerplayNeedsRefresh({ ...fresh, stats: { parser: 1 } }, now).stale, true);
  assert.equal(mod.powerplayNeedsRefresh({ ...fresh, rows_total: 0 }, now).stale, true, 'пустая таблица — устарела');
  assert.equal(mod.powerplayNeedsRefresh({ ...fresh, checked_at: iso(mod.POWERPLAY_STALE_AFTER_MS + 1000) }, now).stale, true);
  assert.equal(mod.powerplayNeedsRefresh({ ...fresh, checked_at: null }, now).stale, true);
  assert.equal(mod.powerplayNeedsRefresh({ ...fresh, attempt_at: iso(60_000) }, now).allowed, false, 'неудача минуту назад — ждём');
  assert.equal(mod.powerplayNeedsRefresh({ ...fresh, attempt_at: iso(mod.POWERPLAY_RETRY_AFTER_MS + 1000) }, now).allowed, true);
  assert.equal(mod.powerplayNeedsRefresh({ ...fresh, status: 'running', attempt_at: iso(5 * 60_000) }, now).allowed, false, 'идёт в другом процессе');
  assert.equal(mod.powerplayNeedsRefresh({ ...fresh, status: 'running', attempt_at: iso(2 * 3600_000) }, now).allowed, true, 'зависший running не блокирует');
});

/* ── Конвейер: по частям, остановка, продолжение ───────────────────────── */

test('по частям: «Скачать архив» → «Разбить на куски» → «Загрузить куски в базу» без EDSM', async () => {
  await resetDb();
  const body = gz(dumpText(manySystems(250, 'Parts')));
  fetchCalls.length = 0;
  const downloaded = await mod.runPowerplaySync(svc, runOptions(edsm(body, { etag: '"parts"' }), { mode: 'download', pieceBytes: 1024 }));
  assert.equal(downloaded.status, 'ok', downloaded.error);
  assert.equal(downloaded.archiveBytes, body.length);
  assert.ok(methods().filter((method) => method === 'GET').length > 1, 'куски файла — отдельными запросами');
  assert.equal(mod.powerplayArchiveInfo(ARCHIVE).complete, true);
  assert.equal((await rows()).length, 0, 'скачивание базу не трогает');
  assert.deepEqual(mod.getPowerplayLastRun().progress.stages.map((stage) => stage.status), ['done', 'done', 'skipped', 'skipped', 'skipped']);
  assert.equal((await syncState()).status, 'idle', 'скачивание состояние импорта не трогает');

  fetchCalls.length = 0;
  const split = await mod.runPowerplaySync(svc, runOptions(edsm(body, { unreachable: true }), { mode: 'split', shardSystems: 100 }));
  assert.equal(split.status, 'ok', split.error);
  assert.equal(split.shards, 3);
  assert.equal(fetchCalls.length, 0, 'разбивка к EDSM не ходит');
  const info = mod.powerplayShardsStatus(SHARDS);
  assert.deepEqual([info.exists, info.complete, info.shards, info.systems, info.imported], [true, true, 3, 250, 0]);
  assert.match(readFileSync(join(SHARDS, 'manifest.json'), 'utf8'), /"pp-00001\.ndjson\.gz"/);

  const imported = await mod.runPowerplaySync(svc, runOptions(edsm(body, { unreachable: true }), { mode: 'import' }));
  assert.equal(imported.status, 'ok', imported.error);
  assert.equal(imported.total, 250);
  assert.equal(fetchCalls.length, 0, 'запись в базу — без EDSM');
  assert.equal((await syncState()).etag, '"parts"', 'в базе тот же дамп, что скачан');
  assert.equal(existsSync(ARCHIVE), false);

  const again = await mod.runPowerplaySync(svc, runOptions(edsm(body, { unreachable: true }), { mode: 'import' }));
  assert.equal(again.status, 'error', 'на сервере больше ничего нет');
  assert.match(again.error, /нет ни архива, ни кусков/);
});

test('«Остановить» на скачивании: скачанное остаётся, следующий запуск докачивает через Range', async () => {
  await resetDb();
  const body = gz(dumpText(manySystems(200, 'Resume')));
  const started = mod.startPowerplaySync(svc, runOptions(edsm(body, { etag: '"resume"', stallAfter: 40 }), { trigger: 'admin' }));
  assert.deepEqual(started, { started: true });
  assert.equal(mod.startPowerplaySync(svc, runOptions(edsm(body))).started, false, 'второй не начинается');
  const downloadedNow = () => mod.getPowerplayLiveRun()?.progress.stages.find((stage) => stage.id === 'download')?.done ?? 0;
  await waitFor(() => downloadedNow() >= 40, 'первые байты на диске');
  assert.equal(mod.getPowerplayLiveRun().progress.stage, 'download');
  assert.equal(mod.powerplayArchiveInfo(ARCHIVE).total, body.length, 'файл выделен целиком, а план кусков уже на диске');
  assert.equal(mod.cancelPowerplaySync(), true);
  assert.equal(mod.cancelPowerplaySync(), false, 'дважды не останавливают');
  await waitIdle();
  const { progress } = mod.getPowerplayLastRun();
  assert.equal(progress.phase, 'cancelled');
  assert.equal(progress.stages.find((stage) => stage.id === 'download').status, 'error');
  assert.match(logText(), /Импорт остановлен администратором: таблица не тронута — скачанное и разбитое осталось на сервере/);
  const partial = mod.powerplayArchiveInfo(ARCHIVE);
  assert.deepEqual([partial.complete, partial.partial, partial.downloaded], [false, true, 40], 'недокачанный архив остался на сервере');
  const state = await syncState();
  assert.equal(state.status, 'error');
  assert.equal(state.error, mod.POWERPLAY_CANCEL_MESSAGE);

  fetchCalls.length = 0;
  const result = await mod.runPowerplaySync(svc, runOptions(edsm(body, { etag: '"resume"' })));
  assert.equal(result.status, 'ok', result.error);
  assert.equal(result.total, 200);
  const resumed = fetchCalls.find((call) => call.method === 'GET');
  assert.equal(resumed.range, `bytes=40-${body.length - 1}`, 'докачка с того же места');
});

test('остановка посреди записи: следующий запуск не качает архив заново и пишет только незаписанные куски', async () => {
  await resetDb();
  const body = gz(dumpText(manySystems(500, 'Halt')));
  let calls = 0;
  let release = null;
  mod.state.rpcGuard = async (name) => {
    if (name !== 'powerplay_apply_batch') return;
    calls += 1;
    if (calls === 2) await new Promise((resolve) => { release = resolve; });
  };
  try {
    const started = mod.startPowerplaySync(svc, runOptions(edsm(body, { etag: '"halt"' }), { shardSystems: 100, keepArchive: false }));
    assert.equal(started.started, true);
    await waitFor(() => release !== null, 'запись второго куска');
    assert.equal(mod.cancelPowerplaySync(), true);
    release();
    await waitIdle();
  } finally {
    mod.state.rpcGuard = null;
  }
  assert.equal(mod.getPowerplayLastRun().progress.phase, 'cancelled');
  assert.match(logText(), /часть систем уже обновлена, пропавшие из дампа не удалялись/);
  const manifest = mod.readPowerplayShardManifest(SHARDS);
  assert.equal(manifest.shards.filter((entry) => entry.imported).length, 2, 'два куска записаны');
  const runId = manifest.runId;

  fetchCalls.length = 0;
  calls = 0;
  mod.state.rpcGuard = async (name) => {
    if (name === 'powerplay_apply_batch') calls += 1;
  };
  try {
    const result = await mod.runPowerplaySync(svc, runOptions(edsm(body, { etag: '"halt"' }), { shardSystems: 100 }));
    assert.equal(result.status, 'ok', result.error);
    assert.equal(result.total, 500);
  } finally {
    mod.state.rpcGuard = null;
  }
  assert.deepEqual(methods(), ['HEAD'], 'архив не качается заново');
  assert.equal(calls, 3, 'дописаны только три незаписанных куска');
  assert.match(logText(), /Запись в базу: продолжаю — 2 кусков этого дампа уже в базе/);
  assert.equal((await syncState()).run_id, runId, 'метка импорта та же');
  const stray = await db.query(`SELECT count(*)::int AS n FROM powerplay_systems WHERE sync_run IS DISTINCT FROM $1::uuid`, [runId]);
  assert.equal(stray.rows[0].n, 0);
});

test('дамп пересобран посреди скачивания: скачанное выбрасывается, загрузка начинается заново со свежим дампом', async () => {
  await resetDb();
  const first = gz(dumpText(manySystems(300, 'Old', { noise: 6 })));
  const second = gz(dumpText(manySystems(320, 'New', { base: 7_100_000, noise: 6 })));
  const changing = edsm(first, {
    etag: '"before"', lastModified: 'Sun, 18 Oct 2026 04:50:00 GMT',
    next: { body: second, etag: '"after"', lastModified: 'Mon, 19 Oct 2026 04:50:00 GMT' }, switchAfterGets: 2,
  });
  const result = await mod.runPowerplaySync(svc, runOptions(changing, { pieceBytes: 1024 }));
  assert.equal(result.status, 'ok', result.error);
  assert.equal(result.total, 320, 'в базе — свежий дамп целиком');
  assert.match(logText(), /Дамп на EDSM обновился во время скачивания .* начинаю заново со свежим дампом/);
  const state = await syncState();
  assert.equal(state.etag, '"after"');
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM powerplay_systems WHERE name LIKE 'Old %'`)).rows[0].n, 0);
});

test('EDSM не отвечает: «Загрузить данные» пишет в базу архив, который уже на сервере', async () => {
  await resetDb();
  const body = gz(dumpText(manySystems(120, 'Offline')));
  const downloaded = await mod.runPowerplaySync(svc, runOptions(edsm(body, { etag: '"offline"' }), { mode: 'download' }));
  assert.equal(downloaded.status, 'ok', downloaded.error);
  const result = await mod.runPowerplaySync(svc, runOptions(edsm(body, { unreachable: true })));
  assert.equal(result.status, 'ok', result.error);
  assert.equal(result.total, 120);
  assert.match(logText(), /EDSM не ответил .* загружаю в базу то, что уже лежит на сервере/);

  const nothing = await mod.runPowerplaySync(svc, runOptions(edsm(body, { unreachable: true })));
  assert.equal(nothing.status, 'error', 'архив удалён после записи — дальше без EDSM нечего загружать');
  assert.match(nothing.error, /EDSM не ответил: fetch failed/);
});

test('сеть «замораживает» сессии после нескольких КБ: соединения переподключаются, загрузка переходит на короткие запросы', async () => {
  await resetDb();
  const body = gz(dumpText(manySystems(400, 'Frozen', { base: 7_200_000, noise: 32 })));
  assert.ok(body.length > 20_000, `архив ${body.length} байт`);
  fetchCalls.length = 0;
  // Каждый ответ отдаёт 6000 байт и замолкает навсегда — как сессия к Cloudflare за ТСПУ.
  const frozen = edsm(body, { etag: '"frozen"', stallAfter: 6000 });
  const result = await mod.runPowerplaySync(svc, runOptions(frozen, { segments: 2, pieceBytes: 64 * 1024, stallTimeoutMs: 150, shortRequests: 'auto' }));
  assert.equal(result.status, 'ok', result.error);
  assert.equal(result.total, 400);
  const text = logText();
  assert.match(text, /соединение без данных 0\.2 с переподключается \(замирающие соединения → короткие запросы\)/);
  assert.match(text, /соединение замолчало на 0\.2 с, успев передать 5\.9 КБ — переподключаюсь/);
  assert.match(text, /Перехожу на короткие запросы по 4\.1 КБ — каждый в новом соединении/);
  const ranges = fetchCalls.filter((call) => call.method === 'GET').map((call) => /bytes=(\d+)-(\d+)/.exec(call.range ?? '')).filter(Boolean);
  const short = ranges.filter((match) => Number(match[2]) - Number(match[1]) + 1 <= 4200);
  assert.ok(short.length >= 3, `после заморозок — короткие запросы (${short.length} из ${ranges.length})`);
});

test('прямой Postgres: кусок одним вызовом, завершение одним запросом', async () => {
  await resetDb();
  const body = gz(dumpText(manySystems(150, 'Direct')));
  const pgliteDirect = async () => ({ query: (text, values) => db.query(text, values), end: async () => {} });
  const result = await mod.runPowerplaySync(svc, runOptions(edsm(body, { etag: '"direct"' }), { directDb: true, pgClient: pgliteDirect }));
  assert.equal(result.status, 'ok', result.error);
  assert.equal(result.backend, 'pg');
  assert.equal(result.total, 150);
  assert.match(logText(), /Запись в базу: прямой Postgres — кусок одним вызовом, без statement_timeout/);
});

test('короткий statement_timeout PostgREST: пачка, не уложившаяся в него, делится пополам', async () => {
  await resetDb();
  const body = gz(dumpText(manySystems(160, 'Timeout')));
  const sizes = [];
  mod.state.rpcGuard = async (name, args) => {
    if (name !== 'powerplay_apply_batch') return;
    sizes.push(args.p_rows.length);
    if (args.p_rows.length > 50) throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
  };
  try {
    const result = await mod.runPowerplaySync(svc, runOptions(edsm(body, { etag: '"timeout"' }), { batchSize: 160 }));
    assert.equal(result.status, 'ok', result.error);
    assert.equal(result.total, 160);
  } finally {
    mod.state.rpcGuard = null;
  }
  assert.deepEqual(sizes.slice(0, 3), [160, 80, 40], 'пачка делится пополам, пока не уложится');
  assert.match(logText(), /Пачка из 160 систем не уложилась в statement_timeout базы — делю пополам/);
});

/* ── API слоя ──────────────────────────────────────────────────────────── */

test('GET /api/powerplay/systems: компактный набор, ETag и 304', async () => {
  await resetDb();
  const imported = await mod.runPowerplaySync(svc, runOptions(edsm(BASE_GZ, { lastModified: null })));
  assert.equal(imported.status, 'ok', imported.error);
  // Источник свежий — фоновый импорт не нужен.
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
  globalThis.fetch = edsm(BASE_GZ, { etag: '"lazy"' });
  const first = await mod.layerRoute.GET(layerRequest());
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('cache-control'), 'no-store');
  const body = await first.json();
  assert.equal(body.status, 'empty');
  assert.equal(body.meta.refreshing, true);
  assert.deepEqual(body.systems, []);

  await waitIdle();
  assert.equal(fetchCalls.filter((call) => call.method === 'HEAD').length, 1);
  assert.equal(fetchCalls[0].url, mod.DEFAULT_POWERPLAY_DUMP_URL);
  // В PGlite минимальное число систем по умолчанию (100) не набрать — фоновый
  // импорт честно отказал; карта показывает это понятным текстом.
  const state = await syncState();
  assert.equal(state.status, 'error');
  assert.equal(mod.getPowerplayLastRun().progress.trigger, 'lazy');
  const refused = await (await mod.layerRoute.GET(layerRequest())).json();
  assert.equal(refused.status, 'empty');
  assert.equal(refused.meta.refreshing, false, 'после неудачи повтор не раньше чем через полчаса');
  assert.equal(refused.meta.lastError, 'Свежий дамп источника выглядит неполным — импорт отложен');
  assert.equal(fetchCalls.filter((call) => call.method === 'HEAD').length, 1, 'неудачная попытка не повторяется на каждый запрос');

  // Нормальный объём (или ручной импорт) — и следующий запрос видит данные.
  const done = await mod.runPowerplaySync(svc, runOptions(edsm(BASE_GZ, { etag: '"lazy"' })));
  assert.equal(done.status, 'ok', done.error);
  const ready = await (await mod.layerRoute.GET(layerRequest())).json();
  assert.equal(ready.status, 'ready');
  assert.equal(ready.systems.length, CONTROLLED);
});

test('GET /api/powerplay/systems: ошибка источника — коротко и без адресов', async () => {
  await db.query(`UPDATE powerplay_sync_state SET status = 'error', error = 'EDSM не ответил: Download failed: HTTP 503 Service Unavailable (https://www.edsm.net/dump/powerPlay.json.gz)', attempt_at = now()`);
  let body = await (await mod.layerRoute.GET(layerRequest())).json();
  assert.equal(body.status, 'ready', 'прошлые данные остаются на карте');
  assert.equal(body.meta.lastError, 'Источник недоступен (HTTP 503)');

  await db.query(`UPDATE powerplay_sync_state SET error = 'EDSM не ответил: fetch failed: getaddrinfo ENOTFOUND www.edsm.net'`);
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
  globalThis.fetch = edsm(BASE_GZ, { etag: '"lazy"' });
  const unchanged = await mod.cronRoute.POST(new Request(url, { method: 'POST', headers: auth }));
  assert.equal(unchanged.status, 200);
  const report = await unchanged.json();
  assert.equal(report.ok, true);
  assert.equal(report.status, 'not_modified', 'тот же дамп — без скачивания');
  assert.equal(mod.getPowerplayLastRun().progress.trigger, 'cron');

  globalThis.fetch = async () => new Response('down', { status: 500 });
  const failed = await mod.cronRoute.GET(new Request(`${url}?force=1`, { headers: auth }));
  assert.equal(failed.status, 502);
  const failure = await failed.json();
  assert.equal(failure.ok, false);
  assert.match(failure.error, /HTTP 500/);
  assert.equal((await rows()).length, CONTROLLED, 'сбой задачи не стёр карту');
});
