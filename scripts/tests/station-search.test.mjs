import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bundleFile } from './helpers/bundle.mjs';
import { stationAtlasLink, atlasFocusFromParams, serviceAliases } from '../../src/lib/stationSearch.ts';

const api = await import(await bundleFile({ entry: 'src/app/api/stations/search/route.ts', stubs: {
  'next/server': `export const NextResponse={json:(body,options={})=>({body,status:options.status||200})};`,
  '@/lib/supabaseServer': `export const createServiceClient=()=>globalThis.__stationSearchDb;`,
  '@/lib/galaxySystemsDb': `export const findSystemByName=async()=>globalThis.__stationSearchReference||null;`,
} }));
function db({ rows = [], center = null, fail = false } = {}) {
  const calls = [];
  globalThis.__stationSearchDb = { calls, from() { const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: center, error: null }) }; return q; },
    rpc: async (name, params) => { calls.push({ name, params }); return { data: rows, error: fail ? { message: 'Missing migration' } : null }; },
  };
  return calls;
}
const request = (params) => new Request(`http://test.local/api/stations/search?${new URLSearchParams(params)}`);
const row = { station_key: 'market:1', station_name: 'Dock', system_name: 'Sol', item: { name: 'Steel', stock: 30 }, metadata: {}, x: 0, y: 0, z: 0, distance: 0, observed_at: '2026-01-01T00:00:00Z', source: 'colonial-helper', stale: true };
test.afterEach(() => { delete globalThis.__stationSearchDb; delete globalThis.__stationSearchReference; });

test('tools menu exposes station search with localized label', () => {
  const sidebar = readFileSync('src/components/Sidebar.tsx','utf8');
  assert.match(sidebar.slice(sidebar.indexOf("id: 'tools'")), /href: '\/station-search'.*nav\.stationSearch/);
});
test('Atlas deep links preserve zero coordinates and reject missing, empty and non-finite values', () => {
  const link = stationAtlasLink(row);
  const params = new URL(link, 'https://test.local').searchParams;
  assert.deepEqual(atlasFocusFromParams(params), { name: 'Sol', x: 0, y: 0, z: 0 });
  assert.equal(stationAtlasLink({ ...row, x: null }), null);
  for (const query of ['focus_system=Sol&y=0&z=0', 'focus_system=Sol&x=&y=0&z=0', 'focus_system=Sol&x=Infinity&y=0&z=0', 'focus_system=Sol&x=900000&y=0&z=0']) {
    assert.equal(atlasFocusFromParams(new URLSearchParams(query)), null);
  }
});
test('station search validates all query filters before accessing database', async () => {
  for (const params of [{ q: 'a' }, { q: 'Steel', kind: 'unknown' }, { q: 'Steel', radius: '-1' }, { q: 'FSD', module_class: '50' }, { q: 'FSD', rating: 'Z' }, { q: 'Steel', page: '101' }]) {
    assert.equal((await api.GET(request(params))).status, 400);
  }
});
test('station search passes stock, distance, pagination, freshness and sort filters to SQL', async () => {
  const calls = db({ rows: Array.from({ length: 51 }, () => row), center: { x: 0, y: 0, z: 0 } });
  const response = await api.GET(request({ kind: 'market', q: 'Steel', reference: 'Sol', radius: '50', min_stock: '20', page: '1', fresh: 'true', sort: 'price' }));
  assert.equal(response.status, 200); assert.equal(response.body.has_more, true); assert.equal(response.body.results.length, 50);
  assert.equal(calls[0].params.cx, 0); assert.equal(calls[0].params.radius_ly, 50); assert.equal(calls[0].params.minimum_stock, 20);
  assert.equal(calls[0].params.page_offset, 50); assert.equal(calls[0].params.fresh_only, true); assert.equal(calls[0].params.sort_by, 'price');
});
test('friendly module and ship names map to actual Frontier symbols, not invented availability', async () => {
  let calls = db({ rows: [{ ...row, item: { name: 'int_hyperdrive_size5_class5' } }] });
  const modules = await api.GET(request({ kind: 'outfitting', q: 'FSD', module_class: '5', rating: 'A' }));
  assert.ok(calls[0].params.needles.some((value) => value.toLowerCase().includes('hyperdrive')));
  assert.ok(modules.body.results[0].item_display.startsWith('5A '));
  calls = db();
  await api.GET(request({ kind: 'shipyard', q: 'Python' }));
  assert.ok(calls[0].params.needles.some((value) => value.toLowerCase() === 'python'));
});
test('service aliases include Tech Broker, named engineers, workshop and material trader reports', async () => {
  assert.ok(serviceAliases('Технологический брокер').includes('techbroker'));
  assert.ok(serviceAliases('Инженер / мастерская').includes('workshop'));
  const calls = db(); await api.GET(request({ kind: 'services', q: 'Технологический брокер' }));
  assert.ok(calls[0].params.needles.includes('technologybroker'));
});
test('unknown reference and database failures are explicit, not empty successful searches', async () => {
  db(); assert.equal((await api.GET(request({ kind: 'market', q: 'Steel', reference: 'Unknown' }))).status, 404);
  db({ fail: true }); assert.equal((await api.GET(request({ kind: 'services', q: 'repair' }))).status, 503);
});
