/**
 * PowerPlay: ход импорта, журнал процесса и раздел админки
 * «Игровые данные → PowerPlay» на настоящем PostgreSQL (PGlite) с миграциями
 * `20261018120000_powerplay_systems.sql` и `20261018180000_powerplay_sync_progress.sql`.
 *
 *   * импорт отмечает этапы (запрос → скачивание → распаковка → разбор →
 *     запись → завершение) и пишет журнал; копия хода и журнала — в базе;
 *   * 304 — «без изменений», остальные этапы пропущены;
 *   * «Остановить» обрывает скачивание, таблица не тронута;
 *   * без второй миграции импорт работает, журнал живёт в памяти процесса;
 *   * `/api/admin/powerplay`: права, состояние, сводка по державам, запуск,
 *     повторный запуск (409), остановка;
 *   * вкладка Atlas видит идущий импорт: этап и процент в `meta.progress`;
 *   * панель админки в jsdom: прогресс-бары этапов, журнал, кнопки.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { PGlite } from '@electric-sql/pglite';
import { TEST_ROOT, bundleFile } from './helpers/bundle.mjs';
import { JOBS } from '../job-schedule.mjs';

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
export * as layerRoute from '@/app/api/powerplay/systems/route';
export { state, createServiceClient } from '@/lib/supabaseServer';
export { authState } from '@/lib/billing/auth';
export {
  runPowerplaySync, startPowerplaySync, cancelPowerplaySync, getPowerplayLiveRun, getPowerplayLastRun,
  resetPowerplaySyncRuntime, readPowerplaySyncState, readPowerplaySummary, isPowerplaySyncRunning,
  nextPowerplayScheduledRun, POWERPLAY_SCHEDULE, POWERPLAY_CANCEL_MESSAGE,
} from '@/lib/powerplaySync';
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
const DUMP = `[\n${RECORDS.map((item) => ` ${JSON.stringify(item)}`).join(',\n')}\n]`;
const DUMP_GZ = gzipSync(Buffer.from(DUMP, 'utf8'));
const CONTROLLED = 7;

const okFetch = async () => new Response(DUMP_GZ, {
  status: 200,
  headers: { 'Content-Type': 'application/gzip', 'Content-Length': String(DUMP_GZ.length), ETag: '"dump-1"', 'Last-Modified': LAST_MODIFIED },
});

/**
 * EDSM, который отдал первые байты и «завис»: поток ждёт, пока запрос не
 * оборвут. Так проверяется «Остановить» на этапе скачивания.
 */
function stallingFetch() {
  return async (_url, init = {}) => {
    const signal = init.signal;
    let sent = false;
    const stream = new ReadableStream({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(DUMP_GZ.subarray(0, 10));
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
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'application/gzip', 'Content-Length': String(DUMP_GZ.length) } });
  };
}

async function waitFor(check, label, attempts = 300) {
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

const realFetch = globalThis.fetch;
test.after(() => {
  globalThis.fetch = realFetch;
});

/* ── Ход импорта и журнал ──────────────────────────────────────────────── */

test('ход импорта: все этапы, журнал процесса и копия в базе', async () => {
  mod.resetPowerplaySyncRuntime();
  const result = await mod.runPowerplaySync(svc, { fetchImpl: okFetch, minRows: 1, trigger: 'admin' });
  assert.equal(result.status, 'ok', result.error);
  assert.equal(result.total, CONTROLLED);

  const last = mod.getPowerplayLastRun();
  assert.ok(last, 'последний прогон запомнен');
  assert.equal(mod.getPowerplayLiveRun(), null, 'живого прогона больше нет');
  const { progress, log } = last;
  assert.equal(progress.phase, 'ok');
  assert.equal(progress.percent, 100);
  assert.equal(progress.trigger, 'admin');
  assert.deepEqual(progress.stages.map((stage) => [stage.id, stage.status]), [
    ['request', 'done'], ['download', 'done'], ['decode', 'done'], ['parse', 'done'], ['write', 'done'], ['finish', 'done'],
  ]);
  const download = progress.stages.find((stage) => stage.id === 'download');
  assert.equal(download.done, DUMP_GZ.length, 'скачивание посчитано в байтах');
  assert.equal(download.total, DUMP_GZ.length, 'размер — из Content-Length');
  assert.equal(progress.stages.find((stage) => stage.id === 'write').done, CONTROLLED);
  assert.equal(progress.result.total, CONTROLLED);

  const text = log.map((line) => line.text).join('\n');
  assert.match(text, /Запуск импорта: вручную из админки/);
  assert.match(text, /Источник: https:\/\/www\.edsm\.net\/dump\/powerPlay\.json\.gz/);
  assert.match(text, /Безусловный запрос: в таблице пока нет систем/);
  assert.match(text, /Ответ EDSM: HTTP 200/);
  assert.match(text, /Скачано /);
  assert.match(text, /Распаковано: .* JSON/);
  assert.match(text, /Разобрано записей: 8 → систем под контролем: 7 \(оплоты 2, укреплённые 2, эксплуатируемые 3\)/);
  assert.match(text, /Запись дампа — «система \+ одна из держав в ней»/);
  assert.match(text, /Держава в системе одна — владелец ясен: 7 · держав несколько — владелец по дампу не определён: 0/);
  assert.match(text, /Отброшено: Unoccupied \(никем не контролируются\) 1/);
  assert.match(text, /Владелец по дампу \(одна держава в системе\): Edmund Mahon 3, Nakato Kaine 3, Li Yong-Rui 1/);
  // База этого теста — без миграции 20261021120000: импорт работает, но админ видит, чего не хватает.
  assert.match(text, /База без миграции 20261021120000_powerplay_owner\.sql/);
  assert.match(text, /Пачка 1\/1: записано 7 из 7/);
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

test('ход импорта: 304 — «без изменений», остальные этапы не нужны; журнал копится по прогонам', async () => {
  const result = await mod.runPowerplaySync(svc, { fetchImpl: async () => new Response(null, { status: 304 }), minRows: 1, trigger: 'cron' });
  assert.equal(result.status, 'not_modified');
  const { progress, log } = mod.getPowerplayLastRun();
  assert.equal(progress.phase, 'not_modified');
  assert.equal(progress.percent, 100);
  assert.equal(progress.trigger, 'cron');
  assert.deepEqual(progress.stages.map((stage) => stage.status), ['done', 'skipped', 'skipped', 'skipped', 'skipped', 'skipped']);
  const text = log.map((line) => line.text).join('\n');
  assert.match(text, /Запуск импорта: задача планировщика powerplay-sync/);
  assert.match(text, /Условный запрос: в таблице 7 систем/);
  assert.match(text, /Дамп не менялся с прошлой загрузки — данные актуальны \(7 систем\)/);
  assert.equal((text.match(/Запуск импорта/g) || []).length, 2, 'журнал хранит и прошлый прогон');
});

test('остановка: скачивание обрывается, таблица не тронута, причина — в журнале', async () => {
  const before = await count();
  const started = mod.startPowerplaySync(svc, { fetchImpl: stallingFetch(), minRows: 1, force: true });
  assert.deepEqual(started, { started: true });
  await waitFor(() => mod.getPowerplayLiveRun()?.progress.stage === 'download', 'этап скачивания');
  const live = mod.getPowerplayLiveRun();
  assert.equal(live.progress.phase, 'running');
  assert.equal(live.progress.force, true);
  assert.deepEqual(mod.startPowerplaySync(svc, { fetchImpl: okFetch }), { started: false, reason: 'Импорт уже идёт — его ход виден ниже' }, 'второй не начинается');

  assert.equal(mod.cancelPowerplaySync(), true);
  assert.equal(mod.cancelPowerplaySync(), false, 'дважды не останавливают');
  await waitIdle();
  const { progress, log } = mod.getPowerplayLastRun();
  assert.equal(progress.phase, 'cancelled');
  assert.equal(progress.stages.find((stage) => stage.id === 'download').status, 'error');
  assert.equal(progress.result.error, mod.POWERPLAY_CANCEL_MESSAGE);
  assert.match(log.map((line) => line.text).join('\n'), /Импорт остановлен администратором: таблица не тронута/);
  assert.equal(await count(), before, 'данные прошлой загрузки на месте');
  const state = await mod.readPowerplaySyncState(svc);
  assert.equal(state.status, 'error');
  assert.equal(state.error, 'Импорт остановлен администратором');
  assert.equal(state.rows_total, before);
});

test('без миграции хода импорта: загрузка работает, журнал — в памяти, админка объясняет почему', async () => {
  mod.state.db = legacyDb;
  mod.resetPowerplaySyncRuntime();
  mod.resetPowerplayLayerCache();
  try {
    const result = await mod.runPowerplaySync(svc, { fetchImpl: okFetch, minRows: 1 });
    assert.equal(result.status, 'ok', result.error);
    const state = await mod.readPowerplaySyncState(svc);
    assert.equal(state.progress_supported, false);
    assert.equal(state.progress, null);
    const { log } = mod.getPowerplayLastRun();
    assert.match(log.map((line) => line.text).join('\n'), /примените миграцию 20261018180000_powerplay_sync_progress\.sql/);

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

test('/api/admin/powerplay: только администратор; состояние, сводка по державам и расписание', async () => {
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
  assert.equal(body.interrupted, false);
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
  assert.equal(body.config.dumpUrl, 'https://www.edsm.net/dump/powerPlay.json.gz');
  assert.equal(body.config.staleAfterHours, 26);
  assert.match(body.config.nextScheduledRun, /T(05|17):20:00\.000Z$/);

  assert.equal((await mod.adminRoute.POST(adminRequest('POST', { action: 'nope' }))).status, 400);
});

test('/api/admin/powerplay: запуск фоном, повторный — 409, ход виден в GET, остановка', async () => {
  globalThis.fetch = stallingFetch();
  try {
    const start = await mod.adminRoute.POST(adminRequest('POST', { action: 'start', force: true }));
    assert.equal(start.status, 200);
    assert.deepEqual(await start.json(), { success: true, started: true, force: true });
    const again = await mod.adminRoute.POST(adminRequest('POST', { action: 'start' }));
    assert.equal(again.status, 409);
    assert.match((await again.json()).reason, /Импорт уже идёт/);

    await waitFor(() => mod.getPowerplayLiveRun()?.progress.stage === 'download', 'этап скачивания');
    const live = await (await mod.adminRoute.GET(adminRequest())).json();
    assert.equal(live.running, true);
    assert.equal(live.progress.phase, 'running');
    assert.equal(live.progress.trigger, 'admin');
    assert.equal(live.progress.stage, 'download');
    assert.ok(live.progress.percent > 0 && live.progress.percent < 100);
    assert.match(live.log.at(-1).text, /Ответ EDSM: HTTP 200/);

    // Вкладка Atlas видит идущий импорт: этап и процент, без журнала.
    mod.resetPowerplayLayerCache();
    const layer = await (await mod.layerRoute.GET(new Request('https://edringcolony.ru/api/powerplay/systems'))).json();
    assert.equal(layer.status, 'ready');
    assert.equal(layer.meta.refreshing, true);
    assert.equal(layer.meta.progress.stage, 'download');
    assert.equal(layer.meta.progress.stageLabel, 'Скачивание дампа');
    assert.equal(layer.meta.progress.trigger, undefined, 'служебного наружу не отдаём');

    const cancel = await mod.adminRoute.POST(adminRequest('POST', { action: 'cancel' }));
    assert.deepEqual(await cancel.json(), { success: true, cancelled: true });
    await waitIdle();
    const after = await (await mod.adminRoute.GET(adminRequest())).json();
    assert.equal(after.running, false);
    assert.equal(after.progress.phase, 'cancelled');
    assert.equal(after.state.status, 'error');
    const idleCancel = await mod.adminRoute.POST(adminRequest('POST', { action: 'cancel' }));
    assert.deepEqual(await idleCancel.json(), { success: true, cancelled: false });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('расписание задачи powerplay-sync совпадает с планировщиком; ближайший запуск', () => {
  const job = JOBS.find((item) => item.name === 'powerplay-sync');
  assert.equal(mod.POWERPLAY_SCHEDULE.periodMs, job.period);
  assert.equal(mod.POWERPLAY_SCHEDULE.offsetMs, job.offset);
  assert.equal(mod.nextPowerplayScheduledRun(Date.parse('2026-10-18T03:00:00Z')), '2026-10-18T05:20:00.000Z');
  assert.equal(mod.nextPowerplayScheduledRun(Date.parse('2026-10-18T06:00:00Z')), '2026-10-18T17:20:00.000Z');
  assert.equal(mod.nextPowerplayScheduledRun(Date.parse('2026-10-18T17:20:00Z')), '2026-10-19T05:20:00.000Z');
});

/* ── Панель админки в jsdom ────────────────────────────────────────────── */

function runningStatus() {
  const at = '2026-10-18T10:00:00.000Z';
  return {
    success: true,
    running: true,
    interrupted: false,
    progress: {
      id: 'run-1',
      trigger: 'admin',
      force: false,
      phase: 'running',
      stage: 'write',
      percent: 61,
      message: 'Запись в базу: пачка 6 из 14 · 12 000 из 26 012',
      startedAt: at,
      updatedAt: at,
      finishedAt: null,
      stages: [
        { id: 'request', status: 'done', done: 0, total: null, detail: 'HTTP 200', startedAt: at, finishedAt: at },
        { id: 'download', status: 'done', done: 3_700_000, total: 3_700_000, detail: '3,5 МБ', startedAt: at, finishedAt: at },
        { id: 'decode', status: 'done', done: 0, total: null, detail: '25 МБ', startedAt: at, finishedAt: at },
        { id: 'parse', status: 'done', done: 95_000, total: 95_000, detail: '95 000 записей → 26 012 систем', startedAt: at, finishedAt: at },
        { id: 'write', status: 'running', done: 12_000, total: 26_012, detail: 'пачка 6 из 14 · 12 000 из 26 012', startedAt: at, finishedAt: null },
        { id: 'finish', status: 'pending', done: 0, total: null, detail: '', startedAt: null, finishedAt: null },
      ],
      result: null,
    },
    log: [
      { at, level: 'info', text: 'Запуск импорта: вручную из админки' },
      { at, level: 'info', text: 'Ответ EDSM: HTTP 200 за 0,4 с · 3,5 МБ' },
      { at, level: 'warn', text: 'Пачка 6/14: записано 12 000 из 26 012' },
    ],
    state: {
      status: 'running', source_url: 'https://www.edsm.net/dump/powerPlay.json.gz', etag: null, last_modified: null, dump_generated_at: null,
      run_id: null, rows_total: 0, stats: null, error: null, attempt_at: at, checked_at: null, synced_at: null,
    },
    summary: { total: 0, powers: [], oldestObservation: null, newestObservation: null, lastChange: null },
    summaryError: null,
    progressPersisted: true,
    config: {
      dumpUrl: 'https://www.edsm.net/dump/powerPlay.json.gz', staleAfterHours: 26, retryAfterMinutes: 30, minRows: 100, batchSize: 2000,
      nextScheduledRun: '2026-10-18T17:20:00.000Z', nextLazyAttempt: null,
    },
    serverTime: '2026-10-18T10:00:12.000Z',
  };
}

function idleStatus() {
  const at = '2026-10-18T10:00:00.000Z';
  const base = runningStatus();
  return {
    ...base,
    running: false,
    progress: {
      ...base.progress,
      phase: 'ok',
      stage: 'finish',
      percent: 100,
      message: 'Загружено 3 систем',
      finishedAt: '2026-10-18T10:00:20.000Z',
      stages: base.progress.stages.map((stage) => ({ ...stage, status: 'done', finishedAt: at })),
      result: { rows: 3, deleted: 0, total: 3, durationMs: 20_000 },
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
  };
}

test('панель «Игровые данные → PowerPlay»: этапы с прогресс-барами, журнал, остановка и запуск', async () => {
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
  let current = runningStatus();
  const calls = [];
  globalThis.__ppAdminFetch = async (url, init) => {
    const method = init.method || 'GET';
    calls.push(`${method} ${url}${init.body ? ` ${init.body}` : ''}`);
    if (method === 'POST') {
      const body = JSON.parse(init.body);
      if (body.action === 'cancel') return new Response(JSON.stringify({ success: true, cancelled: true }), { status: 200 });
      return new Response(JSON.stringify({ success: true, started: true, force: body.force === true }), { status: 200 });
    }
    return new Response(JSON.stringify(current), { status: 200 });
  };
  const React = (await import('react')).default;
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { PowerplayAdminTab } = await import(panelBundle);
  const root = createRoot(dom.window.document.getElementById('root'));
  const flush = async () => {
    for (let i = 0; i < 5; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  };
  const click = async (element) => {
    await act(async () => { element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
    await flush();
  };
  try {
    await act(async () => { root.render(React.createElement(PowerplayAdminTab)); });
    await flush();
    const doc = dom.window.document;
    assert.match(doc.querySelector('[data-pp-admin-pill]').textContent, /идёт загрузка/);
    // Общая полоса + шесть этапов.
    const stages = Array.from(doc.querySelectorAll('[data-pp-admin-stage]'));
    assert.deepEqual(stages.map((item) => [item.getAttribute('data-pp-admin-stage'), item.getAttribute('data-status')]), [
      ['request', 'done'], ['download', 'done'], ['decode', 'done'], ['parse', 'done'], ['write', 'running'], ['finish', 'pending'],
    ]);
    const write = doc.querySelector('[data-pp-admin-stage="write"] [role="progressbar"]');
    assert.equal(write.getAttribute('aria-valuenow'), '46', '12 000 из 26 012 строк');
    assert.match(doc.querySelector('[data-pp-admin-stage="write"]').textContent, /пачка 6 из 14/);
    const overall = doc.querySelector('[role="progressbar"][aria-label="Общий ход загрузки"]');
    assert.equal(overall.getAttribute('aria-valuenow'), '61');
    assert.match(doc.querySelector('[data-pp-admin-message]').textContent, /Запись в базу: пачка 6 из 14/);
    assert.match(doc.body.textContent, /Запуск: вручную из админки/);
    // Журнал процесса — строками, предупреждение — своим цветом.
    const lines = Array.from(doc.querySelectorAll('[data-pp-admin-log] > div'));
    assert.equal(lines.length, 3);
    assert.equal(lines[2].getAttribute('data-level'), 'warn');
    assert.match(lines[1].textContent, /Ответ EDSM: HTTP 200/);
    // Пока идёт загрузка: запуск недоступен, остановка — доступна.
    assert.equal(doc.querySelector('[data-pp-admin-action="start"]').disabled, true);
    assert.equal(doc.querySelector('[data-pp-admin-action="cancel"]').disabled, false);
    await click(doc.querySelector('[data-pp-admin-action="cancel"]'));
    assert.ok(calls.some((call) => call.startsWith('POST /api/admin/powerplay') && call.includes('"action":"cancel"')));
    assert.match(doc.body.textContent, /Останавливаю импорт/);

    // Загрузка закончилась: сводка по державам и кнопки запуска.
    current = idleStatus();
    await click(Array.from(doc.querySelectorAll('button')).find((button) => (button.textContent || '').includes('Обновить')));
    assert.match(doc.querySelector('[data-pp-admin-pill]').textContent, /данные загружены/);
    assert.deepEqual(Array.from(doc.querySelectorAll('[data-pp-admin-power]')).map((row) => row.getAttribute('data-pp-admin-power')), ['Jerome Archer', 'Nakato Kaine']);
    assert.match(doc.querySelector('[data-pp-admin-data]').textContent, /Систем в базе3/);
    assert.match(doc.body.textContent, /Записано 3 систем, удалено пропавших 0/);
    assert.equal(doc.querySelector('[data-pp-admin-action="cancel"]').disabled, true);
    await click(doc.querySelector('[data-pp-admin-action="force"]'));
    assert.ok(calls.some((call) => call.includes('"action":"start"') && call.includes('"force":true')));
    assert.match(doc.body.textContent, /Загрузка запущена принудительно/);
  } finally {
    await act(async () => { root.unmount(); });
    delete globalThis.__ppAdminFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete global[key];
      else global[key] = value;
    }
  }
});
