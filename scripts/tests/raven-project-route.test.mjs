/**
 * Тесты /api/architect/raven-project — создание проекта постройки плана.
 *
 * Главное обещание: проект сначала сохраняется на сайте проекта
 * (`construction_projects`), а Raven Colonial — вторичная синхронизация.
 * Проверка RCC-ключа в Raven отвечает 503, но проект всё равно должен быть
 * создан и виден оверлею Helper'а.
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

const NEXT_SERVER_STUB = `
export const NextResponse = {
  json: (body, init) =>
    new Response(JSON.stringify(body), {
      status: (init && init.status) || 200,
      headers: { 'content-type': 'application/json' },
    }),
};
`;

const SUPABASE_STUB = `
export const db = { user: { id: 'user-1' }, rpcCalls: [], rpcError: null };

export function reset(rows = {}) {
  db.user = rows.user === undefined ? { id: 'user-1' } : rows.user;
  db.rpcCalls.length = 0;
  db.rpcError = rows.rpcError ?? null;
}

export async function authFromRequest() {
  return { user: db.user, error: null };
}

export function createServiceClient() {
  return {
    rpc: async (name, params) => {
      db.rpcCalls.push([name, params]);
      return { data: [{ project_key: params.p_project.project_key }], error: db.rpcError };
    },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
  };
}

export async function createClient() { return createServiceClient(); }
`;

const KEY_STORE_STUB = `
export const state = { key: null, cmdrName: null, error: null };

export function resetKey(rows = {}) {
  state.key = rows.key ?? null;
  state.cmdrName = rows.cmdrName ?? null;
  state.error = rows.error ?? null;
}

export async function loadRavenKey() {
  return { key: state.key, cmdrName: state.cmdrName, error: state.error };
}
`;

const RAVEN_CLIENT_STUB = `
export const state = { result: null, linkError: null, createCalls: [], linkCalls: [] };

export function resetRaven(result = null) {
  state.result = result;
  state.linkError = null;
  state.createCalls.length = 0;
  state.linkCalls.length = 0;
}

export async function ravenCreateProject(key, draft) {
  state.createCalls.push([key, draft]);
  return state.result ?? { ok: false, status: 503, data: null, error: 'Raven Colonial ответил 503' };
}

export function buildIdFromResponse(data) {
  return data && data.buildId ? String(data.buildId) : '';
}

export async function ravenLinkCommander(key, buildId, cmdr) {
  state.linkCalls.push([key, buildId, cmdr]);
  return state.linkError ? { ok: false, error: state.linkError } : { ok: true, error: null };
}
`;

const API_T_STUB = `
export async function apiTranslate() {
  return (key, vars = {}) => {
    if (key === 'api.ravenKeyFirst') return 'Сначала сохраните RCC-ключ.';
    if (key === 'api.ravenNoBuildId') return 'Raven не вернул buildId.';
    if (key === 'rvcp.siteSaveFailed') return 'Проект не сохранён на сайте.';
    return key + Object.entries(vars).map(([name, value]) => ' ' + name + '=' + value).join('');
  };
}
`;

async function buildRoute() {
  const dir = mkdtempSync(join(ROOT, '.tmp-raven-project-'));
  writeFileSync(join(dir, 'next-server.mjs'), NEXT_SERVER_STUB);
  writeFileSync(join(dir, 'supabase.mjs'), SUPABASE_STUB);
  writeFileSync(join(dir, 'key-store.mjs'), KEY_STORE_STUB);
  writeFileSync(join(dir, 'raven-client.mjs'), RAVEN_CLIENT_STUB);
  writeFileSync(join(dir, 'api-t.mjs'), API_T_STUB);

  const entry = join(dir, 'entry.ts');
  writeFileSync(
    entry,
    "export * as route from '@/app/api/architect/raven-project/route';\n"
    + "export { db, reset } from './supabase.mjs';\n"
    + "export { resetKey } from './key-store.mjs';\n"
    + "export { resetRaven, state as raven } from './raven-client.mjs';\n",
  );
  const bundle = join(dir, 'bundle.mjs');
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: bundle,
    external: [],
    alias: {
      'next/server': join(dir, 'next-server.mjs'),
      '@/lib/supabaseServer': join(dir, 'supabase.mjs'),
      '@/lib/raven/keyStore': join(dir, 'key-store.mjs'),
      '@/lib/raven/client': join(dir, 'raven-client.mjs'),
      '@/lib/i18n/apiT': join(dir, 'api-t.mjs'),
      '@': join(ROOT, 'src'),
    },
    loader: { '.ts': 'ts', '.tsx': 'tsx' },
    logLevel: 'silent',
  });

  const mod = await import(bundle);
  mod.reset();
  mod.resetKey();
  mod.resetRaven();
  return { mod, dir };
}

const SYSTEM = 'Architest';

function body(overrides = {}) {
  return {
    system: SYSTEM,
    site: {
      id: 'site-1',
      installationId: 'no_truss',
      bodyName: `${SYSTEM} A 1`,
      note: '',
      primary: false,
    },
    body: { name: `${SYSTEM} A 1`, bodyId: 1 },
    marketId: 128016640,
    systemAddress: 28682976,
    buildName: 'Первый порт',
    architectName: 'Jameson',
    ...overrides,
  };
}

const post = (payload) => new Request('http://localhost/api/architect/raven-project', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
});

maybe('без RCC-ключа проект сохраняется на сайте и не теряется', async () => {
  const { mod, dir } = await buildRoute();
  try {
    const response = await mod.route.POST(post(body()));
    const data = await response.json();

    assert.equal(response.status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.buildId, null, 'проекта в Raven ещё нет');
    assert.equal(data.raven, 'no_key');
    assert.equal(mod.db.rpcCalls.length, 1);
    const [name, params] = mod.db.rpcCalls[0];
    assert.equal(name, 'construction_project_register');
    assert.equal(params.p_project.project_key, '28682976:128016640');
    assert.equal(params.p_project.rc_state, 'no_key', 'состояние Raven честное');
    assert.equal(params.p_project.build_name, 'Первый порт');
    assert.equal(params.p_user, 'user-1');
    assert.equal(mod.raven.createCalls.length, 0, 'без ключа в Raven не ходим');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('Raven отвечает 503: проект остаётся на сайте, причина видна', async () => {
  const { mod, dir } = await buildRoute();
  try {
    mod.resetKey({ key: 'rcc-key-123456', cmdrName: 'Jameson' });
    mod.resetRaven({ ok: false, status: 503, data: null, error: 'Raven Colonial ответил 503' });

    const response = await mod.route.POST(post(body()));
    const data = await response.json();

    assert.equal(response.status, 200, 'отказ Raven не отменяет проект');
    assert.equal(data.ok, true);
    assert.equal(data.buildId, null);
    assert.equal(data.raven, 'unavailable');
    assert.match(data.warning, /503/);
    assert.equal(mod.db.rpcCalls.length, 1, 'запись на сайте уже сделана');
    assert.equal(mod.db.rpcCalls[0][1].p_project.rc_state, 'unknown',
      'перед попыткой синхронизации состояние ещё неизвестно');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('Raven ответил: на сайте остаётся карточка уже с buildId', async () => {
  const { mod, dir } = await buildRoute();
  try {
    mod.resetKey({ key: 'rcc-key-123456', cmdrName: 'Jameson' });
    mod.resetRaven({ ok: true, status: 200, data: { buildId: 'b-77' }, error: null });

    const response = await mod.route.POST(post(body()));
    const data = await response.json();

    assert.equal(response.status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.buildId, 'b-77');
    assert.equal(data.raven, 'ok');
    assert.deepEqual(mod.raven.linkCalls, [['rcc-key-123456', 'b-77', 'Jameson']],
      'проект привязан к командиру');
    assert.equal(mod.db.rpcCalls.length, 2, 'вторая запись — с buildId');
    assert.equal(mod.db.rpcCalls[1][1].p_project.build_id, 'b-77');
    assert.equal(mod.db.rpcCalls[1][1].p_project.rc_state, 'ok');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('ошибка записи на сайте — 503, а не «проект создан»', async () => {
  const { mod, dir } = await buildRoute();
  try {
    mod.reset({ rpcError: { message: 'function construction_project_register does not exist' } });
    const response = await mod.route.POST(post(body()));
    const data = await response.json();
    assert.equal(response.status, 503);
    assert.match(data.error, /not migrated/);
    assert.equal(mod.raven.createCalls.length, 0, 'в Raven без записи на сайте не идём');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('без площадки или адреса — 400 и ни одной записи', async () => {
  const { mod, dir } = await buildRoute();
  try {
    const noMarket = await mod.route.POST(post({ marketId: 0 }));
    assert.equal(noMarket.status, 400);

    const noAddress = await mod.route.POST(post({ systemAddress: 0 }));
    assert.equal(noAddress.status, 400);

    const anonymous = await mod.route.POST(post({ site: null }));
    assert.equal(anonymous.status, 400);
    assert.equal(mod.db.rpcCalls.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
