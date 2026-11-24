import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { normalizeCarrierEvents, carrierOpsFromStationReport } from '../../src/lib/fleetCarriers.ts';

/* Учёт авианосцев в БД (supabase/migrations/20261017000000_fleet_carriers.sql и
   20261018000000_fleet_carrier_squadron_claims.sql — правила привязки Javelin).
   Функция apply_fleet_carrier_batch получает уже нормализованные операции —
   здесь проверяется сама книга груза и правила «свежее побеждает». Переход
   со старых привязок и все правила squadron_claim —
   fleet-carriers-squadron-claims.test.mjs. */

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
await db.exec(readFileSync(new URL('../../supabase/migrations/20261018000000_fleet_carrier_squadron_claims.sql', import.meta.url), 'utf8'));
await db.exec(readFileSync(new URL('../../supabase/migrations/20261123120000_carrier_cargo_observation_time.sql', import.meta.url), 'utf8'));
await db.exec(readFileSync(new URL('../../supabase/migrations/20261124100000_squadron_cargo_no_negative_debt.sql', import.meta.url), 'utf8'));

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
  // Привязку дают только свежие события (30 дней), поэтому время — от «сейчас».
  const recent = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
  await apply([{ op: 'identity', carrier_id: SQ_FC, at: recent(30), carrier_type: 'SquadronCarrier' }]);
  // A personal claim on a squadron carrier is refused.
  const personal = await apply([{ op: 'owner', carrier_id: SQ_FC, at: recent(29), proof: 'journal' }], MEMBER);
  assert.equal(personal.ignored, 1);
  // A claim without a membership proof (old server: docking) is refused too.
  const unproven = await apply([{ op: 'squadron_claim', carrier_id: SQ_FC, at: recent(28) }], MEMBER);
  assert.equal(unproven.ignored, 1);
  assert.equal((await carrier(SQ_FC)).squadron_id, null);
  await apply([{ op: 'squadron_claim', carrier_id: SQ_FC, at: recent(27), proof: 'CarrierLocation' }], MEMBER);
  let row = await carrier(SQ_FC);
  assert.equal(row.carrier_type, 'SquadronCarrier');
  assert.equal(row.owner_id, null);
  assert.equal(Number(row.squadron_id), 1);
  assert.equal(row.squadron_source, 'member');
  // A member of another squadron cannot rebind it.
  const foreign = await apply([{ op: 'squadron_claim', carrier_id: SQ_FC, at: recent(26), proof: 'CarrierStats' }], OTHER);
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
           has_function_privilege('anon', 'public.fleet_carrier_tag_conflict(text,bigint)', 'EXECUTE') AS anon_tag,
           has_function_privilege('service_role', 'public.apply_fleet_carrier_batch(uuid,text,jsonb)', 'EXECUTE') AS service_exec,
           has_table_privilege('anon', 'public.fleet_carriers', 'SELECT') AS anon_select`);
  assert.deepEqual(rows[0], { anon_exec: false, auth_exec: false, anon_tag: false, service_exec: true, anon_select: false });
});

test('squadron partial market stock, bank deltas, depletion and observation time survive retries/late history', async () => {
  const id = '3709000901';
  const baseline = (at, items) => ({ op: 'baseline', carrier_id: id, at, full: false, source_event: 'Market', items });
  await apply([baseline('2026-03-01T10:00:00Z', [{ commodity: 'steel', qty: 100 }, { commodity: 'water', qty: 50 }])]);
  const bank = { ...delta('2026-03-01T10:01:00Z', 'steel', 500, hash(), id), event: 'SquadronBankTransfer' };
  await apply([bank]);
  await apply([bank]); // lost response and retry: never duplicate the bank transfer
  assert.deepEqual(await cargo(id), { steel: 600, water: 50 });
  await apply([baseline('2026-03-01T10:02:00Z', [{ commodity: 'steel', qty: 900 }])]);
  assert.deepEqual(await cargo(id), { steel: 900, water: 50 });
  await apply([delta('2026-03-01T09:00:00Z', 'steel', 9999, hash(), id)]); // recent write != recent observation
  assert.deepEqual(await cargo(id), { steel: 900, water: 50 });
  let row = (await db.query("SELECT observed_at FROM fleet_carrier_cargo WHERE carrier_id=$1 AND commodity='steel'", [id])).rows[0];
  assert.equal(new Date(row.observed_at).toISOString(), '2026-03-01T10:02:00.000Z');
  await apply([baseline('2026-03-01T10:03:00Z', [{ commodity: 'steel', qty: 0 }])]);
  assert.deepEqual(await cargo(id), { water: 50 });
  row = (await db.query("SELECT quantity, observed_at FROM fleet_carrier_cargo WHERE carrier_id=$1 AND commodity='steel'", [id])).rows[0];
  assert.equal(Number(row.quantity), 0);
  assert.equal(new Date(row.observed_at).toISOString(), '2026-03-01T10:03:00.000Z');
});

test('cargo observation migration backfills existing rows, is repeatable and does not grant public execution', async () => {
  const id = '3709000901';
  await db.query('UPDATE fleet_carrier_cargo SET observed_at = NULL WHERE carrier_id=$1', [id]);
  await db.exec(readFileSync(new URL('../../supabase/migrations/20261123120000_carrier_cargo_observation_time.sql', import.meta.url), 'utf8'));
  const row = (await db.query("SELECT observed_at FROM fleet_carrier_cargo WHERE carrier_id=$1 AND commodity='steel'", [id])).rows[0];
  assert.equal(new Date(row.observed_at).toISOString(), '2026-03-01T10:03:00.000Z');
  assert.deepEqual(await cargo(id), { water: 50 });
  const acl = (await db.query("SELECT has_function_privilege('anon', 'public.fleet_carrier_cargo_observation_time()', 'EXECUTE') AS allowed")).rows[0];
  assert.equal(acl.allowed, false);
});

test('member sales enter the real ledger, but cannot reveal pre-existing squadron stock without a baseline', async () => {
  const id = '3713477376';
  const sales = JSON.parse(readFileSync(new URL('./fixtures/squadron-market-sales.json', import.meta.url), 'utf8'));
  const { ops } = normalizeCarrierEvents(sales, { userId: MEMBER, now: new Date('2026-11-24T01:00:00Z') });
  // MEMBER has squadron membership, no carrier ownership or officer proof.
  await apply([{ op: 'identity', carrier_id: id, at: '2026-11-23T22:00:00Z', carrier_type: 'SquadronCarrier' }], MEMBER);
  const result = await apply(ops, MEMBER);
  assert.equal(result.applied, 4);
  assert.deepEqual(await cargo(id), { steel: 5280 });
  assert.equal((await carrier(id)).owner_id, null);
  assert.equal((await apply(ops, MEMBER)).duplicates, 4);
  // A consumer order (the carrier BUYS steel) exposes demand, not bank stock.
  const marketOps = carrierOpsFromStationReport({ market_id: id, station_type: 'FleetCarrier',
    station_name: 'DNHG', system_name: 'Test System', observed_at: '2026-11-24T00:23:00Z',
    metadata: { services: ['squadronBank'] }, inventories: { market: {
      observed_at: '2026-11-24T00:23:00Z', items: [
        { name: 'steel', stock: 0, demand: 20000, producer: false, consumer: true },
      ],
    } },
  });
  assert.deepEqual(marketOps.find(op => op.op === 'baseline').items, []);
  await apply(marketOps, MEMBER);
  assert.deepEqual(await cargo(id), { steel: 5280 });
  // Officer-only CarrierStats supplies a total, NOT a per-commodity inventory.
  await apply([{ op: 'stats', carrier_id: id, at: '2026-11-24T00:24:00Z',
    space_usage: { cargo: 17280, free_space: 42720, total_capacity: 60000 } }], OWNER);
  assert.deepEqual(await cargo(id), { steel: 5280 });
  // Illustrative prior inventory, NOT a measurement of the user's carrier.
  // Even an older snapshot supplies missing opening stock; later sales remain.
  await apply([{ op: 'baseline', carrier_id: id, at: '2026-11-23T23:00:00Z',
    full: true, source_event: 'capi', items: [
      { commodity: 'steel', qty: 10000 }, { commodity: 'water', qty: 2000 },
    ] }], OWNER);
  assert.deepEqual(await cargo(id), { steel: 15280, water: 2000 });
  assert.equal((await apply(ops, MEMBER)).duplicates, 4);
  assert.deepEqual(await cargo(id), { steel: 15280, water: 2000 });
});

test('a later inactive market row must not erase squadron sales; the next sale must add to existing bank stock', async () => {
  const { bundleFile } = await import('./helpers/bundle.mjs');
  const { applyCarrierOps } = await import(await bundleFile({ entry: 'src/lib/fleetCarrierStore.ts' }));
  const id = '3713477999';
  const svc = {
    from(table) { assert.equal(table, 'fleet_carriers'); return {
      select() { return this; },
      async in(_column, ids) { return { data: (await db.query('SELECT carrier_id, carrier_type FROM fleet_carriers WHERE carrier_id = ANY($1::bigint[])', [ids])).rows, error: null }; },
    }; },
    async rpc(_name, params) { return { data: await apply(params.p_ops, MEMBER), error: null }; },
  };
  const send = ops => applyCarrierOps(svc, MEMBER, 'helper', ops);
  await send([{ op: 'identity', carrier_id: id, at: '2026-03-01T10:00:00Z', carrier_type: 'SquadronCarrier' },
    delta('2026-03-01T10:01:00Z', 'steel', 1320, hash(), id)]);
  // Old Helper/report without station services: lookup must still recognise Javelin.
  const snapshot = carrierOpsFromStationReport({ market_id: id, station_type: 'FleetCarrier', station_name: 'TEST',
    system_name: 'Sol', observed_at: '2026-03-01T10:02:00Z', inventories: { market: {
      observed_at: '2026-03-01T10:02:00Z', items: [{ name: 'steel', stock: 0, demand: 0, producer: false, consumer: false }],
    } },
  });
  await send(snapshot);
  assert.deepEqual(await cargo(id), { steel: 1320 });
  await send([delta('2026-03-01T10:03:00Z', 'steel', 1320, hash(), id)]);
  assert.deepEqual(await cargo(id), { steel: 2640 });
});

test('actual Nov 24 market: steel demand is not bank stock; no inventory row may erase tracked squadron goods', async () => {
  const market = JSON.parse(readFileSync(new URL('./fixtures/squadron-current-market.json', import.meta.url), 'utf8'));
  const id = String(market.MarketID);
  const steel = market.Items.find(item => item.Name === '$steel_name;');
  assert.deepEqual(steel, { Name: '$steel_name;', Stock: 0, Demand: 7003, Producer: false, Consumer: true });
  const before = await cargo(id);
  assert.ok(before.steel > 0);
  const { bundleFile } = await import('./helpers/bundle.mjs');
  const { applyCarrierOps } = await import(await bundleFile({ entry: 'src/lib/fleetCarrierStore.ts' }));
  const ops = carrierOpsFromStationReport({
    market_id: id, station_type: market.StationType, station_name: market.StationName,
    system_name: market.StarSystem, observed_at: market.timestamp,
    inventories: { market: { observed_at: market.timestamp, items: market.Items.map(item => ({
      name: item.Name, stock: item.Stock, demand: item.Demand, producer: item.Producer, consumer: item.Consumer,
    })) } },
  });
  const baseline = ops.find(op => op.op === 'baseline');
  assert.equal(baseline.items.length, 6); // inactive rows, before persisted-type protection
  assert.ok(!baseline.items.some(item => item.commodity === 'steel'));
  const svc = {
    from(table) { assert.equal(table, 'fleet_carriers'); return {
      select() { return this; },
      async in(_column, ids) { return { data: (await db.query('SELECT carrier_id, carrier_type FROM fleet_carriers WHERE carrier_id = ANY($1::bigint[])', [ids])).rows, error: null }; },
    }; },
    async rpc(_name, params) {
      assert.deepEqual(params.p_ops.find(op => op.op === 'baseline').items, []);
      return { data: await apply(params.p_ops, MEMBER), error: null };
    },
  };
  await applyCarrierOps(svc, MEMBER, 'helper', ops);
  assert.deepEqual(await cargo(id), before);
});

test('squadron withdrawal from unknown stock must not leave debt that swallows later deliveries', async () => {
  const id = '3713477881';
  await apply([{ op: 'identity', carrier_id: id, at: '2026-03-02T10:00:00Z', carrier_type: 'SquadronCarrier' }], MEMBER);
  // Missing opening inventory: somebody withdraws stock we never observed.
  await apply([{ ...delta('2026-03-02T10:01:00Z', 'steel', -10000, hash(), id), event: 'MarketBuy' }], MEMBER);
  assert.deepEqual(await cargo(id), {});
  // Previously returns applied=1 but quantity remains zero: -10000+1320 < 0.
  const result = await apply([delta('2026-03-02T10:02:00Z', 'steel', 1320, hash(), id)], MEMBER);
  assert.equal(result.applied, 1);
  assert.equal(result.ignored, 0);
  assert.deepEqual(await cargo(id), { steel: 1320 });
  await apply([delta('2026-03-02T10:03:00Z', 'steel', 1320, hash(), id)], MEMBER);
  assert.deepEqual(await cargo(id), { steel: 2640 });
});

test('squadron per-event floor preserves known stock, delayed uploads, baselines and deduplication', async () => {
  const id = '3713477882';
  await apply([{ op: 'identity', carrier_id: id, at: '2026-03-03T00:00:00Z', carrier_type: 'SquadronCarrier' }], MEMBER);
  const withdrawal = { ...delta('2026-03-03T10:01:00Z', 'steel', -10000, hash(), id), event: 'MarketBuy' };
  const sale = delta('2026-03-03T10:02:00Z', 'steel', 1320, hash(), id);
  await apply([withdrawal, sale], MEMBER);
  assert.deepEqual(await cargo(id), { steel: 1320 });
  // Delayed older evidence fills opening stock; recompute, don't discard the withdrawal.
  await apply([delta('2026-03-03T10:00:00Z', 'steel', 12000, hash(), id)], MEMBER);
  assert.deepEqual(await cargo(id), { steel: 3320 });
  assert.equal((await apply([sale], MEMBER)).duplicates, 1);
  assert.deepEqual(await cargo(id), { steel: 3320 });
  await apply([{ op: 'baseline', carrier_id: id, at: '2026-03-03T10:01:30Z',
    source_event: 'Market', full: false, items: [{ commodity: 'steel', qty: 500 }] }], MEMBER);
  assert.deepEqual(await cargo(id), { steel: 1820 });
  await apply([delta('2026-03-03T10:03:00Z', 'steel', -2000, hash(), id)], MEMBER);
  await apply([delta('2026-03-03T10:04:00Z', 'steel', 1320, hash(), id)], MEMBER);
  assert.deepEqual(await cargo(id), { steel: 1320 });
  const row = (await db.query("SELECT observed_at FROM fleet_carrier_cargo WHERE carrier_id=$1 AND commodity='steel'", [id])).rows[0];
  assert.equal(new Date(row.observed_at).toISOString(), '2026-03-03T10:04:00.000Z');
});

test('squadron floor matches chronological clamp even when events arrive backwards', async () => {
  const id = '3713477883';
  await apply([{ op: 'identity', carrier_id: id, at: '2026-03-04T00:00:00Z', carrier_type: 'SquadronCarrier' }], MEMBER);
  const amounts = [-6000, 1320, -500, 1320, -6000, 1320, 1320, -100, -100, 50];
  const ops = amounts.map((amount, i) => delta(new Date(Date.parse('2026-03-04T10:00:00Z') + i * 1000).toISOString(), 'steel', amount, hash(), id));
  for (const op of [...ops].reverse()) await apply([op], MEMBER);
  const expected = amounts.reduce((qty, amount) => Math.max(0, qty + amount), 0);
  assert.deepEqual(await cargo(id), { steel: expected });
  assert.equal((await apply(ops, MEMBER)).duplicates, amounts.length);
  assert.deepEqual(await cargo(id), { steel: expected });
});

test('migration repairs existing squadron estimates, is repeatable and leaves personal semantics and event hashes alone', async () => {
  const id = '3713477884';
  const personal = '3713477885';
  await apply([{ op: 'identity', carrier_id: id, at: '2026-03-05T00:00:00Z', carrier_type: 'SquadronCarrier' }], MEMBER);
  await db.exec('DROP TRIGGER squadron_cargo_quantity_floor ON fleet_carrier_cargo');
  for (const cid of [id, personal]) {
    await apply([delta('2026-03-05T10:00:00Z', 'steel', -10000, hash(), cid),
      delta('2026-03-05T10:01:00Z', 'steel', 1320, hash(), cid)], MEMBER);
    assert.deepEqual(await cargo(cid), {}); // the previous SQL semantics
  }
  const before = (await db.query('SELECT * FROM fleet_carrier_events WHERE carrier_id=$1 ORDER BY id', [id])).rows;
  const observedBefore = (await db.query('SELECT observed_at, baseline_at FROM fleet_carrier_cargo WHERE carrier_id=$1', [id])).rows;
  const migration = readFileSync(new URL('../../supabase/migrations/20261124100000_squadron_cargo_no_negative_debt.sql', import.meta.url), 'utf8');
  await db.exec(migration);
  await db.exec(migration);
  assert.deepEqual(await cargo(id), { steel: 1320 });
  assert.deepEqual(await cargo(personal), {});
  assert.deepEqual((await db.query('SELECT * FROM fleet_carrier_events WHERE carrier_id=$1 ORDER BY id', [id])).rows, before);
  assert.deepEqual((await db.query('SELECT observed_at, baseline_at FROM fleet_carrier_cargo WHERE carrier_id=$1', [id])).rows, observedBefore);
  for (const role of ['anon', 'authenticated']) {
    const result = await db.query("SELECT has_function_privilege($1, 'public.squadron_cargo_running_quantity(bigint,text,integer,timestamp with time zone)', 'EXECUTE') AS allowed", [role]);
    assert.equal(result.rows[0].allowed, false);
  }
});

test('read-only diagnosis distinguishes accepted-event debt from a newer baseline without changing cargo', async () => {
  const id = '3713477884';
  const before = await cargo(id);
  const sql = readFileSync(new URL('../diagnose-squadron-cargo.sql', import.meta.url), 'utf8').replaceAll('3713477376', id);
  const [summary, recent] = await db.exec(sql);
  const row = summary.rows[0];
  assert.equal(Number(row.quantity), 1320);
  assert.equal(Number(row.old_formula_quantity), 0);
  assert.equal(Number(row.per_event_floor_quantity), 1320);
  assert.equal(Number(row.unobserved_withdrawal_deficit), 10000);
  assert.equal(row.latest_deposit_covered_by_baseline, false);
  assert.equal(recent.rows.length, 2);
  assert.deepEqual(await cargo(id), before);
});

test('squadron floor never adds a late delivery already covered by a newer inventory baseline', async () => {
  const id = '3713477886';
  await apply([{ op: 'identity', carrier_id: id, at: '2026-03-06T00:00:00Z', carrier_type: 'SquadronCarrier' },
    { op: 'baseline', carrier_id: id, at: '2026-03-06T12:00:00Z', full: true,
      source_event: 'capi', items: [{ commodity: 'steel', qty: 500 }, { commodity: 'water', qty: 100 }] }], MEMBER);
  const result = await apply([delta('2026-03-06T11:00:00Z', 'steel', 1320, hash(), id)], MEMBER);
  assert.equal(result.applied, 1);
  // applied is not quantity-changed; a real newer observation must still win.
  assert.deepEqual(await cargo(id), { steel: 500, water: 100 });
  await apply([delta('2026-03-06T12:01:00Z', 'steel', 1320, hash(), id)], MEMBER);
  assert.deepEqual(await cargo(id), { steel: 1820, water: 100 });
});
