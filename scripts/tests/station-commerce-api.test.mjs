import test from 'node:test';
import assert from 'node:assert/strict';
import { bundleFile } from './helpers/bundle.mjs';
const server = `export const NextResponse={json:(body,options={})=>({body,status:options.status||200})};`;
const dbStub = `export const createServiceClient=()=>globalThis.__stationDb;export const authFromRequest=async()=>({user:globalThis.__stationUser||null});`;
const api = await import(await bundleFile({ entry: 'src/app/api/stations/report/route.ts', stubs: { 'next/server': server, '@/lib/supabaseServer': dbStub } }));
const eddn = await import(await bundleFile({ entry: 'src/app/api/eddn/ingest/route.ts', stubs: { 'next/server': server, '@/lib/supabaseServer': dbStub,
  '@/lib/galaxySystemsDb': 'export const findSystemByName=async()=>({x:0,y:0,z:0});' } }));
const report = { system_name: 'Sol', station_name: 'Galileo', market_id: '123', observed_at: '2026-01-01T00:00:00Z',
  inventories: { market: { observed_at: '2026-01-01T00:00:00Z', items: [{ name: 'steel', stock: 30, buyPrice: 100 }] } } };
const request = (body, headers = {}) => new Request('http://test.local', { method: 'POST', body: JSON.stringify(body), headers });
function setup({ revoked = false, rpcError = false, carrierRpcError = false } = {}) {
  const calls = [];
  globalThis.__stationDb = {
    calls,
    from(table) {
      const query = { select: () => query, eq: () => query,
        maybeSingle: async () => ({ data: { user_id: 'user-1', is_revoked: revoked }, error: null }),
        upsert: async (value) => { calls.push({ table, value }); return { error: null }; },
      };
      return query;
    },
    async rpc(name, params) { calls.push({ name, params }); return { error: (rpcError || (carrierRpcError && name === 'apply_fleet_carrier_batch')) ? { message: 'Unavailable' } : null }; },
  };
  return calls;
}
test.afterEach(() => { delete globalThis.__stationDb; delete globalThis.__stationUser; });

test('station reports require authenticated Helper token or web session', async () => {
  setup();
  assert.equal((await api.POST(request({ reports: [report] }))).status, 401);
  setup({ revoked: true });
  assert.equal((await api.POST(request({ token: 'revoked', reports: [report] }))).status, 401);
  globalThis.__stationUser = { id: 'web-user' };
  assert.equal((await api.POST(request({ reports: [report] }))).status, 200);
});

test('valid Helper report normalizes commodities and does not trust supplied source/station key', async () => {
  const calls = setup();
  const response = await api.POST(request({ token: 'valid', reports: [{ ...report, source: 'spansh', station_key: 'fake' }] }));
  assert.equal(response.body.ok, true);
  assert.equal(calls[0].params.report.source, 'colonial-helper');
  assert.equal(calls[0].params.report.station_key, 'market:123');
  assert.equal(calls[0].params.report.inventories.market.items[0].name, 'Steel');
});

test('malformed/future/oversized inventory is rejected before any report in batch is written', async () => {
  const calls = setup();
  assert.equal((await api.POST(request({ token: 'valid', reports: [report, { ...report, station_name: '' }] }))).status, 400);
  assert.equal(calls.length, 0);
  assert.equal((await api.POST(request({ token: 'valid', reports: [{ ...report, observed_at: '2100-01-01T00:00:00Z' }] }))).status, 400);
  assert.equal((await api.POST(request({ token: 'valid', reports: [{ ...report, inventories: { market: { observed_at: report.observed_at, items: [{ name: 'steel', stock: -1 }] } } }] }))).status, 400);
  assert.equal((await api.POST(request({ token: 'valid', reports: Array(21).fill(report) }))).status, 400);
  assert.equal((await api.POST(request({}, { 'content-length': '10000000' }))).status, 413);
});

test('database failures return retriable errors rather than acknowledging lost reports', async () => {
  setup({ rpcError: true });
  assert.equal((await api.POST(request({ token: 'valid', reports: [report] }))).status, 503);
});

const squadronReport = {
  ...report, market_id: '3709000001', station_name: 'SQD-001', station_type: 'FleetCarrier',
  metadata: { services: ['dock', 'squadronBank'] },
  inventories: { market: { observed_at: report.observed_at,
    items: [{ name: '$steel_name;', stock: 300, producer: true, consumer: false },
            { name: 'water', stock: 0, demand: 50, producer: false, consumer: true }] } },
};

test('squadron market updates carrier cargo accounting as well as station inventory', async () => {
  const calls = setup();
  const response = await api.POST(request({ token: 'valid', reports: [squadronReport] }));
  assert.equal(response.status, 200);
  const accounting = calls.find((call) => call.name === 'apply_fleet_carrier_batch');
  assert.ok(accounting);
  assert.deepEqual(accounting.params.p_ops.find((op) => op.op === 'baseline').items,
    [{ commodity: 'steel', qty: 300, name_localised: undefined }]);
  assert.equal(accounting.params.p_ops[0].carrier_type, 'SquadronCarrier');
});

test('failed squadron cargo accounting is retried rather than silently acknowledged after saving market', async () => {
  const failed = setup({ carrierRpcError: true });
  const response = await api.POST(request({ token: 'valid', reports: [squadronReport] }));
  assert.equal(response.status, 503);
  assert.match(response.body.error, /retry/i);
  assert.ok(failed.find((call) => call.name === 'save_station_commerce'));
  assert.ok(failed.find((call) => call.name === 'apply_fleet_carrier_batch'));
  const retried = setup();
  assert.equal((await api.POST(request({ token: 'valid', reports: [squadronReport] }))).status, 200);
  assert.ok(retried.find((call) => call.name === 'apply_fleet_carrier_batch'));
});

test('EDDN refuses missing configured secret and stores independent module/ship snapshots', async () => {
  const previous = process.env.EDDN_INGEST_SECRET;
  try {
    delete process.env.EDDN_INGEST_SECRET;
    setup();
    assert.equal((await eddn.POST(request({}))).status, 401);
    process.env.EDDN_INGEST_SECRET = 'test-secret';
    const calls = setup();
    const response = await eddn.POST(request({ $schemaRef: 'https://eddn.edcd.io/schemas/outfitting/2', message: {
      systemName: 'Sol', stationName: 'Galileo', marketId: 123, timestamp: report.observed_at, modules: ['int_hyperdrive_size5_class5'],
    } }, { 'x-eddn-secret': 'test-secret' }));
    assert.equal(response.status, 200);
    assert.equal(calls[0].params.report.inventories.outfitting.items[0].name, 'int_hyperdrive_size5_class5');
    assert.equal(calls[0].params.report.source, 'eddn');
  } finally { if (previous == null) delete process.env.EDDN_INGEST_SECRET; else process.env.EDDN_INGEST_SECRET = previous; }
});
