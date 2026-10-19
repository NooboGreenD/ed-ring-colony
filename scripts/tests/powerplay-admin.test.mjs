/**
 * PowerPlay: ход импорта, журнал процесса и раздел админки
 * «Игровые данные → PowerPlay» на настоящем PostgreSQL (PGlite) с миграциями
 * `20261018120000_powerplay_systems.sql` и `20261018180000_powerplay_sync_progress.sql`.
 *
 * С web 2.24.0 загрузка устроена как у минорных фракций: архив скачивается на
 * сервер целиком → разбивается на куски → куски пишутся в базу.
 *
 *   * импорт отмечает этапы (запрос → скачивание архива → разбивка →
 *     запись кусков → завершение) и пишет журнал; копия хода и журнала — в базе;
 *   * тот же дамп — «без изменений», остальные этапы не нужны;
 *   * «Остановить» обрывает скачивание, таблица не тронута;
 *   * без второй миграции импорт работает, журнал живёт в памяти процесса;
 *   * `/api/admin/powerplay`: права, состояние, сводка по державам, архив,
 *     куски, путь записи, запуск, повторный запуск (409), остановка, запуски по
 *     частям, удаление архива, прерванный перезапуском ход;
 *   * `/api/admin/powerplay/upload`: архив с компьютера кусками, продолжение,
 *     проверка, отмена, файл, положенный вручную;
 *   * вкладка Atlas видит идущий импорт: этап и процент в `meta.progress`;
 *   * панель админки в jsdom: прогресс-бары этапов, журнал, карточки архива и
 *     кусков, кнопки, загрузка архива с компьютера.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { PGlite } from '@electric-sql/pglite';
import { TEST_ROOT, bundleFile } from './helpers/bundle.mjs';
import { JOBS } from '../job-schedule.mjs';

const ARCHIVE_DIR = mkdtempSync(join(tmpdir(), 'pp-admin-archive-'));
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
process.env.CRON_SECRET = 'powerplay-cron-secret';
process.env.POWERPLAY_ARCHIVE_DIR = ARCHIVE_DIR;
process.env.POWERPLAY_FRESH_CONNECTIONS = '0';
// Подставной дамп — семь систем: настоящий минимум (100) задан для боевого EDSM.
process.env.POWERPLAY_MIN_ROWS = '2';
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

// Права админки: тест переключает роль; без сессии — 401, не админ — 403.
const AUTH_STUB = `
export const authState = { role: 'admin' };
const json = (body, status) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
export async function requireAdmin() {
  if (!authState.role) return { response: json({ error: 'Требуется авторизация' }, 401) };
  if (authState.role !== 'admin') return { response: json({ error: 'Access denied: Administrator required' }, 403) };
  return { actor: { userId: 'admin-1', cmdrName: 'CMDR Admin', email: null, role: 'admin', isPreview: false } };
}
`;

const ENTRY = `
export * as adminRoute from '@/app/api/admin/powerplay/route';
export * as uploadRoute from '@/app/api/admin/powerplay/upload/route';
export * as layerRoute from '@/app/api/powerplay/systems/route';
export { state, createServiceClient } from '@/lib/supabaseServer';
export { authState } from '@/lib/billing/auth';
export {
  runPowerplaySync, startPowerplaySync, cancelPowerplaySync, getPowerplayLiveRun, getPowerplayLastRun,
  resetPowerplaySyncRuntime, readPowerplaySyncState, readPowerplaySummary, isPowerplaySyncRunning,
  nextPowerplayScheduledRun, POWERPLAY_SCHEDULE, POWERPLAY_CANCEL_MESSAGE, powerplayArchivePath, powerplayArchiveInfo,
  cleanupPowerplayArchive,
} from '@/lib/powerplaySync';
export { powerplayUploadInfo, powerplayUploadFile } from '@/lib/powerplayUpload';
export { resetPowerplayLayerCache } from '@/lib/powerplayStore';
`;

const MIGRATION_SYSTEMS = readFileSync(join(TEST_ROOT, 'supabase', 'migrations', '20261018120000_powerplay_systems.sql'), 'utf8');
const MIGRATION_PROGRESS = readFileSync(join(TEST_ROOT, 'supabase', 'migrations', '20261018180000_powerplay_sync_progress.sql'), 'utf8');

async function freshDb({ progress = true } = {}) {
  const db = new PGlite();
  await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;');
  await db.exec(MIGRATION_SYSTEMS);
  if (progress) {
    await db.exec(MIGRATION_PROGRESS);
    // Снимок full_schema.sql и повторный прогон update-project.sh накатывают её ещё раз.
    await db.exec(MIGRATION_PROGRESS);
  }
  return db;
}

const db = await freshDb();
const legacyDb = await freshDb({ progress: false });

const bundle = await bundleFile({
  entrySource: ENTRY,
  stubs: { 'next/server': NEXT_SERVER_STUB, '@/lib/supabaseServer': SUPABASE_STUB, '@/lib/billing/auth': AUTH_STUB },
  platform: 'node',
});
const mod = await import(bundle);
mod.state.db = db;
const svc = mod.createServiceClient();
const ARCHIVE = mod.powerplayArchivePath();

// Панель админки — отдельным бандлом для jsdom.
const PANEL_ENTRY = `export { default as PowerplayAdminTab } from '@/components/Admin/PowerplayAdminTab';`;
const SUPABASE_CLIENT_STUB = `
export async function authFetch(input, init) {
  return globalThis.__ppAdminFetch(String(input), init || {});
}
export const supabase = {};
`;
const panelBundle = await bundleFile({
  entrySource: PANEL_ENTRY,
  stubs: { '@/lib/supabaseClient': SUPABASE_CLIENT_STUB },
  external: ['react', 'react-dom', 'react-dom/client'],
});

/* ── Подставной EDSM ───────────────────────────────────────────────────── */

const LAST_MODIFIED = 'Sat, 17 Oct 2026 02:46:06 GMT';

function record(name, power, state, id64) {
  return { power, powerState: state, id: 1, id64, name, coords: { x: 10, y: 5, z: -20 }, allegiance: 'Independent', government: 'Corporate', state: 'None', date: '2026-10-16 12:00:00' };
}

const RECORDS = [
  record('Prajan', 'Edmund Mahon', 'Stronghold', 2557888041682),
  record('Fedmich', 'Edmund Mahon', 'Fortified', 2518755068267),
  record('Seedi', 'Edmund Mahon', 'Exploited', 3657332560586),
  record('LHS 154a', 'Li Yong-Rui', 'Fortified', 671222801825),
  record('LTT 4428', 'Nakato Kaine', 'Stronghold', 2656194005355),
  record('Antevorta', 'Nakato Kaine', 'Exploited', 1458309206738),
  record('Ross 1015', 'Nakato Kaine', 'Exploited', 670686127529),
  record('Free World', 'Yuri Grom', 'Unoccupied', 5069270099361),
];
const dumpText = (records) => `[\n${records.map((item) => ` ${JSON.stringify(item)}`).join(',\n')}\n]`;
const DUMP_GZ = gzipSync(Buffer.from(dumpText(RECORDS), 'utf8'));
const CONTROLLED = 7;

const fetchCalls = [];

/** EDSM: HEAD и GET с Range; `stallAfter` — ответ отдаёт столько байт и «зависает», пока запрос не оборвут. */
function edsm(body, { etag = '"dump-1"', lastModified = LAST_MODIFIED, stallAfter = null, unreachable = false } = {}) {
  return async (url, init = {}) => {
    const headers = new Headers(init.headers || {});
    const method = init.method || 'GET';
    const range = headers.get('range');
    fetchCalls.push({ method, range, url: String(url) });
    if (unreachable) throw new TypeError('fetch failed');
    const common = { etag, 'last-modified': lastModified, 'accept-ranges': 'bytes', 'content-type': 'application/gzip' };
    if (method === 'HEAD') return new Response(null, { status: 200, headers: { ...common, 'content-length': String(body.length) } });
    let start = 0;
    let end = body.length - 1;
    if (range) {
      const match = /bytes=(\d+)-(\d*)/.exec(range);
      start = Number(match[1]);
      if (match[2]) end = Math.min(end, Number(match[2]));
    }
    const slice = body.subarray(start, end + 1);
    const extra = range ? { 'content-range': `bytes ${start}-${end}/${body.length}` } : {};
    const status = range ? 206 : 200;
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
            if (signal?.aborted) {
              reject(signal.reason);
              return;
            }
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        },
      });
      return new Response(stream, { status, headers: { ...common, ...extra, 'content-length': String(slice.length) } });
    }
    return new Response(slice, { status, headers: { ...common, ...extra, 'content-length': String(slice.length) } });
  };
}

async function waitFor(check, label, attempts = 500) {
  for (let i = 0; i < attempts; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`не дождались: ${label}`);
}

async function waitIdle() {
  await waitFor(() => !mod.isPowerplaySyncRunning(), 'фоновый импорт завершился');
}

async function count() {
  const { rows } = await mod.state.db.query('SELECT count(*)::int AS n FROM powerplay_systems');
  return rows[0].n;
}

function adminRequest(method = 'GET', body) {
  return new Request('https://edringcolony.ru/api/admin/powerplay', {
    method,
    headers: { 'content-type': 'application/json', authorization: 'Bearer test' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

const runOptions = (fetchImpl, extra = {}) => ({ fetchImpl, segments: 1, minRows: 1, directDb: false, sleep: async () => {}, ...extra });
const logText = (log) => log.map((line) => line.text).join('\n');

const realFetch = globalThis.fetch;
test.after(() => {
  globalThis.fetch = realFetch;
});

/* ── Ход импорта и журнал ──────────────────────────────────────────────── */

test('ход импорта: этапы архив → куски → база, журнал процесса и копия в базе', async () => {
  mod.resetPowerplaySyncRuntime();
  const result = await mod.runPowerplaySync(svc, runOptions(edsm(DUMP_GZ), { trigger: 'admin' }));
  assert.equal(result.status, 'ok', result.error);
  assert.equal(result.total, CONTROLLED);

  const last = mod.getPowerplayLastRun();
  assert.ok(last, 'последний прогон запомнен');
  assert.equal(mod.getPowerplayLiveRun(), null, 'живого прогона больше нет');
  const { progress, log } = last;
  assert.equal(progress.phase, 'ok');
  assert.equal(progress.percent, 100);
  assert.equal(progress.trigger, 'admin');
  assert.equal(progress.mode, 'full');
  assert.deepEqual(progress.stages.map((stage) => [stage.id, stage.status]), [
    ['probe', 'done'], ['download', 'done'], ['split', 'done'], ['import', 'done'], ['finish', 'done'],
  ]);
  const download = progress.stages.find((stage) => stage.id === 'download');
  assert.equal(download.done, DUMP_GZ.length, 'скачивание посчитано в байтах');
  assert.equal(download.total, DUMP_GZ.length, 'размер — из ответа на HEAD');
  assert.equal(progress.stages.find((stage) => stage.id === 'import').done, 1, 'запись — в кусках');
  assert.equal(progress.result.total, CONTROLLED);
  assert.equal(progress.result.shards, 1);

  const text = logText(log);
  assert.match(text, /Запуск импорта: вручную из админки · загрузка данных/);
  assert.match(text, /Источник: https:\/\/www\.edsm\.net\/dump\/powerPlay\.json\.gz/);
  assert.match(text, /Ответ EDSM за .*: .* · дамп от Sat, 17 Oct 2026 02:46:06 GMT · докачка и параллельные соединения \(Range\): да/);
  assert.match(text, /Скачиваю архив на сервер целиком/);
  assert.match(text, /Архив скачан целиком: /);
  assert.match(text, /Разбивка: читаю архив/);
  assert.match(text, /Разобрано записей: 8 → систем под контролем: 7 \(оплоты 2, укреплённые 2, эксплуатируемые 3\)/);
  assert.match(text, /Запись дампа — «система \+ одна из держав в ней»/);
  assert.match(text, /Держава в системе одна — владелец ясен: 7 · держав несколько — владелец по дампу не определён: 0/);
  assert.match(text, /Отброшено: Unoccupied \(никем не контролируются\) 1/);
  assert.match(text, /Владелец по дампу \(одна держава в системе\): Edmund Mahon 3, Nakato Kaine 3, Li Yong-Rui 1/);
  // База этого теста — без миграции 20261021120000: импорт работает, но админ видит, чего не хватает.
  assert.match(text, /База без миграции 20261021120000_powerplay_owner\.sql/);
  assert.match(text, /Запись в базу: кусок 1 из 1 — записано 7 из 7 систем/);
  assert.match(text, /Удалено систем, пропавших из дампа: 0 · всего в таблице: 7/);
  assert.match(text, /Готово за .*: на карте 7 систем держав/);
  assert.ok(log.every((line) => line.level !== 'error'), 'удачный прогон — без ошибок');
  const warnings = log.filter((line) => line.level === 'warn');
  assert.equal(warnings.length, 1, 'единственное предупреждение — о недостающей миграции (полный путь — powerplay-owner.test.mjs)');
  assert.match(warnings[0].text, /^База без миграции 20261021120000_powerplay_owner\.sql/);
  assert.equal((text.match(/Запуск импорта/g) || []).length, 1, 'строки прогона не задваиваются через копию в базе');

  // Копия — в базе: админка увидит её и после перезапуска сайта.
  const state = await mod.readPowerplaySyncState(svc);
  assert.equal(state.progress_supported, true);
  assert.equal(state.progress.phase, 'ok');
  assert.equal(state.progress.percent, 100);
  assert.equal(state.log.length, log.length);
  assert.match(state.log.at(-1).text, /Готово за/);
});

test('ход импорта: тот же дамп — «без изменений», остальные этапы не нужны; журнал копится по прогонам', async () => {
  const result = await mod.runPowerplaySync(svc, runOptions(edsm(DUMP_GZ), { trigger: 'cron' }));
  assert.equal(result.status, 'not_modified');
  const { progress, log } = mod.getPowerplayLastRun();
  assert.equal(progress.phase, 'not_modified');
  assert.equal(progress.percent, 100);
  assert.equal(progress.trigger, 'cron');
  assert.deepEqual(progress.stages.map((stage) => stage.status), ['done', 'skipped', 'skipped', 'skipped', 'skipped']);
  const text = logText(log);
  assert.match(text, /Запуск импорта: задача планировщика powerplay-sync/);
  assert.match(text, /Дамп не менялся с прошлой загрузки — данные актуальны \(7 систем\)/);
  assert.equal((text.match(/Запуск импорта/g) || []).length, 2, 'журнал хранит и прошлый прогон');
});

test('остановка: скачивание обрывается, таблица не тронута, причина — в журнале', async () => {
  const before = await count();
  const started = mod.startPowerplaySync(svc, runOptions(edsm(DUMP_GZ, { etag: '"dump-stall"', stallAfter: 10 }), { force: true }));
  assert.deepEqual(started, { started: true });
  await waitFor(() => (mod.getPowerplayLiveRun()?.progress.stages.find((stage) => stage.id === 'download')?.done ?? 0) >= 10, 'первые байты на диске');
  const live = mod.getPowerplayLiveRun();
  assert.equal(live.progress.stage, 'download');
  assert.equal(live.progress.phase, 'running');
  assert.equal(live.progress.force, true);
  assert.deepEqual(mod.startPowerplaySync(svc, runOptions(edsm(DUMP_GZ))), { started: false, reason: 'Импорт уже идёт — его ход виден ниже' }, 'второй не начинается');

  assert.equal(mod.cancelPowerplaySync(), true);
  assert.equal(mod.cancelPowerplaySync(), false, 'дважды не останавливают');
  await waitIdle();
  const { progress, log } = mod.getPowerplayLastRun();
  assert.equal(progress.phase, 'cancelled');
  assert.equal(progress.stages.find((stage) => stage.id === 'download').status, 'error');
  assert.equal(progress.result.error, mod.POWERPLAY_CANCEL_MESSAGE);
  assert.match(logText(log), /Импорт остановлен администратором: таблица не тронута/);
  assert.equal(await count(), before, 'данные прошлой загрузки на месте');
  const state = await mod.readPowerplaySyncState(svc);
  assert.equal(state.status, 'error');
  assert.equal(state.error, 'Импорт остановлен администратором');
  assert.equal(state.rows_total, before);
  assert.equal(mod.powerplayArchiveInfo(ARCHIVE).partial, true, 'скачанная часть осталась на сервере');
  mod.cleanupPowerplayArchive(ARCHIVE);
});

test('без миграции хода импорта: загрузка работает, журнал — в памяти, админка объясняет почему', async () => {
  mod.state.db = legacyDb;
  mod.resetPowerplaySyncRuntime();
  mod.resetPowerplayLayerCache();
  try {
    const result = await mod.runPowerplaySync(svc, runOptions(edsm(DUMP_GZ)));
    assert.equal(result.status, 'ok', result.error);
    const state = await mod.readPowerplaySyncState(svc);
    assert.equal(state.progress_supported, false);
    assert.equal(state.progress, null);
    const { log } = mod.getPowerplayLastRun();
    assert.match(logText(log), /примените миграцию 20261018180000_powerplay_sync_progress\.sql/);

    const response = await mod.adminRoute.GET(adminRequest());
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.progressPersisted, false);
    assert.equal(body.summary, null);
    assert.match(body.summaryError, /20261018180000_powerplay_sync_progress\.sql/);
    assert.equal(body.state.rows_total, CONTROLLED, 'а данные загружены');
    assert.equal(body.progress.phase, 'ok', 'ход последнего прогона — из памяти процесса');
  } finally {
    mod.state.db = db;
    mod.resetPowerplaySyncRuntime();
    mod.resetPowerplayLayerCache();
  }
});

/* ── /api/admin/powerplay ──────────────────────────────────────────────── */

test('/api/admin/powerplay: только администратор; состояние, сводка, архив, куски, путь записи и расписание', async () => {
  mod.authState.role = null;
  assert.equal((await mod.adminRoute.GET(adminRequest())).status, 401);
  mod.authState.role = 'moderator';
  assert.equal((await mod.adminRoute.GET(adminRequest())).status, 403);
  assert.equal((await mod.adminRoute.POST(adminRequest('POST', { action: 'start' }))).status, 403, 'и запустить тоже нельзя');
  mod.authState.role = 'admin';

  const response = await mod.adminRoute.GET(adminRequest());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.equal(body.running, false);
  assert.equal(body.mode, null);
  assert.equal(body.progressPersisted, true);
  assert.equal(body.state.rows_total, CONTROLLED);
  assert.equal(body.summary.total, CONTROLLED);
  assert.deepEqual(body.summary.powers.map((row) => [row.power, row.Stronghold, row.Fortified, row.Exploited, row.total]), [
    ['Edmund Mahon', 1, 1, 1, 3],
    ['Nakato Kaine', 1, 0, 2, 3],
    ['Li Yong-Rui', 0, 1, 0, 1],
  ]);
  assert.equal(body.summary.newestObservation, '2026-10-16T12:00:00.000Z');
  assert.ok(body.log.length > 0, 'журнал прошлых прогонов — из базы');
  assert.deepEqual([body.archive.exists, body.archive.path], [false, ARCHIVE]);
  assert.deepEqual([body.shards.exists, body.shards.shards], [false, 0]);
  assert.deepEqual([body.upload.active, body.upload.chunkBytes], [false, 8 * 1024 * 1024]);
  assert.equal(body.writer.backend, 'postgrest');
  assert.equal(body.config.dumpUrl, 'https://www.edsm.net/dump/powerPlay.json.gz');
  assert.equal(body.config.staleAfterHours, 26);
  assert.deepEqual(
    [body.config.segments, body.config.maxSegments, body.config.pieceBytes, body.config.shardSystems, body.config.batchSize, body.config.stallSeconds, body.config.shortRequests, body.config.archiveKeep, body.config.minRows],
    [4, 16, 256 * 1024, 2000, 2000, 15, 'auto', false, 2],
  );
  assert.match(body.config.nextScheduledRun, /T(05|17):20:00\.000Z$/);

  assert.equal((await mod.adminRoute.POST(adminRequest('POST', { action: 'nope' }))).status, 400);
  assert.equal((await mod.adminRoute.POST(adminRequest('POST', { action: 'download', segments: 0 }))).status, 400, 'соединений — от 1 до 16');
  assert.equal((await mod.adminRoute.POST(adminRequest('POST', { action: 'download', segments: 40 }))).status, 400);
});

test('/api/admin/powerplay: запуск фоном, повторный — 409, ход виден в GET и во вкладке Atlas, остановка, удаление архива', async () => {
  globalThis.fetch = edsm(DUMP_GZ, { etag: '"dump-2"', stallAfter: 10 });
  try {
    const start = await mod.adminRoute.POST(adminRequest('POST', { action: 'start', force: true }));
    assert.equal(start.status, 200);
    assert.deepEqual(await start.json(), { success: true, started: true, force: true, mode: 'full', message: 'Загрузка запущена' });
    const again = await mod.adminRoute.POST(adminRequest('POST', { action: 'start' }));
    assert.equal(again.status, 409);
    assert.match((await again.json()).reason, /Импорт уже идёт/);

    await waitFor(() => mod.getPowerplayLiveRun()?.progress.stage === 'download', 'этап скачивания');
    // Первые байты на диске — их и освободит «Удалить архив и куски» после остановки.
    await waitFor(() => (mod.getPowerplayLiveRun()?.progress.stages.find((stage) => stage.id === 'download')?.done ?? 0) >= 10, 'первые байты на диске');
    const live = await (await mod.adminRoute.GET(adminRequest())).json();
    assert.equal(live.running, true);
    assert.equal(live.mode, 'full');
    assert.equal(live.progress.phase, 'running');
    assert.equal(live.progress.trigger, 'admin');
    assert.equal(live.progress.stage, 'download');
    assert.ok(live.progress.percent > 0 && live.progress.percent < 100);
    assert.match(logText(live.log), /Скачиваю архив на сервер целиком/);
    assert.equal(live.archive.exists, true, 'архив уже выделен на диске');

    // Вкладка Atlas видит идущий импорт: этап и процент, без журнала.
    mod.resetPowerplayLayerCache();
    const layer = await (await mod.layerRoute.GET(new Request('https://edringcolony.ru/api/powerplay/systems'))).json();
    assert.equal(layer.status, 'ready');
    assert.equal(layer.meta.refreshing, true);
    assert.equal(layer.meta.progress.stage, 'download');
    assert.equal(layer.meta.progress.stageLabel, 'Скачивание архива на сервер');
    assert.equal(layer.meta.progress.trigger, undefined, 'служебного наружу не отдаём');

    const busyCleanup = await mod.adminRoute.POST(adminRequest('POST', { action: 'cleanup' }));
    assert.equal(busyCleanup.status, 409, 'архив нужен идущему импорту');
    const cancel = await mod.adminRoute.POST(adminRequest('POST', { action: 'cancel' }));
    assert.deepEqual(await cancel.json(), { success: true, cancelled: true });
    await waitIdle();
    const after = await (await mod.adminRoute.GET(adminRequest())).json();
    assert.equal(after.running, false);
    assert.equal(after.progress.phase, 'cancelled');
    assert.equal(after.state.status, 'error');
    assert.equal(after.archive.partial, true);
    const idleCancel = await mod.adminRoute.POST(adminRequest('POST', { action: 'cancel' }));
    assert.deepEqual(await idleCancel.json(), { success: true, cancelled: false });

    const cleanup = await (await mod.adminRoute.POST(adminRequest('POST', { action: 'cleanup' }))).json();
    assert.equal(cleanup.success, true);
    assert.equal(cleanup.removed, true);
    assert.ok(cleanup.freed > 0);
    assert.equal(existsSync(ARCHIVE), false);
    const nothing = await (await mod.adminRoute.POST(adminRequest('POST', { action: 'cleanup' }))).json();
    assert.equal(nothing.removed, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('/api/admin/powerplay: по частям — «Скачать архив», «Разбить на куски», «Загрузить куски в базу»; прерванный ход честно помечен', async () => {
  globalThis.fetch = edsm(DUMP_GZ, { etag: '"dump-3"' });
  try {
    const download = await (await mod.adminRoute.POST(adminRequest('POST', { action: 'download', segments: 2 }))).json();
    assert.deepEqual([download.success, download.mode, download.segments, download.message], [true, 'download', 2, 'Скачивание архива запущено']);
    await waitIdle();
    let status = await (await mod.adminRoute.GET(adminRequest())).json();
    assert.equal(status.progress.mode, 'download');
    assert.equal(status.progress.phase, 'ok');
    assert.equal(status.archive.complete, true);
    assert.equal(status.archive.lastModified, LAST_MODIFIED);

    globalThis.fetch = edsm(DUMP_GZ, { unreachable: true });
    const split = await (await mod.adminRoute.POST(adminRequest('POST', { action: 'split' }))).json();
    assert.equal(split.mode, 'split');
    await waitIdle();
    status = await (await mod.adminRoute.GET(adminRequest())).json();
    assert.deepEqual([status.shards.complete, status.shards.shards, status.shards.systems, status.shards.imported], [true, 1, CONTROLLED, 0]);

    const imported = await (await mod.adminRoute.POST(adminRequest('POST', { action: 'import' }))).json();
    assert.equal(imported.mode, 'import');
    await waitIdle();
    status = await (await mod.adminRoute.GET(adminRequest())).json();
    assert.equal(status.progress.phase, 'ok', status.progress.result?.error);
    assert.equal(status.state.etag, '"dump-3"');
    assert.equal(status.archive.exists, false, 'после записи архив удалён');
  } finally {
    globalThis.fetch = realFetch;
  }

  // Сайт перезапустили посреди загрузки: в базе «идёт», живого прогона нет.
  const at = new Date().toISOString();
  const stuck = { id: 'stuck', trigger: 'cron', force: false, mode: 'full', phase: 'running', stage: 'download', percent: 20, message: 'Скачивание архива на сервер: 1 из 3,5 МБ', startedAt: at, updatedAt: at, finishedAt: null, stages: [{ id: 'download', status: 'running', done: 1, total: 3, detail: '', startedAt: at, finishedAt: null }], result: null };
  await db.query(`UPDATE powerplay_sync_state SET status = 'running', attempt_at = now(), progress = $1::jsonb WHERE id = 1`, [JSON.stringify(stuck)]);
  mod.resetPowerplaySyncRuntime();
  const body = await (await mod.adminRoute.GET(adminRequest())).json();
  assert.equal(body.running, false);
  assert.equal(body.interrupted, true);
  assert.equal(body.progress.phase, 'cancelled');
  assert.match(body.progress.message, /Прервано перезапуском сайта/);
  await db.query(`UPDATE powerplay_sync_state SET status = 'ok' WHERE id = 1`);
});

test('расписание задачи powerplay-sync совпадает с планировщиком; ближайший запуск', () => {
  const job = JOBS.find((item) => item.name === 'powerplay-sync');
  assert.equal(mod.POWERPLAY_SCHEDULE.periodMs, job.period);
  assert.equal(mod.POWERPLAY_SCHEDULE.offsetMs, job.offset);
  assert.equal(mod.nextPowerplayScheduledRun(Date.parse('2026-10-18T03:00:00Z')), '2026-10-18T05:20:00.000Z');
  assert.equal(mod.nextPowerplayScheduledRun(Date.parse('2026-10-18T06:00:00Z')), '2026-10-18T17:20:00.000Z');
  assert.equal(mod.nextPowerplayScheduledRun(Date.parse('2026-10-18T17:20:00Z')), '2026-10-19T05:20:00.000Z');
});

/* ── Архив с компьютера ────────────────────────────────────────────────── */

function uploadRequest(method, { body, offset, json } = {}) {
  return new Request(`https://edringcolony.ru/api/admin/powerplay/upload${offset != null ? `?offset=${offset}` : ''}`, {
    method,
    headers: { authorization: 'Bearer test', 'content-type': json ? 'application/json' : 'application/octet-stream' },
    body: json ? JSON.stringify(json) : body,
  });
}

const uploadPost = (json) => mod.uploadRoute.POST(uploadRequest('POST', { json }));
const uploadPut = (offset, body) => mod.uploadRoute.PUT(uploadRequest('PUT', { offset, body }));

test('архив с компьютера: кусками с продолжением, проверка, «Загрузить данные» без EDSM', async () => {
  const records = Array.from({ length: 40 }, (_, i) => record(`Upload ${i}`, i % 2 ? 'Aisling Duval' : 'Pranav Antal', 'Exploited', 8_000_000 + i));
  const gz = gzipSync(Buffer.from(dumpText(records), 'utf8'));
  const file = { name: 'powerPlay.json.gz', size: gz.length, lastModified: Date.parse('2026-10-26T06:00:00Z') };

  mod.authState.role = 'user';
  assert.equal((await uploadPost({ action: 'start', ...file })).status, 403, 'только администратор');
  assert.equal((await uploadPut(0, gz)).status, 403);
  mod.authState.role = 'admin';
  const unpacked = await uploadPost({ action: 'start', name: 'powerPlay.json', size: 5000 });
  assert.equal(unpacked.status, 400);
  assert.match((await unpacked.json()).error, /Нужен архив \.json\.gz \(powerPlay\.json\.gz с EDSM\)/);
  const huge = await uploadPost({ action: 'start', name: 'systemsPopulated.json.gz', size: 500 * 1024 * 1024 });
  assert.equal(huge.status, 400, 'полугигабайтный файл — не дамп PowerPlay');
  assert.match((await huge.json()).error, /это не дамп powerPlay/);
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
  assert.deepEqual([status.upload.active, status.upload.received, status.upload.size, status.upload.name], [true, half, gz.length, 'powerPlay.json.gz']);
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
  assert.deepEqual([body.bytes, body.sameAsEdsm, body.source.etag, body.name], [gz.length, true, '"edsm-upload"', 'powerPlay.json.gz']);
  const info = mod.powerplayArchiveInfo(ARCHIVE);
  assert.deepEqual([info.complete, info.uploaded, info.uploadName, info.bytes, info.manual], [true, true, 'powerPlay.json.gz', gz.length, false]);
  assert.equal(mod.powerplayUploadInfo(ARCHIVE).active, false);
  assert.equal(existsSync(mod.powerplayUploadFile(ARCHIVE)), false, 'временный файл стал архивом');

  fetchCalls.length = 0;
  const result = await mod.runPowerplaySync(svc, runOptions(edsm(gz, { unreachable: true })));
  assert.equal(result.status, 'ok', result.error);
  assert.equal(fetchCalls.length, 0, 'EDSM не спрашивали');
  assert.equal(result.total, 40);
  const { progress, log } = mod.getPowerplayLastRun();
  assert.match(logText(log), /Архив загружен в админке с компьютера \(powerPlay\.json\.gz/);
  assert.deepEqual(progress.stages.map((stage) => [stage.id, stage.status]),
    [['probe', 'skipped'], ['download', 'done'], ['split', 'done'], ['import', 'done'], ['finish', 'done']]);
  assert.equal((await mod.readPowerplaySyncState(svc)).etag, '"edsm-upload"', 'в базе тот же дамп, что на EDSM: «Загрузить данные» его второй раз не качает');

  fetchCalls.length = 0;
  const again = await mod.runPowerplaySync(svc, runOptions(edsm(gz, { etag: '"edsm-upload"', lastModified: 'Mon, 26 Oct 2026 04:50:00 GMT' })));
  assert.equal(again.status, 'not_modified');
  assert.deepEqual(fetchCalls.map((call) => call.method), ['HEAD']);
});

test('архив с компьютера: не gzip, не дамп PowerPlay и дамп фракций отвергаются, отмена удаляет принятое; файл, положенный вручную, принимается', async () => {
  const send = async (buffer, name = 'powerPlay.json.gz') => {
    assert.equal((await uploadPost({ action: 'start', name, size: buffer.length, lastModified: 1 })).status, 200);
    assert.equal((await uploadPut(0, buffer)).status, 200);
    return uploadPost({ action: 'finish' });
  };
  let response = await send(Buffer.from('это не gzip, а просто текст '.repeat(8)));
  assert.equal(response.status, 422);
  assert.match((await response.json()).error, /не похож на powerPlay\.json\.gz с EDSM: это не gzip/);
  assert.equal(existsSync(mod.powerplayUploadFile(ARCHIVE)), false, 'отвергнутый файл удалён');
  response = await send(gzipSync(Buffer.from(JSON.stringify({ hello: 'world', padding: 'x'.repeat(100) }))));
  assert.equal(response.status, 422);
  assert.match((await response.json()).error, /не JSON-массив/);
  // Дамп фракций по ошибке: массив систем EDSM, но без power/powerState.
  const populated = `[\n {"id":1,"id64":10477373803,"name":"Sol","coords":{"x":0,"y":0,"z":0},"allegiance":"Federation","factions":[]}\n]`;
  response = await send(gzipSync(Buffer.from(populated)), 'systemsPopulated.json.gz');
  assert.equal(response.status, 422);
  assert.match((await response.json()).error, /внутри не системы PowerPlay EDSM \(нет power, powerState и name\)/);
  assert.equal(mod.powerplayArchiveInfo(ARCHIVE).exists, false, 'архива не появилось');

  const part = gzipSync(Buffer.from(dumpText(RECORDS), 'utf8'));
  assert.equal((await uploadPost({ action: 'start', name: 'powerPlay.json.gz', size: part.length, lastModified: 2 })).status, 200);
  assert.equal((await uploadPut(0, part.subarray(0, 50))).status, 200);
  const cancelled = await (await uploadPost({ action: 'cancel' })).json();
  assert.deepEqual([cancelled.success, cancelled.removed, cancelled.freed], [true, true, 50]);
  assert.equal(mod.powerplayUploadInfo(ARCHIVE).active, false);
  assert.equal((await uploadPost({ action: 'bogus' })).status, 400);

  // Администратор положил файл в каталог архива сам (scp) — без метки и плана докачки.
  const manual = Array.from({ length: 25 }, (_, i) => record(`Manual ${i}`, 'Archon Delaine', 'Exploited', 8_100_000 + i));
  const gz = gzipSync(Buffer.from(dumpText(manual), 'utf8'));
  writeFileSync(ARCHIVE, gz);
  const info = mod.powerplayArchiveInfo(ARCHIVE);
  assert.deepEqual([info.manual, info.partial, info.complete, info.total], [true, false, false, gz.length]);
  fetchCalls.length = 0;
  const result = await mod.runPowerplaySync(svc, runOptions(edsm(gz, { unreachable: true }), { mode: 'import' }));
  assert.equal(result.status, 'ok', result.error);
  assert.equal(fetchCalls.length, 0);
  assert.match(logText(mod.getPowerplayLastRun().log), /файл архива без метки .* принят как положенный вручную/);
  assert.equal(result.total, 25);
  assert.equal(existsSync(ARCHIVE), false, 'после загрузки архив удалён');
});

test('архив с компьютера: импорт, начавшийся во время запроса к EDSM, не теряет свой архив — «Завершить» отвечает 409, повтор удаётся', async () => {
  const gz = gzipSync(Buffer.from(dumpText(RECORDS.map((item) => ({ ...item, name: `${item.name} Race` }))), 'utf8'));
  assert.equal((await uploadPost({ action: 'start', name: 'powerPlay.json.gz', size: gz.length, lastModified: 3 })).status, 200);
  assert.equal((await uploadPut(0, gz)).status, 200);
  let started = null;
  // Ответ EDSM на вопрос «какой размер у сегодняшнего дампа» приходит, когда
  // задача планировщика уже начала импорт.
  globalThis.fetch = async (url, init = {}) => {
    started ??= mod.startPowerplaySync(svc, runOptions(edsm(DUMP_GZ, { etag: '"race"', stallAfter: 10 }), { trigger: 'cron' }));
    return edsm(gz)(url, init);
  };
  let response;
  try {
    response = await uploadPost({ action: 'finish' });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(started?.started, true, 'импорт начался во время проверки');
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /Идёт загрузка данных/);
  assert.equal(existsSync(mod.powerplayUploadFile(ARCHIVE)), true, 'принятый файл остался');
  assert.notEqual(mod.powerplayArchiveInfo(ARCHIVE).uploaded, true, 'архив импорта не подменён');

  mod.cancelPowerplaySync();
  await waitIdle();
  mod.cleanupPowerplayArchive(ARCHIVE);
  globalThis.fetch = edsm(gz, { unreachable: true });
  try {
    response = await uploadPost({ action: 'finish' });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(response.status, 200, 'импорт закончился — «Завершить» удаётся');
  assert.equal(mod.powerplayArchiveInfo(ARCHIVE).uploaded, true);
  mod.cleanupPowerplayArchive(ARCHIVE);
});

/* ── Панель админки в jsdom ────────────────────────────────────────────── */

function runningStatus() {
  const at = '2026-10-18T10:00:00.000Z';
  return {
    success: true,
    running: true,
    mode: 'full',
    interrupted: false,
    progress: {
      id: 'run-1',
      trigger: 'admin',
      force: false,
      mode: 'full',
      phase: 'running',
      stage: 'import',
      percent: 76,
      message: 'Загрузка кусков в базу: кусок 6 из 14 · 12 000 из 26 012 систем',
      startedAt: at,
      updatedAt: at,
      finishedAt: null,
      stages: [
        { id: 'probe', status: 'done', done: 0, total: null, detail: '3,5 МБ · от Sat, 17 Oct 2026 02:46:06 GMT', startedAt: at, finishedAt: at },
        { id: 'download', status: 'done', done: 3_700_000, total: 3_700_000, detail: '3,5 МБ за 1,2 с · соединений: 4', startedAt: at, finishedAt: at },
        { id: 'split', status: 'done', done: 3_700_000, total: 3_700_000, detail: '14 кусков · 26 012 систем', startedAt: at, finishedAt: at },
        { id: 'import', status: 'running', done: 6, total: 14, detail: 'кусок 6 из 14 · 12 000 из 26 012 систем', startedAt: at, finishedAt: null },
        { id: 'finish', status: 'pending', done: 0, total: null, detail: '', startedAt: null, finishedAt: null },
      ],
      result: null,
    },
    log: [
      { at, level: 'info', text: 'Запуск импорта: вручную из админки · загрузка данных' },
      { at, level: 'info', text: 'Архив скачан целиком: 3,5 МБ за 1,2 с (4 соедин.)' },
      { at, level: 'warn', text: 'Скачивание: Кусок 3: соединение замолчало на 15 с, успев передать 14 КБ — переподключаюсь' },
    ],
    state: {
      status: 'running', source_url: 'https://www.edsm.net/dump/powerPlay.json.gz', etag: null, last_modified: null, dump_generated_at: null,
      run_id: null, rows_total: 0, stats: null, error: null, attempt_at: at, checked_at: null, synced_at: null,
    },
    summary: { total: 0, powers: [], oldestObservation: null, newestObservation: null, lastChange: null },
    summaryError: null,
    progressPersisted: true,
    archive: {
      path: '/app/data/spansh/powerplay/edsm-powerPlay.json.gz', exists: true, bytes: 3_700_000, downloaded: 3_700_000, total: 3_700_000,
      partial: false, complete: true, lastModified: 'Sat, 17 Oct 2026 02:46:06 GMT', freeBytes: 50 * 1024 ** 3, uploaded: false, uploadName: null, manual: false,
    },
    upload: { active: false, name: null, size: 0, received: 0, startedAt: null, chunkBytes: 1024 },
    shards: {
      dir: '/app/data/spansh/powerplay/shards', exists: true, complete: true, shards: 14, imported: 6, systems: 26_012, importedSystems: 12_000,
      files: 14, bytes: 900_000, completedAt: at,
    },
    writer: { backend: 'pg', host: 'db', disabled: false },
    config: {
      dumpUrl: 'https://www.edsm.net/dump/powerPlay.json.gz', archiveKeep: false, segments: 4, maxSegments: 16, pieceBytes: 256 * 1024,
      stallSeconds: 15, shortRequests: 'auto', shardSystems: 2000, staleAfterHours: 26, retryAfterMinutes: 30, minRows: 100, batchSize: 2000,
      nextScheduledRun: '2026-10-18T17:20:00.000Z', nextLazyAttempt: null,
    },
    serverTime: '2026-10-18T10:00:12.000Z',
  };
}

function idleStatus(extra = {}) {
  const at = '2026-10-18T10:00:00.000Z';
  const base = runningStatus();
  return {
    ...base,
    running: false,
    mode: null,
    progress: {
      ...base.progress,
      phase: 'ok',
      stage: 'finish',
      percent: 100,
      message: 'Загружено 3 систем',
      finishedAt: '2026-10-18T10:00:20.000Z',
      stages: base.progress.stages.map((stage) => ({ ...stage, status: 'done', finishedAt: at })),
      result: { rows: 3, deleted: 0, total: 3, shards: 1, durationMs: 20_000 },
    },
    state: { ...base.state, status: 'ok', rows_total: 3, dump_generated_at: '2026-10-17T02:46:06.000Z', synced_at: at, checked_at: at },
    summary: {
      total: 3,
      powers: [
        { power: 'Jerome Archer', Stronghold: 1, Fortified: 0, Exploited: 1, total: 2 },
        { power: 'Nakato Kaine', Stronghold: 0, Fortified: 1, Exploited: 0, total: 1 },
      ],
      oldestObservation: '2026-10-01T00:00:00.000Z',
      newestObservation: '2026-10-16T00:00:00.000Z',
      lastChange: at,
    },
    archive: { ...base.archive, exists: false, bytes: 0, downloaded: 0, total: null, complete: false, lastModified: null },
    shards: { ...base.shards, exists: false, complete: false, shards: 0, imported: 0, systems: 0, importedSystems: 0, files: 0, bytes: 0 },
    ...extra,
  };
}

async function setupPanel() {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true, url: 'http://localhost/admin?tab=powerplay' });
  const previous = {
    window: global.window, document: global.document, HTMLElement: global.HTMLElement, Element: global.Element, Node: global.Node,
    IS_REACT_ACT_ENVIRONMENT: global.IS_REACT_ACT_ENVIRONMENT,
  };
  global.window = dom.window;
  global.document = dom.window.document;
  global.HTMLElement = dom.window.HTMLElement;
  global.Element = dom.window.Element;
  global.Node = dom.window.Node;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const React = (await import('react')).default;
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { PowerplayAdminTab } = await import(panelBundle);
  const root = createRoot(dom.window.document.getElementById('root'));
  const flush = async (times = 5) => {
    for (let i = 0; i < times; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  };
  const click = async (element) => {
    await act(async () => { element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
    await flush();
  };
  const render = async () => {
    await act(async () => { root.render(React.createElement(PowerplayAdminTab)); });
    await flush();
  };
  const cleanup = async () => {
    await act(async () => { root.unmount(); });
    delete globalThis.__ppAdminFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete global[key];
      else global[key] = value;
    }
  };
  const text = (selector) => dom.window.document.querySelector(selector)?.textContent.replace(/[\u00a0\u202f]/g, ' ') ?? '';
  return { dom, document: dom.window.document, act, flush, click, render, cleanup, text };
}

test('панель «Игровые данные → PowerPlay»: этапы, журнал, карточки архива и кусков, запуск по частям и остановка', async () => {
  const ui = await setupPanel();
  let current = runningStatus();
  const posts = [];
  globalThis.__ppAdminFetch = async (url, init) => {
    const method = init.method || 'GET';
    if (method === 'POST') {
      const body = JSON.parse(init.body);
      posts.push(body);
      if (body.action === 'cancel') return new Response(JSON.stringify({ success: true, cancelled: true }), { status: 200 });
      if (body.action === 'cleanup') return new Response(JSON.stringify({ success: true, removed: true, freed: 3_700_000, shards: 0 }), { status: 200 });
      return new Response(JSON.stringify({ success: true, started: true, force: body.force === true }), { status: 200 });
    }
    return new Response(JSON.stringify(current), { status: 200 });
  };
  ui.dom.window.confirm = () => true;
  const button = (action) => ui.document.querySelector(`[data-pp-admin-action="${action}"]`);
  try {
    await ui.render();
    const doc = ui.document;
    assert.match(ui.text('[data-pp-admin-pill]'), /идёт загрузка дампа/);
    // Общая полоса + пять этапов, как у фракций.
    const stages = Array.from(doc.querySelectorAll('[data-pp-admin-stage]'));
    assert.deepEqual(stages.map((item) => [item.getAttribute('data-pp-admin-stage'), item.getAttribute('data-status')]), [
      ['probe', 'done'], ['download', 'done'], ['split', 'done'], ['import', 'running'], ['finish', 'pending'],
    ]);
    const write = doc.querySelector('[data-pp-admin-stage="import"] [role="progressbar"]');
    assert.equal(write.getAttribute('aria-valuenow'), '43', '6 из 14 кусков');
    assert.match(ui.text('[data-pp-admin-stage="import"]'), /кусок 6 из 14/);
    assert.match(ui.text('[data-pp-admin-stage="download"]'), /Скачивание архива на сервер/);
    const overall = doc.querySelector('[role="progressbar"][aria-label="Общий ход загрузки"]');
    assert.equal(overall.getAttribute('aria-valuenow'), '76');
    assert.match(ui.text('[data-pp-admin-message]'), /Загрузка кусков в базу: кусок 6 из 14/);
    assert.match(doc.body.textContent, /Запуск: вручную из админки · загрузка данных/);
    // Карточки: архив на сервере и куски → база.
    assert.match(ui.text('[data-pp-admin-archive]'), /1 · Архив на сервере/);
    assert.match(ui.text('[data-pp-admin-archive]'), /Скачан целиком: 3,5 МБ \(дамп от Sat, 17 Oct 2026 02:46:06 GMT\)/);
    assert.match(ui.text('[data-pp-admin-archive]'), /до 4 соединений, куски файла по 256 КБ/);
    assert.match(ui.text('[data-pp-admin-shards]'), /14 кусков · 26 012 систем/);
    assert.match(ui.text('[data-pp-admin-shards]'), /В базе: 6 из 14 кусков \(12 000 систем\)/);
    assert.match(ui.text('[data-pp-admin-writer]'), /прямой Postgres \(db\) — кусок одним вызовом/);
    assert.match(ui.text('[data-pp-admin-upload]'), /Скачайте powerPlay\.json\.gz на этом компьютере и загрузите его сюда/);
    assert.equal(doc.querySelector('[data-pp-admin-upload] a').getAttribute('href'), 'https://www.edsm.net/dump/powerPlay.json.gz');
    // Журнал процесса — строками, предупреждение — своим цветом.
    const lines = Array.from(doc.querySelectorAll('[data-pp-admin-log] > div'));
    assert.equal(lines.length, 3);
    assert.equal(lines[2].getAttribute('data-level'), 'warn');
    // Пока идёт загрузка: запуск и шаги недоступны, остановка — доступна.
    for (const action of ['start', 'force', 'download', 'cleanup', 'split', 'import', 'upload']) {
      assert.equal(button(action).disabled, true, `${action} недоступна во время загрузки`);
    }
    assert.equal(button('cancel').disabled, false);
    await ui.click(button('cancel'));
    assert.deepEqual(posts.at(-1), { action: 'cancel', force: false });
    assert.match(doc.body.textContent, /Останавливаю импорт/);

    // Загрузка закончилась: сводка по державам и кнопки запуска.
    current = idleStatus();
    await ui.click(Array.from(doc.querySelectorAll('button')).find((item) => (item.textContent || '').includes('Обновить')));
    assert.match(ui.text('[data-pp-admin-pill]'), /данные загружены/);
    assert.deepEqual(Array.from(doc.querySelectorAll('[data-pp-admin-power]')).map((row) => row.getAttribute('data-pp-admin-power')), ['Jerome Archer', 'Nakato Kaine']);
    assert.match(ui.text('[data-pp-admin-data]'), /Систем в базе3/);
    assert.match(ui.text('[data-pp-admin-result]'), /Записано 3 систем, удалено пропавших 0, всего на карте 3 · кусков 1/);
    assert.match(ui.text('[data-pp-admin-archive]'), /Архива нет/);
    assert.equal(button('cancel').disabled, true);
    assert.equal(button('split').disabled, true, 'разбивать нечего — архива нет');
    assert.equal(button('import').disabled, true);
    assert.equal(button('cleanup').disabled, true);

    // Число соединений — на запуск.
    const select = doc.querySelector('[data-pp-admin-segments]');
    await ui.act(async () => {
      select.value = '8';
      select.dispatchEvent(new ui.dom.window.Event('change', { bubbles: true }));
    });
    await ui.click(button('force'));
    assert.deepEqual(posts.at(-1), { action: 'start', force: true, segments: 8 });
    assert.match(doc.body.textContent, /Загрузка запущена принудительно/);
    await ui.click(button('download'));
    assert.deepEqual(posts.at(-1), { action: 'download', force: false, segments: 8 });
    assert.match(doc.body.textContent, /Архив скачивается на сервер в 8 соедин\./);

    // Архив скачан — доступны «Разбить», «Загрузить куски в базу» и удаление.
    current = idleStatus({
      progress: {
        ...idleStatus().progress, mode: 'download', message: 'Архив скачан на сервер: 3,5 МБ',
        stages: idleStatus().progress.stages.map((stage) => ({ ...stage, status: ['probe', 'download'].includes(stage.id) ? 'done' : 'skipped' })),
        result: { archiveBytes: 3_700_000, durationMs: 1_200 },
      },
      archive: { ...runningStatus().archive },
    });
    await ui.click(Array.from(doc.querySelectorAll('button')).find((item) => (item.textContent || '').includes('Обновить')));
    assert.match(ui.text('[data-pp-admin-progress]'), /Последний запуск: архив скачан/);
    assert.match(ui.text('[data-pp-admin-result]'), /Архив на сервере: 3,5 МБ · за 1,2 с — в базу пока ничего не записано/);
    assert.match(ui.text('[data-pp-admin-shards]'), /архив на сервере: «Разбить на куски» или «Загрузить данные» разобьют его/);
    assert.equal(button('split').disabled, false);
    assert.equal(button('import').disabled, false);
    await ui.click(button('split'));
    assert.deepEqual(posts.at(-1), { action: 'split', force: false });
    await ui.click(button('import'));
    assert.deepEqual(posts.at(-1), { action: 'import', force: false });
    assert.match(doc.body.textContent, /без обращения к EDSM/);
    await ui.click(button('cleanup'));
    assert.deepEqual(posts.at(-1), { action: 'cleanup', force: false });
    assert.match(doc.body.textContent.replace(/[\u00a0\u202f]/g, ' '), /Архив и куски удалены с сервера — освобождено 3,5 МБ/);
  } finally {
    await ui.cleanup();
  }
});

test('панель: архив с компьютера — кусками, продолжение с принятого, 409, проверка, остановка, удаление незаконченной', async () => {
  const ui = await setupPanel();
  const calls = [];
  let payload = idleStatus({ upload: { active: true, name: 'powerPlay.json.gz', size: 3000, received: 1000, startedAt: '2026-10-18T11:00:00.000Z', chunkBytes: 1024 } });
  let refusedOnce = false;
  let holdPut = null;
  globalThis.__ppAdminFetch = async (url, init) => {
    if (url.startsWith('/api/admin/powerplay/upload')) {
      const offset = /offset=(\d+)/.exec(url)?.[1];
      if (init.method === 'PUT') {
        calls.push({ put: Number(offset), size: init.body.size });
        if (holdPut) await holdPut(init.signal);
        if (Number(offset) === 1000 && !refusedOnce) {
          // Сервер уже принял больше (прошлый ответ потерялся): продолжить с его размера.
          refusedOnce = true;
          return { ok: false, status: 409, json: async () => ({ success: false, error: 'Сервер принял 1024 байт', offset: 1024 }) };
        }
        const next = Number(offset) + init.body.size;
        return { ok: true, status: 200, json: async () => ({ success: true, offset: next, size: 3000, complete: next === 3000 }) };
      }
      const body = JSON.parse(init.body);
      calls.push({ post: body.action, ...(body.action === 'start' ? { name: body.name, size: body.size, lastModified: body.lastModified } : {}) });
      if (body.action === 'start') return { ok: true, status: 200, json: async () => ({ success: true, offset: 1000, size: 3000, resumed: true, chunkBytes: 1024 }) };
      if (body.action === 'finish') return { ok: true, status: 200, json: async () => ({ success: true, bytes: 3000, sameAsEdsm: true, name: 'powerPlay.json.gz' }) };
      if (body.action === 'cancel') return { ok: true, status: 200, json: async () => ({ success: true, removed: true, freed: 1000 }) };
    }
    return { ok: true, status: 200, json: async () => payload };
  };
  ui.dom.window.confirm = () => true;
  const choose = async (file) => {
    const input = ui.document.querySelector('[data-pp-admin-upload-input]');
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await ui.act(async () => {
      input.dispatchEvent(new ui.dom.window.Event('change', { bubbles: true }));
    });
  };
  const refresh = () => ui.click(Array.from(ui.document.querySelectorAll('button')).find((item) => (item.textContent || '').includes('Обновить')));
  try {
    await ui.render();
    const doc = ui.document;
    assert.match(ui.text('[data-pp-admin-upload-pending]'), /Незаконченная загрузка: powerPlay\.json\.gz — 1 000 Б из 2,9 КБ\. Выберите тот же файл/);
    assert.equal(doc.querySelector('[data-pp-admin-action="upload"]').disabled, false);

    await choose(new ui.dom.window.File([new Uint8Array(3000).fill(7)], 'powerPlay.json.gz', { lastModified: 1_760_000_000_000 }));
    for (let i = 0; i < 40 && !calls.some((call) => call.post === 'finish'); i++) await ui.flush(4);
    assert.deepEqual(calls, [
      { post: 'start', name: 'powerPlay.json.gz', size: 3000, lastModified: 1_760_000_000_000 },
      { put: 1000, size: 1024 },
      { put: 1024, size: 1024 },
      { put: 2048, size: 952 },
      { post: 'finish' },
    ], 'продолжение с принятого сервером, после 409 — с его размера, кусками по chunkBytes');
    await ui.flush(8);
    assert.match(doc.body.textContent.replace(/[\u00a0\u202f]/g, ' '), /Архив загружен на сервер: 2,9 КБ — это тот же дамп, что сейчас на EDSM\. Нажмите «Загрузить данные»/);

    // Архив на сервере — загруженный с компьютера.
    payload = idleStatus({ archive: { ...runningStatus().archive, bytes: 3000, downloaded: 3000, total: 3000, uploaded: true, uploadName: 'powerPlay.json.gz' } });
    await refresh();
    assert.match(ui.text('[data-pp-admin-archive]'), /Загружен с компьютера целиком: 2,9 КБ \(powerPlay\.json\.gz\)/);
    assert.equal(doc.querySelector('[data-pp-admin-upload-pending]'), null);

    // Остановка посреди куска: запрос обрывается, принятое остаётся на сервере.
    calls.length = 0;
    holdPut = (signal) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
    await choose(new ui.dom.window.File([new Uint8Array(3000).fill(9)], 'powerPlay.json.gz', { lastModified: 1_760_000_000_000 }));
    for (let i = 0; i < 20 && !doc.querySelector('[data-pp-admin-action="upload-stop"]'); i++) await ui.flush(4);
    assert.match(ui.text('[data-pp-admin-upload-progress]'), /Загружаю powerPlay\.json\.gz: 1 000 Б из 2,9 КБ \(33 %\)/);
    assert.equal(doc.querySelector('[data-pp-admin-action="start"]').disabled, true, 'пока архив загружается, запуск недоступен');
    await ui.click(doc.querySelector('[data-pp-admin-action="upload-stop"]'));
    await ui.flush(8);
    assert.match(doc.body.textContent, /Загрузка архива остановлена\. Принятое осталось на сервере/);
    assert.ok(!calls.some((call) => call.post === 'finish'));
    holdPut = null;

    // Незаконченную загрузку можно удалить.
    payload = idleStatus({ upload: { active: true, name: 'powerPlay.json.gz', size: 3000, received: 1000, startedAt: '2026-10-18T11:00:00.000Z', chunkBytes: 1024 } });
    await refresh();
    await ui.click(doc.querySelector('[data-pp-admin-action="upload-discard"]'));
    assert.deepEqual(calls.at(-1), { post: 'cancel' });
    assert.match(doc.body.textContent.replace(/[\u00a0\u202f]/g, ' '), /Незаконченная загрузка удалена — освобождено 1 000 Б/);
  } finally {
    await ui.cleanup();
  }
});
