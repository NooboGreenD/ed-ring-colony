import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { canonicalReport, edsmInventoryItems, spanshCommercePayload } from '../../src/lib/stationCommerce.ts';

const db = new PGlite();
const old = '2026-01-01T00:00:00Z';
const newer = '2026-01-02T00:00:00Z';
await db.exec(`
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
CREATE TABLE colonisation_market_systems(system_name text,x float8,y float8,z float8,has_market boolean,last_checked_at timestamptz);
CREATE TABLE market_search_jobs(id integer);
CREATE TABLE market_search_cache(market_id bigint);
CREATE TABLE market_prices(station_name text,system_name text,commodity_name text,buy_price integer,sell_price integer,stock integer,demand integer,reported_at timestamptz,source text);
`);
await db.exec(readFileSync(new URL('../../supabase/migrations/20261014000000_station_commerce.sql', import.meta.url), 'utf8'));
const base = { system_name: 'Sol', station_name: 'Galileo', market_id: '123', x: 0, y: 0, z: 0, observed_at: old };
async function save(report, source = 'colonial-helper') {
  await db.query('SELECT save_station_commerce($1::jsonb)', [JSON.stringify(canonicalReport(report, source))]);
}
async function snapshots(key = 'market:123') {
  return (await db.query('SELECT * FROM station_inventory_snapshots WHERE station_key = $1 ORDER BY kind', [key])).rows;
}
test.after(async () => { await db.close(); });

test('database atomically replaces a complete inventory, removes missing goods and ignores older snapshots', async () => {
  await save({ ...base, inventories: { market: { observed_at: old, items: [{ name: 'steel', stock: 10 }, { name: 'water', stock: 20 }] } } });
  await save({ ...base, observed_at: newer, inventories: { market: { observed_at: newer, items: [{ name: 'steel', stock: 0 }] } } });
  await save({ ...base, inventories: { market: { observed_at: old, items: [{ name: 'water', stock: 500 }] } } }, 'spansh');
  const [market] = await snapshots();
  assert.deepEqual(market.items, [{ name: 'Steel', stock: 0 }]);
  assert.equal(market.source, 'colonial-helper');
  // Explicit complete empty inventory clears the service, not the other services.
  await save({ ...base, observed_at: newer, inventories: { market: { observed_at: newer, items: [] }, outfitting: { observed_at: newer, items: [{ name: 'int_hyperdrive_size5_class5' }] } } });
  await save({ ...base, observed_at: newer, inventories: {} });
  const rows = await snapshots();
  assert.deepEqual(rows.find((r) => r.kind === 'market').items, []);
  assert.equal(rows.find((r) => r.kind === 'outfitting').items.length, 1);
});

test('equal observation times prefer live Helper over EDSM/Spansh regardless of upload order', async () => {
  await save({ ...base, observed_at: newer, inventories: { outfitting: { observed_at: newer, items: [{ name: 'old_module' }] } } }, 'edsm');
  assert.equal((await snapshots()).find((r) => r.kind === 'outfitting').items[0].name, 'int_hyperdrive_size5_class5');
});

test('carrier identity survives moves without duplicating stations or keeping old body coordinates', async () => {
  await save({ ...base, metadata: { body_name: 'Earth', latitude: 10 } });
  await db.exec(`INSERT INTO market_prices VALUES ('Galileo','Sol','Steel',100,90,500,0,'2026-01-01','eddn'); INSERT INTO market_search_cache VALUES (123)`);
  await save({ ...base, system_name: 'Alpha', x: 5, observed_at: newer, metadata: { distance_to_arrival: 50 } });
  // Older historical upload must not move the carrier back.
  await save(base, 'spansh');
  const { rows } = await db.query("SELECT system_name,metadata FROM station_commerce WHERE station_key='market:123'");
  assert.equal(rows[0].system_name, 'Alpha');
  assert.equal((await db.query("SELECT count(*)::int AS n FROM market_prices WHERE station_name='Galileo'")).rows[0].n, 0);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM market_search_cache')).rows[0].n, 0);
  assert.deepEqual(rows[0].metadata, { distance_to_arrival: 50 });
  assert.equal((await db.query("SELECT count(*)::int AS n FROM station_commerce WHERE market_id='123'")).rows[0].n, 1);
});

test('Spansh imports population-only candidates and complete ship/module/market snapshots', async () => {
  const payload = spanshCommercePayload({ name: 'Populated', coords: { x: 10, y: 0, z: 0 }, population: 5000, date: newer });
  await db.query('SELECT save_spansh_commerce($1::jsonb)', [JSON.stringify(payload)]);
  const rich = spanshCommercePayload({ name: 'StationSystem', coords: { x: 12, y: 0, z: 0 }, population: 0, date: newer,
    stations: [{ id: 456, name: 'Orbital', updateTime: old, type: 'Coriolis Starport',
      market: { updateTime: old, commodities: [{ name: 'Steel', supply: 40, buyPrice: 500 }] },
      shipyard: { updateTime: old, ships: [{ name: 'Sidewinder', symbol: 'sidewinder', shipId: 1 }] },
      outfitting: { updateTime: old, modules: [{ name: 'Frame Shift Drive', symbol: 'int_hyperdrive_size5_class5', moduleId: 2, class: 5, rating: 'A' }] },
    }] });
  await db.query('SELECT save_spansh_commerce($1::jsonb)', [JSON.stringify(rich)]);
  assert.deepEqual((await snapshots('market:456')).map((r) => r.kind), ['market', 'outfitting', 'shipyard']);
  const result = (await db.query('SELECT nearby_commerce_systems(0,0,0,11) AS systems')).rows[0].systems;
  assert.ok(result.some((r) => r.system_name === 'Populated'));
  assert.ok(!result.some((r) => r.system_name === 'StationSystem'));
  const outsideBox = spanshCommercePayload({ name: 'OutsideSphere', coords: { x: 10, y: 10, z: 10 }, population: 100, date: newer });
  await db.query('SELECT save_spansh_commerce($1::jsonb)', [JSON.stringify(outsideBox)]);
  assert.ok(!(await db.query('SELECT nearby_commerce_systems(0,0,0,11) AS systems')).rows[0].systems.some((r) => r.system_name === 'OutsideSphere'));
  const candidate = (await db.query('SELECT nearby_commerce_systems(0,0,0,20) AS systems')).rows[0].systems;
  assert.ok(candidate.some((r) => r.system_name === 'StationSystem'), 'older station timestamp still establishes that a station exists');
});

test('a name-only EDDN identity reconciles to MarketID without losing a newer inventory', async () => {
  await save({ ...base, market_id: undefined, station_name: 'NameOnly', inventories: { market: { observed_at: newer, items: [{ name: 'Water', stock: 100 }] } } }, 'eddn');
  await save({ ...base, market_id: '789', station_name: 'NameOnly', inventories: { market: { observed_at: old, items: [] } } }, 'edsm');
  assert.equal((await snapshots('market:789'))[0].items[0].stock, 100);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM station_commerce WHERE station_name='NameOnly'")).rows[0].n, 1);
});

test('RLS denies browser writes and service-only RPC access', async () => {
  await db.exec('SET ROLE authenticated');
  try {
    await assert.rejects(db.query('SELECT save_station_commerce($1::jsonb)', [JSON.stringify(canonicalReport(base, 'colonial-helper'))]), /permission denied/);
    await assert.rejects(db.query('SELECT * FROM station_inventory_snapshots'), /permission denied/);
  } finally { await db.exec('RESET ROLE'); }
});

test('standalone commodity search uses durable inventory and never resurrects legacy removed goods', async () => {
  await db.exec(`INSERT INTO market_prices VALUES ('NameOnly','Sol','Steel',100,90,500,0,'2026-01-01','eddn')`);
  const rows = (await db.query("SELECT search_station_commodity('water',NULL,10) AS prices")).rows[0].prices;
  assert.ok(rows.some((r) => r.station_name === 'NameOnly' && r.stock === 100));
  const removed = (await db.query("SELECT search_station_commodity('Steel','Sol',10) AS prices")).rows[0].prices;
  assert.ok(!removed.some((r) => r.station_name === 'NameOnly'));
});

test('older rich data can fill unknown system coordinates without replacing a newer inventory', async () => {
  await save({ system_name: 'Sparse', station_name: 'Dock', market_id: '1000', observed_at: newer,
    inventories: { market: { observed_at: newer, items: [{ name: 'Steel', stock: 80 }] } } });
  const payload = spanshCommercePayload({ name: 'Sparse', coords: { x: 8, y: 0, z: 0 }, population: 300, date: old });
  await db.query('SELECT save_spansh_commerce($1::jsonb)', [JSON.stringify(payload)]);
  const candidates = (await db.query('SELECT nearby_commerce_systems(0,0,0,10) AS systems')).rows[0].systems;
  assert.ok(candidates.some((r) => r.system_name === 'Sparse'));
  assert.equal((await snapshots('market:1000'))[0].items[0].stock, 80);
});

test('later name-only reports reuse a known MarketID rather than reintroducing duplicate stations', async () => {
  await save({ ...base, market_id: undefined, station_name: 'NameOnly', observed_at: newer,
    inventories: { shipyard: { observed_at: newer, items: [{ name: 'sidewinder' }] } } }, 'eddn');
  assert.equal((await snapshots('market:789')).find((s) => s.kind === 'shipyard').items[0].name, 'sidewinder');
  assert.equal((await db.query("SELECT count(*)::int AS n FROM station_commerce WHERE station_name='NameOnly'")).rows[0].n, 1);
});

test('migration can be reapplied without erasing inventories', async () => {
  const before = await snapshots('market:456');
  await db.exec(readFileSync(new URL('../../supabase/migrations/20261014000000_station_commerce.sql', import.meta.url), 'utf8'));
  assert.deepEqual(await snapshots('market:456'), before);
});

await db.exec(readFileSync(new URL('../../supabase/migrations/20261014010000_station_search.sql', import.meta.url), 'utf8'));
// Поиск списком (2.25.0) переписывает плоский поиск поверх общей функции
// совпадений: все проверки `search_station_catalog` ниже идут уже по нему.
const BY_STATION = new URL('../../supabase/migrations/20261022120000_station_search_by_station.sql', import.meta.url);
await db.exec(readFileSync(BY_STATION, 'utf8'));
async function searchStations(kind, needles, overrides = {}) {
  const p = { cx: null, cy: null, cz: null, radius: 500, min_stock: 1, module_class: null, rating: null, fresh: false, sort: 'distance', offset: 0, limit: 50, ...overrides };
  return (await db.query('SELECT search_station_catalog($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) AS rows',
    [kind, needles, p.cx, p.cy, p.cz, p.radius, p.min_stock, p.module_class, p.rating, p.fresh, p.sort, p.offset, p.limit])).rows[0].rows;
}
test('station finder searches goods, module symbols with class/rating, ships and service aliases', async () => {
  await save({ ...base, market_id: '2000', station_name: 'Search Dock', observed_at: newer, metadata: { services: ['Tech Broker', 'Material Trader'] },
    inventories: { market: { observed_at: newer, items: [{ name: 'Steel', stock: 30, buyPrice: 90 }] },
      outfitting: { observed_at: newer, items: [{ name: 'int_hyperdrive_size5_class5' }, { name: 'int_hyperdrive_size4_class4' }] },
      shipyard: { observed_at: newer, items: [{ name: 'python', price: 56000000 }] } } });
  assert.ok((await searchStations('market', ['Steel'], { min_stock: 20 })).some((r) => r.station_name === 'Search Dock'));
  assert.ok(!(await searchStations('market', ['Steel'], { min_stock: 100 })).some((r) => r.station_name === 'Search Dock'));
  const modules = await searchStations('outfitting', ['hyperdrive'], { module_class: 5, rating: 'A' });
  assert.ok(modules.some((r) => r.station_name === 'Search Dock'));
  assert.ok(modules.every((r) => (r.item.symbol || r.item.name).includes('size5_class5')));
  assert.ok((await searchStations('shipyard', ['Python'])).some((r) => r.station_name === 'Search Dock'));
  assert.ok((await searchStations('services', ['techbroker','technologybroker'])).some((r) => r.station_name === 'Search Dock'));
  assert.deepEqual(await searchStations('shipyard', ['Python'], { fresh: true }), [], 'old snapshots are not promoted to fresh');
});

test('EDSM outfitting and shipyard responses reach the station search with symbol, class and rating', async () => {
  // Формат ответов EDSM /api-system-v1/stations/{outfitting,shipyard}: до 2.25.2 модули
  // читались из несуществующего `modules`, и снимок модулей из EDSM не доходил до поиска.
  const outfitting = edsmInventoryItems('outfitting', { marketId: 2100, sName: 'EDSM Dock', outfitting: [
    { id: 'int_hyperdrive_size5_class5', name: '5A Frame Shift Drive' },
    { id: 'hpt_pulselaser_gimbal_small', name: '1G Pulse Laser' },
    { id: null, name: '1I Lightweight Alloy' },
  ] });
  const shipyard = edsmInventoryItems('shipyard', { marketId: 2100, ships: [{ id: 128049249, name: 'Sidewinder' }] });
  await save({ ...base, market_id: '2100', station_name: 'EDSM Dock', observed_at: newer,
    inventories: { outfitting: { observed_at: newer, items: outfitting }, shipyard: { observed_at: newer, items: shipyard } } }, 'edsm');
  const modules = await searchStations('outfitting', ['hyperdrive'], { module_class: 5, rating: 'A' });
  assert.ok(modules.some((r) => r.station_name === 'EDSM Dock' && r.item.symbol === 'int_hyperdrive_size5_class5'));
  assert.ok((await searchStations('outfitting', ['Lightweight Alloy'])).some((r) => r.station_name === 'EDSM Dock'), 'модуль без символа ищется по названию');
  // В символе орудия рейтинга нет: 1G берётся из справочника FDevIDs, а не заглушкой E.
  const dock = (rows) => rows.some((r) => r.station_name === 'EDSM Dock');
  assert.ok(dock(await searchStations('outfitting', ['Pulse Laser'], { module_class: 1, rating: 'G' })), 'фильтр 1G находит 1G Pulse Laser');
  assert.ok(!dock(await searchStations('outfitting', ['Pulse Laser'], { module_class: 1, rating: 'E' })), 'фильтр 1E его не находит');
  assert.ok((await searchStations('shipyard', ['Sidewinder'])).some((r) => r.station_name === 'EDSM Dock'));

  // Пустой список — честный пустой снимок; нет списка (в том числе выдуманного `modules`) — «данных нет».
  assert.deepEqual(edsmInventoryItems('outfitting', { outfitting: [] }), []);
  assert.equal(edsmInventoryItems('outfitting', { modules: [{ name: 'int_hyperdrive_size5_class5' }] }), null);
  assert.equal(edsmInventoryItems('shipyard', null), null);
  assert.deepEqual(edsmInventoryItems('outfitting', { outfitting: [{ id: 'bad symbol!', name: 'X' }, ' Y ', { id: 5 }] }), [{ name: 'X' }, { name: 'Y' }]);
  assert.deepEqual(edsmInventoryItems('shipyard', { ships: [{ id: 'x', name: 'Anaconda' }] }), [{ name: 'Anaconda' }]);
});

test('station reports grade modules from the FDevIDs catalogue: weapons get their real rating, source values win', () => {
  const report = canonicalReport({ ...base, inventories: { outfitting: { observed_at: old, items: [
    { name: 'Hpt_PulseLaser_Gimbal_Small' }, // EDDN: только символ
    { name: '$hpt_beamlaser_turret_large_name;' }, // журнал/CAPI
    { name: 'Hpt_MultiCannon_Fixed_Small_Advanced' },
    { name: 'Int_Hyperdrive_Size5_Class5' },
    { name: 'Int_GuardianFSDBooster_Size5' },
    { name: 'Hpt_Railgun_Fixed_Medium', class: 2, rating: 'X' }, // значение источника (Spansh) не переписываем
    { name: 'Hpt_Unknown_Fixed_Small' },
    { name: 'Not a module' },
  ] } } }, 'eddn');
  const grades = report.inventories.outfitting.items.map((item) => `${item.class ?? ''}${item.rating ?? ''}`);
  assert.deepEqual(grades, ['1G', '3D', '1F', '5A', '5H', '2X', '', '']);
});

test('named engineer search requires an observed database station, with coordinates included', async () => {
  assert.deepEqual(await searchStations('services', ['Felicity Farseer']), []);
  await save({ system_name: 'Deciat', station_name: 'Farseer Inc.', market_id: '2001', x: 20, y: 0, z: 0, observed_at: newer });
  const rows = await searchStations('services', ['Felicity Farseer']);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].system_name, 'Deciat');
  assert.equal(rows[0].x, 20);
  assert.ok(!(await searchStations('services', ['engineer'], { cx: 0, cy: 0, cz: 0, radius: 10 })).some((r) => r.system_name === 'Deciat'));
});

test('station search preserves zero coordinates, real distance, price order, and a pagination lookahead', async () => {
  const near = await searchStations('market', ['Steel'], { cx: 0, cy: 0, cz: 0, radius: 1 });
  const row = near.find((r) => r.station_name === 'Search Dock');
  assert.equal(row.distance, 0);
  assert.equal(row.x, 0);
  const limit = await searchStations('outfitting', ['hyperdrive'], { limit: 1 });
  assert.equal(limit.length, 2, 'one extra row is returned for has_more');
  const priceRows = await searchStations('market', ['Steel'], { sort: 'price' });
  assert.equal(priceRows[0].item.buyPrice, 90);
});

async function stationList(kind, needles, overrides = {}) {
  const p = { exact: null, cx: null, cy: null, cz: null, radius: 500, min_stock: 1, module_class: null, rating: null,
    fresh: false, sort: 'distance', offset: 0, limit: 50, items: 100, ...overrides };
  return (await db.query('SELECT search_station_catalog_stations($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) AS result',
    [kind, needles, p.exact, p.cx, p.cy, p.cz, p.radius, p.min_stock, p.module_class, p.rating, p.fresh, p.sort, p.offset, p.limit, p.items])).rows[0].result;
}

test('station list returns one row per station with every match, counts stations and keeps a picked item exact', async () => {
  await save({ ...base, market_id: '3000', station_name: 'List Dock', x: 1, y: 0, z: 0, observed_at: newer,
    inventories: {
      market: { observed_at: newer, items: [
        { name: 'water', stock: 50, buyPrice: 300, sellPrice: 280, demand: 0 },
        { name: 'waterpurifiers', stock: 20, buyPrice: 500 },
        { name: '$gold_name;', stock: 5, buyPrice: 9000 },
      ] },
      outfitting: { observed_at: newer, items: [
        { name: 'int_shieldgenerator_size5_class5', price: 1000 },
        { name: 'int_shieldgenerator_size5_class5_strong', price: 2000 },
        { name: 'Int_ShieldGenerator_Size4_Class3_Fast', price: 3000 },
      ] },
    } });
  const loose = await stationList('market', ['Water'], { cx: 0, cy: 0, cz: 0, radius: 20 });
  const dock = loose.stations.find((s) => s.station_name === 'List Dock');
  assert.equal(dock.item_count, 2, 'free text still finds every name containing the query');
  assert.deepEqual(dock.items.map((item) => item.name).sort(), ['Water', 'Water Purifiers']);
  assert.equal(dock.best_price, 300);
  assert.equal(dock.distance, 1);
  assert.equal(dock.stale, true);
  assert.equal(loose.total, loose.stations.length, 'total counts stations, not station/item pairs');

  const exact = await stationList('market', ['Water'], { exact: ['Water', 'water'] });
  const exactDock = exact.stations.find((s) => s.station_name === 'List Dock');
  assert.equal(exactDock.item_count, 1);
  assert.deepEqual(exactDock.items.map((item) => item.name), ['Water']);
  assert.equal(exactDock.items[0].sellPrice, 280);

  const gold = await stationList('market', [], { exact: ['Gold'] });
  assert.deepEqual(gold.stations.map((s) => s.station_name), ['List Dock'], 'Helper $gold_name; matches the English name key');

  const shields = await stationList('outfitting', [], { exact: ['Int_ShieldGenerator_Size5_Class5'] });
  assert.deepEqual(shields.stations.find((s) => s.station_name === 'List Dock').items.map((item) => item.name),
    ['int_shieldgenerator_size5_class5'], 'a plain shield pick does not return prismatic or bi-weave shields');
  const prismatic = await stationList('outfitting', [], { exact: ['$int_shieldgenerator_size5_class5_strong_name;'] });
  assert.equal(prismatic.stations[0].items[0].name, 'int_shieldgenerator_size5_class5_strong');
});

test('station list pages by station with a lookahead, sorts by best price and caps the items of a row', async () => {
  await save({ ...base, market_id: '3001', station_name: 'Cheap Dock', x: 3, y: 0, z: 0, observed_at: newer,
    inventories: { market: { observed_at: newer, items: [{ name: 'Steel', stock: 40, buyPrice: 50 }] } } });
  await save({ ...base, market_id: '3002', station_name: 'Far Dock', x: 9, y: 0, z: 0, observed_at: old,
    inventories: { market: { observed_at: old, items: [{ name: 'Steel', stock: 40, buyPrice: 120 }] } } });
  const all = await stationList('market', ['Steel'], { cx: 0, cy: 0, cz: 0, radius: 20 });
  assert.ok(all.total >= 3);
  const distances = all.stations.map((s) => s.distance);
  assert.deepEqual(distances, [...distances].sort((a, b) => a - b), 'default order is by distance');
  const page = await stationList('market', ['Steel'], { cx: 0, cy: 0, cz: 0, radius: 20, limit: 1 });
  assert.equal(page.stations.length, 2, 'one extra station tells the API that there is a next page');
  assert.equal(page.total, all.total);
  const second = await stationList('market', ['Steel'], { cx: 0, cy: 0, cz: 0, radius: 20, limit: 1, offset: 1 });
  assert.equal(second.stations[0].station_key, page.stations[1].station_key);
  const cheap = await stationList('market', ['Steel'], { sort: 'price' });
  assert.equal(cheap.stations[0].station_name, 'Cheap Dock');
  assert.equal(cheap.stations[0].best_price, 50);
  const updated = await stationList('market', ['Steel'], { sort: 'updated' });
  assert.notEqual(updated.stations[0].station_name, 'Far Dock', 'the oldest snapshot is not first when sorting by update');
  const capped = await stationList('outfitting', ['shieldgenerator'], { items: 1 });
  const row = capped.stations.find((s) => s.station_name === 'List Dock');
  assert.equal(row.items.length, 1);
  assert.equal(row.item_count, 3);
  const beyond = await stationList('market', ['Steel'], { offset: 4000 });
  assert.deepEqual(beyond.stations, []);
  assert.equal(beyond.total, cheap.total, 'an empty page still reports the total');
});

test('station list migration is idempotent and stays service-only', async () => {
  const before = await searchStations('market', ['Steel']);
  await db.exec(readFileSync(BY_STATION, 'utf8'));
  assert.deepEqual(await searchStations('market', ['Steel']), before);
  await db.exec('SET ROLE authenticated');
  try {
    await assert.rejects(db.query("SELECT search_station_catalog_stations('market', ARRAY['Steel'])"), /permission denied/);
    await assert.rejects(db.query("SELECT * FROM station_catalog_matches('market', ARRAY['Steel'])"), /permission denied/);
  } finally { await db.exec('RESET ROLE'); }
  assert.equal((await db.query("SELECT station_item_key('$Steel_Name;') AS key")).rows[0].key, 'steel');
});
