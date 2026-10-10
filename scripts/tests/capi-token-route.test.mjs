/**
 * Тесты роута `/api/capi/token` — обмена привязкой Frontier CAPI между
 * Colonial Helper и сайтом.
 *
 * Роут импортируется настоящим: собирается esbuild'ом с подменой `next/server`,
 * `@supabase/supabase-js`, `@/lib/supabaseServer` и `@/lib/projects/autoProgress`
 * на заглушки (как в capi-callback-route.test.mjs), сеть Frontier — через
 * подмену `globalThis.fetch`.
 *
 * Что закрепляется:
 *
 *  1. POST не перетирает СВЕЖУЮ пару токенов сайта СТАРОЙ копией Helper'а:
 *     refresh-токен одноразовый, поэтому перезапись свежей пары старой ломает
 *     продление расписанием сайта (`stale: true`, строка не меняется).
 *  2. POST принимает более свежую пару и перепривязку другого аккаунта.
 *  3. GET продлевает access-токен сам (сайт — владелец refresh-цикла), чтобы
 *     Helper получал живой токен и не расходовал refresh-токен сайта.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let esbuild = null;
try {
  esbuild = await import('esbuild');
} catch {
  // devDependencies не установлены — пропускаем, а не падаем.
}
const maybe = esbuild ? test : test.skip;

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
process.env.NEXT_PUBLIC_SITE_URL = 'https://colony.test';

const NEXT_SERVER_STUB = `
export const NextResponse = {
  json: (body, init) =>
    new Response(JSON.stringify(body), {
      status: (init && init.status) || 200,
      headers: { 'content-type': 'application/json' },
    }),
};
`;

/** In-memory Supabase: таблицы, select/eq/neq/upsert/update/maybeSingle. */
const SUPABASE_STUB = `
export const db = {
  user: { id: 'user-1' },
  tables: {},
};

export function reset() {
  db.user = { id: 'user-1' };
  db.tables = {};
}

const rowsOf = (table) => (db.tables[table] ||= []);

function matches(row, filters) {
  return filters.every(([op, column, value]) => {
    if (op === 'eq') return row[column] === value;
    if (op === 'neq') return row[column] !== value;
    if (op === 'ilike') return String(row[column] ?? '').toLowerCase() === String(value).toLowerCase();
    return true;
  });
}

function makeQuery(table) {
  const filters = [];
  const api = {
    select: () => api,
    eq: (column, value) => { filters.push(['eq', column, value]); return api; },
    neq: (column, value) => { filters.push(['neq', column, value]); return api; },
    ilike: (column, value) => { filters.push(['ilike', column, value]); return api; },
    order: () => api,
    limit: () => api,
    upsert: (values) => {
      const rows = rowsOf(table);
      const index = rows.findIndex((row) => row.user_id === values.user_id);
      if (index >= 0) rows[index] = { ...rows[index], ...values };
      else rows.push({ ...values });
      return Promise.resolve({ error: null, data: values });
    },
    insert: (values) => { rowsOf(table).push({ ...values }); return Promise.resolve({ error: null }); },
    update: (values) => ({
      eq: (column, value) => {
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
  return api;
}

const client = () => ({
  auth: { getUser: async () => ({ data: { user: db.user }, error: null }) },
  from: (table) => makeQuery(table),
});

export function createClient() { return client(); }
export function createServiceClient() { return client(); }
export async function authFromRequest() { return { user: db.user, supabase: client() }; }
`;

const PROGRESS_STUB = `
export const progressCalls = [];
export async function updateProjectProgress(system, progress, resources, source) {
  progressCalls.push({ system, progress, resources, source });
}
`;

async function buildRoute() {
  const dir = mkdtempSync(join(ROOT, '.tmp-capi-token-route-'));
  writeFileSync(join(dir, 'next-server.mjs'), NEXT_SERVER_STUB);
  writeFileSync(join(dir, 'supabase.mjs'), SUPABASE_STUB);
  writeFileSync(join(dir, 'progress.mjs'), PROGRESS_STUB);

  const entry = join(dir, 'entry.ts');
  writeFileSync(entry, "export * as token from '@/app/api/capi/token/route';\n"
    + "export { db, reset } from './supabase.mjs';\n");

  const bundle = join(dir, 'bundle.mjs');
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: bundle,
    alias: {
      'next/server': join(dir, 'next-server.mjs'),
      '@supabase/supabase-js': join(dir, 'supabase.mjs'),
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

/* ── данные Frontier ───────────────────────────────────────────────── */

const PROFILE_JSON = {
  commander: {
    id: 777, name: 'Nova', credits: 4200000, debt: 0, docked: true,
    rank: { combat: 5, trade: 4, explore: 6, empire: 2, federation: 1, cqc: 0, soldier: 3, exobiologist: 2 },
  },
  lastSystem: { id: 3238296097059, name: 'Colonia' },
  lastStarport: { id: 128667761, name: 'Jaques Station' },
  ship: { id: 4, name: 'Python', shipName: 'Mule', shipID: 'MU-01' },
  ships: { 4: { id: 4, name: 'Python', shipName: 'Mule' } },
};

function fakeFrontier({ platform = 'frontier', customerId = '777', refresh = null } = {}) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? String(init.body) : null });
    if (url.includes('auth.frontierstore.net/token')) {
      return new Response(JSON.stringify(refresh ?? {
        access_token: 'site-fresh', refresh_token: 'site-r2', expires_in: 14400, token_type: 'Bearer',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('auth.frontierstore.net/me')) {
      return new Response(JSON.stringify({ customer_id: customerId, email: 'cmdr@example.test', platform }), { status: 200 });
    }
    if (url.includes('/profile')) {
      return new Response(JSON.stringify(PROFILE_JSON), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const HELPER_TOKEN = 'rc_helper-token-0123456789abcdef';
const HELPER_TOKEN_HASH = createHash('sha256').update(HELPER_TOKEN).digest('hex');

function seedApiToken(mod) {
  mod.db.tables.api_tokens = [{ user_id: 'user-1', is_revoked: false, token_hash: HELPER_TOKEN_HASH }];
}

function seedBinding(mod, { expiresAt, frontierId = '777', active = true }) {
  mod.db.tables.capi_tokens = [{
    user_id: 'user-1',
    access_token: 'site-access',
    refresh_token: 'site-refresh',
    expires_at: expiresAt,
    frontier_id: frontierId,
    is_active: active,
    platform: 'frontier',
    cmdr_name: 'Nova',
  }];
}

function postTokens(mod, body) {
  return mod.token.POST(new Request('https://colony.test/api/capi/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

const HOUR = 3600_000;

/* ── тесты ─────────────────────────────────────────────────────────── */

maybe('POST: старая копия токенов Helper не перетирает свежую пару сайта', async () => {
  const { mod, dir } = await buildRoute();
  const frontier = fakeFrontier();
  try {
    seedApiToken(mod);
    // Сайт уже продлил пару: access истекает через 3 часа.
    seedBinding(mod, { expiresAt: new Date(Date.now() + 3 * HOUR).toISOString() });

    // Helper прислал свою копию, полученную час назад (истекает через 3 часа
    // от момента получения, т.е. раньше, чем у сайта — считаем относительно).
    const res = await postTokens(mod, {
      token: HELPER_TOKEN,
      access_token: 'helper-access-token-0123456789',
      refresh_token: 'helper-refresh-token-0123456789',
      expires_in: 3600,
      obtained_at: Math.floor(Date.now() / 1000),
    });
    const json = await res.json();

    assert.equal(res.status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.stale, true, 'сервер сообщает, что пара сайта свежее');

    const row = mod.db.tables.capi_tokens[0];
    assert.equal(row.access_token, 'site-access', 'свежая пара сайта на месте');
    assert.equal(row.refresh_token, 'site-refresh');
    assert.equal(mod.db.tables.capi_profiles, undefined, 'синхронизация при stale-push не запускается');
  } finally {
    frontier.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('POST: повторная отправка той же пары идемпотентна (ничего не ломает)', async () => {
  const { mod, dir } = await buildRoute();
  const frontier = fakeFrontier();
  try {
    seedApiToken(mod);
    const expiresAt = new Date(Date.now() + 2 * HOUR).toISOString();
    seedBinding(mod, { expiresAt });

    const res = await postTokens(mod, {
      token: HELPER_TOKEN,
      access_token: 'helper-access-token-0123456789',
      refresh_token: 'helper-refresh-token-0123456789',
      expires_in: 7200,
      obtained_at: Math.floor((Date.now() - HOUR) / 1000),
    });
    const json = await res.json();

    // obtained_at час назад + 2 часа = срок как у сайта: не свежее, пропускаем.
    assert.equal(json.ok, true);
    assert.equal(json.stale, true);
    assert.equal(mod.db.tables.capi_tokens[0].access_token, 'site-access');
  } finally {
    frontier.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('POST: свежая пара принимается и запускает синхронизацию профиля', async () => {
  const { mod, dir } = await buildRoute();
  const frontier = fakeFrontier();
  try {
    seedApiToken(mod);
    // Сайт не обновлялся давно: его access истёк час назад.
    seedBinding(mod, { expiresAt: new Date(Date.now() - HOUR).toISOString() });

    const res = await postTokens(mod, {
      token: HELPER_TOKEN,
      access_token: 'helper-access-token-0123456789',
      refresh_token: 'helper-refresh-token-0123456789',
      expires_in: 14400,
      obtained_at: Math.floor(Date.now() / 1000),
    });
    const json = await res.json();

    assert.equal(res.status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.stale, undefined);
    assert.equal(json.synced, true);
    assert.equal(json.cmdr, 'Nova');

    const row = mod.db.tables.capi_tokens[0];
    assert.equal(row.access_token, 'helper-access-token-0123456789');
    assert.equal(row.refresh_token, 'helper-refresh-token-0123456789');
    assert.equal(row.is_active, true);
    // Профиль подтянут сразу: досье не ждёт расписания.
    assert.equal(mod.db.tables.capi_profiles[0].cmdr_name, 'Nova');
    assert.equal(mod.db.tables.capi_profiles[0].credits, 4200000);
  } finally {
    frontier.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('POST: перепривязка другого аккаунта Frontier принимается даже со старым сроком', async () => {
  const { mod, dir } = await buildRoute();
  // Токен выдан ДРУГИМ аккаунтом Frontier (customer_id 888).
  const frontier = fakeFrontier({ customerId: '888' });
  try {
    seedApiToken(mod);
    seedBinding(mod, { expiresAt: new Date(Date.now() + 3 * HOUR).toISOString(), frontierId: '777' });

    const res = await postTokens(mod, {
      token: HELPER_TOKEN,
      access_token: 'helper-access-token-0123456789',
      refresh_token: 'helper-refresh-token-0123456789',
      expires_in: 3600,
      obtained_at: Math.floor(Date.now() / 1000),
    });
    const json = await res.json();

    assert.equal(json.ok, true);
    assert.equal(json.stale, undefined, 'другой аккаунт — это перепривязка, а не stale-push');
    assert.equal(mod.db.tables.capi_tokens[0].frontier_id, '888');
  } finally {
    frontier.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('POST: привязка того же аккаунта к другой учётке сайта отклоняется (409)', async () => {
  const { mod, dir } = await buildRoute();
  const frontier = fakeFrontier();
  try {
    seedApiToken(mod);
    // Аккаунт 777 уже привязан к другому пользователю сайта.
    mod.db.tables.capi_tokens = [{ user_id: 'user-2', frontier_id: '777', access_token: 'x', refresh_token: 'y', expires_at: new Date(Date.now() + HOUR).toISOString() }];

    const res = await postTokens(mod, {
      token: HELPER_TOKEN,
      access_token: 'helper-access-token-0123456789',
      refresh_token: 'helper-refresh-token-0123456789',
      expires_in: 14400,
      obtained_at: Math.floor(Date.now() / 1000),
    });

    assert.equal(res.status, 409);
    const json = await res.json();
    assert.equal(json.error, 'already_linked_elsewhere');
  } finally {
    frontier.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('GET: сайт продлевает access-токен сам и отдаёт Helper живую пару', async () => {
  const { mod, dir } = await buildRoute();
  const frontier = fakeFrontier();
  try {
    seedApiToken(mod);
    // Access-токен сайта истекает через минуту — сессия продлит его сама.
    seedBinding(mod, { expiresAt: new Date(Date.now() + 60_000).toISOString() });

    const res = await mod.token.GET(new Request(`https://colony.test/api/capi/token?token=${HELPER_TOKEN}`));
    const json = await res.json();

    assert.equal(res.status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.tokens.access_token, 'site-fresh', 'Helper получает живой access-токен');
    assert.equal(json.tokens.refresh_token, 'site-r2');

    const refreshCall = frontier.calls.find((call) => call.url.includes('auth.frontierstore.net/token'));
    assert.ok(refreshCall, 'сайт сходил в /token за продлением');
    assert.match(refreshCall.body, /refresh_token=site-refresh/);

    // База хранит свежую пару: расписание сайта продолжает ею владеть.
    assert.equal(mod.db.tables.capi_tokens[0].access_token, 'site-fresh');
  } finally {
    frontier.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('GET: без привязки — честный 404, с отозванной — тоже', async () => {
  const { mod, dir } = await buildRoute();
  const frontier = fakeFrontier();
  try {
    seedApiToken(mod);

    let res = await mod.token.GET(new Request(`https://colony.test/api/capi/token?token=${HELPER_TOKEN}`));
    assert.equal(res.status, 404);

    seedBinding(mod, { expiresAt: new Date(Date.now() + HOUR).toISOString(), active: false });
    res = await mod.token.GET(new Request(`https://colony.test/api/capi/token?token=${HELPER_TOKEN}`));
    assert.equal(res.status, 404, 'сломанная привязка не отдаётся Helper\'у');
  } finally {
    frontier.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('GET/POST: без авторизации — 401', async () => {
  const { mod, dir } = await buildRoute();
  const frontier = fakeFrontier();
  try {
    // Ни API-токена, ни сессии: заглушка authFromRequest возвращает null user.
    mod.db.user = null;

    const res = await mod.token.GET(new Request('https://colony.test/api/capi/token'));
    assert.equal(res.status, 401);

    const post = await postTokens(mod, {
      access_token: 'helper-access-token-0123456789',
      refresh_token: 'helper-refresh-token-0123456789',
    });
    assert.equal(post.status, 401);
  } finally {
    frontier.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});
