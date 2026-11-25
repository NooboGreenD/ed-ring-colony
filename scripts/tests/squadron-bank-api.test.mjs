import test from 'node:test';
import assert from 'node:assert/strict';
import { bundleFile } from './helpers/bundle.mjs';

const { GET } = await import(await bundleFile({
  entry: 'src/app/api/squadrons/[id]/bank/route.ts',
  stubs: {
    'next/server': `export const NextResponse={json:(body,options={})=>({body,status:options.status||200,headers:options.headers||{}})};`,
    '@/lib/supabaseServer': `export const createServiceClient=()=>globalThis.__bankDb;`,
    '@/lib/helperAuth': `export const resolveRequestUser=async()=>globalThis.__bankUser ? {userId:globalThis.__bankUser,via:'session'} : null;`,
  },
}));

function setup(user = 'member') {
  globalThis.__bankUser = user;
  const reads = [];
  const tables = {
    squadron_members: [{ squadron_id: 7, user_id: 'member', rank_id: 1 }, { squadron_id: 7, user_id: 'officer', rank_id: 2 }, { squadron_id: 8, user_id: 'stranger', rank_id: 3 }],
    squadron_ranks: [{ id: 1, squadron_id: 7, can_edit_squadron: false }, { id: 2, squadron_id: 7, can_edit_squadron: true }],
    squadrons: [{ id: 7, created_by: 'officer' }],
    fleet_carriers: [
      { carrier_id: '3713477376', carrier_type: 'SquadronCarrier', squadron_id: 7, name: 'Squadron Depot', finance: { bank_balance: 123456789 }, updated_at: '2026-11-24T21:30:00Z' },
      { carrier_id: '3713477377', carrier_type: 'FleetCarrier', squadron_id: 7, owner_id: 'member', name: 'Personal' },
      { carrier_id: '3713477378', carrier_type: 'SquadronCarrier', squadron_id: 8, name: 'Other Squadron' },
    ],
    fleet_carrier_cargo: [
      { carrier_id: '3713477376', commodity: 'steel', name_localised: 'Сталь', quantity: 2640, updated_at: '2026-11-24T21:30:00Z' },
      { carrier_id: '3713477377', commodity: 'water', quantity: 999 },
      { carrier_id: '3713477378', commodity: 'gold', quantity: 777 },
    ],
  };
  globalThis.__bankDb = { from(table) {
    reads.push(table);
    const filters = [];
    const query = {
      select() { return this; }, order() { return this; },
      eq(key, value) { filters.push(row => String(row[key]) === String(value)); return this; },
      in(key, values) { filters.push(row => values.map(String).includes(String(row[key]))); return this; },
      then(resolve, reject) { return Promise.resolve({ data: (tables[table] ?? []).filter(row => filters.every(f => f(row))), error: null }).then(resolve, reject); },
    };
    return query;
  } };
  return { reads, tables };
}
const request = (id = '7') => GET(new Request('https://example.test/api/squadrons/' + id + '/bank'), { params: Promise.resolve({ id }) });

test('bank endpoint rejects anonymous and other-squadron users before reading cargo', async () => {
  for (const [user, status] of [[null, 401], ['stranger', 403]]) {
    const { reads } = setup(user);
    const response = await request();
    assert.equal(response.status, status);
    assert.equal(response.headers['Cache-Control'], 'private, no-store');
    assert.ok(!reads.includes('fleet_carrier_cargo'));
    assert.ok(!reads.includes('fleet_carriers'));
    assert.equal(response.body.carriers, undefined);
  }
});

test('ordinary member and officer see identical tracked goods, without personal cargo, markets or finance', async () => {
  setup('member');
  const member = await request();
  setup('officer');
  const officer = await request();
  assert.equal(member.status, 200);
  assert.deepEqual(member.body, officer.body);
  const [carrier] = member.body.carriers;
  assert.equal(member.body.carriers.length, 1);
  assert.equal(carrier.carrierId, '3713477376');
  assert.equal(carrier.cargo.trackedTotal, 2640);
  assert.equal(carrier.cargo.items[0].quantity, 2640);
  assert.deepEqual(Object.keys(carrier).sort(), ['carrierId', 'cargo', 'name', 'callsign', 'type', 'relation'].sort());
  assert.doesNotMatch(JSON.stringify(member.body), /123456789|Personal|Other Squadron|"finance"|"market"/);
  assert.match(member.headers.Vary, /Authorization/);
});

test('bank handles invalid ids, absent carriers and database failures without disclosing stale cargo', async () => {
  for (const id of ['0', '-1', '7abc', 'NaN', '9999999999999999999999']) {
    setup();
    assert.equal((await request(id)).status, 400);
  }
  const { tables } = setup();
  tables.fleet_carriers = [];
  assert.deepEqual((await request()).body, { ok: true, carriers: [] });
  setup();
  globalThis.__bankDb.from = () => { throw new Error('simulated failure'); };
  const unavailable = await request();
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.body.carriers, undefined);
  assert.equal(unavailable.headers['Cache-Control'], 'private, no-store');
});
