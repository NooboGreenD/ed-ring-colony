/**
 * Тесты маршрутов /api/projects/active и /api/projects/register.
 *
 * Проверяется главное обещание: список действующих строек собирается из
 * учёта сайта, кэша Raven и снимков депотов, а регистрация проекта принимает
 * тело Helper и отвергает запрос без ключа площадки. База — заглушка,
 * маршрут собирается esbuild'ом (как и остальные route-тесты).
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

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';

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
export const db = {
  user: null,
  stored: [],
  journal: [],
  raven: [],
  rpcCalls: [],
  error: null,
};

export function reset(rows = {}) {
  db.user = null;
  db.stored = rows.stored ?? [];
  db.journal = rows.journal ?? [];
  db.raven = rows.raven ?? [];
  db.rpcCalls.length = 0;
  db.error = null;
}

function rowsFor(table) {
  if (table === 'construction_projects') return db.stored;
  if (table === 'colonisation_sites') return db.journal;
  if (table === 'system_progress') return db.raven;
  return [];
}

function matches(row, filters) {
  return filters.every(([op, column, value]) => {
    const cell = row?.[column];
    if (op === 'eq') return cell === value;
    if (op === 'in') return (value ?? []).includes(cell);
    if (op === 'ilike') return String(cell ?? '').toLowerCase() === String(value).toLowerCase();
    return true;
  });
}

function makeQuery(table) {
  const record = { table, filters: [], limitValue: null };
  const respond = () => {
    const rows = rowsFor(table).filter((row) => matches(row, record.filters));
    const limited = Number.isInteger(record.limitValue) ? rows.slice(0, record.limitValue) : rows;
    return { data: limited, error: db.error };
  };
  const api = {
    select: () => api,
    eq: (column, value) => { record.filters.push(['eq', column, value]); return api; },
    in: (column, value) => { record.filters.push(['in', column, value]); return api; },
    ilike: (column, value) => { record.filters.push(['ilike', column, value]); return api; },
    order: () => api,
    limit: (value) => { record.limitValue = value; return api; },
    maybeSingle: async () => respond(),
    then: (resolve, reject) => Promise.resolve(respond()).then(resolve, reject),
  };
  return api;
}

export function createServiceClient() {
  return {
    from: (table) => makeQuery(table),
    rpc: async (name, params) => {
      db.rpcCalls.push([name, params]);
      return {
        data: {
          project_key: params.p_project.project_key,
          created_at: '2026-11-09T10:00:00.000Z',
          updated_at: '2026-11-09T10:00:00.000Z',
        },
        error: db.error,
      };
    },
  };
}

export function createClient() { return createServiceClient(); }
`;

const HELPER_AUTH_STUB = `
import { db } from './supabase.mjs';

export async function resolveRequestUser() {
  return db.user ? { userId: db.user, via: 'api_token' } : null;
}
`;

async function buildRoutes() {
  const dir = mkdtempSync(join(ROOT, '.tmp-projects-route-'));
  writeFileSync(join(dir, 'next-server.mjs'), NEXT_SERVER_STUB);
  writeFileSync(join(dir, 'supabase.mjs'), SUPABASE_STUB);
  writeFileSync(join(dir, 'helper-auth.mjs'), HELPER_AUTH_STUB);

  const entry = join(dir, 'entry.ts');
  writeFileSync(
    entry,
    "export * as active from '@/app/api/projects/active/route';\n"
    + "export * as register from '@/app/api/projects/register/route';\n"
    + "export { db, reset } from './supabase.mjs';\n",
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
      '@/lib/helperAuth': join(dir, 'helper-auth.mjs'),
      '@': join(ROOT, 'src'),
    },
    loader: { '.ts': 'ts', '.tsx': 'tsx' },
    logLevel: 'silent',
  });

  const mod = await import(bundle);
  mod.reset();
  return { mod, dir };
}

const request = (method, url, body) => new Request(url, {
  method,
  headers: { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

const json = async (response) => ({ status: response.status, body: await response.json() });

maybe('активные проекты: без параметров 400, «мои проекты» без ключа 401', async () => {
  const { mod, dir } = await buildRoutes();
  try {
    const bad = await json(await mod.active.GET(request('GET', 'http://localhost/api/projects/active')));
    assert.equal(bad.status, 400);

    const anonymous = await json(await mod.active.GET(
      request('GET', 'http://localhost/api/projects/active?cmdr=Jameson'),
    ));
    assert.equal(anonymous.status, 401);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('активные проекты: сайт первичен, Raven и депоты дополняют', async () => {
  const { mod, dir } = await buildRoutes();
  try {
    mod.reset({
      stored: [{
        project_key: '10:20',
        system_name: 'Ravenless 1',
        // Генерируемая колонка (`lower(btrim(system_name))`) — как в Postgres.
        system_name_lc: 'ravenless 1',
        system_address: 10,
        market_id: 20,
        build_id: null,
        build_name: 'Первый порт',
        build_type: 'no_truss',
        status: 'active',
        commodities: { steel: 900 },
        resources: [],
        progress: 40,
        is_primary_port: false,
        source: 'helper',
        rc_state: 'unavailable',
        updated_at: '2026-11-09T10:00:00.000Z',
      }],
      journal: [{
        market_id: 20,
        system_name: 'Ravenless 1',
        construction_name: 'Первый порт',
        construction_progress: 55,
        resources_total: [{ Name: 'steel', RequiredAmount: 1000, ProvidedAmount: 550 }],
        event_timestamp: '2026-11-09T12:00:00.000Z',
      }],
      raven: [{
        system_name: 'Ravenless 1',
        updated_at: '2026-11-09T09:00:00.000Z',
        data: {
          projects: [{ buildId: 'b-1', marketId: 20, buildName: 'Первый порт', progress: 40 }],
        },
      }],
    });

    const response = await json(await mod.active.GET(
      request('GET', 'http://localhost/api/projects/active?system=Ravenless%201'),
    ));

    assert.equal(response.status, 200);
    assert.equal(response.body.projects.length, 1, 'одна площадка — один проект');
    const project = response.body.projects[0];
    assert.equal(project.buildId, 'b-1', 'buildId пришёл из кэша Raven');
    assert.deepEqual(project.commodities, { steel: 450 });
    assert.equal(project.progress, 55);
    assert.deepEqual(project.sources, ['site', 'journal', 'raven']);
    assert.equal(response.body.sources.site, 1);
    assert.equal(response.body.raven.cachedAt, '2026-11-09T09:00:00.000Z');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('активные проекты: закрытые стройки не попадают в список', async () => {
  const { mod, dir } = await buildRoutes();
  try {
    mod.reset({
      stored: [{
        project_key: '10:20',
        system_name: 'Ravenless 1',
        system_name_lc: 'ravenless 1',
        market_id: 20,
        build_name: 'Готовый порт',
        build_type: 'no_truss',
        status: 'complete',
        commodities: {},
        progress: 100,
        updated_at: '2026-11-01T10:00:00.000Z',
      }],
    });

    const list = await json(await mod.active.GET(
      request('GET', 'http://localhost/api/projects/active?system=Ravenless%201'),
    ));
    assert.equal(list.body.projects.length, 0);
    assert.match(list.body.warnings.join(' '), /no active projects/);

    const exact = await json(await mod.active.GET(
      request('GET', 'http://localhost/api/projects/active?market_id=20'),
    ));
    assert.equal(exact.body.projects.length, 1, 'по MarketID закрытый проект виден');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('регистрация проекта: без авторизации 401, без ключа площадки 400', async () => {
  const { mod, dir } = await buildRoutes();
  try {
    const anonymous = await json(await mod.register.POST(request(
      'POST', 'http://localhost/api/projects/register',
      { project: { systemAddress: 10, marketId: 20, buildName: 'Порт' } },
    )));
    assert.equal(anonymous.status, 401);

    mod.db.user = 'user-id';
    const empty = await json(await mod.register.POST(request(
      'POST', 'http://localhost/api/projects/register',
      { project: { buildName: 'Без адреса' } },
    )));
    assert.equal(empty.status, 400);
    assert.equal(mod.db.rpcCalls.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('регистрация проекта: остаток считается из депота и уходит в rpc', async () => {
  const { mod, dir } = await buildRoutes();
  try {
    mod.db.user = 'user-id';
    const response = await json(await mod.register.POST(request(
      'POST', 'http://localhost/api/projects/register',
      {
        cmdr: 'Jameson',
        rcState: 'unavailable',
        project: {
          systemName: 'Ravenless 1',
          systemAddress: 10,
          marketId: 20,
          buildName: 'Первый порт',
          buildType: 'no_truss',
          commodities: { steel: 1 },
          colonisationConstructionDepot: {
            ConstructionProgress: 0.4,
            Resources: [
              { Name: 'steel', RequiredAmount: 1000, ProvidedAmount: 750 },
              { Name: 'aluminium', RequiredAmount: 500, ProvidedAmount: 500 },
            ],
          },
        },
      },
    )));

    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.equal(mod.db.rpcCalls.length, 1);
    const [name, params] = mod.db.rpcCalls[0];
    assert.equal(name, 'construction_project_register');
    assert.equal(params.p_project.project_key, '10:20');
    assert.deepEqual(params.p_project.commodities, { steel: 250 });
    assert.equal(params.p_project.progress, 40);
    assert.equal(params.p_project.rc_state, 'unavailable');
    assert.equal(params.p_project.commander, 'Jameson');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
