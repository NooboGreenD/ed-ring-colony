/**
 * Тесты маршрута /api/leaderboard/stats — блоки «самые застроенные системы»
 * и «топ-10 архитекторов» для лидерборда.
 *
 * Маршрут собирается настоящим (esbuild подменяет только next/server и
 * supabase-клиент), база — заглушка: она применяет eq/gte/in-фильтры,
 * сортировку и range-срезки, как PostgREST, так что проверяется логика
 * агрегации с учётом страничности чтения.
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

// Заглушки ставим принудительно: `??=` оставил бы «настоящие» значения из
// build-args web-образа (ENV шага `npm test` в docker build) — тест не герметичен.
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
  deliveries: [],
  system_plans: [],
  system_progress: [],
  system_architects: [],
  error: null,
  queries: [],
};

export function reset() {
  db.deliveries = [];
  db.system_plans = [];
  db.system_progress = [];
  db.system_architects = [];
  db.error = null;
  db.queries.length = 0;
}

function applyFilters(rows, filters) {
  return rows.filter((row) => filters.every(([op, column, value]) => {
    if (op === 'eq') return row?.[column] === value;
    if (op === 'gte') return String(row?.[column] ?? '') >= String(value);
    if (op === 'in') return Array.isArray(value) && value.includes(row?.[column]);
    return true;
  }));
}

function makeQuery(table) {
  const record = { table, filters: [], orders: [], rangeValue: null };
  db.queries.push(record);
  const respond = () => {
    let rows = applyFilters(db[table] ?? [], record.filters);
    for (const [column, options] of [...record.orders].reverse()) {
      const asc = options?.ascending !== false;
      rows = [...rows].sort((a, b) => {
        const left = a?.[column];
        const right = b?.[column];
        const cmp = typeof left === 'number' && typeof right === 'number'
          ? left - right
          : String(left ?? '').localeCompare(String(right ?? ''));
        return asc ? cmp : -cmp;
      });
    }
    if (record.rangeValue) rows = rows.slice(record.rangeValue[0], record.rangeValue[1] + 1);
    return { data: rows, error: db.error };
  };
  const api = {
    select: () => api,
    eq: (column, value) => { record.filters.push(['eq', column, value]); return api; },
    gte: (column, value) => { record.filters.push(['gte', column, value]); return api; },
    in: (column, value) => { record.filters.push(['in', column, value]); return api; },
    order: (column, options) => { record.orders.push([column, options]); return api; },
    range: (from, to) => { record.rangeValue = [from, to]; return api; },
    limit: () => api,
    single: async () => ({ data: respond().data[0] ?? null, error: db.error }),
    maybeSingle: async () => ({ data: respond().data[0] ?? null, error: db.error }),
    then: (resolve, reject) => Promise.resolve(respond()).then(resolve, reject),
  };
  return api;
}

const client = () => ({
  auth: { getUser: async () => ({ data: { user: null }, error: null }) },
  from: (table) => makeQuery(table),
});

export function createClient() { return client(); }
export function createServiceClient() { return client(); }
`;

async function buildRoutes() {
  const dir = mkdtempSync(join(ROOT, '.tmp-leaderboard-stats-'));
  writeFileSync(join(dir, 'next-server.mjs'), NEXT_SERVER_STUB);
  writeFileSync(join(dir, 'supabase.mjs'), SUPABASE_STUB);

  const entry = join(dir, 'entry.ts');
  writeFileSync(
    entry,
    "export * as stats from '@/app/api/leaderboard/stats/route';\n"
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
      '@': join(ROOT, 'src'),
    },
    loader: { '.ts': 'ts', '.tsx': 'tsx' },
    logLevel: 'silent',
  });

  const mod = await import(bundle);
  mod.reset();
  return { mod, dir };
}

const json = async (response) => ({ status: response.status, body: await response.json() });

maybe('самые застроенные системы: тоннаж суммируется без учёта регистра, топ-10', async () => {
  const { mod, dir } = await buildRoutes();
  try {
    const fresh = new Date().toISOString();
    mod.db.deliveries = [
      // Одна система с разным регистром — должна склеиться в одну строку.
      { id: 1, user_id: 'u1', system_name: 'HIP 90297', amount: 500, delivered_at: fresh },
      { id: 2, user_id: 'u2', system_name: 'hip 90297', amount: 1500, delivered_at: fresh },
      { id: 3, user_id: 'u2', system_name: 'Sol', amount: 700, delivered_at: fresh },
      // Нулевые/битые поставки рейтинг не двигают.
      { id: 4, user_id: 'u3', system_name: 'Sol', amount: 0, delivered_at: fresh },
    ];
    // Ещё девять систем, чтобы проверить границу «топ-10».
    for (let index = 0; index < 10; index += 1) {
      mod.db.deliveries.push({
        id: 100 + index,
        user_id: 'u4',
        system_name: `Tick System ${index + 1}`,
        amount: 10 + index,
        delivered_at: fresh,
      });
    }
    mod.db.system_progress = [
      { system_name: 'HIP 90297', progress: 75 },
      { system_name: 'Sol', progress: 100 },
    ];

    const response = await json(await mod.stats.GET(new Request('http://localhost/api/leaderboard/stats?period=all')));
    assert.equal(response.status, 200);
    assert.equal(response.body.builtSystems.length, 10, 'выдача ограничена топ-10');
    const [first, second] = response.body.builtSystems;
    assert.equal(first.system_name, 'HIP 90297');
    assert.equal(first.total_amount, 2000, 'поставки с разным регистром сложились вместе');
    assert.equal(first.pilots, 2);
    assert.equal(first.deliveries_count, 2);
    assert.equal(first.progress, 75);
    assert.equal(first.status, 'building');
    assert.equal(first.rank, 1);
    assert.equal(second.system_name, 'Sol');
    assert.equal(second.total_amount, 700);
    assert.equal(second.status, 'done');
    // Название не встречалось в кэше прогресса — честный null, а не ноль.
    const tail = response.body.builtSystems.find((row) => row.system_name.startsWith('Tick System'));
    assert.equal(tail.progress, null);
    assert.equal(tail.status, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('период блока систем: неделя отсекает старые поставки', async () => {
  const { mod, dir } = await buildRoutes();
  try {
    const fresh = new Date(Date.now() - 2 * 86400000).toISOString();
    const old = new Date(Date.now() - 40 * 86400000).toISOString();
    mod.db.deliveries = [
      { id: 1, user_id: 'u1', system_name: 'HIP 90297', amount: 500, delivered_at: fresh },
      { id: 2, user_id: 'u2', system_name: 'Sol', amount: 999, delivered_at: old },
    ];

    const week = await json(await mod.stats.GET(new Request('http://localhost/api/leaderboard/stats?period=week')));
    assert.equal(week.status, 200);
    assert.deepEqual(week.body.builtSystems.map((row) => row.system_name), ['HIP 90297']);

    const all = await json(await mod.stats.GET(new Request('http://localhost/api/leaderboard/stats?period=all')));
    assert.deepEqual(
      all.body.builtSystems.map((row) => row.system_name).sort(),
      ['HIP 90297', 'Sol'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

maybe('топ архитекторов: публичные планы + закреплённые системы', async () => {
  const { mod, dir } = await buildRoutes();
  try {
    mod.db.system_plans = [
      { id: 'p1', author_id: 'u1', author_name: 'CMDR Old Name', site_count: 3, haul_tons: 1000, visibility: 'public', updated_at: '2026-09-01T10:00:00.000Z' },
      { id: 'p2', author_id: 'u1', author_name: 'CMDR Builder', site_count: 5, haul_tons: 3000, visibility: 'public', updated_at: '2026-09-20T10:00:00.000Z' },
      // Приватные и «по ссылке» в рейтинг не попадают — отфильтрует eq-запрос.
      { id: 'p3', author_id: 'u9', author_name: 'Hidden', site_count: 99, haul_tons: 9999, visibility: 'private', updated_at: '2026-09-21T10:00:00.000Z' },
      { id: 'p4', author_id: 'u2', author_name: 'CMDR Small', site_count: 1, haul_tons: 100, visibility: 'public', updated_at: '2026-09-22T10:00:00.000Z' },
    ];
    mod.db.system_architects = [
      { system_name: 'HIP 90297', user_id: 'u2', architect_name: 'CMDR Small' },
      { system_name: 'Sol', user_id: 'u2', architect_name: 'CMDR Small' },
      // Архитектор без публичных планов тоже виден — маленький топ про них.
      { system_name: 'LHS 3447', user_id: 'u3', architect_name: 'CMDR Silent' },
    ];

    const response = await json(await mod.stats.GET(new Request('http://localhost/api/leaderboard/stats?period=all')));
    assert.equal(response.status, 200);

    const eqFilter = mod.db.queries
      .filter((item) => item.table === 'system_plans')
      .map((item) => item.filters.find(([op]) => op === 'eq'))[0];
    assert.deepEqual(eqFilter, ['eq', 'visibility', 'public']);

    const top = response.body.topArchitects;
    assert.equal(top.length, 3);
    assert.equal(top[0].user_id, 'u2', 'закреплённые системы выше числа построек');
    assert.equal(top[0].assigned_systems, 2);
    assert.deepEqual(top[0].assigned_names, ['HIP 90297', 'Sol']);
    assert.equal(top[0].plans_count, 1);
    assert.equal(top[1].user_id, 'u3');
    assert.equal(top[1].cmdr_name, 'CMDR Silent');
    assert.equal(top[2].user_id, 'u1');
    assert.equal(top[2].plans_count, 2);
    assert.equal(top[2].sites_count, 8);
    assert.equal(top[2].haul_tons, 4000);
    assert.equal(top[2].cmdr_name, 'CMDR Builder', 'позывной из самого свежего плана');
    assert.equal(top[2].rank, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
