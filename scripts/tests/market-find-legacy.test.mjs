import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bundleFile } from './helpers/bundle.mjs';
import { BUILD_COMMODITIES } from '../../src/lib/commodities.ts';

/*
 * Прежний GET /api/market/find (web 2.25.2): совместимый ответ из БД проекта.
 * До 2.25.2 это была одна строка в 8,6 КБ, которая на каждый вызов обходила
 * EDSM сотнями запросов без тайм-аутов и брала цену покупки из `sellPrice`.
 */
const api = await import(await bundleFile({ entry: 'src/app/api/market/find/route.ts', stubs: {
  'next/server': `export const NextResponse={json:(body,options={})=>({body,status:options.status||200})};`,
  '@/lib/supabaseServer': `export const createServiceClient=()=>globalThis.__marketFindDb;`,
  '@/lib/galaxySystemsDb': `export const findSystemByName=async(name)=>(globalThis.__marketFindCatalog||{})[name]||null;`,
} }));

const SOL = { x: 0, y: 0, z: 0 };
function db({ stations = [], center = SOL, error = null } = {}) {
  const calls = [];
  globalThis.__marketFindDb = {
    calls,
    from(table) {
      const q = { select: () => q, eq: (column, value) => { calls.push({ name: `${table}.${column}`, value }); return q; },
        maybeSingle: async () => ({ data: center, error: null }) };
      return q;
    },
    rpc: async (name, params) => { calls.push({ name, params }); return error ? { data: null, error } : { data: { total: stations.length, stations }, error: null }; },
  };
  return calls;
}
const station = (name, distance, items, extra = {}) => ({
  station_key: `market:${name}`, station_name: name, station_type: 'Coriolis', system_name: `${name} System`, market_id: '1',
  x: distance, y: 0, z: 0, distance, metadata: {}, observed_at: '2026-10-01T00:00:00Z', source: 'colonial-helper', stale: false,
  items, item_count: items.length, best_price: null, ...extra,
});
const request = (params) => new Request(`http://test.local/api/market/find?${new URLSearchParams(params)}`);
const realFetch = globalThis.fetch;
test.beforeEach(() => { globalThis.fetch = async (url) => { throw new Error(`внешний запрос из /api/market/find: ${url}`); }; });
test.afterEach(() => {
  globalThis.fetch = realFetch;
  delete globalThis.__marketFindDb; delete globalThis.__marketFindCatalog;
});

test('market find answers one commodity from the project DB, with the buy price and without EDSM', async () => {
  const calls = db({ stations: [
    station('Galileo', 12.5, [{ name: 'Steel', stock: 900, demand: 0, buyPrice: 1200, sellPrice: 1100 }]),
    station('Carrier', 40, [{ name: 'Steel', stock: 50 }], { station_type: 'FleetCarrier' }),
    station('Outpost', 41, [{ name: 'Steel', stock: 5, buyPrice: 1300 }], { station_type: 'Outpost' }),
    station('Settlement', 42, [{ name: 'Steel', stock: 5 }], { station_type: 'OnFootSettlement' }),
  ] });
  const response = await api.GET(request({ commodity: 'steel', reference_system: 'Sol', radius: '50' }));
  assert.equal(response.status, 200);
  const rpc = calls.find((call) => call.name === 'search_station_catalog_stations');
  assert.deepEqual(rpc.params.exact_keys.sort(), ['steel'], 'название из справочника ищется точно');
  assert.equal(rpc.params.search_kind, 'market');
  assert.deepEqual([rpc.params.cx, rpc.params.cy, rpc.params.cz, rpc.params.radius_ly], [0, 0, 0, 50]);
  assert.equal(rpc.params.minimum_stock, 1);
  assert.equal(rpc.params.sort_by, 'distance');
  assert.equal(rpc.params.row_limit, 25);
  assert.equal(response.body.mode, 'single');
  assert.equal(response.body.commodity, 'steel');
  assert.equal(response.body.reference_system, 'Sol');
  assert.equal(response.body.radius, 50);
  assert.equal(response.body.source, 'project-db');
  assert.equal(response.body.count, 4);
  assert.deepEqual(response.body.stations[0], {
    station_name: 'Galileo', system_name: 'Galileo System', distance: 12.5, landing_pad: 'L', station_type: 'Coriolis',
    market_id: '1', observed_at: '2026-10-01T00:00:00Z', source: 'colonial-helper',
    commodity: 'Steel', stock: 900, buy_price: 1200, sell_price: 1100, demand: 0,
  });
  assert.deepEqual(response.body.stations.map((row) => row.landing_pad), ['L', 'L', 'M', null], 'площадка — только где её задаёт тип станции');
  assert.equal(response.body.stations[1].buy_price, null, 'неизвестная цена не выдумывается');
});

test('market find resolves the reference system through the project DB and validates its input', async () => {
  let calls = db();
  assert.equal((await api.GET(request({ reference_system: 'Sol' }))).status, 400, 'без товара — 400');
  assert.equal(calls.length, 0, 'до проверки параметров БД не трогается');

  calls = db({ center: null });
  globalThis.__marketFindCatalog = { Colonia: { x: -9530.5, y: -910.3, z: 19808.1 } };
  const viaCatalog = await api.GET(request({ commodity: 'Steel', system: '  Colonia ' }));
  assert.equal(viaCatalog.status, 200, 'нет в commerce_systems — берётся каталог систем');
  assert.equal(calls[0].value, 'colonia', 'ключ системы — systemKey');
  assert.equal(calls.find((call) => call.params).params.cx, -9530.5);

  db({ center: null });
  const unknown = await api.GET(request({ commodity: 'Steel', reference_system: 'Nowhere' }));
  assert.equal(unknown.status, 404);

  for (const [radius, expected] of [['5000', 500], ['abc', 500], ['-5', 500], ['0', 500], ['120', 120]]) {
    calls = db();
    const response = await api.GET(request({ commodity: 'Steel', radius }));
    assert.equal(response.body.radius, expected, `radius=${radius}`);
    assert.equal(calls.find((call) => call.params).params.radius_ly, expected);
  }
  calls = db();
  await api.GET(request({ commodity: 'Steel' }));
  assert.equal(calls[0].value, 'sol', 'по умолчанию — Sol');
});

test('market find build mode ranks the nearest stations by construction goods found', async () => {
  const calls = db({ stations: [
    station('Near', 10, [{ name: 'Steel', stock: 10 }, { name: 'Aluminium', stock: 5, buyPrice: 300 }]),
    station('Far', 30, ['Steel', 'Aluminium', 'Titanium', 'Copper', 'Polymers'].map((name) => ({ name, stock: 100 }))),
    station('Empty', 5, []),
  ] });
  const response = await api.GET(request({ mode: 'build', reference_system: 'Sol' }));
  assert.equal(response.status, 200);
  const rpc = calls.find((call) => call.name === 'search_station_catalog_stations');
  assert.ok(rpc.params.exact_keys?.length >= BUILD_COMMODITIES.length, 'все строительные товары есть в справочнике и ищутся точно');
  assert.ok(rpc.params.needles.includes('CMM Composite') && rpc.params.needles.includes('Steel'));
  assert.equal(rpc.params.row_limit, 50);
  assert.ok(rpc.params.item_limit >= BUILD_COMMODITIES.length, 'строка станции вмещает все строительные товары');
  assert.equal(response.body.mode, 'build');
  assert.deepEqual(response.body.commodities, BUILD_COMMODITIES);
  assert.deepEqual(response.body.stations.map((row) => [row.station_name, row.commodities_found]), [['Far', 5], ['Near', 2]]);
  assert.equal(response.body.stations[0].commodities_total, BUILD_COMMODITIES.length);
  assert.deepEqual(response.body.stations[1].commodities[1], { name: 'Aluminium', stock: 5, buy_price: 300, sell_price: null });
  assert.equal(response.body.count, 2);
});

test('market find keeps unknown commodity names as a substring search and hides database errors', async () => {
  let calls = db();
  await api.GET(request({ commodity: 'Mystery Crate' }));
  const rpc = calls.find((call) => call.params);
  assert.equal(rpc.params.exact_keys, null, 'название не из справочника — поиск по вхождению');
  assert.ok(rpc.params.needles.includes('Mystery Crate'));

  calls = db({ error: { code: 'PGRST202', message: 'Could not find the function search_station_catalog_stations' } });
  const failed = await api.GET(request({ commodity: 'Steel' }));
  assert.equal(failed.status, 503);
  assert.doesNotMatch(failed.body.error, /PGRST202|Could not find/, 'текст ошибки БД наружу не уходит');
  assert.match(failed.body.error, /20261022120000_station_search_by_station/);
});

test('market find route is readable source without direct EDSM calls', () => {
  const source = readFileSync('src/app/api/market/find/route.ts', 'utf8');
  assert.ok(source.split('\n').length > 60, 'маршрут — читаемый исходник, а не одна строка');
  assert.doesNotMatch(source, /edsm\.net|fetch\(/, 'EDSM не вызывается');
});
