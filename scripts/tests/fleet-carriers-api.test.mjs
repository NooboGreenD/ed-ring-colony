import test from 'node:test';
import assert from 'node:assert/strict';
import { bundleFile } from './helpers/bundle.mjs';

/* Маршруты учёта авианосцев: авторизация (сессия сайта или API-токен Helper'а),
   источник данных и права ручной привязки. БД — заглушка в памяти с тем
   подмножеством PostgREST-цепочек, которое используют маршруты. */

const server = `export const NextResponse={json:(body,options={})=>({body,status:options.status||200})};`;
const dbStub = `export const createServiceClient=()=>globalThis.__db;export const authFromRequest=async()=>({user:globalThis.__user||null});`;
const stubs = { 'next/server': server, '@/lib/supabaseServer': dbStub };
const load = async (entry) => import(await bundleFile({ entry, stubs }));
const sync = await load('src/app/api/carriers/sync/route.ts');
const mine = await load('src/app/api/carriers/mine/route.ts');
const bind = await load('src/app/api/carriers/bind/route.ts');
const one = await load('src/app/api/carriers/[id]/route.ts');

const PILOT = 'user-pilot';
const OFFICER = 'user-officer';
const MEMBER = 'user-member';
const STRANGER = 'user-stranger';

function makeDb(tables) {
  const calls = [];
  function from(table) {
    const filters = [];
    let operation = 'select';
    let payload = null;
    let conflictKey = null;
    let limit = null;
    const query = {
      select: () => query,
      order: () => query,
      eq(column, value) { filters.push((row) => String(row[column]) === String(value)); return query; },
      neq(column, value) { filters.push((row) => String(row[column]) !== String(value)); return query; },
      in(column, values) { const set = new Set(values.map(String)); filters.push((row) => set.has(String(row[column]))); return query; },
      gt(column, value) { filters.push((row) => Number(row[column]) > value); return query; },
      ilike(column, value) { filters.push((row) => String(row[column] ?? '').toLowerCase() === String(value).toLowerCase()); return query; },
      limit(count) { limit = count; return query; },
      update(values) { operation = 'update'; payload = values; return query; },
      upsert(values, options) { operation = 'upsert'; payload = values; conflictKey = options?.onConflict; return query; },
      maybeSingle: () => run(true),
      then: (resolve, reject) => run(false).then(resolve, reject),
    };
    async function run(single) {
      const rows = (tables[table] ??= []);
      let matched = rows.filter((row) => filters.every((filter) => filter(row)));
      if (operation === 'update') {
        calls.push({ table, operation, payload, count: matched.length });
        for (const row of matched) Object.assign(row, payload);
      } else if (operation === 'upsert') {
        let row = rows.find((candidate) => String(candidate[conflictKey]) === String(payload[conflictKey]));
        if (!row) { row = { carrier_type: 'FleetCarrier', ...payload }; rows.push(row); }
        calls.push({ table, operation, payload });
        matched = [row];
      }
      if (limit != null) matched = matched.slice(0, limit);
      return { data: single ? (matched[0] ?? null) : matched, error: null };
    }
    return query;
  }
  return {
    calls,
    from,
    async rpc(name, params) {
      calls.push({ rpc: name, params });
      return { data: { applied: params.p_ops.length, duplicates: 0, ignored: 0, stations_moved: 0,
        carriers: [...new Set(params.p_ops.map((op) => op.carrier_id))] }, error: null };
    },
  };
}

function setup() {
  const tables = {
    // token_hash выставляет тест: sha256('rc_valid'), как его считает helperAuth.
    api_tokens: [{ token_hash: '', user_id: PILOT, is_revoked: false }],
    squadron_members: [
      { squadron_id: 7, user_id: OFFICER, rank_id: 70 },
      { squadron_id: 7, user_id: MEMBER, rank_id: 71 },
    ],
    squadron_ranks: [{ id: 70, squadron_id: 7, can_edit_squadron: true }, { id: 71, squadron_id: 7, can_edit_squadron: false }],
    squadrons: [{ id: 7, created_by: 'someone-else', tag: '[DNHG]' }],
    fleet_carriers: [
      { carrier_id: 3700000001, carrier_type: 'FleetCarrier', callsign: 'AAA-111', owner_id: STRANGER, owner_source: 'journal', updated_at: '2026-01-01' },
      { carrier_id: 3700000002, carrier_type: 'FleetCarrier', callsign: 'BBB-222', owner_id: null, updated_at: '2026-01-01' },
      { carrier_id: 3709000001, carrier_type: 'SquadronCarrier', callsign: 'SQD-001', squadron_id: 7, updated_at: '2026-01-01',
        finance: { carrier_balance: 99 }, space_usage: { cargo: 100, free_space: 59000 }, squadron_rejected: [] },
    ],
    fleet_carrier_cargo: [{ carrier_id: 3709000001, commodity: 'steel', name_localised: 'Steel', quantity: 100 }],
    station_inventory_snapshots: [],
  };
  globalThis.__db = makeDb(tables);
  return tables;
}

async function tokenHash(token) {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(token).digest('hex');
}

const post = (body, headers = {}) => new Request('http://test.local/api', { method: 'POST', body: JSON.stringify(body), headers });
const get = (headers = {}) => new Request('http://test.local/api', { method: 'GET', headers });
const del = (body) => new Request('http://test.local/api', { method: 'DELETE', body: JSON.stringify(body) });
const SALE = { timestamp: '2026-01-02T00:00:00Z', event: 'MarketSell', MarketID: 3700000002, Type: 'steel', Count: 10 };

test.afterEach(() => { delete globalThis.__db; delete globalThis.__user; });

test('sync requires a session or a Helper token and labels the source', async () => {
  const tables = setup();
  tables.api_tokens[0].token_hash = await tokenHash('rc_valid');
  assert.equal((await sync.POST(post({ events: [SALE] }))).status, 401);
  assert.equal((await sync.POST(post({ token: 'rc_wrong', events: [SALE] }))).status, 401);

  const viaToken = await sync.POST(post({ token: 'rc_valid', events: [SALE, { event: 'Scan' }] }));
  assert.equal(viaToken.status, 200);
  assert.equal(viaToken.body.skipped, 1);
  const rpc = globalThis.__db.calls.find((call) => call.rpc);
  assert.equal(rpc.params.p_source, 'helper');
  assert.equal(rpc.params.p_user_id, PILOT);
  assert.equal(rpc.params.p_ops[0].delta, 10);

  // Bearer API token works too (GET /mine from the Helper uses it).
  const viaBearer = await sync.POST(post({ events: [SALE] }, { authorization: 'Bearer rc_valid' }));
  assert.equal(viaBearer.status, 200);

  globalThis.__user = { id: MEMBER };
  setup();
  const viaSession = await sync.POST(post({ events: [SALE] }));
  assert.equal(viaSession.status, 200);
  assert.equal(globalThis.__db.calls.find((call) => call.rpc).params.p_source, 'web');
});

test('sync validates payload shape and size', async () => {
  setup();
  globalThis.__user = { id: PILOT };
  assert.equal((await sync.POST(new Request('http://t', { method: 'POST', body: '{bad' }))).status, 400);
  assert.equal((await sync.POST(post({ events: 'nope' }))).status, 400);
  assert.equal((await sync.POST(post({ events: Array(3001).fill(SALE) }))).status, 413);
  const empty = await sync.POST(post({ events: [] }));
  assert.equal(empty.body.applied, 0);
  assert.equal(globalThis.__db.calls.filter((call) => call.rpc).length, 0);
});

test('mine returns the squadron carrier with cargo to members; finance only to officers', async () => {
  setup();
  globalThis.__user = { id: MEMBER };
  let response = await mine.GET(get());
  assert.equal(response.status, 200);
  assert.equal(response.body.own, null);
  assert.equal(response.body.squadron.length, 1);
  const carrier = response.body.squadron[0];
  assert.equal(carrier.relation, 'squadron');
  assert.deepEqual(carrier.cargo.items.map((item) => [item.commodity, item.quantity]), [['steel', 100]]);
  assert.equal(carrier.finance, null);
  assert.equal(response.body.can_manage_squadron, false);

  globalThis.__user = { id: OFFICER };
  response = await mine.GET(get());
  assert.equal(response.body.squadron[0].finance.carrier_balance, 99);
  assert.equal(response.body.can_manage_squadron, true);
});

test('public carrier card hides cargo and finance', async () => {
  setup();
  globalThis.__user = { id: STRANGER };
  const response = await one.GET(get(), { params: Promise.resolve({ id: 'SQD-001' }) });
  assert.equal(response.status, 200);
  assert.equal(response.body.carrier.relation, 'public');
  assert.equal(response.body.carrier.cargo, null);
  assert.equal(response.body.carrier.finance, null);
  assert.equal((await one.GET(get(), { params: Promise.resolve({ id: 'nonsense' }) })).status, 400);
});

test('manual personal binding: free carriers bind, proven foreign ones and squadron carriers are refused', async () => {
  const tables = setup();
  globalThis.__user = { id: PILOT };
  let response = await bind.POST(post({ kind: 'personal', carrier: 'bbb-222' }));
  assert.equal(response.status, 200);
  assert.equal(response.body.carrier.relation, 'own');
  assert.equal(tables.fleet_carriers[1].owner_source, 'manual');

  assert.equal((await bind.POST(post({ kind: 'personal', carrier: 'AAA-111' }))).status, 409);
  assert.equal((await bind.POST(post({ kind: 'personal', carrier: 'SQD-001' }))).status, 400);
  // Unknown callsign: ask for the Carrier ID; unknown in-range ID: created.
  assert.equal((await bind.POST(post({ kind: 'personal', carrier: 'ZZZ-999' }))).status, 404);
  response = await bind.POST(post({ kind: 'personal', carrier: '3700000077' }));
  assert.equal(response.status, 200);
  // One personal carrier per profile: the previous manual binding is released.
  assert.equal(tables.fleet_carriers[1].owner_id, null);
  assert.equal(tables.fleet_carriers.find((row) => String(row.carrier_id) === '3700000077').owner_id, PILOT);

  // Unbinding someone else's carrier is refused, own works.
  assert.equal((await bind.DELETE(del({ kind: 'personal', carrier_id: '3700000001' }))).status, 403);
  assert.equal((await bind.DELETE(del({ kind: 'personal', carrier_id: '3700000077' }))).status, 200);
});

test('squadron binding needs membership and edit rights; cannot steal another squadron carrier', async () => {
  const tables = setup();
  tables.fleet_carriers.push({ carrier_id: 3709000002, carrier_type: 'SquadronCarrier', callsign: 'SQD-002', squadron_id: 99 });
  globalThis.__user = { id: STRANGER };
  assert.equal((await bind.POST(post({ kind: 'squadron', squadron_id: 7, carrier: 'BBB-222' }))).status, 403);
  globalThis.__user = { id: MEMBER };
  assert.equal((await bind.POST(post({ kind: 'squadron', squadron_id: 7, carrier: 'BBB-222' }))).status, 403);
  globalThis.__user = { id: OFFICER };
  const response = await bind.POST(post({ kind: 'squadron', squadron_id: 7, carrier: 'BBB-222' }));
  assert.equal(response.status, 200);
  assert.equal(Number(tables.fleet_carriers[1].squadron_id), 7);
  assert.equal(tables.fleet_carriers[1].squadron_source, 'manual');
  assert.equal((await bind.POST(post({ kind: 'squadron', squadron_id: 7, carrier: 'SQD-002' }))).status, 409);

  globalThis.__user = { id: MEMBER };
  assert.equal((await bind.DELETE(del({ kind: 'squadron', carrier_id: '3700000002' }))).status, 403);
  globalThis.__user = { id: OFFICER };
  assert.equal((await bind.DELETE(del({ kind: 'squadron', carrier_id: '3700000002' }))).status, 200);
  assert.equal(tables.fleet_carriers[1].squadron_id, null);
});

test('squadron unbinding is remembered for journals, manual binding clears it; a Javelin of another squadron tag is refused', async () => {
  const tables = setup();
  const javelin = () => tables.fleet_carriers.find((row) => String(row.carrier_id) === '3709000001');
  globalThis.__user = { id: OFFICER };

  // Отвязка офицером: журналы участников эскадрильи 7 этот носитель больше не вернут.
  assert.equal((await bind.DELETE(del({ kind: 'squadron', carrier_id: '3709000001' }))).status, 200);
  assert.equal(javelin().squadron_id, null);
  assert.deepEqual(javelin().squadron_rejected, [7]);
  // Ручная привязка — решение офицеров — отказ снимает.
  let response = await bind.POST(post({ kind: 'squadron', squadron_id: 7, carrier: '3709000001' }));
  assert.equal(response.status, 200);
  assert.equal(Number(javelin().squadron_id), 7);
  assert.equal(javelin().squadron_source, 'manual');
  assert.deepEqual(javelin().squadron_rejected, []);

  // Позывной Javelin — тег его эскадрильи: «ENEX» не носитель эскадрильи с тегом «[DNHG]».
  tables.fleet_carriers.push({ carrier_id: 3713124352, carrier_type: 'SquadronCarrier', callsign: 'ENEX', squadron_id: null, squadron_rejected: [] });
  response = await bind.POST(post({ kind: 'squadron', squadron_id: 7, carrier: 'enex' }));
  assert.equal(response.status, 409);
  assert.match(response.body.error, /\[ENEX\].*\[DNHG\]/);
  assert.equal(tables.fleet_carriers.at(-1).squadron_id, null);

  // Тег совпал — привязывается. Базы без миграции 20261018000000 (нет колонки
  // squadron_rejected) маршрут не ломает: колонку он тогда не пишет.
  tables.fleet_carriers.push({ carrier_id: 3713000001, carrier_type: 'SquadronCarrier', callsign: 'DNHG', squadron_id: null });
  response = await bind.POST(post({ kind: 'squadron', squadron_id: 7, carrier: 'DNHG' }));
  assert.equal(response.status, 200);
  assert.equal(Number(tables.fleet_carriers.at(-1).squadron_id), 7);
  const update = globalThis.__db.calls.filter((call) => call.operation === 'update').at(-1);
  assert.equal('squadron_rejected' in update.payload, false);
  assert.equal((await bind.DELETE(del({ kind: 'squadron', carrier_id: '3713000001' }))).status, 200);
  assert.equal('squadron_rejected' in tables.fleet_carriers.at(-1), false);
});
