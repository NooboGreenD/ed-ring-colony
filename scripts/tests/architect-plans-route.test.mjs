/**
 * Тесты маршрутов «Архитектора»: хранение планов, публикация и «где купить».
 *
 * Как и `logs-upload-route.test.mjs`, маршруты импортируются настоящими:
 * esbuild собирает их с подменой `next/server`, `@/lib/supabaseServer` и
 * `@/lib/galaxySystemsDb`, поэтому проверяется тот код, который отвечает на
 * запрос, а не его пересказ. База в заглушке запоминает запросы — по ним видно,
 * какие фильтры действительно ушли в Supabase и что сервер посчитал сам.
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
  user: { id: 'author-id' },
  rows: [],
  single: null,
  error: null,
  queries: [],
  inserted: [],
  updated: [],
  deleted: [],
};

export function reset() {
  db.user = { id: 'author-id' };
  db.rows = [];
  db.single = null;
  db.error = null;
  db.queries.length = 0;
  db.inserted.length = 0;
  db.updated.length = 0;
  db.deleted.length = 0;
}

function makeQuery(table) {
  const record = { table, verb: null, filters: [], orders: [], limitValue: null, orFilter: null };
  db.queries.push(record);
  const respond = () => ({ data: record.single || record.verb === 'select' ? db.single ?? db.rows : db.rows, error: db.error });
  const api = {
    select: () => { record.verb = record.verb || 'select'; return api; },
    insert: (row) => { record.verb = 'insert'; db.inserted.push(row); return api; },
    update: (row) => { record.verb = 'update'; db.updated.push(row); return api; },
    delete: () => { record.verb = 'delete'; db.deleted.push(record); return api; },
    upsert: (row) => { record.verb = 'upsert'; db.inserted.push(row); return api; },
    eq: (column, value) => { record.filters.push(['eq', column, value]); return api; },
    neq: (column, value) => { record.filters.push(['neq', column, value]); return api; },
    gt: (column, value) => { record.filters.push(['gt', column, value]); return api; },
    in: (column, value) => { record.filters.push(['in', column, value]); return api; },
    ilike: (column, value) => { record.filters.push(['ilike', column, value]); return api; },
    or: (expr) => { record.orFilter = expr; return api; },
    order: (column, options) => { record.orders.push([column, options]); return api; },
    limit: (value) => { record.limitValue = value; return api; },
    single: async () => { record.single = true; return respond(); },
    maybeSingle: async () => { record.single = true; return respond(); },
    then: (resolve, reject) => Promise.resolve(respond()).then(resolve, reject),
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

const GALAXY_STUB = `
export const galaxy = { calls: [], systems: new Map(), origin: null };
export async function findSystemByName(name) { galaxy.calls.push(['byName', name]); return galaxy.origin; }
export async function findSystemsByNames(names) {
  galaxy.calls.push(['byNames', names]);
  const found = new Map();
  for (const name of names) {
    const row = galaxy.systems.get(String(name).toLowerCase());
    if (row) found.set(String(name).toLowerCase(), row);
  }
  return found;
}
`;

async function buildRoutes() {
  const dir = mkdtempSync(join(ROOT, '.tmp-architect-route-'));
  writeFileSync(join(dir, 'next-server.mjs'), NEXT_SERVER_STUB);
  writeFileSync(join(dir, 'supabase.mjs'), SUPABASE_STUB);
  writeFileSync(join(dir, 'galaxy.mjs'), GALAXY_STUB);

  const entry = join(dir, 'entry.ts');
  writeFileSync(
    entry,
    "export * as plans from '@/app/api/architect/plans/route';\n"
    + "export * as planById from '@/app/api/architect/plans/[id]/route';\n"
    + "export * as sourcing from '@/app/api/architect/sourcing/route';\n"
    + "export { db, reset } from './supabase.mjs';\n"
    + "export { galaxy } from './galaxy.mjs';\n",
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
      '@/lib/galaxySystemsDb': join(dir, 'galaxy.mjs'),
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

function samplePlan(system = 'HIP 90297') {
  return {
    version: 1,
    system,
    architect: 'CMDR Tester',
    createdAt: '2026-09-25T09:00:00.000Z',
    updatedAt: '2026-09-25T09:00:00.000Z',
    notes: '',
    sites: [
      { id: 's1', bodyName: `${system} A`, installationId: 'no_truss', status: 'plan' },
      { id: 's2', bodyName: `${system} A 1`, installationId: 'consus', status: 'plan' },
    ],
  };
}

maybe('список планов: без системы 400, гость видит только публичные', async () => {
  const { mod, dir } = await buildRoutes();
  try {
    const bad = await json(await mod.plans.GET(request('GET', 'http://localhost/api/architect/plans')));
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /system parameter is required/);

    mod.db.user = null;
    mod.db.rows = [];
    const guest = await json(await mod.plans.GET(request('GET', 'http://localhost/api/architect/plans?system=HIP%2090297')));
    assert.equal(guest.status, 200);
    assert.deepEqual(guest.body.plans, []);
    const query = mod.db.queries.find((item) => item.table === 'system_plans');
    assert.deepEqual(query.filters, [['eq', 'system_name_lc', 'hip 90297'], ['eq', 'visibility', 'public']]);
    assert.equal(query.orFilter, null, 'гостю «по ссылке» в список не отдаётся');
    assert.equal(query.limitValue, 50);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('список планов: автор видит свои приватные через or-фильтр', async () => {
  const { mod, dir } = await buildRoutes();
  try {
    mod.db.rows = [{
      id: 'plan-1',
      system_name: 'HIP 90297',
      title: '',
      author_id: 'author-id',
      author_name: 'CMDR Tester',
      visibility: 'private',
      catalogue_version: 3,
      site_count: 2,
      haul_tons: 56_562,
      score: 9,
      tier2_points: 1,
      tier3_points: 1,
      updated_at: '2026-09-25T10:00:00.000Z',
    }];
    const response = await json(await mod.plans.GET(request('GET', 'http://localhost/api/architect/plans?system=HIP 90297')));
    assert.equal(response.status, 200);
    const query = mod.db.queries.find((item) => item.table === 'system_plans');
    assert.equal(query.orFilter, 'visibility.eq.public,author_id.eq.author-id');
    assert.equal(response.body.count, 1);
    assert.equal(response.body.plans[0].haulTons, 56_562);
    assert.equal(response.body.plans[0].own, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('сохранение плана: без входа 401, битый план 400, сводные числа считает сервер', async () => {
  const { mod, dir } = await buildRoutes();
  try {
    mod.db.user = null;
    const anonymous = await json(await mod.plans.POST(request('POST', 'http://localhost/api/architect/plans', {
      system: 'HIP 90297',
      plan: samplePlan(),
    })));
    assert.equal(anonymous.status, 401);

    mod.reset();
    const broken = await json(await mod.plans.POST(request('POST', 'http://localhost/api/architect/plans', {
      system: 'HIP 90297',
      plan: { sites: 'не список' },
    })));
    assert.equal(broken.status, 400);
    assert.match(broken.body.error, /sites должно быть списком/);

    mod.reset();
    mod.db.single = {
      id: 'plan-9',
      system_name: 'HIP 90297',
      author_id: 'author-id',
      author_name: 'CMDR Tester',
      visibility: 'public',
      site_count: 2,
      haul_tons: 56_562,
      score: 9,
      tier2_points: 1,
      tier3_points: 1,
      catalogue_version: 3,
      updated_at: '2026-09-25T10:00:00.000Z',
    };
    const created = await json(await mod.plans.POST(request('POST', 'http://localhost/api/architect/plans', {
      system: 'HIP 90297',
      title: 'Первая очередь',
      visibility: 'public',
      // Клиент пытается нарисовать себе «оценку 999» и чужого автора.
      plan: { ...samplePlan(), score: 999, author: 'Не я' },
    })));

    assert.equal(created.status, 201);
    assert.equal(created.body.plan.id, 'plan-9');
    const inserted = mod.db.inserted[0];
    assert.equal(inserted.system_name, 'HIP 90297');
    assert.equal(inserted.author_id, 'author-id');
    assert.equal(inserted.visibility, 'public');
    assert.equal(inserted.title, 'Первая очередь');
    assert.equal(inserted.score, 9, 'оценка посчитана движком, а не взята из тела запроса');
    assert.equal(inserted.haul_tons, 56_562);
    assert.equal(inserted.site_count, 2);
    assert.equal(typeof inserted.published_at, 'string');
    assert.equal(inserted.plan.sites.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('сохранение плана: слишком большой план отклоняется', async () => {
  const { mod, dir } = await buildRoutes();
  try {
    const sites = Array.from({ length: 201 }, (_, index) => ({
      id: `s${index}`,
      bodyName: 'HIP 90297 A 1',
      installationId: 'consus',
      status: 'plan',
    }));
    const response = await json(await mod.plans.POST(request('POST', 'http://localhost/api/architect/plans', {
      system: 'HIP 90297',
      plan: { ...samplePlan(), sites },
    })));
    assert.equal(response.status, 400);
    assert.match(response.body.error, /максимум 200 построек/);
    assert.equal(mod.db.inserted.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('план по ссылке: чужой приватный план выглядит как отсутствующий', async () => {
  const { mod, dir } = await buildRoutes();
  try {
    mod.db.single = null;
    const missing = await json(await mod.planById.GET(
      request('GET', 'http://localhost/api/architect/plans/plan-1'),
      { params: Promise.resolve({ id: 'plan-1' }) },
    ));
    assert.equal(missing.status, 404);

    mod.db.single = {
      id: 'plan-1',
      system_name: 'HIP 90297',
      author_id: 'author-id',
      author_name: 'CMDR Tester',
      visibility: 'unlisted',
      plan: samplePlan(),
      catalogue_version: 3,
      site_count: 2,
      haul_tons: 56_562,
      score: 9,
      tier2_points: 1,
      tier3_points: 1,
      published_at: '2026-09-25T10:00:00.000Z',
      updated_at: '2026-09-25T10:00:00.000Z',
    };
    const found = await json(await mod.planById.GET(
      request('GET', 'http://localhost/api/architect/plans/plan-1'),
      { params: Promise.resolve({ id: 'plan-1' }) },
    ));
    assert.equal(found.status, 200);
    assert.equal(found.body.plan.visibility, 'unlisted');
    assert.equal(found.body.draft.sites.length, 2, 'по ссылке отдаётся и сам план — его можно забрать себе');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('обновление плана: чужой план менять нельзя, свой — с новой сводкой', async () => {
  const { mod, dir } = await buildRoutes();
  try {
    mod.db.single = {
      id: 'plan-1',
      system_name: 'HIP 90297',
      author_id: 'someone-else',
      visibility: 'public',
      plan: samplePlan(),
      published_at: '2026-09-25T08:00:00.000Z',
    };
    const forbidden = await json(await mod.planById.PUT(
      request('PUT', 'http://localhost/api/architect/plans/plan-1', { visibility: 'private' }),
      { params: Promise.resolve({ id: 'plan-1' }) },
    ));
    assert.equal(forbidden.status, 403);
    assert.equal(mod.db.updated.length, 0);

    mod.db.single = { ...mod.db.single, author_id: 'author-id' };
    const updated = await json(await mod.planById.PUT(
      request('PUT', 'http://localhost/api/architect/plans/plan-1', { visibility: 'unlisted', title: 'Черновик' }),
      { params: Promise.resolve({ id: 'plan-1' }) },
    ));
    assert.equal(updated.status, 200);
    const patch = mod.db.updated[0];
    assert.equal(patch.visibility, 'unlisted');
    assert.equal(patch.title, 'Черновик');
    assert.equal(patch.published_at, '2026-09-25T08:00:00.000Z', 'дата первой публикации сохраняется');
    assert.equal(patch.haul_tons, 56_562, 'сводка пересчитана по сохранённому плану');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('удаление плана требует входа', async () => {
  const { mod, dir } = await buildRoutes();
  try {
    mod.db.user = null;
    const anonymous = await json(await mod.planById.DELETE(
      request('DELETE', 'http://localhost/api/architect/plans/plan-1'),
      { params: Promise.resolve({ id: 'plan-1' }) },
    ));
    assert.equal(anonymous.status, 401);

    mod.reset();
    const removed = await json(await mod.planById.DELETE(
      request('DELETE', 'http://localhost/api/architect/plans/plan-1'),
      { params: Promise.resolve({ id: 'plan-1' }) },
    ));
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.body, { ok: true, id: 'plan-1' });
    assert.equal(mod.db.deleted[0].table, 'system_plans');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('«где купить»: запрос к базе цен и раскладка по станциям', async () => {
  const { mod, dir } = await buildRoutes();
  try {
    mod.galaxy.origin = { name: 'HIP 90297', x: 0, y: 0, z: 0 };
    mod.galaxy.systems.set('near', { name: 'Near', x: 5, y: 0, z: 0 });
    mod.db.rows = [
      { station_name: 'Alpha Station', system_name: 'Near', commodity_name: '$Steel_Name;', sell_price: 500, stock: 900, reported_at: new Date().toISOString() },
      { station_name: 'Alpha Station', system_name: 'Near', commodity_name: 'Titanium', sell_price: 1200, stock: 400, reported_at: new Date().toISOString() },
      { station_name: 'Other', system_name: 'Near', commodity_name: 'Wine', sell_price: 900, stock: 10, reported_at: new Date().toISOString() },
    ];

    const badRequest = await json(await mod.sourcing.POST(request('POST', 'http://localhost/api/architect/sourcing', {
      cargo: { steel: 100 },
    })));
    assert.equal(badRequest.status, 400);
    assert.match(badRequest.body.error, /system parameter is required/);

    const response = await json(await mod.sourcing.POST(request('POST', 'http://localhost/api/architect/sourcing', {
      system: 'HIP 90297',
      cargo: { steel: 1000, titanium: 300, Wine: 5 },
      options: { capacityTons: 400 },
    })));

    assert.equal(response.status, 200);
    assert.equal(response.body.source, 'db');
    assert.equal(response.body.originFound, true);
    assert.equal(response.body.empty, false);

    // Запрос к базе цен: точное совпадение по вариантам имени, только сток > 0.
    const pricesQuery = mod.db.queries.find((item) => item.table === 'market_prices');
    const variants = pricesQuery.filters.find((filter) => filter[0] === 'in')[2];
    assert.ok(variants.includes('$steel_name;'), 'игровой токен EDDN участвует в поиске');
    assert.ok(variants.includes('Steel'), 'человеческое имя тоже ищем');
    assert.ok(variants.some((item) => String(item).toLowerCase() === 'wine'), 'вино из плана тоже ищем');
    assert.deepEqual(pricesQuery.filters.find((filter) => filter[0] === 'gt'), ['gt', 'stock', 0]);

    // Координаты запрошены и у целевой системы, и у систем из выдачи.
    assert.ok(mod.galaxy.calls.some((call) => call[0] === 'byName' && call[1] === 'HIP 90297'));
    assert.ok(mod.galaxy.calls.some((call) => call[0] === 'byNames'));

    const steel = response.body.plan.commodities.find((item) => item.key === 'steel');
    assert.equal(steel.coveredTons, 900, 'на рынке только 900 т — остаток честно не закрыт');
    assert.equal(steel.remainingTons, 100);
    assert.equal(response.body.plan.summary.stationCount, 2, 'вино лежит на другой станции');
    assert.equal(response.body.plan.summary.neededTons, 1305);
    assert.equal(response.body.plan.summary.coveredTons, 1205);
    assert.equal(response.body.plan.summary.coveragePercent, 92.3);
    assert.equal(response.body.plan.summary.trips, 4, '3 рейса на сталь и титан + 1 на вино');
    assert.equal(response.body.plan.stops[0].totalTons, 1200);
    assert.equal(response.body.plan.stops[0].distanceLy, 5);
    assert.equal(response.body.plan.stops[0].items.length, 2);
    assert.equal(response.body.plan.stops[1].items[0].key, 'wine');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('«где купить»: пустая база честно возвращает нулевое покрытие', async () => {
  const { mod, dir } = await buildRoutes();
  try {
    mod.galaxy.origin = null;
    mod.db.rows = [];
    const response = await json(await mod.sourcing.POST(request('POST', 'http://localhost/api/architect/sourcing', {
      system: 'HIP 90297',
      cargo: { steel: 500 },
    })));
    assert.equal(response.status, 200);
    assert.equal(response.body.empty, true);
    assert.equal(response.body.originFound, false);
    assert.equal(response.body.plan.summary.coveredTons, 0);
    assert.equal(response.body.plan.summary.remainingTons, 500);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
