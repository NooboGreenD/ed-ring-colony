import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

/* Учёт авианосцев в БД (supabase/migrations/20261017000000_fleet_carriers.sql).
   Функция apply_fleet_carrier_batch получает уже нормализованные операции —
   здесь проверяется сама книга груза и правила «свежее побеждает». */

const db = new PGlite();
const OWNER = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const MEMBER = '00000000-0000-4000-8000-000000000003';
const FC = '3700005632';
const FC2 = '3700009999';
const SQ_FC = '3709000001';

await db.exec(`
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
CREATE SCHEMA auth;
CREATE TABLE auth.users(id uuid PRIMARY KEY);
INSERT INTO auth.users VALUES ('${OWNER}'), ('${OTHER}'), ('${MEMBER}');
CREATE TABLE public.profiles(id uuid PRIMARY KEY);
CREATE TABLE public.squadrons(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name text, tag text);
INSERT INTO public.squadrons(name, tag) VALUES ('Alpha', 'ALP'), ('Beta', 'BET');
CREATE TABLE public.squadron_members(squadron_id bigint, user_id uuid);
INSERT INTO public.squadron_members VALUES (1, '${MEMBER}'), (2, '${OTHER}');
CREATE TABLE public.squadron_carriers(id serial, squadron_id integer, owner_id uuid, carrier_name text, carrier_id text,
  callsign text, current_system text, x numeric, y numeric, z numeric, updated_at timestamptz, created_at timestamptz);
INSERT INTO public.squadron_carriers(squadron_id, owner_id, carrier_name, carrier_id, callsign, current_system, updated_at, created_at)
  VALUES (2, '${OTHER}', 'Legacy Hauler', '3700001111', 'LEG-001', 'Sol', '2026-01-01', '2026-01-01'),
         (1, '${MEMBER}', 'Broken', 'not-a-number', null, null, '2026-01-01', '2026-01-01');
CREATE TABLE colonisation_market_systems(system_name text,x float8,y float8,z float8,has_market boolean,last_checked_at timestamptz);
CREATE TABLE market_search_jobs(id integer);
CREATE TABLE market_search_cache(market_id bigint);
CREATE TABLE market_prices(station_name text,system_name text,commodity_name text,buy_price integer,sell_price integer,stock integer,demand integer,reported_at timestamptz,source text);
`);
await db.exec(readFileSync(new URL('../../supabase/migrations/20261014000000_station_commerce.sql', import.meta.url), 'utf8'));
await db.exec(readFileSync(new URL('../../supabase/migrations/20261017000000_fleet_carriers.sql', import.meta.url), 'utf8'));

let hashCounter = 0;
const hash = () => (++hashCounter).toString(16).padStart(64, '0');

async function apply(ops, user = OWNER, source = 'helper') {
  const { rows } = await db.query('SELECT apply_fleet_carrier_batch($1::uuid, $2, $3::jsonb) AS r', [user, source, JSON.stringify(ops)]);
  return rows[0].r;
}
async function cargo(carrier = FC) {
  const { rows } = await db.query(
    'SELECT commodity, quantity FROM fleet_carrier_cargo WHERE carrier_id = $1 AND quantity > 0 ORDER BY commodity', [carrier]);
  return Object.fromEntries(rows.map((row) => [row.commodity, row.quantity]));
}
async function carrier(id = FC) {
  return (await db.query('SELECT * FROM fleet_carriers WHERE carrier_id = $1', [id])).rows[0];
}
const delta = (at, commodity, value, h = hash(), carrier_id = FC) => ({ op: 'delta', carrier_id, at, commodity, delta: value, hash: h, event: 'MarketSell' });

test.after(async () => { await db.close(); });

test('legacy squadron_carriers rows become squadron bindings; malformed ids are skipped', async () => {
  const legacy = await carrier('3700001111');
  assert.equal(Number(legacy.squadron_id), 2);
  assert.equal(legacy.squadron_source, 'legacy');
  assert.equal(legacy.callsign, 'LEG-001');
  assert.equal(legacy.system_name, 'Sol');
  const { rows } = await db.query('SELECT count(*)::int AS n FROM fleet_carriers');
  assert.equal(rows[0].n, 1);
});

test('deltas are idempotent by hash and recomputed from the ledger', async () => {
  const h1 = hash();
  let result = await apply([delta('2026-02-01T10:00:00Z', 'steel', 500, h1), delta('2026-02-01T10:01:00Z', 'steel', -120)]);
  assert.equal(result.applied, 2);
  // The website and Helper upload the same MarketSell: same hash, no double count.
  result = await apply([delta('2026-02-01T10:00:00Z', 'steel', 500, h1)], OWNER, 'web');
  assert.equal(result.duplicates, 1);
  assert.deepEqual(await cargo(), { steel: 380 });
  // Selling more than tracked never makes the hold negative.
  await apply([delta('2026-02-01T10:02:00Z', 'steel', -1000)]);
  assert.deepEqual(await cargo(), {});
});

test('a full baseline (empty hold) supersedes earlier deltas, even ones uploaded later', async () => {
  await apply([{ op: 'baseline', carrier_id: FC, at: '2026-02-02T00:00:00Z', full: true, source_event: 'CarrierStats', items: [] }]);
  await apply([delta('2026-02-02T01:00:00Z', 'aluminium', 700), delta('2026-02-02T02:00:00Z', 'steel', 50)]);
  // An old log uploaded afterwards (before the baseline) must not resurrect cargo.
  const late = await apply([delta('2026-02-01T23:00:00Z', 'titanium', 999)]);
  assert.equal(late.applied, 1);
  assert.deepEqual(await cargo(), { aluminium: 700, steel: 50 });
  // Older full baselines are ignored.
  const stale = await apply([{ op: 'baseline', carrier_id: FC, at: '2026-02-01T00:00:00Z', full: true, items: [] }]);
  assert.equal(stale.ignored, 1);
  assert.deepEqual(await cargo(), { aluminium: 700, steel: 50 });
});

test('a market snapshot sets sold commodities; later deltas still apply; older snapshots do not win', async () => {
  await apply([{ op: 'baseline', carrier_id: FC, at: '2026-02-02T03:00:00Z', full: false, source_event: 'Market',
    items: [{ commodity: 'aluminium', qty: 400, name_localised: 'Aluminium' }] }]);
  await apply([delta('2026-02-02T03:05:00Z', 'aluminium', -100)]);
  await apply([{ op: 'baseline', carrier_id: FC, at: '2026-02-02T02:30:00Z', full: false, source_event: 'Market',
    items: [{ commodity: 'aluminium', qty: 5000 }] }]);
  assert.deepEqual(await cargo(), { aluminium: 300, steel: 50 });
  const { rows } = await db.query("SELECT name_localised FROM fleet_carrier_cargo WHERE carrier_id=$1 AND commodity='aluminium'", [FC]);
  assert.equal(rows[0].name_localised, 'Aluminium');
});

test('stats and identity: newest observation wins per field; weak dock names never replace real names', async () => {
  await apply([
    { op: 'identity', carrier_id: FC, at: '2026-02-03T00:00:00Z', callsign: 'L14-X1J', name: 'L14-X1J', weak_name: true },
    { op: 'stats', carrier_id: FC, at: '2026-02-03T00:00:00Z', name: 'Spirula', callsign: 'L14-X1J', docking_access: 'all',
      allow_notorious: false, fuel_level: 63, pending_decommission: false,
      space_usage: { total_capacity: 25000, cargo: 440, free_space: 17379 }, finance: { carrier_balance: 1e7 },
      services: [{ role: 'Refuel', activated: true, enabled: false }, { role: 'Shipyard', activated: false, enabled: false }] },
  ]);
  await apply([{ op: 'identity', carrier_id: FC, at: '2026-02-04T00:00:00Z', name: 'L14-X1J', weak_name: true }]);
  let row = await carrier();
  assert.equal(row.name, 'Spirula');
  assert.equal(row.fuel_level, 63);
  // Older CarrierStats are ignored entirely.
  const old = await apply([{ op: 'stats', carrier_id: FC, at: '2026-02-01T00:00:00Z', fuel_level: 1, docking_access: 'none' }]);
  assert.equal(old.ignored, 1);
  // Crew services: newer CarrierCrewServices patches one role.
  await apply([
    { op: 'service', carrier_id: FC, at: '2026-02-03T01:00:00Z', role: 'Refuel', operation: 'resume' },
    { op: 'service', carrier_id: FC, at: '2026-02-03T02:00:00Z', role: 'VistaGenomics', operation: 'activate', crew_name: 'Bob' },
    { op: 'docking', carrier_id: FC, at: '2026-02-03T03:00:00Z', docking_access: 'squadronfriends', allow_notorious: true },
    { op: 'decommission', carrier_id: FC, at: '2026-02-03T04:00:00Z', pending: true },
  ]);
  row = await carrier();
  const refuel = row.services.find((s) => s.role === 'Refuel');
  assert.equal(refuel.enabled, true);
  assert.deepEqual(row.services.find((s) => s.role === 'VistaGenomics'), { role: 'VistaGenomics', activated: true, enabled: true, crew_name: 'Bob' });
  assert.equal(row.docking_access, 'squadronfriends');
  assert.equal(row.pending_decommission, true);
  await apply([{ op: 'decommission', carrier_id: FC, at: '2026-02-03T05:00:00Z', pending: false }]);
  assert.equal((await carrier()).pending_decommission, false);
});

test('trade orders: newest wins, cancel removes', async () => {
  await apply([
    { op: 'order', carrier_id: FC, at: '2026-02-05T00:00:00Z', commodity: 'steel', name_localised: 'Steel', purchase: 1000, price: 4000 },
    { op: 'order', carrier_id: FC, at: '2026-02-05T00:00:00Z', commodity: 'water', sale: 200, price: 300 },
  ]);
  await apply([{ op: 'order', carrier_id: FC, at: '2026-02-04T00:00:00Z', commodity: 'steel', purchase: 1 }]);
  await apply([{ op: 'order', carrier_id: FC, at: '2026-02-05T01:00:00Z', commodity: 'water', cancel: true }]);
  const orders = (await carrier()).trade_orders;
  assert.deepEqual(Object.keys(orders), ['steel']);
  assert.equal(orders.steel.purchase, 1000);
});

test('personal binding: proofs bind, soft proofs never steal, the newest carrier keeps the slot', async () => {
  await apply([{ op: 'owner', carrier_id: FC, at: '2026-02-03T00:00:00Z', proof: 'journal' }]);
  assert.equal((await carrier()).owner_id, OWNER);
  // Another pilot's CarrierLocation (soft) cannot take a proven carrier.
  const soft = await apply([{ op: 'owner', carrier_id: FC, at: '2026-02-06T00:00:00Z', proof: 'soft' }], OTHER);
  assert.equal(soft.ignored, 1);
  assert.equal((await carrier()).owner_id, OWNER);
  // New carrier bought later: the slot moves to it.
  await apply([{ op: 'owner', carrier_id: FC2, at: '2026-03-01T00:00:00Z', proof: 'journal' }]);
  assert.equal((await carrier(FC2)).owner_id, OWNER);
  assert.equal((await carrier()).owner_id, null);
  // Replaying an old journal with the decommissioned carrier does not move it back.
  const replay = await apply([{ op: 'owner', carrier_id: FC, at: '2026-02-04T00:00:00Z', proof: 'journal' }]);
  assert.equal(replay.ignored, 1);
  assert.equal((await carrier(FC2)).owner_id, OWNER);
});

test('squadron carriers: type clears personal ownership, members auto-bind to their own squadron only', async () => {
  await apply([{ op: 'identity', carrier_id: SQ_FC, at: '2026-03-02T00:00:00Z', carrier_type: 'SquadronCarrier' }]);
  // A personal claim on a squadron carrier is refused.
  const personal = await apply([{ op: 'owner', carrier_id: SQ_FC, at: '2026-03-02T00:00:01Z', proof: 'journal' }], MEMBER);
  assert.equal(personal.ignored, 1);
  await apply([{ op: 'squadron_claim', carrier_id: SQ_FC, at: '2026-03-02T00:00:02Z' }], MEMBER);
  let row = await carrier(SQ_FC);
  assert.equal(row.carrier_type, 'SquadronCarrier');
  assert.equal(row.owner_id, null);
  assert.equal(Number(row.squadron_id), 1);
  // A member of another squadron cannot rebind it.
  const foreign = await apply([{ op: 'squadron_claim', carrier_id: SQ_FC, at: '2026-03-03T00:00:00Z' }], OTHER);
  assert.equal(foreign.ignored, 1);
  row = await carrier(SQ_FC);
  assert.equal(Number(row.squadron_id), 1);
});

test('location: newest wins, completed jumps clear, old requests are ignored, the market moves with the carrier', async () => {
  await db.query(`SELECT save_station_commerce($1::jsonb)`, [JSON.stringify({
    system_name: 'Sol', station_name: 'L14-X1J', market_id: FC, station_key: `market:${FC}`, source: 'colonial-helper',
    station_type: 'FleetCarrier', observed_at: '2026-02-10T00:00:00Z', metadata: { body_name: 'Earth' },
    inventories: { market: { observed_at: '2026-02-10T00:00:00Z', items: [{ name: 'Steel', stock: 10 }] } } })]);
  await db.exec(`INSERT INTO market_prices VALUES ('L14-X1J','Sol','Steel',100,90,500,0,'2026-02-10','eddn')`);

  await apply([
    { op: 'location', carrier_id: FC, at: '2026-02-11T00:00:00Z', system_name: 'Sol', system_address: 10477373803, body_id: 3, source_event: 'CarrierLocation' },
    { op: 'jump', carrier_id: FC, at: '2026-02-11T01:00:00Z', system_name: 'Alpha Centauri', body_name: 'Alpha Centauri A', departure_at: '2026-02-11T01:15:00Z' },
  ]);
  let row = await carrier();
  assert.equal(row.jump_system_name, 'Alpha Centauri');
  // An older location must not move the carrier back.
  const stale = await apply([{ op: 'location', carrier_id: FC, at: '2026-02-10T00:00:00Z', system_name: 'Achenar' }]);
  assert.equal(stale.ignored, 1);
  // Arrival after the departure time clears the scheduled jump and moves the market.
  const arrival = await apply([{ op: 'location', carrier_id: FC, at: '2026-02-11T01:20:00Z', system_name: 'Alpha Centauri', x: 3.03, y: -0.09, z: 3.16, source_event: 'CarrierJump' }]);
  assert.equal(arrival.stations_moved, 1);
  row = await carrier();
  assert.equal(row.system_name, 'Alpha Centauri');
  assert.equal(row.system_address, null, 'address of the previous system is dropped');
  assert.equal(row.body_id, null);
  assert.equal(row.jump_system_name, null);
  const station = (await db.query(`SELECT system_name, metadata FROM station_commerce WHERE station_key=$1`, [`market:${FC}`])).rows[0];
  assert.equal(station.system_name, 'Alpha Centauri');
  assert.deepEqual(station.metadata, {});
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM market_prices WHERE station_name='L14-X1J'`)).rows[0].n, 0);
  // The market snapshot stays attached to the MarketID.
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM station_inventory_snapshots WHERE station_key=$1`, [`market:${FC}`])).rows[0].n, 1);
  // A jump request whose departure already happened before the known location is stale.
  const oldJump = await apply([{ op: 'jump', carrier_id: FC, at: '2026-02-11T00:30:00Z', system_name: 'Achenar', departure_at: '2026-02-11T00:45:00Z' }]);
  assert.equal(oldJump.ignored, 1);
  // Cancel clears a pending request.
  await apply([{ op: 'jump', carrier_id: FC, at: '2026-02-12T00:00:00Z', system_name: 'Barnard', departure_at: '2026-02-12T00:15:00Z' }]);
  await apply([{ op: 'jump_cancel', carrier_id: FC, at: '2026-02-12T00:05:00Z' }]);
  assert.equal((await carrier()).jump_system_name, null);
});

test('invalid input: bad ids, timestamps from the future, unknown ops and malformed deltas are ignored', async () => {
  const result = await apply([
    { op: 'delta', carrier_id: 'abc', at: '2026-02-01T00:00:00Z', commodity: 'steel', delta: 1, hash: hash() },
    { op: 'delta', carrier_id: FC, at: '2999-01-01T00:00:00Z', commodity: 'steel', delta: 1, hash: hash() },
    { op: 'delta', carrier_id: FC, at: '2026-02-20T00:00:00Z', commodity: 'Steel!', delta: 1, hash: hash() },
    { op: 'delta', carrier_id: FC, at: '2026-02-20T00:00:00Z', commodity: 'steel', delta: 1, hash: 'nothex' },
    { op: 'teleport', carrier_id: FC, at: '2026-02-20T00:00:00Z' },
  ]);
  assert.equal(result.applied, 0);
  assert.equal(result.ignored, 5);
  await assert.rejects(apply([], OWNER, 'evil'), /Invalid carrier source/);
});

test('only service_role may execute the batch function', async () => {
  const { rows } = await db.query(`
    SELECT has_function_privilege('anon', 'public.apply_fleet_carrier_batch(uuid,text,jsonb)', 'EXECUTE') AS anon_exec,
           has_function_privilege('authenticated', 'public.apply_fleet_carrier_batch(uuid,text,jsonb)', 'EXECUTE') AS auth_exec,
           has_table_privilege('anon', 'public.fleet_carriers', 'SELECT') AS anon_select`);
  assert.deepEqual(rows[0], { anon_exec: false, auth_exec: false, anon_select: false });
});
