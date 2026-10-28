/**
 * `/api/systems/route-hint` — маленькая подсказка для оверлея Route: идёт ли в
 * следующей системе стройка (процент) и кто её открыл.
 *
 * Проверяем два уровня: чистые функции (`shapeDiscovery`, `shapeConstruction`)
 * и сам маршрут — с заглушкой базы, чтобы не ходить ни в Supabase, ни в Raven.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { bundleFile } from './helpers/bundle.mjs';
import { buildRouteHint, shapeConstruction, shapeDiscovery } from '../../src/lib/routeHint.ts';

let esbuild = null;
try {
  esbuild = await import('esbuild');
} catch {
  // devDependencies не установлены — пропускаем маршрутную часть.
}
const maybe = esbuild ? test : test.skip;

function scan(overrides = {}) {
  return {
    body_name: 'Test A 1',
    body_type: 'Planet',
    distance_ls: 1200,
    first_discovered_by: null,
    first_mapped_by: null,
    first_footfall_by: null,
    updated_at: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

test('системы нет в базе проекта — «ещё не исследована», без выдуманного имени', () => {
  const discovery = shapeDiscovery([]);
  assert.equal(discovery.known, false);
  assert.equal(discovery.discoverer, null);
  assert.equal(discovery.bodies, 0);
});

test('первооткрыватель берётся у главной звезды, а не у случайного тела', () => {
  const discovery = shapeDiscovery([
    scan({ body_name: 'Test A 4', distance_ls: 4200, first_discovered_by: 'CMDR Planet' }),
    scan({ body_name: 'Test A', body_type: 'Star', distance_ls: 0, first_discovered_by: 'CMDR Star' }),
  ]);
  assert.equal(discovery.known, true);
  assert.equal(discovery.discoverer, 'CMDR Star');
  assert.equal(discovery.bodies, 2);
});

test('если первооткрыватель неизвестен — так и говорим, имя не придумываем', () => {
  const discovery = shapeDiscovery([scan(), scan({ first_mapped_by: 'CMDR Map' })]);
  assert.equal(discovery.known, true);
  assert.equal(discovery.discoverer, null);
  assert.equal(discovery.mapped, 1);
});

test('счётчики картографии и следов считаются по телам', () => {
  const discovery = shapeDiscovery([
    scan({ first_mapped_by: 'A', first_footfall_by: 'B' }),
    scan({ first_mapped_by: 'A' }),
    scan(),
  ]);
  assert.equal(discovery.mapped, 2);
  assert.equal(discovery.footfall, 1);
  assert.equal(discovery.updatedAt, '2026-10-01T00:00:00.000Z');
});

test('стройка: процент, статус и остаток тонн', () => {
  const building = shapeConstruction({
    systemName: 'Test A',
    key: 'test a',
    status: 'building',
    progress: 42.7,
    sitesComplete: 0,
    sitesActive: 1,
    remaining: 12345.6,
    needs: [{ label: 'Сталь', remaining: 5000.4 }],
    ravenUpdatedAt: '2026-10-20T10:00:00.000Z',
    journalUpdatedAt: null,
  });
  assert.equal(building.known, true);
  assert.equal(building.status, 'building');
  assert.equal(building.progress, 43);
  assert.equal(building.remaining, 12346);
  assert.deepEqual(building.needs, [{ label: 'Сталь', remaining: 5000 }]);
  assert.equal(building.updatedAt, '2026-10-20T10:00:00.000Z');
});

test('стройка: завершённая, запланированная и неизвестная различаются', () => {
  const done = shapeConstruction({ status: 'done', progress: 100, sitesComplete: 2, sitesActive: 0 });
  assert.equal(done.status, 'done');
  const planned = shapeConstruction({ status: 'planned', progress: 0, sitesComplete: 0, sitesActive: 0 });
  assert.equal(planned.status, 'planned');
  const none = shapeConstruction(null);
  assert.equal(none.known, false);
  assert.equal(none.status, 'unknown');
});

test('сборка ответа: имена полей — контракт оверлея', () => {
  const hint = buildRouteHint('Test A', {
    progress: { status: 'building', progress: 10, sitesActive: 1 },
    scans: [scan({ first_discovered_by: 'CMDR Star', body_type: 'Star', distance_ls: 0 })],
  });
  assert.equal(hint.ok, true);
  assert.equal(hint.system, 'Test A');
  assert.equal(hint.construction.progress, 10);
  assert.equal(hint.discovery.discoverer, 'CMDR Star');
});

/* ── маршрут ───────────────────────────────────────────────────────────── */

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';

const NEXT_SERVER_STUB = `
export const NextResponse = {
  json: (body, init) =>
    new Response(JSON.stringify(body), {
      status: (init && init.status) || 200,
      headers: { 'content-type': 'application/json', ...((init && init.headers) || {}) },
    }),
};
`;

const SUPABASE_STUB = `
export const db = { scans: [], scansError: null };
export function reset() { db.scans = []; db.scansError = null; }

function makeQuery() {
  const api = {
    select: () => api,
    ilike: () => api,
    order: () => api,
    limit: () => api,
    then: (resolve, reject) => Promise.resolve({ data: db.scans, error: db.scansError }).then(resolve, reject),
  };
  return api;
}

export const supabaseAdmin = { from: () => makeQuery() };
export function createServiceClient() { return supabaseAdmin; }
export async function createClient() { return supabaseAdmin; }
export async function authFromRequest() { return { user: null }; }
`;

const PROGRESS_STUB = `
export const progressBySystem = new Map();
export async function loadSystemsProgress(_svc, names) {
  return Array.from(names).map((name) => progressBySystem.get(name.toLowerCase()))
    .filter(Boolean);
}
`;

const ENTRY = "export * as route from '@/app/api/systems/route-hint/route';\n"
  + "export { db, reset } from '@/lib/supabaseServer';\n"
  + "export { progressBySystem } from '@/lib/systemOverview';\n";

async function buildRoute() {
  const bundle = await bundleFile({
    entrySource: ENTRY,
    stubs: {
      'next/server': NEXT_SERVER_STUB,
      '@/lib/supabaseServer': SUPABASE_STUB,
      '@/lib/supabaseAdmin': SUPABASE_STUB,
      '@/lib/systemOverview': PROGRESS_STUB,
    },
  });
  const mod = await import(bundle);
  mod.reset();
  mod.progressBySystem.clear();
  return { mod };
}

maybe('/api/systems/route-hint отдаёт стройку и первооткрывателя', async () => {
  const { mod } = await buildRoute();
  mod.progressBySystem.set('test a', {
    systemName: 'Test A', key: 'test a', status: 'building', progress: 55,
    sitesComplete: 0, sitesActive: 1, remaining: 100, needs: [],
    ravenUpdatedAt: null, journalUpdatedAt: '2026-10-21T00:00:00.000Z',
  });
  mod.db.scans = [scan({ body_type: 'Star', distance_ls: 0, first_discovered_by: 'CMDR Star' })];

  const response = await mod.route.GET(new Request('https://site.test/api/systems/route-hint?name=Test%20A'));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.system, 'Test A');
  assert.equal(body.construction.status, 'building');
  assert.equal(body.construction.progress, 55);
  assert.equal(body.discovery.discoverer, 'CMDR Star');
  assert.match(response.headers.get('cache-control') || '', /max-age=60/);
});

maybe('/api/systems/route-hint: система не в базе — known=false, а не ошибка', async () => {
  const { mod } = await buildRoute();
  const response = await mod.route.GET(new Request('https://site.test/api/systems/route-hint?name=Empty%20One'));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.discovery.known, false);
  assert.equal(body.construction.known, false);
  assert.equal(body.construction.status, 'unknown');
});

maybe('/api/systems/route-hint без имени отвечает 400', async () => {
  const { mod } = await buildRoute();
  const response = await mod.route.GET(new Request('https://site.test/api/systems/route-hint'));
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.ok, false);
});

maybe('/api/systems/route-hint переживает сбой базы тел: стройка всё равно отдаётся', async () => {
  const { mod } = await buildRoute();
  mod.progressBySystem.set('test b', {
    systemName: 'Test B', key: 'test b', status: 'done', progress: 100,
    sitesComplete: 1, sitesActive: 0, remaining: 0, needs: [],
    ravenUpdatedAt: null, journalUpdatedAt: null,
  });
  mod.db.scans = null;
  mod.db.scansError = { message: 'boom' };

  const response = await mod.route.GET(new Request('https://site.test/api/systems/route-hint?name=Test%20B'));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.construction.status, 'done');
  assert.equal(body.discovery.known, false);
});
