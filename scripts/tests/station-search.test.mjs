import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bundleFile } from './helpers/bundle.mjs';
import { stationAtlasLink, atlasFocusFromParams, serviceAliases, groupStationRows, stationItemKey, stationItemMatchesKeys } from '../../src/lib/stationSearch.ts';
import { filterStationOptions, exactStationOption, pickMatchesKind, ruPlural, optionKey } from '../../src/lib/stationSearchOptions.ts';

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
const options = await import(await bundleFile({ entry: 'src/app/api/stations/search/options/route.ts', stubs: {
  'next/server': `export const NextResponse={json:(body,options={})=>({body,status:options.status||200,headers:options.headers||{}})};`,
} }));
/** Заглушка БД для поиска списком: отдельные ответы новой и прежней функций. */
function listDb({ list = { total: 0, stations: [] }, listError = null, flat = [], center = null } = {}) {
  const calls = [];
  globalThis.__stationSearchDb = { calls, from() { const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: center, error: null }) }; return q; },
    rpc: async (name, params) => {
      calls.push({ name, params });
      if (name === 'search_station_catalog_stations') return listError ? { data: null, error: listError } : { data: list, error: null };
      return { data: flat, error: null };
    },
  };
  return calls;
}
const request = (params) => new Request(`http://test.local/api/stations/search?${new URLSearchParams(params)}`);
const optionsRequest = (kind) => options.GET(new Request(`http://test.local/api/stations/search/options${kind ? `?kind=${kind}` : ''}`));
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
test('weapon mounts in results use the shipyard dictionary: Gimbal is gimballed, Turret is turret', async () => {
  db({ rows: ['Fixed', 'Gimbal', 'Turret'].map((mount) => ({ ...row, item: { name: `hpt_pulselaser_${mount.toLowerCase()}_small`, symbol: `Hpt_PulseLaser_${mount}_Small` } })) });
  const response = await api.GET(request({ kind: 'outfitting', q: 'Pulse Laser' }));
  const [fixed, gimballed, turret] = response.body.results.map((result) => result.item_display);
  assert.match(fixed, /^1F .+ \(фикс\.\)$/);
  assert.match(gimballed, /^1G .+ \(наводящееся\)$/);
  assert.match(turret, /^1G .+ \(турель\)$/);
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

test('quick-pick lists come from FDevIDs and project dictionaries with Russian names where they exist', async () => {
  const market = await optionsRequest('market');
  assert.equal(market.status, 200);
  assert.match(market.headers['Cache-Control'], /max-age=3600/);
  const steel = market.body.options.find((option) => option.id === 'market:Steel');
  assert.equal(steel.label, 'Сталь');
  assert.match(steel.hint, /Steel/);
  assert.equal(steel.badge, 'стройка');
  const featured = market.body.options.filter((option) => option.featured);
  assert.equal(featured.length, 55, 'every construction material is offered before typing');
  assert.ok(featured.every((option) => /[а-яё]/i.test(option.label)), 'construction materials have Russian labels');
  assert.ok(market.body.options.some((option) => option.id === 'market:Gold' && option.label === 'Gold'), 'no invented Russian names');
  assert.equal(market.body.source.source, 'https://github.com/EDCD/FDevIDs');
  const modules = (await optionsRequest('outfitting')).body.options;
  const fsd = modules.find((option) => option.id === 'module:frame-shift-drive');
  assert.equal(fsd.label, 'Гипердвигатель (FSD)');
  assert.equal(fsd.hint, 'Frame Shift Drive');
  assert.equal(modules.find((option) => option.id === 'module:frame-shift-drive-sco').hint, 'Гипердвигатель (FSD)');
  assert.ok(!modules.some((option) => /armour|alloy/i.test(option.label)), 'ship-specific bulkheads are not offered');
  const ships = (await optionsRequest('shipyard')).body.options;
  assert.ok(ships.some((option) => option.id === 'ship:python_nx' && option.label === 'Python MkII'));
  assert.match(ships.find((option) => option.id === 'ship:python').hint, /Faulcon DeLacy · площадка M/);
  const services = (await optionsRequest('services')).body.options;
  assert.ok(services.some((option) => option.id === 'service:techbroker' && option.label === 'Технологический брокер'));
  assert.ok(services.some((option) => option.id === 'engineer:farseer' && option.hint === 'Deciat · Farseer Inc'));
  assert.equal((await optionsRequest('nope')).status, 400);
  assert.equal((await optionsRequest()).body.kind, 'market');
});

test('typing filters suggestions by Russian, English, symbol and abbreviation; exact names become picks', async () => {
  const market = (await optionsRequest('market')).body.options;
  assert.equal(filterStationOptions(market, 'ста')[0].label, 'Сталь');
  assert.equal(filterStationOptions(market, 'steel')[0].label, 'Сталь');
  assert.equal(filterStationOptions(market, 'low temp')[0].label, 'Low Temperature Diamonds');
  assert.equal(filterStationOptions(market, 'he suits')[0].id, 'market:HazardousEnvironmentSuits');
  assert.deepEqual(filterStationOptions(market, 'water').slice(0, 2).map((option) => option.label), ['Вода', 'Водоочистители']);
  assert.equal(filterStationOptions(market, '').length, 55, 'empty input shows construction materials');
  assert.equal(exactStationOption(market, 'water')?.id, 'market:Water');
  assert.equal(exactStationOption(market, 'Вода')?.id, 'market:Water');
  assert.equal(exactStationOption(market, 'LowTemperatureDiamond')?.id, 'market:LowTemperatureDiamond');
  assert.equal(exactStationOption(market, 'wat'), null);
  const modules = (await optionsRequest('outfitting')).body.options;
  assert.equal(filterStationOptions(modules, 'fsd')[0].label, 'Гипердвигатель (FSD)');
  assert.equal(filterStationOptions(modules, 'afmu')[0].label, 'Ремонтный модуль (AFMU)');
  assert.ok(filterStationOptions(modules, 'щит').some((option) => option.label === 'Призматический щит'));
  assert.ok(pickMatchesKind('services', 'engineer:farseer'));
  assert.ok(!pickMatchesKind('market', 'module:frame-shift-drive'));
  assert.equal(optionKey('Ёлка H.E.'), 'елкаhe');
  assert.deepEqual([1, 2, 5, 11, 21, 104].map((n) => ruPlural(n, ['станция', 'станции', 'станций'])),
    ['станция', 'станции', 'станций', 'станций', 'станция', 'станции']);
});

test('item keys match Helper, EDDN and Spansh spellings of the same item', () => {
  assert.equal(stationItemKey('$Steel_Name;'), 'steel');
  assert.equal(stationItemKey('Int_Hyperdrive_Size5_Class5'), 'inthyperdrivesize5class5');
  assert.equal(stationItemKey(128049152), '128049152');
  assert.ok(stationItemMatchesKeys({ name: '$water_name;' }, ['water']));
  assert.ok(!stationItemMatchesKeys({ name: 'Water Purifiers' }, ['water']));
  assert.ok(stationItemMatchesKeys({ name: 'Gold', id: 'gold' }, ['gold']));
  const grouped = groupStationRows([
    { ...row, item: { name: 'Water', buyPrice: 300, stock: 5 } },
    { ...row, item: { name: 'Water Purifiers', buyPrice: 100, stock: 5 } },
    { ...row, station_key: 'market:2', station_name: 'Other', item: { name: 'Water', buyPrice: 200, stock: 9 } },
  ], { exactKeys: ['water'] });
  assert.deepEqual(grouped.map((station) => [station.station_name, station.item_count, station.best_price]), [['Dock', 1, 300], ['Other', 1, 200]]);
});

test('station list mode sends a pick as exact keys and returns stations with Russian item labels', async () => {
  const station = { ...row, station_key: 'market:9', station_name: 'Galileo', station_type: 'Ocellus', market_id: '9',
    items: [{ name: 'Water', buyPrice: 300, sellPrice: 280, stock: 40, demand: 0 }], item_count: 1, best_price: 300 };
  const calls = listDb({ list: { total: 51, stations: Array.from({ length: 51 }, (_, index) => ({ ...station, station_key: `market:${index}` })) }, center: { x: 1, y: 2, z: 3 } });
  const response = await api.GET(request({ kind: 'market', q: 'Вода', item: 'market:Water', group: 'station', reference: 'Sol', page: '1', sort: 'price' }));
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'search_station_catalog_stations');
  assert.deepEqual(calls[0].params.exact_keys, ['water']);
  assert.deepEqual(calls[0].params.needles, ['Water']);
  assert.equal(calls[0].params.page_offset, 50);
  assert.equal(calls[0].params.row_limit, 50);
  assert.equal(calls[0].params.item_limit, 100);
  assert.equal(calls[0].params.sort_by, 'price');
  assert.equal(response.body.stations.length, 50);
  assert.equal(response.body.has_more, true);
  assert.equal(response.body.total, 51);
  assert.equal(response.body.grouping, 'station');
  assert.deepEqual(response.body.pick, { id: 'market:Water', label: 'Вода' });
  assert.equal(response.body.query, 'Вода');
  assert.deepEqual(response.body.reference, { name: 'Sol', x: 1, y: 2, z: 3 });
  assert.equal(response.body.stations[0].items[0].display, 'Вода');
  assert.equal(response.body.stations[0].items[0].hint, 'Water');
});

test('picks of another tab and free Russian text are handled without inventing availability', async () => {
  let calls = listDb();
  const ignored = await api.GET(request({ kind: 'market', q: 'Сталь', item: 'module:frame-shift-drive', group: 'station' }));
  assert.equal(ignored.status, 200);
  assert.equal(ignored.body.pick, null);
  assert.equal(calls[0].params.exact_keys, null);
  assert.ok(calls[0].params.needles.includes('Steel'), 'Russian commodity names search the English name and symbol');
  assert.equal((await api.GET(request({ kind: 'market', q: 'Steel', item: 'market:<script>' }))).status, 400);
  calls = listDb();
  await api.GET(request({ kind: 'outfitting', q: 'Генератор щита', item: 'module:shield-generator', group: 'station' }));
  assert.ok(calls[0].params.exact_keys.includes('intshieldgeneratorsize5class5'));
  assert.ok(!calls[0].params.exact_keys.some((key) => key.endsWith('strong') || key.endsWith('fast')), 'prismatic and bi-weave are separate picks');
  calls = listDb({ list: { total: 1, stations: [{ ...row, items: [{ name: 'Engineer: Felicity Farseer' }], item_count: 1, best_price: null }] } });
  const engineer = await api.GET(request({ kind: 'services', q: 'Felicity Farseer', item: 'engineer:farseer', group: 'station' }));
  assert.equal(calls[0].params.exact_keys, null, 'services and engineers are matched by alias, not exact keys');
  assert.ok(calls[0].params.needles.includes('Felicity Farseer'));
  assert.equal(engineer.body.stations[0].items[0].display, 'Инженер Felicity Farseer');
});

test('flat API keeps its contract and trims an exact pick on the server', async () => {
  const calls = db({ rows: [{ ...row, item: { name: 'Water', stock: 30 } }, { ...row, item: { name: 'Water Purifiers', stock: 30 } }] });
  const response = await api.GET(request({ kind: 'market', q: 'Вода', item: 'market:Water' }));
  assert.equal(calls[0].name, 'search_station_catalog');
  assert.deepEqual(response.body.results.map((result) => result.item.name), ['Water']);
  assert.equal(response.body.results[0].item_display, 'Вода');
});

// Последним: запасной путь запоминает отсутствие функции на пять минут.
test('without the station list migration the API groups one page of the old search and warns once', async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const flat = [
      { ...row, item: { name: 'Water', buyPrice: 300, stock: 30 } },
      { ...row, item: { name: 'Water Purifiers', buyPrice: 100, stock: 30 } },
      { ...row, station_key: 'market:2', station_name: 'Second', item: { name: '$water_name;', buyPrice: 200, stock: 30 } },
    ];
    let calls = listDb({ flat, listError: { code: 'PGRST202', message: 'Could not find the function public.search_station_catalog_stations' } });
    const response = await api.GET(request({ kind: 'market', q: 'Вода', item: 'market:Water', group: 'station' }));
    assert.equal(response.status, 200);
    assert.deepEqual(calls.map((call) => call.name), ['search_station_catalog_stations', 'search_station_catalog']);
    assert.equal(calls[1].params.row_limit, 100);
    assert.equal(response.body.grouping, 'page');
    assert.equal(response.body.total, null);
    assert.deepEqual(response.body.stations.map((station) => [station.station_name, station.item_count]), [['Dock', 1], ['Second', 1]]);
    assert.equal(response.body.stations[1].items[0].display, 'Вода');
    calls = listDb({ flat });
    await api.GET(request({ kind: 'market', q: 'Steel', group: 'station' }));
    assert.deepEqual(calls.map((call) => call.name), ['search_station_catalog'], 'the missing function is remembered');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /20261022120000/);
  } finally {
    console.warn = originalWarn;
  }
});

test('FDevIDs snapshot generator skips bulkheads, removed items and MercGear duplicates, and the committed file round-trips', async () => {
  const { buildItems, formatItems, parseCsv } = await import('../build-station-search-items.mjs');
  assert.deepEqual(parseCsv('id,symbol,name\r\n1,"A,B",Steel\r\n'), [{ id: '1', symbol: 'A,B', name: 'Steel' }]);
  const items = buildItems({
    'commodity.csv': 'id,symbol,category,name\n128049204,Steel,Metals,Steel\n',
    'rare_commodity.csv': 'id,symbol,market_id,category,name\n128666746,EraninPearlWhisky,128001536,Legal Drugs,Eranin Pearl Whisky\n',
    'outfitting.csv': [
      'id,symbol,category,name,mount,guidance,ship,class,rating,entitlement',
      '128049250,SideWinder_Armour_Grade1,standard,Lightweight Alloy,,,Sidewinder,1,I,',
      '128064103,Int_Hyperdrive_Size5_Class5,standard,Frame Shift Drive,,,,5,A,',
      '128662535,Int_StellarBodyDiscoveryScanner_Standard,internal,Basic Discovery Scanner,,,,1,E,removed',
      '129030000,Hpt_Railgun_Fixed_Medium,hardpoint,Rail Gun,Fixed,,,2,B,',
      '129040000,Hpt_Railgun_Fixed_Medium,mercgear,Enduring Feedback Rail Gun,Fixed,,,2,B,',
    ].join('\n'),
    'shipyard.csv': 'id,symbol,name,entitlement\n128049309,Python,Python,\n',
  }, { ref: 'test', retrieved: '2026-10-19' });
  assert.deepEqual(items.modules.map((module) => module.name), ['Frame Shift Drive', 'Rail Gun']);
  assert.deepEqual(items.modules[0].items, [['Int_Hyperdrive_Size5_Class5', 5, 'A', '']]);
  assert.equal(items.rare[0].name, 'Eranin Pearl Whisky');
  assert.deepEqual(JSON.parse(formatItems(items)), items);
  const committed = JSON.parse(readFileSync('src/lib/stationSearchItems.json', 'utf8'));
  assert.equal(committed.source, 'https://github.com/EDCD/FDevIDs');
  assert.ok(committed.commodities.some((entry) => entry.symbol === 'Steel'));
  assert.ok(committed.modules.some((module) => module.items.some(([symbol]) => symbol === 'Int_Hyperdrive_Size5_Class5')));
  assert.ok(committed.ships.some((ship) => ship.symbol === 'Python_NX'));
  const symbols = committed.modules.flatMap((module) => module.items.map(([symbol]) => symbol.toLowerCase()));
  assert.equal(new Set(symbols).size, symbols.length, 'one module name per symbol');
  assert.equal(readFileSync('src/lib/stationSearchItems.json', 'utf8'), formatItems(committed), 'file is in generator format');
});
