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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let esbuild = null;
try {
  esbuild = await import('esbuild');
} catch {
  // devDependencies не установлены — пропускаем, а не падаем.
}
const maybe = esbuild ? test : test.skip;

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'service-role-key';
process.env.NEXT_PUBLIC_SITE_URL ??= 'https://colony.test';
process.env.FRONTIER_REDIRECT_URI ??= 'https://colony.test/api/capi/callback';

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
    op === 'eq' ? row[column] === value : op === 'neq' ? row[column] !== value : true);
}

function missing(values) {
  return Object.keys(values).find((key) => db.missingColumns.has(key));
}

function makeQuery(table) {
  const filters = [];
  let verb = 'select';
  const api = {
    select: () => { verb = 'select'; return api; },
    eq: (column, value) => { filters.push(['eq', column, value]); return api; },
    neq: (column, value) => { filters.push(['neq', column, value]); return api; },
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
    insert: (values) => { rowsOf(table).push({ ...values }); return Promise.resolve({ error: null }); },
    update: (values) => ({
      eq: (column, value) => {
        const bad = missing(values);
        if (bad) {
          return Promise.resolve({ error: { code: 'PGRST204', message: "Could not find the '" + bad + "' column of '" + table + "' in the schema cache" } });
        }
        for (const row of rowsOf(table)) {
          if (row[column] === value || row.id === value) Object.assign(row, values);
        }
        return Promise.resolve({ error: null });
      },
    }),
    delete: () => ({ eq: (column, value) => {
      db.tables[table] = rowsOf(table).filter((row) => row[column] !== value);
      return Promise.resolve({ error: null });
    } }),
    maybeSingle: async () => {
      const found = rowsOf(table).find((row) => matches(row, filters));
      return { data: found ?? null, error: null };
    },
    single: async () => {
      const found = rowsOf(table).find((row) => matches(row, filters));
      return { data: found ?? null, error: found ? null : { message: 'not found' } };
    },
    then: (resolve, reject) => Promise.resolve({
      data: rowsOf(table).filter((row) => matches(row, filters)),
      error: null,
    }).then(resolve, reject),
  };
  void verb;
  return api;
}

const client = () => ({
  auth: { getUser: async () => ({ data: { user: db.user }, error: null }) },
  from: (table) => makeQuery(table),
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
`;

async function buildRoutes() {
  const dir = mkdtempSync(join(ROOT, '.tmp-capi-route-'));
  writeFileSync(join(dir, 'next-server.mjs'), NEXT_SERVER_STUB);
  writeFileSync(join(dir, 'supabase.mjs'), SUPABASE_STUB);
  writeFileSync(join(dir, 'progress.mjs'), PROGRESS_STUB);

  const entry = join(dir, 'entry.ts');
  writeFileSync(
    entry,
    "export * as callback from '@/app/api/capi/callback/route';\n"
    + "export * as sync from '@/app/api/capi/sync/route';\n"
    + "export * as profile from '@/app/api/capi/profile/route';\n"
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
function fakeFrontier({ profile = PROFILE_JSON, profileStatus = 200, journal = JOURNAL_NDJSON, journalStatus = 200 } = {}) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? String(init.body) : null });

    if (url.includes('auth.frontierstore.net/token')) {
      return new Response(JSON.stringify({
        access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 14400, token_type: 'Bearer',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('auth.frontierstore.net/me')) {
      return new Response(JSON.stringify({ customer_id: 777, email: 'cmdr@example.test', platform: 'frontier' }), { status: 200 });
    }
    // Тело у 204 запрещено конструктором Response — как и у настоящего CAPI.
    if (url.includes('/profile')) {
      return profileStatus === 200
        ? new Response(JSON.stringify(profile), { status: 200 })
        : new Response(profileStatus === 204 ? null : 'error', { status: profileStatus });
    }
    if (url.includes('/journal')) {
      return journalStatus === 200
        ? new Response(journal, { status: 200 })
        : new Response(journalStatus === 204 ? null : 'error', { status: journalStatus });
    }
    return new Response('{}', { status: 200 });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function callbackRequest(dir, { state = 'state-123', cookieState = 'state-123', code = 'auth-code' } = {}) {
  void dir;
  const url = new URL('https://colony.test/api/capi/callback');
  if (code) url.searchParams.set('code', code);
  if (state) url.searchParams.set('state', state);
  return new Request(url, {
    headers: cookieState
      ? { cookie: `capi_state=${cookieState}; capi_pkce=verifier%3D; sb-access-token=abc` }
      : {},
  });
}

/* ── Тесты ──────────────────────────────────────────────────────────── */

maybe('успешная привязка сохраняет токен и РЕАЛЬНЫЕ данные профиля', async () => {
  const { mod, dir } = await buildRoutes();
  const frontier = fakeFrontier();
  try {
    const res = await mod.callback.GET(callbackRequest(dir));
    const location = new URL(res.headers.get('location'));

    assert.equal(res.status, 307);
    assert.equal(location.pathname, '/account/capi');
    assert.equal(location.searchParams.get('status'), 'success');
    assert.equal(location.searchParams.get('cmdr'), 'Nova');

    const token = mod.db.tables.capi_tokens[0];
    assert.equal(token.user_id, 'user-1');
    assert.equal(token.access_token, 'access-1');
    assert.equal(token.refresh_token, 'refresh-1');
    assert.equal(token.is_active, true);
    assert.equal(token.frontier_id, '777');
    assert.equal(token.cmdr_name, 'Nova', 'имя командира попадает в привязку');
    assert.ok(token.last_synced_at, 'первая синхронизация отмечена');

    // Главное: профиль заполнен, а не состоит из NULL.
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

    // Пустое имя в профиле сайта заполняется именем Frontier.
    assert.equal(mod.db.tables.profiles[0].cmdr_name, 'Nova');
    // И витрина досье тоже.
    assert.equal(mod.db.tables.pilot_stats[0].credits, 4200000);

    // Обмен кода шёл по PKCE: верификатор с «=», без client_secret.
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

    assert.equal(location.searchParams.get('status'), 'partial');
    assert.equal(location.searchParams.get('reason'), 'profile_unavailable');
    // Токен на месте — пилот сможет синхронизироваться позже.
    assert.equal(mod.db.tables.capi_tokens[0].access_token, 'access-1');
  } finally {
    frontier.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('пустой журнал (204) — не ошибка: профиль всё равно сохранён', async () => {
  const { mod, dir } = await buildRoutes();
  const frontier = fakeFrontier({ journalStatus: 204 });
  try {
    const res = await mod.callback.GET(callbackRequest(dir));
    assert.equal(new URL(res.headers.get('location')).searchParams.get('status'), 'success');
    assert.equal(mod.db.tables.capi_profiles[0].credits, 4200000);
  } finally {
    frontier.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('отставшая схема БД: профиль пишется без недостающих колонок', async () => {
  const { mod, dir } = await buildRoutes();
  const frontier = fakeFrontier();
  try {
    // База без миграции 20261002000000: нет loan/cqc_rank/frontier_id.
    mod.db.missingColumns = new Set(['loan', 'cqc_rank', 'frontier_id', 'platform', 'linked_at', 'last_error', 'last_error_at']);

    const res = await mod.callback.GET(callbackRequest(dir));
    assert.equal(new URL(res.headers.get('location')).searchParams.get('status'), 'success');

    const profileRow = mod.db.tables.capi_profiles[0];
    assert.equal(profileRow.credits, 4200000, 'данные сохранены, несмотря на отставшую схему');
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

maybe('ручной синк отвечает 200 и сообщает состояние журнала', async () => {
  const { mod, dir } = await buildRoutes();
  const frontier = fakeFrontier({ journalStatus: 204 });
  try {
    mod.db.tables.capi_tokens = [{
      user_id: 'user-1',
      access_token: 'access-1',
      refresh_token: 'refresh-1',
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      cmdr_name: 'Nova',
      is_active: true,
    }];

    const res = await mod.sync.POST(new Request('https://colony.test/api/capi/sync', { method: 'POST' }));
    const body = await res.json();

    assert.equal(res.status, 200, 'пустой журнал — не пятисотка');
    assert.equal(body.synced, true);
    assert.equal(body.journalStatus, 'empty');
    assert.equal(body.cmdrName, 'Nova');
    assert.equal(mod.db.tables.capi_profiles[0].current_system, 'Colonia');
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
