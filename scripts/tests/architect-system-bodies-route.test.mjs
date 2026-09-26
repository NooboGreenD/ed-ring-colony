/**
 * Маршрут `/api/atlas/system-bodies?compare=1` — режим сверки, которым
 * пользуется «Архитектор» при загрузке системы: оба источника (база проекта
 * и EDSM) запрашиваются вместе, а не «EDSM только если база пуста».
 *
 * Маршрут собирается esbuild'ом как есть (тот же приём, что и в
 * `architect-plans-route.test.mjs`), `@/lib/supabaseAdmin` подменяется
 * заглушкой в памяти, а сетевой `fetch` к EDSM подставляется тестом.
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
export const db = { rows: [], error: null, upserts: [] };
export function reset() { db.rows = []; db.error = null; db.upserts.length = 0; }

function makeQuery() {
  const api = {
    select: () => api,
    ilike: () => api,
    order: () => api,
    upsert: (rows) => { db.upserts.push(...(Array.isArray(rows) ? rows : [rows])); return Promise.resolve({ data: rows, error: null }); },
    then: (resolve, reject) => Promise.resolve({ data: db.rows, error: db.error }).then(resolve, reject),
  };
  return api;
}

export const supabaseAdmin = { from: () => makeQuery() };
`;

async function buildRoute() {
  const dir = mkdtempSync(join(ROOT, '.tmp-system-bodies-route-'));
  writeFileSync(join(dir, 'next-server.mjs'), NEXT_SERVER_STUB);
  writeFileSync(join(dir, 'supabase.mjs'), SUPABASE_STUB);
  const entry = join(dir, 'entry.ts');
  writeFileSync(
    entry,
    "export * as route from '@/app/api/atlas/system-bodies/route';\n"
    + "export { db, reset } from './supabase.mjs';\n",
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
      '@/lib/supabaseAdmin': join(dir, 'supabase.mjs'),
      '@': join(ROOT, 'src'),
    },
    loader: { '.ts': 'ts', '.tsx': 'tsx' },
    logLevel: 'silent',
  });
  const mod = await import(bundle);
  mod.reset();
  return { mod, dir };
}

function dbBodyRow(overrides = {}) {
  return {
    system_name: 'Architest',
    body_name: 'Architest 1',
    body_type: 'Planet',
    sub_type: 'Rocky body',
    distance_ls: 100,
    radius_m: 0,
    gravity: 0,
    earth_masses: 0,
    surface_temp_k: 0,
    surface_pressure: 0,
    volcanism: null,
    atmosphere: null,
    atmosphere_type: null,
    atmosphere_composition: [],
    solid_composition: {},
    materials: {},
    rings: [],
    is_landable: true,
    bio_signals_count: 2,
    geo_signals_count: 0,
    human_signals_count: 0,
    thargoid_signals_count: 0,
    guardian_signals_count: 0,
    other_signals_count: 0,
    signals: [],
    bio_genuses: ['Bacterium'],
    first_discovered_by: null,
    first_mapped_by: null,
    first_footfall_by: null,
    scanned_by_cmdr: 'CMDR Old',
    source: 'journal',
    raw_data: {},
    updated_at: '2020-01-01T00:00:00.000Z', // намеренно старая запись
    ...overrides,
  };
}

test('/api/atlas/system-bodies?compare=1 сверяет базу и EDSM: сигналы из базы сохраняются, пробелы дополняются из EDSM', async (t) => {
  if (!esbuild) return t.skip('esbuild недоступен');
  const { mod, dir } = await buildRoute();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  mod.db.rows = [dbBodyRow()];

  const previousFetch = global.fetch;
  global.fetch = async (url) => {
    assert.match(String(url), /edsm\.net\/api-system-v1\/bodies/);
    return {
      ok: true,
      json: async () => ({
        bodies: [
          {
            name: 'Architest 1',
            bodyId: 1,
            type: 'Planet',
            subType: 'Rocky body',
            distanceToArrival: 100,
            radius: 3000,
            gravity: 0.4,
            atmosphereType: 'Thin nitrogen',
          },
          { name: 'Architest 2', bodyId: 2, type: 'Planet', subType: 'Icy body', distanceToArrival: 500 },
        ],
      }),
    };
  };
  t.after(() => { global.fetch = previousFetch; });

  const req = new Request('http://web:3000/api/atlas/system-bodies?system=Architest&compare=1');
  const res = await mod.route.GET(req);
  assert.equal(res.status, 200);
  const data = await res.json();

  assert.equal(data.source, 'compare');
  assert.equal(data.count, 2);
  assert.equal(data.sources.total, 2);
  assert.equal(data.sources.edsm, 1); // Architest 2 — только в EDSM

  const first = data.bodies.find((b) => b.body_name === 'Architest 1');
  // Сигналы и командир — из базы, они не должны потеряться при сверке.
  assert.equal(first.bio_signals_count, 2);
  assert.equal(first.scanned_by_cmdr, 'CMDR Old');
  // Атмосфера и уточнённый радиус — из EDSM, которых не было в базе.
  assert.equal(first.atmosphere, 'Thin nitrogen');
  assert.equal(first.radius_m, 3_000_000);

  const second = data.bodies.find((b) => b.body_name === 'Architest 2');
  assert.ok(second, 'тело, найденное только в EDSM, тоже возвращается');

  // Дозаписи в базу: тело, которого не было (Architest 2), и уточнённая
  // запись Architest 1 (сохранившая сигналы, а не сброс к нулю).
  assert.equal(mod.db.upserts.length, 2);
  const upsertedFirst = mod.db.upserts.find((r) => r.body_name === 'Architest 1');
  assert.equal(upsertedFirst.bio_signals_count, 2);
  assert.equal('id' in upsertedFirst, false);
});

test('/api/atlas/system-bodies?compare=1 без данных ни в базе, ни в EDSM честно отвечает source: none', async (t) => {
  if (!esbuild) return t.skip('esbuild недоступен');
  const { mod, dir } = await buildRoute();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  mod.db.rows = [];
  const previousFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ bodies: [] }) });
  t.after(() => { global.fetch = previousFetch; });

  const req = new Request('http://web:3000/api/atlas/system-bodies?system=Nowhere&compare=1');
  const res = await mod.route.GET(req);
  const data = await res.json();
  assert.equal(data.source, 'none');
  assert.equal(data.bodies.length, 0);
});

test('без ?compare=1 поведение прежнее: непустая база возвращается без обращения к EDSM', async (t) => {
  if (!esbuild) return t.skip('esbuild недоступен');
  const { mod, dir } = await buildRoute();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  mod.db.rows = [dbBodyRow()];
  const previousFetch = global.fetch;
  let fetchCalled = false;
  global.fetch = async () => { fetchCalled = true; return { ok: true, json: async () => ({ bodies: [] }) }; };
  t.after(() => { global.fetch = previousFetch; });

  const req = new Request('http://web:3000/api/atlas/system-bodies?system=Architest');
  const res = await mod.route.GET(req);
  const data = await res.json();
  assert.equal(data.source, 'database');
  assert.equal(fetchCalled, false);
});
