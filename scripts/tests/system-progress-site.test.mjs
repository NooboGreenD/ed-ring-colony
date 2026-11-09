/**
 * Тесты /api/systems/progress?name= — страница системы при живом и мёртвом Raven.
 *
 * Главное обещание: сайт проекта — первичный источник. Если Raven Colonial
 * отвечает 503 (проверка токена RCC лежит у него самого), стройка, о которой
 * Helper уже сообщил сайту, всё равно видна на странице. Если Raven жив, его
 * данные показываются вместе с проектами, которых он ещё не знает.
 *
 * База и Raven — заглушки, маршрут собирается esbuild'ом (как остальные
 * route-тесты).
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
  site: [],
  raven: [],
  snapshots: [],
  mapSystem: [],
};

export function reset(rows = {}) {
  db.site = rows.site ?? [];
  db.raven = rows.raven ?? [];
  db.mapSystem = rows.mapSystem ?? [];
  db.snapshots = rows.snapshots ?? [];
}

function rowsFor(table) {
  if (table === 'construction_projects') return db.site;
  if (table === 'system_progress') return db.raven;
  if (table === 'construction_depot_snapshots') return db.snapshots;
  if (table === 'route_systems' || table === 'hubs') return db.mapSystem;
  return [];
}

function matches(row, filters) {
  return filters.every(([op, column, value]) => {
    const cell = row?.[column];
    if (op === 'eq') return String(cell) === String(value);
    if (op === 'in') return (value ?? []).map(String).includes(String(cell));
    if (op === 'ilike') {
      // Заглушка понимает простой шаблон %слово% — его и использует маршрут.
      const pattern = String(value).replace(/^%|%$/g, '').toLowerCase();
      return String(cell ?? '').toLowerCase().includes(pattern);
    }
    return true;
  });
}

function makeQuery(table) {
  const state = { filters: [], limit: null };
  const respond = () => {
    const rows = rowsFor(table).filter((row) => matches(row, state.filters));
    return { data: Number.isInteger(state.limit) ? rows.slice(0, state.limit) : rows, error: null };
  };
  const api = {
    select: () => api,
    eq: (column, value) => { state.filters.push(['eq', column, value]); return api; },
    in: (column, value) => { state.filters.push(['in', column, value]); return api; },
    ilike: (column, value) => { state.filters.push(['ilike', column, value]); return api; },
    order: () => api,
    limit: (value) => { state.limit = value; return api; },
    range: (from, to) => Promise.resolve({ data: respond().data.slice(from, to + 1), error: null }),
    update: () => api,
    upsert: async () => ({ error: null }),
    maybeSingle: async () => respond(),
    then: (resolve, reject) => Promise.resolve(respond()).then(resolve, reject),
  };
  return api;
}

export function createClient() { return createServiceClient(); }

export function createServiceClient() {
  return { from: (table) => makeQuery(table), rpc: async () => ({ data: null, error: null }) };
}
`;

const RAVEN_STUB = `
export const state = { response: null };

export function reset(response) { state.response = response; }

export async function fetchRavenSystemProgress(name) {
  const response = state.response;
  if (!response) {
    return {
      system_name: name,
      progress: null,
      status: 'planned',
      found: false,
      updated_at: null,
      data: null,
      error: 'Raven Colonial: 503 Service Unavailable',
    };
  }
  return response;
}

export function deriveStatusFromProgress(progress) {
  if (progress == null) return 'planned';
  if (progress >= 100) return 'done';
  if (progress > 0) return 'building';
  return 'planned';
}
`;

const DEPOT_STUB = `
export function enrichRavenSystemWithJournalSnapshots(details) { return details; }
`;

const API_T_STUB = `
export async function apiTranslate() {
  return (key, vars = {}) => {
    const text = key === 'api.siteProjectShown'
      ? '{error} Показаны данные сайта проекта.'
      : key;
    return String(text).replace(/\\{(\\w+)\\}/g, (_, name) => String(vars[name] ?? ''));
  };
}
`;

async function buildRoute() {
  const dir = mkdtempSync(join(ROOT, '.tmp-system-progress-'));
  writeFileSync(join(dir, 'next-server.mjs'), NEXT_SERVER_STUB);
  writeFileSync(join(dir, 'supabase.mjs'), SUPABASE_STUB);
  writeFileSync(join(dir, 'raven.mjs'), RAVEN_STUB);
  writeFileSync(join(dir, 'depot.mjs'), DEPOT_STUB);
  writeFileSync(join(dir, 'api-t.mjs'), API_T_STUB);

  const entry = join(dir, 'entry.ts');
  writeFileSync(
    entry,
    "export * as progress from '@/app/api/systems/progress/route';\n"
    + "export { db, reset } from './supabase.mjs';\n"
    + "export { reset as resetRaven } from './raven.mjs';\n",
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
      '@/lib/ravenColonial': join(dir, 'raven.mjs'),
      '@/lib/ravenDepotSnapshots': join(dir, 'depot.mjs'),
      '@/lib/i18n/apiT': join(dir, 'api-t.mjs'),
      '@': join(ROOT, 'src'),
    },
    loader: { '.ts': 'ts', '.tsx': 'tsx' },
    logLevel: 'silent',
  });

  const mod = await import(bundle);
  mod.reset();
  mod.resetRaven(null);
  return { mod, dir };
}

const request = (url) => new Request(url);
const json = async (response) => ({ status: response.status, body: await response.json() });

const SYSTEM = 'Ravenless 1';

function siteRow(overrides = {}) {
  return {
    project_key: '10:20',
    system_name: SYSTEM,
    system_name_lc: SYSTEM.toLowerCase(),
    system_address: 10,
    market_id: 20,
    build_id: null,
    build_name: 'Первый порт',
    build_type: 'no_truss',
    body_name: `${SYSTEM} 2`,
    architect_name: 'Jameson',
    status: 'active',
    commodities: { steel: 900 },
    max_need: 1000,
    resources: [
      { Name: 'steel', RequiredAmount: 1000, ProvidedAmount: 100 },
      { Name: 'aluminium', RequiredAmount: 500, ProvidedAmount: 200 },
    ],
    progress: 20,
    is_primary_port: false,
    source: 'helper',
    rc_state: 'unavailable',
    updated_at: '2026-11-09T10:00:00.000Z',
    ...overrides,
  };
}

maybe('Raven отвечает 503: страница показывает стройку с сайта', async () => {
  const { mod, dir } = await buildRoute();
  try {
    mod.reset({ site: [siteRow()] });
    const response = await json(await mod.progress.GET(
      request(`http://localhost/api/systems/progress?name=${encodeURIComponent(SYSTEM)}`),
    ));

    assert.equal(response.status, 200);
    const body = response.body;
    assert.equal(body.found, true, 'стройка найдена, хотя Raven лежит');
    assert.equal(body.projects.length, 1);
    const project = body.projects[0];
    assert.equal(project.buildName, 'Первый порт');
    assert.equal(project.complete, false);
    assert.equal(project.totalRequired, 1500, 'объём взят из точных строк депота');
    assert.equal(project.totalProvided, 300);
    assert.equal(project.totalRemaining, 1200);
    assert.equal(project.resources.length, 2);
    assert.equal(body.totalRequired, 1500);
    assert.equal(body.totalRemaining, 1200);
    assert.equal(body.progress, 20);
    assert.match(body.error, /503/, 'причина недоступности Raven не скрывается');
    assert.match(body.error, /сайта проекта/, 'страница говорит, откуда данные');
    assert.equal(body.siteProjects, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('Raven жив, но про систему ничего не знает: показывается сайт', async () => {
  const { mod, dir } = await buildRoute();
  try {
    mod.reset({ site: [siteRow()] });
    mod.resetRaven({
      system_name: SYSTEM,
      progress: null,
      status: 'planned',
      found: true,
      updated_at: '2026-11-09T11:00:00.000Z',
      data: { projects: [], resources: [] },
      error: null,
    });

    const { body } = await json(await mod.progress.GET(
      request(`http://localhost/api/systems/progress?name=${encodeURIComponent(SYSTEM)}`),
    ));
    assert.equal(body.projects.length, 1, 'проект сайта не потерян');
    assert.equal(body.projects[0].buildName, 'Первый порт');
    assert.equal(body.error, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('Raven жив и знает проект: его данные не дублируются сайтом', async () => {
  const { mod, dir } = await buildRoute();
  try {
    mod.reset({
      site: [
        siteRow(),
        // Второй проект Helper успел записать только на сайт.
        siteRow({
          project_key: '10:21',
          market_id: 21,
          build_name: 'Второй аванпост',
          resources: [{ Name: 'titanium', RequiredAmount: 400, ProvidedAmount: 0 }],
          commodities: { titanium: 400 },
          updated_at: '2026-11-09T10:30:00.000Z',
        }),
      ],
    });
    mod.resetRaven({
      system_name: SYSTEM,
      progress: 15,
      status: 'building',
      found: true,
      updated_at: '2026-11-09T12:00:00.000Z',
      data: {
        projects: [{ buildId: 'b-1', marketId: 20, buildName: 'Первый порт', progress: 15 }],
        resources: [{ key: 'steel', name: 'Steel', required: null, provided: null, remaining: 900, exact: false }],
        totalRemaining: 900,
      },
      error: null,
    });

    const { body } = await json(await mod.progress.GET(
      request(`http://localhost/api/systems/progress?name=${encodeURIComponent(SYSTEM)}`),
    ));
    assert.equal(body.projects.length, 2, 'Raven-проект один плюс сайтовый, без дубля');
    assert.deepEqual(
      body.projects.map((project) => project.buildName).sort(),
      ['Второй аванпост', 'Первый порт'],
    );
    assert.equal(body.progress, 15, 'проценты взяты у Raven');
    assert.equal(body.siteProjects, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('ни сайта, ни Raven: страница честно говорит, что данных нет', async () => {
  const { mod, dir } = await buildRoute();
  try {
    mod.reset({});
    const { body } = await json(await mod.progress.GET(
      request(`http://localhost/api/systems/progress?name=${encodeURIComponent('Пустая 9')}`),
    ));
    assert.equal(body.found, false);
    assert.deepEqual(body.projects, []);
    assert.match(body.error, /503/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
