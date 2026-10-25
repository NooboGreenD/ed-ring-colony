/**
 * Сквозной тест привязки Frontier CAPI: настоящий маршрут `/api/capi/callback`
 * и настоящий движок синхронизации, собранные esbuild'ом с подменой
 * `next/server`, Supabase и сети (как в architect-plans-route.test.mjs).
 *
 * Что именно закрепляется — это и есть разбор жалобы «все этапы проходят, но
 * привязка не делается, данные не подтягиваются»:
 *
 *   1. токены сохраняются СРАЗУ после обмена кода, до любого обращения к
 *      Companion API, и сбой CAPI (418, 204, пустой профиль) больше не
 *      уничтожает привязку;
 *   2. профиль пишется из НАСТОЯЩИХ полей ответа Frontier
 *      (`commander.credits`, `commander.rank`, `lastSystem`, `ship`), а не из
 *      несуществующих полей верхнего уровня;
 *   3. журнал разбирается как построчный JSON, а пустой день не считается
 *      ошибкой;
 *   4. любой исход возвращает пилота на /account/capi с понятной причиной.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { capiReasonText } from '../../src/lib/capi/messages.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let esbuild = null;
try {
  esbuild = await import('esbuild');
} catch {
  // devDependencies не установлены — пропускаем, а не падаем.
}
const maybe = esbuild ? test : test.skip;

// Заглушки ставим принудительно: `??=` оставил бы «настоящие» значения из
// build-args web-образа (ENV шага `npm test` в docker build) — тест не герметичен.
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
process.env.NEXT_PUBLIC_SITE_URL = 'https://colony.test';
process.env.FRONTIER_REDIRECT_URI = 'https://colony.test/api/capi/callback';

/** Минимальный NextResponse/NextRequest: нужны redirect и cookies. */
const NEXT_SERVER_STUB = `
class Cookies {
  constructor() { this.set_ = new Map(); }
  set(name, value, options) { this.set_.set(name, { value, options }); }
  get(name) { return this.set_.get(name); }
}
function wrap(response) {
  response.cookies = new Cookies();
  return response;
}
export const NextResponse = {
  json: (body, init) => wrap(new Response(JSON.stringify(body), {
    status: (init && init.status) || 200,
    headers: { 'content-type': 'application/json' },
  })),
  redirect: (url) => wrap(new Response(null, {
    status: 307,
    headers: { location: String(url) },
  })),
  next: () => wrap(new Response(null, { status: 200 })),
};
export class NextRequest extends Request {}
`;

/**
 * Заглушка Supabase: хранит таблицы в памяти и умеет прикидываться базой,
 * отставшей на миграцию (missingColumns).
 */
const SUPABASE_STUB = `
export const db = {
  user: { id: 'user-1' },
  tables: {},
  missingColumns: new Set(),
  failTable: null,
};

export function reset() {
  db.user = { id: 'user-1' };
  db.tables = { profiles: [{ id: 'user-1', cmdr_name: null }] };
  db.missingColumns = new Set();
  db.failTable = null;
}
reset();

const rowsOf = (table) => (db.tables[table] ||= []);

function matches(row, filters) {
  return filters.every(([op, column, value]) =>
    op === 'eq' ? row[column] === value : op === 'neq' ? row[column] !== value : op === 'in' ? value.includes(row[column]) : op === 'gte' ? row[column] >= value : true);
}

function missing(values) {
  return Object.keys(values).find((key) => db.missingColumns.has(key));
}

function makeQuery(table) {
  const filters = [];
  const insertedRows = [];
  let updateValues = null;
  let verb = 'select';
  const api = {
    select: () => { if (verb !== 'insert' && verb !== 'update') verb = 'select'; return api; },
    eq: (column, value) => { filters.push(['eq', column, value]); return api; },
    neq: (column, value) => { filters.push(['neq', column, value]); return api; },
    in: (column, value) => { filters.push(['in', column, value]); return api; },
    gte: (column, value) => { filters.push(['gte', column, value]); return api; },
    order: () => api,
    limit: () => api,
    upsert: (values) => {
      verb = 'upsert';
      const bad = missing(values);
      if (bad || db.failTable === table) {
        return Promise.resolve({ error: bad
          ? { code: 'PGRST204', message: "Could not find the '" + bad + "' column of '" + table + "' in the schema cache" }
          : { code: '42501', message: 'permission denied for table ' + table } });
      }
      const rows = rowsOf(table);
      const index = rows.findIndex((row) => row.user_id === values.user_id);
      if (index >= 0) rows[index] = { ...rows[index], ...values };
      else rows.push({ ...values });
      return Promise.resolve({ error: null, data: values });
    },
    insert: (values) => {
      verb = 'insert';
      const inserted = Array.isArray(values) ? values : [values];
      for (const value of inserted) {
        const row = { ...(table === 'capi_sync_jobs' ? { id: '11111111-1111-4111-8111-' + String(rowsOf(table).length + 1).padStart(12, '0'), requested_at: new Date().toISOString(), attempts: 0 } : {}), ...value };
        rowsOf(table).push(row);
        insertedRows.push(row);
      }
      return api;
    },
    update: (values) => { verb = 'update'; updateValues = values; return api; },
    delete: () => ({ eq: (column, value) => {
      db.tables[table] = rowsOf(table).filter((row) => row[column] !== value);
      return Promise.resolve({ error: null });
    } }),
    maybeSingle: async () => {
      const found = rowsOf(table).find((row) => matches(row, filters));
      return { data: found ?? null, error: null };
    },
    single: async () => {
      const found = verb === 'insert' ? insertedRows[0] : rowsOf(table).find((row) => matches(row, filters));
      return { data: found ?? null, error: found ? null : { message: 'not found' } };
    },
    then: (resolve, reject) => {
      if (verb === 'update') {
        const bad = missing(updateValues || {});
        if (bad) return Promise.resolve({ error: { code: 'PGRST204', message: "Could not find the '" + bad + "' column of '" + table + "' in the schema cache" } }).then(resolve, reject);
        for (const row of rowsOf(table).filter((item) => matches(item, filters))) Object.assign(row, updateValues);
        return Promise.resolve({ error: null }).then(resolve, reject);
      }
      return Promise.resolve({ data: verb === 'insert' ? insertedRows : rowsOf(table).filter((row) => matches(row, filters)), error: null }).then(resolve, reject);
    },
  };
  void verb;
  return api;
}

const client = () => ({
  auth: { getUser: async () => ({ data: { user: db.user }, error: null }) },
  from: (table) => makeQuery(table),
  rpc: async (name) => {
    if (name !== 'claim_next_capi_sync_job') return { data: null, error: { message: 'unknown rpc' } };
    const job = rowsOf('capi_sync_jobs').find((row) => row.status === 'queued');
    if (!job) return { data: [], error: null };
    Object.assign(job, { status: 'running', stage: 'starting', attempts: (job.attempts || 0) + 1, started_at: new Date().toISOString(), heartbeat_at: new Date().toISOString() });
    return { data: [job], error: null };
  },
});

export function createClient() { return client(); }
export function createServiceClient() { return client(); }
export function createRouteClient() { return client(); }
export async function authFromRequest() { return { user: db.user, supabase: client() }; }
`;

/** Прогресс проектов трогает собственные таблицы — в тесте не нужен. */
const PROGRESS_STUB = `
export const progressCalls = [];
export async function updateProjectProgress(system, progress, resources, source) {
  progressCalls.push({ system, progress, resources, source });
}
export async function syncProjectsFromSites(svc, systems, options) {
  progressCalls.push({ systems: Array.from(systems), options });
  return { changed: [], notified: 0, warning: null };
}
`;

async function buildRoutes() {
  const dir = mkdtempSync(join(ROOT, '.tmp-capi-route-'));
  writeFileSync(join(dir, 'next-server.mjs'), NEXT_SERVER_STUB);
  writeFileSync(join(dir, 'supabase.mjs'), SUPABASE_STUB);
  writeFileSync(join(dir, 'progress.mjs'), PROGRESS_STUB);
  writeFileSync(join(dir, 'cron.mjs'), 'export const runCronTask = async (_req, _name, action) => action();');

  const entry = join(dir, 'entry.ts');
  writeFileSync(
    entry,
    "export * as callback from '@/app/api/capi/callback/route';\n"
    + "export * as sync from '@/app/api/capi/sync/route';\n"
    + "export * as syncStatus from '@/app/api/capi/sync/[jobId]/route';\n"
    + "export * as syncWorker from '@/app/api/cron/capi-sync-jobs/route';\n"    + "export * as profile from '@/app/api/capi/profile/route';\n"
    + "export * as status from '@/app/api/capi/status/route';\n"
    + "export * as auth from '@/app/api/capi/auth/route';\n"
    + "export * as cron from '@/app/api/cron/capi-sync/route';\n"
    + "export { db, reset } from './supabase.mjs';\n"
    + "export { progressCalls } from './progress.mjs';\n",
  );

  const bundle = join(dir, 'bundle.mjs');
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: bundle,
    alias: {
      'next/server': join(dir, 'next-server.mjs'),
      '@/lib/supabaseServer': join(dir, 'supabase.mjs'),
      '@/lib/projects/autoProgress': join(dir, 'progress.mjs'),
      '@/lib/cronAuth': join(dir, 'cron.mjs'),
      '@': join(ROOT, 'src'),
    },
    loader: { '.ts': 'ts', '.tsx': 'tsx' },
    logLevel: 'silent',
  });

  const mod = await import(bundle);
  mod.reset();
  return { mod, dir };
}

/* ── Данные Frontier ────────────────────────────────────────────────── */

const PROFILE_JSON = {
  commander: {
    id: 777, name: 'Nova', credits: 4200000, debt: 0, docked: true,
    rank: { combat: 5, trade: 4, explore: 6, empire: 2, federation: 1, cqc: 0, soldier: 3, exobiologist: 2 },
  },
  lastSystem: { id: 3238296097059, name: 'Colonia' },
  lastStarport: { id: 128667761, name: 'Jaques Station' },
  ship: { id: 4, name: 'Python', shipName: 'Mule', shipID: 'MU-01', starsystem: { name: 'Colonia', systemaddress: 3238296097059 } },
  ships: { 4: { id: 4, name: 'Python', shipName: 'Mule' } },
};

const JOURNAL_NDJSON = [
  JSON.stringify({ timestamp: '2026-09-27T10:00:00Z', event: 'FSDJump', StarSystem: 'Colonia' }),
  JSON.stringify({ timestamp: '2026-09-27T10:05:00Z', event: 'Docked', StationName: 'Jaques Station' }),
].join('\n');

/** Подменяет сеть: сервер токенов Frontier + CAPI. */
function fakeFrontier({ profile = PROFILE_JSON, profileStatus = 200, profileError = 'error',
  journal = JOURNAL_NDJSON, journalStatus = 200, communityGoals = { goals: [] }, platform = 'frontier',
  meStatus = 200, decodedIdentity = null, refreshStatus = 200 } = {}) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? String(init.body) : null });

    if (url.includes('auth.frontierstore.net/token')) {
      if (new URLSearchParams(String(init?.body)).get('grant_type') === 'refresh_token' && refreshStatus !== 200) {
        return new Response('{"error":"invalid_grant"}', { status: refreshStatus });
      }
      return new Response(JSON.stringify({
        access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 14400, token_type: 'Bearer',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('auth.frontierstore.net/me')) {
      return new Response(JSON.stringify({ customer_id: 777, email: 'cmdr@example.test', platform }), { status: meStatus });
    }
    if (url.includes('auth.frontierstore.net/decode')) {
      return new Response(JSON.stringify(decodedIdentity || {}), { status: decodedIdentity ? 200 : 503 });
    }
    // Тело у 204 запрещено конструктором Response — как и у настоящего CAPI.
    if (url.includes('/profile')) {
      return profileStatus === 200
        ? new Response(JSON.stringify(profile), { status: 200 })
        : new Response(profileStatus === 204 ? null : profileError, { status: profileStatus });
    }
    if (url.includes('/journal')) {
      return journalStatus === 200
        ? new Response(journal, { status: 200 })
        : new Response(journalStatus === 204 ? null : 'error', { status: journalStatus });
    }
    if (url.includes('/communitygoals')) {
      return new Response(JSON.stringify(communityGoals), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

async function runQueuedWorker(mod) {
  return mod.syncWorker.POST(new Request('https://colony.test/api/cron/capi-sync-jobs', { method: 'POST' }));
}

function callbackRequest(dir, { state = 'state-123', cookieState = 'state-123', code = 'auth-code', platformCookie = null } = {}) {
  void dir;
  const url = new URL('https://colony.test/api/capi/callback');
  if (code) url.searchParams.set('code', code);
  if (state) url.searchParams.set('state', state);
  const cookies = [`capi_state=${cookieState}`, 'capi_pkce=verifier%3D', 'sb-access-token=abc'];
  if (platformCookie) cookies.push(`capi_platform=${platformCookie}`);
  return new Request(url, {
    headers: cookieState ? { cookie: cookies.join('; ') } : {},
  });
}

/* ── Тесты ──────────────────────────────────────────────────────────── */

maybe('OAuth callback быстро сохраняет привязку, ставит sync job, worker пишет реальные данные', async () => {
  const { mod, dir } = await buildRoutes();
  const frontier = fakeFrontier();
  try {
    const res = await mod.callback.GET(callbackRequest(dir));
    const location = new URL(res.headers.get('location'));
    assert.equal(res.status, 307);
    assert.equal(location.pathname, '/account/capi');
    assert.equal(location.searchParams.get('status'), 'partial');
    assert.equal(location.searchParams.get('reason'), 'sync_queued');
    assert.equal(frontier.calls.some((call) => call.url.includes('/profile') || call.url.includes('/journal')), false,
      'OAuth callback must not run the CAPI pipeline in the browser request');

    const token = mod.db.tables.capi_tokens[0];
    assert.equal(token.user_id, 'user-1');
    assert.equal(token.access_token, 'access-1');
    assert.equal(token.refresh_token, 'refresh-1');
    assert.equal(token.is_active, true);
    assert.equal(token.frontier_id, '777');
    assert.equal(mod.db.tables.capi_sync_jobs[0].status, 'queued');

    await runQueuedWorker(mod);
    assert.equal(mod.db.tables.capi_sync_jobs[0].status, 'succeeded');
    assert.equal(token.cmdr_name, 'Nova');
    assert.ok(token.last_synced_at);
    const profileRow = mod.db.tables.capi_profiles[0];
    assert.equal(profileRow.cmdr_name, 'Nova');
    assert.equal(profileRow.credits, 4200000);
    assert.equal(profileRow.combat_rank, 5);
    assert.equal(profileRow.explore_rank, 6);
    assert.equal(profileRow.mercenary_rank, 3);
    assert.equal(profileRow.current_system, 'Colonia');
    assert.equal(profileRow.current_station, 'Jaques Station');
    assert.equal(profileRow.current_ship, 'Mule');
    assert.equal(profileRow.frontier_id, '777');
    assert.equal(mod.db.tables.profiles[0].cmdr_name, 'Nova');
    assert.equal(mod.db.tables.pilot_stats[0].credits, 4200000);

    const tokenCall = frontier.calls.find((call) => call.url.includes('/token'));
    assert.match(tokenCall.body, /code_verifier=verifier%3D/);
    assert.equal(tokenCall.body.includes('client_secret'), false);
  } finally {
    frontier.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('CAPI на техобслуживании (418) не отменяет привязку', async () => {
  const { mod, dir } = await buildRoutes();
  const frontier = fakeFrontier({ profileStatus: 418 });
  try {
    const res = await mod.callback.GET(callbackRequest(dir));
    const location = new URL(res.headers.get('location'));
    assert.equal(location.searchParams.get('reason'), 'sync_queued');
    await runQueuedWorker(mod);
    assert.equal(mod.db.tables.capi_sync_jobs[0].status, 'failed');
    assert.equal(mod.db.tables.capi_tokens[0].access_token, 'access-1');
    assert.equal(mod.db.tables.capi_tokens[0].is_active, true, 'CAPI HTTP failure does not revoke OAuth');
  } finally {
    frontier.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('400 о покупке после OAuth сохраняет привязку; worker обнаруживает платформенную ошибку', async () => {
  const { mod, dir } = await buildRoutes();
  const frontier = fakeFrontier({ profileStatus: 400, profileError: PURCHASE_ERROR });
  try {
    const res = await mod.callback.GET(callbackRequest(dir, { platformCookie: 'epic' }));
    assert.equal(new URL(res.headers.get('location')).searchParams.get('reason'), 'sync_queued');
    assert.equal(mod.db.tables.capi_sync_jobs[0].requested_platform, 'epic');
    // Simulate a previous version having incorrectly marked this still-valid token inactive.
    mod.db.tables.capi_tokens[0].is_active = false;
    await runQueuedWorker(mod);
    const result = mod.db.tables.capi_sync_jobs[0].result;
    assert.equal(result.reason, 'platform_not_entitled');
    assert.equal(result.needsReauth, false);
    assert.equal(result.platform, 'frontier');
    assert.equal(mod.db.tables.capi_tokens[0].is_active, true, 'an EGS/Frontier identity difference must not invalidate OAuth');
    assert.match(mod.db.tables.capi_tokens[0].last_error, /не подтвердил|CAPI/i);
    const goalsRequest = frontier.calls.findIndex((call) => call.url.includes('/communitygoals'));
    const profileRequest = frontier.calls.findIndex((call) => call.url.includes('/profile'));
    assert.ok(goalsRequest >= 0, 'Community Goals are fetched independently even if /profile is refused');
    assert.ok(goalsRequest < profileRequest, 'independent catalog request runs before the fragile profile request');
  } finally {
    frontier.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('фоновая проверка EGS объясняет несоответствие platform без блокировки OAuth callback', async () => {
  const { mod, dir } = await buildRoutes();
  const frontier = fakeFrontier({ profileStatus: 400, profileError: PURCHASE_ERROR });
  try {
    const res = await mod.callback.GET(callbackRequest(dir, { platformCookie: 'epic' }));
    const location = new URL(res.headers.get('location'));
    assert.equal(location.searchParams.get('reason'), 'sync_queued');
    assert.equal(location.searchParams.get('platform'), 'epic');
    assert.equal(location.searchParams.get('actualPlatform'), 'frontier');
    await runQueuedWorker(mod);
    const job = mod.db.tables.capi_sync_jobs[0];
    assert.equal(job.result.reason, 'platform_not_entitled');
    assert.match(job.result.error, /epic/i);
    assert.match(job.result.error, /frontier/i);
    assert.match(capiReasonText('platform_not_entitled').hint, /не доказывает неверный вход/);
    assert.equal(capiReasonText('platform_not_entitled').retryAuth, false);
  } finally {
    frontier.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('пустой журнал (204) — не ошибка: фоновый worker сохраняет профиль', async () => {
  const { mod, dir } = await buildRoutes();
  const frontier = fakeFrontier({ journalStatus: 204 });
  try {
    const res = await mod.callback.GET(callbackRequest(dir));
    assert.equal(new URL(res.headers.get('location')).searchParams.get('status'), 'partial');
    await runQueuedWorker(mod);
    assert.equal(mod.db.tables.capi_sync_jobs[0].status, 'succeeded');
    assert.equal(mod.db.tables.capi_sync_jobs[0].result.journalStatus, 'empty');
    assert.equal(mod.db.tables.capi_profiles[0].credits, 4200000);
  } finally {
    frontier.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('отставшая схема БД: worker пишет доступные поля привязки и профиля', async () => {
  const { mod, dir } = await buildRoutes();
  const frontier = fakeFrontier();
  try {
    mod.db.missingColumns = new Set(['loan', 'cqc_rank', 'frontier_id', 'platform', 'linked_at', 'last_error', 'last_error_at']);
    const res = await mod.callback.GET(callbackRequest(dir));
    assert.equal(new URL(res.headers.get('location')).searchParams.get('reason'), 'sync_queued');
    await runQueuedWorker(mod);
    const profileRow = mod.db.tables.capi_profiles[0];
    assert.equal(profileRow.credits, 4200000);
    assert.equal('loan' in profileRow, false);
    assert.equal(mod.db.tables.capi_tokens[0].access_token, 'access-1');
  } finally {
    frontier.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('несовпадение state и отсутствие кода объясняются пилоту', async () => {
  const { mod, dir } = await buildRoutes();
  const frontier = fakeFrontier();
  try {
    const wrongState = await mod.callback.GET(callbackRequest(dir, { state: 'a', cookieState: 'b' }));
    assert.equal(new URL(wrongState.headers.get('location')).searchParams.get('reason'), 'invalid_state');

    const noCookie = await mod.callback.GET(callbackRequest(dir, { cookieState: null }));
    assert.equal(new URL(noCookie.headers.get('location')).searchParams.get('reason'), 'expired_state');

    const noCode = await mod.callback.GET(callbackRequest(dir, { code: null }));
    assert.equal(new URL(noCode.headers.get('location')).searchParams.get('reason'), 'missing_code');

    const denied = await mod.callback.GET(new Request('https://colony.test/api/capi/callback?error=access_denied'));
    assert.equal(new URL(denied.headers.get('location')).searchParams.get('reason'), 'access_denied');

    assert.equal(mod.db.tables.capi_tokens, undefined, 'при ошибке ничего не записано');
  } finally {
    frontier.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('ручной синк быстро ставит durable job в очередь, worker пишет измеримые этапы', async () => {
  const { mod, dir } = await buildRoutes();
  assert.equal(mod.sync.maxDuration, undefined, 'браузерный запрос больше не выполняет долгую синхронизацию');
  const frontier = fakeFrontier({ journalStatus: 204 });
  try {
    mod.db.tables.capi_tokens = [{
      user_id: 'user-1', access_token: 'access-1', refresh_token: 'refresh-1',
      expires_at: new Date(Date.now() + 3600_000).toISOString(), cmdr_name: 'Nova', is_active: true,
    }];

    const res = await mod.sync.POST(new Request('https://colony.test/api/capi/sync', { method: 'POST' }));
    const body = await res.json();
    assert.equal(res.status, 202);
    assert.equal(body.job.status, 'queued');
    assert.equal(frontier.calls.length, 0, 'enqueue request не должен вызывать Frontier');
    const duplicate = await mod.sync.POST(new Request('https://colony.test/api/capi/sync', { method: 'POST' }));
    assert.equal(duplicate.status, 202);
    assert.equal((await duplicate.json()).job.id, body.job.id, 'повторный клик присоединяется к активному заданию');
    assert.equal(mod.db.tables.capi_sync_jobs.length, 1);
    const active = await mod.sync.GET(new Request('https://colony.test/api/capi/sync'));
    assert.equal((await active.json()).job.status, 'queued');

    const worker = await mod.syncWorker.POST(new Request('https://colony.test/api/cron/capi-sync-jobs', { method: 'POST' }));
    assert.equal(worker.status, 200);
    const job = mod.db.tables.capi_sync_jobs[0];
    assert.equal(job.status, 'succeeded');
    assert.equal(job.result.journalStatus, 'empty');
    assert.equal(job.result.cmdrName, 'Nova');
    assert.ok(job.total_duration_ms >= 0);
    assert.ok(job.stage_timings.some((timing) => timing.stage === 'profile_request'));
    assert.ok(job.stage_timings.some((timing) => timing.stage === 'journal_request'));
    assert.equal(mod.db.tables.capi_profiles[0].current_system, 'Colonia');
    assert.equal(frontier.calls.some((call) => call.url.includes('/communitygoals')), false,
      'foreground worker does not wait on optional Community Goals catalogue endpoint');

    const status = await mod.syncStatus.GET(new Request(`https://colony.test/api/capi/sync/${body.job.id}`), { params: { jobId: body.job.id } });
    assert.equal(status.status, 200);
    assert.equal((await status.json()).job.status, 'succeeded');
  } finally {
    frontier.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('привязка видна интерфейсу даже без строки в capi_profiles', async () => {
  const { mod, dir } = await buildRoutes();
  try {
    mod.db.tables.capi_tokens = [{
      user_id: 'user-1',
      access_token: 'access-1',
      refresh_token: 'refresh-1',
      expires_at: new Date(Date.now() - 1000).toISOString(),
      cmdr_name: 'Nova',
      is_active: true,
    }];

    const res = await mod.profile.GET(new Request('https://colony.test/api/capi/profile'));
    const body = await res.json();

    assert.equal(body.profile, null);
    assert.equal(body.binding.linked, true, 'кнопка «подключить» больше не появляется при живой привязке');
    assert.equal(body.binding.accessExpired, true);
    assert.equal(body.binding.capiName, 'Nova');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const PURCHASE_ERROR = 'Please Visit the store to purchase Elite: Dangerous.';

for (const platform of ['epic', 'steam', 'frontier']) {
  maybe(`колбэк: ${platform} подтверждён, CAPI 400 не отключает OAuth`, async () => {
    const { mod, dir } = await buildRoutes();
    const frontier = fakeFrontier({ profileStatus: 400, profileError: PURCHASE_ERROR, platform });
    try {
      const res = await mod.callback.GET(callbackRequest(dir, { platformCookie: platform }));
      const location = new URL(res.headers.get('location'));
      assert.equal(location.searchParams.get('status'), 'partial');
      assert.equal(location.searchParams.get('reason'), 'sync_queued');
      assert.equal(location.searchParams.get('actualPlatform'), platform);
      assert.equal(mod.db.tables.capi_tokens[0].is_active, true);
      await runQueuedWorker(mod);
      const result = mod.db.tables.capi_sync_jobs[0].result;
      assert.equal(result.reason, 'entitlement_unavailable');
      assert.equal(result.needsReauth, false);
      assert.equal(result.platform, platform);
      assert.equal(mod.db.tables.capi_tokens[0].is_active, true);
      assert.equal(mod.db.tables.capi_tokens[0].refresh_token, 'refresh-1');
      assert.match(mod.db.tables.capi_tokens[0].last_error, /Авторизация сохранена/);
      assert.doesNotMatch(mod.db.tables.capi_tokens[0].last_error, /войдите кнопкой|выйдите из|переподключ/i);
      assert.equal(mod.db.tables.capi_profiles, undefined, 'нет ложного успешного профиля');
      assert.equal(frontier.calls.filter((c) => c.url.includes('/token')).length, 1, '400 не запускает refresh');
    } finally {
      frontier.restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

maybe('колбэк не маскирует долгий Bad Request; background result не объявляет entitlement ошибку', async () => {
  const { mod, dir } = await buildRoutes();
  const frontier = fakeFrontier({ profileStatus: 400, profileError: 'Bad Request: invalid query', platform: 'epic' });
  try {
    const res = await mod.callback.GET(callbackRequest(dir, { platformCookie: 'epic' }));
    assert.equal(new URL(res.headers.get('location')).searchParams.get('reason'), 'sync_queued');
    await runQueuedWorker(mod);
    const result = mod.db.tables.capi_sync_jobs[0].result;
    assert.equal(result.reason, 'profile_unavailable');
    assert.equal(mod.db.tables.capi_tokens[0].is_active, true);
    assert.match(result.error, /invalid query/);
    assert.doesNotMatch(result.error, /куплен|Steam\/Epic/);
  } finally {
    frontier.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('платформа неизвестна до sync; worker бережёт OAuth и учитывает подтверждённый /decode', async () => {
  for (const decodedIdentity of [null, { usr: { customer_id: 777, platform: 'epic' } }]) {
    const { mod, dir } = await buildRoutes();
    const frontier = fakeFrontier({ profileStatus: 400, profileError: PURCHASE_ERROR,
      platform: null, meStatus: 503, decodedIdentity });
    try {
      const res = await mod.callback.GET(callbackRequest(dir, { platformCookie: 'epic' }));
      assert.equal(new URL(res.headers.get('location')).searchParams.get('reason'), 'sync_queued');
      await runQueuedWorker(mod);
      const result = mod.db.tables.capi_sync_jobs[0].result;
      assert.equal(result.reason, 'entitlement_unavailable');
      assert.equal(result.platform, decodedIdentity ? 'epic' : null);
      assert.equal(result.needsReauth, false);
      assert.equal(mod.db.tables.capi_tokens[0].is_active, true);
      if (!decodedIdentity) assert.match(mod.db.tables.capi_tokens[0].last_error, /не доказательство/);
    } finally {
      frontier.restore();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

maybe('отозванный refresh определяется worker-ом после редиректа и не выглядит как отсутствие игры', async () => {
  const { mod, dir } = await buildRoutes();
  const frontier = fakeFrontier({ profileStatus: 401, refreshStatus: 400, platform: 'epic' });
  try {
    const res = await mod.callback.GET(callbackRequest(dir, { platformCookie: 'epic' }));
    assert.equal(new URL(res.headers.get('location')).searchParams.get('reason'), 'sync_queued');
    await runQueuedWorker(mod);
    const result = mod.db.tables.capi_sync_jobs[0].result;
    assert.equal(result.reason, 'token_rejected');
    assert.equal(result.needsReauth, true);
    assert.equal(mod.db.tables.capi_tokens[0].is_active, false);
    assert.doesNotMatch(result.error, /куплен|игр/);
  } finally {
    frontier.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('фоновый ручной синк сохраняет привязку при отказе entitlement и допускает повтор', async () => {
  const { mod, dir } = await buildRoutes();
  let frontier = fakeFrontier({ profileStatus: 400, profileError: PURCHASE_ERROR, platform: 'epic' });
  mod.db.tables.capi_tokens = [{ user_id: 'user-1', access_token: 'access-1', refresh_token: 'refresh-1',
    expires_at: new Date(Date.now() + 3600_000).toISOString(), platform: 'epic', is_active: false }];
  try {
    let res = await mod.sync.POST(new Request('https://colony.test/api/capi/sync', { method: 'POST' }));
    assert.equal(res.status, 202);
    await mod.syncWorker.POST(new Request('https://colony.test/api/cron/capi-sync-jobs', { method: 'POST' }));
    let job = mod.db.tables.capi_sync_jobs[0];
    assert.equal(job.status, 'failed');
    assert.equal(job.result.needsReauth, false, 'entitlement отказ не означает потерю OAuth');
    assert.equal(job.result.reason, 'entitlement_unavailable');
    assert.equal(mod.db.tables.capi_tokens[0].is_active, true);

    frontier.restore();
    frontier = fakeFrontier({ platform: 'epic' });
    res = await mod.sync.POST(new Request('https://colony.test/api/capi/sync', { method: 'POST' }));
    assert.equal(res.status, 202);
    await mod.syncWorker.POST(new Request('https://colony.test/api/cron/capi-sync-jobs', { method: 'POST' }));
    job = mod.db.tables.capi_sync_jobs[1];
    assert.equal(job.status, 'succeeded');
    assert.equal(mod.db.tables.capi_tokens[0].last_error, null);
    assert.equal(mod.db.tables.capi_tokens[0].last_error_at, null);
    assert.equal(mod.db.tables.capi_tokens[0].access_token, 'access-1');
    assert.equal(frontier.calls.some((c) => c.url.includes('/token')), false);
  } finally {
    frontier.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('диагностика показывает подтверждённый EGS и ответ CAPI без секретов', async () => {
  const { mod, dir } = await buildRoutes();
  const frontier = fakeFrontier({ profileStatus: 400, profileError: PURCHASE_ERROR, platform: 'epic' });
  mod.db.tables.capi_tokens = [{ user_id: 'user-1', access_token: 'access-1', refresh_token: 'refresh-1',
    expires_at: new Date(Date.now() + 3600_000).toISOString(), platform: 'epic', is_active: true }];
  try {
    const res = await mod.status.GET(new Request('https://colony.test/api/capi/status?probe=1'));
    const json = await res.json();
    assert.equal(json.live.reason, 'entitlement_unavailable');
    assert.equal(json.live.needsReauth, false);
    assert.equal(json.live.platform, 'epic');
    assert.equal(json.live.status, 400);
    assert.equal(json.live.host, 'https://companion.orerve.net');
    assert.match(json.live.detail, /purchase Elite/);
    assert.doesNotMatch(JSON.stringify(json), /access-1|refresh-1/);
  } finally {
    frontier.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('выбранный EGS доходит до auth audience и cookie без замены на Frontier', async () => {
  const { mod, dir } = await buildRoutes();
  try {
    const req = new Request('https://colony.test/api/capi/auth?platform=egs');
    req.nextUrl = new URL(req.url);
    const res = await mod.auth.GET(req);
    assert.equal(new URL(res.headers.get('location')).searchParams.get('audience'), 'epic');
    assert.equal(res.cookies.get('capi_platform').value, 'epic');
    assert.ok(res.cookies.get('capi_pkce').value);
    assert.ok(res.cookies.get('capi_link').value);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('cron: правильная платформа + отказ в правах не отключает дальнейшую синхронизацию', async () => {
  const { mod, dir } = await buildRoutes();
  const frontier = fakeFrontier({ profileStatus: 400, profileError: PURCHASE_ERROR, platform: 'epic' });
  mod.db.tables.capi_tokens = [{ user_id: 'user-1', access_token: 'access-1', refresh_token: 'refresh-1',
    expires_at: new Date(Date.now() + 3600_000).toISOString(), platform: 'epic', is_active: true }];
  try {
    const res = await mod.cron.GET(new Request('https://colony.test/api/cron/capi-sync'));
    const json = await res.json();
    assert.equal(json.failed, 1);
    assert.equal(json.needsReauth, 0);
    assert.equal(mod.db.tables.capi_tokens[0].is_active, true);
    assert.match(mod.db.tables.capi_tokens[0].last_error, /Авторизация сохранена/);
  } finally {
    frontier.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('неизвестная платформа не оставляет старое ложное требование авторизации после синка', async () => {
  const { mod, dir } = await buildRoutes();
  const frontier = fakeFrontier({ profileStatus: 400, profileError: PURCHASE_ERROR, meStatus: 503 });
  mod.db.tables.capi_tokens = [{ user_id: 'user-1', access_token: 'access-1', refresh_token: 'refresh-1',
    expires_at: new Date(Date.now() + 3600_000).toISOString(), is_active: false }];
  try {
    const res = await mod.sync.POST(new Request('https://colony.test/api/capi/sync', { method: 'POST' }));
    assert.equal(res.status, 202);
    await mod.syncWorker.POST(new Request('https://colony.test/api/cron/capi-sync-jobs', { method: 'POST' }));
    const result = mod.db.tables.capi_sync_jobs[0].result;
    assert.equal(result.needsReauth, false);
    assert.equal(result.reason, 'entitlement_unavailable');
    assert.equal(result.platform, null);
    assert.equal(mod.db.tables.capi_tokens[0].is_active, true);
  } finally {
    frontier.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});
