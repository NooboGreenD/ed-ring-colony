import test from 'node:test';
import assert from 'node:assert/strict';
import { bundleFile } from './helpers/bundle.mjs';
const catalog = await import(
  await bundleFile({ entry: 'src/lib/constructionBlueprints.ts' })
);
const upstream = await import(
  await bundleFile({ entry: 'src/lib/marketUpstream.ts' })
);
const server = `export const NextResponse={json:(body,options={})=>({body,status:options.status||200})};`;
const dbStub = `export const createServiceClient=()=>globalThis.__marketDb;`;
const galaxy = `export const findSystemByName=async()=>({name:'Sol',x:0,y:0,z:0});export const getGalaxyStats=async()=>({});export const catalogIsComplete=()=>true;export const findSystemsInCube=async()=>[{name:'Sol',x:0,y:0,z:0},{name:'Alpha',x:1,y:0,z:0}];`;
const cache = `export const boxAround=()=>({});export const listCachedSystemsInBox=async()=>[];export const saveCachedSystems=async()=>0;`;
const start = await import(
  await bundleFile({
    entry: 'src/app/api/market/find/start/route.ts',
    stubs: {
      'next/server': server,
      '@/lib/supabaseServer': dbStub,
      '@/lib/galaxySystemsDb': galaxy,
      '@/lib/atlasSystemCache': cache,
    },
  })
);
const step = await import(
  await bundleFile({
    entry: 'src/app/api/market/find/step/route.ts',
    stubs: { 'next/server': server, '@/lib/supabaseServer': dbStub },
  })
);
function database({ job, cache = [], prices = [] } = {}) {
  const writes = [];
  return {
    writes,
    from(table) {
      let patch,
        insert,
        filters = [];
      const query = {
        select() {
          return query;
        },
        limit() {
          return query;
        },
        eq(key, value) {
          filters.push([key, value]);
          return query;
        },
        insert(value) {
          insert = value;
          return query;
        },
        update(value) {
          patch = value;
          return query;
        },
        upsert: async (value) => {
          writes.push({ table, value });
          return { error: null };
        },
        single: async () => {
          if (insert) {
            writes.push({ table, value: insert });
            return { data: { ...insert, id: 'job-1' }, error: null };
          }
          return { data: structuredClone(job), error: null };
        },
        maybeSingle: async () => {
          if (patch) {
            assert.equal(
              filters.find(([key]) => key === 'scanned_systems')?.[1],
              job.scanned_systems
            );
            Object.assign(job, patch);
            writes.push({ table, value: patch });
          }
          return { data: structuredClone(job), error: null };
        },
        then(resolve, reject) {
          return Promise.resolve({
            data: table === 'market_prices' ? prices : cache,
            error: null,
          }).then(resolve, reject);
        },
      };
      return query;
    },
  };
}
const request = (body) =>
  new Request('http://test.local', {
    method: 'POST',
    body: JSON.stringify(body),
  });
const job = (overrides) => ({
  id: 'job-1',
  status: 'pending',
  mode: 'single',
  commodity: 'Steel',
  systems_list: [{ name: 'Sol', distance: 0, x: 0, y: 0, z: 0 }],
  scanned_systems: 0,
  total_systems: 1,
  result: [],
  scan_log: [],
  found_stations: 0,
  ...overrides,
});

test('construction catalog contains 55 selectable sites and 55 canonical materials, with nonzero baseline amounts', () => {
  assert.equal(catalog.CONSTRUCTION_BLUEPRINTS.length, 55);
  assert.equal(catalog.CONSTRUCTION_COMMODITIES.length, 55);
  assert.equal(
    new Set(catalog.CONSTRUCTION_BLUEPRINTS.map((site) => site.id)).size,
    55
  );
  for (const site of catalog.CONSTRUCTION_BLUEPRINTS) {
    assert.ok(site.materials.length);
    assert.ok(site.materials.every((item) => item.amount > 0));
    assert.ok(['surface', 'orbital'].includes(site.location));
  }
  assert.ok(catalog.constructionCommodities('no_truss').includes('Steel'));
  assert.deepEqual(catalog.constructionCommodities('bad-type'), []);
});

test('EDSM transport retries a transient fetch failure, bounds requests, and does not leak fetch failed', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async (_, options) => {
      assert.ok(options.signal);
      if (++calls === 1) throw new TypeError('fetch failed');
      return { ok: true, json: async () => ({ coords: { x: 0, y: 0, z: 0 } }) };
    };
    assert.ok((await upstream.marketUpstream('/api-v1/system')).coords);
    assert.equal(calls, 2);
    calls = 0;
    globalThis.fetch = async () => {
      calls++;
      throw new TypeError('fetch failed');
    };
    await assert.rejects(
      () => upstream.marketUpstream('/api-v1/system'),
      /EDSM недоступен/
    );
    assert.equal(calls, 2);
    assert.doesNotMatch(
      upstream.marketError(new TypeError('fetch failed')),
      /fetch failed/
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('market start uses local catalog without EDSM and persists selected recipe; validates inputs', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('external request should not run');
  };
  globalThis.__marketDb = database();
  try {
    const response = await start.POST(
      request({
        ref_system: 'Sol',
        radius: 50,
        mode: 'build',
        build_type: 'no_truss',
      })
    );
    assert.equal(response.status, 200);
    assert.equal(response.body.source, 'catalog');
    assert.equal(globalThis.__marketDb.writes[0].value.build_type, 'no_truss');
    for (const body of [
      { radius: -1, mode: 'single', commodity: 'Steel' },
      { radius: 50, mode: 'build', build_type: 'invalid' },
      { radius: 50, mode: 'single', commodity: '' },
    ]) {
      assert.equal(
        (await start.POST(request({ ref_system: 'Sol', ...body }))).status,
        400
      );
    }
  } finally {
    globalThis.fetch = original;
    delete globalThis.__marketDb;
  }
});

test('single commodity works offline from fresh EDDN symbols and uses commander purchase price', async () => {
  const original = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches++;
    throw new TypeError('fetch failed');
  };
  globalThis.__marketDb = database({
    job: job(),
    prices: [
      {
        station_name: 'Station',
        commodity_name: 'steel',
        stock: 400,
        buy_price: 100,
        sell_price: 90,
        reported_at: new Date().toISOString(),
      },
    ],
  });
  try {
    const response = await step.POST(request({ job_id: 'job-1' }));
    assert.equal(response.status, 200);
    assert.equal(response.body.is_done, true);
    assert.equal(fetches, 0);
    assert.equal(response.body.result[0].commodity, 'Steel');
    assert.equal(response.body.result[0].sell_price, 100);
  } finally {
    globalThis.fetch = original;
    delete globalThis.__marketDb;
  }
});

test('build search merges cached station inventory with EDDN on EDSM outage, and reports partial coverage', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError('fetch failed');
  };
  const names = catalog.constructionCommodities('no_truss');
  globalThis.__marketDb = database({
    job: job({ mode: 'build', commodity: null, build_type: 'no_truss' }),
    cache: [
      {
        station_name: 'Station',
        commodity_name: names[0],
        stock: 100,
        buy_price: 111,
        updated_at: '2020-01-01',
      },
    ],
    prices: [
      {
        station_name: 'Station',
        commodity_name: names[1].replace(/ /g, '').toLowerCase(),
        stock: 200,
        buy_price: 222,
        reported_at: '2020-01-01',
      },
      {
        station_name: 'Station',
        commodity_name: 'Gold',
        stock: 999,
        buy_price: 1,
        reported_at: '2020-01-01',
      },
    ],
  });
  try {
    const response = await step.POST(request({ job_id: 'job-1' }));
    assert.equal(response.status, 200);
    assert.equal(response.body.is_done, true);
    const station = response.body.result[0];
    assert.equal(station.commodities_found, 2);
    assert.equal(station.commodities_total, names.length);
    assert.deepEqual(
      station.commodities.map((item) => item.sell_price),
      [111, 222]
    );
    assert.equal(response.body.warnings.length, 1);
    assert.equal(response.body.scan_log[0].status, 'unavailable');
    assert.ok(
      !globalThis.__marketDb.writes.some(
        (write) => write.table === 'colonisation_market_systems'
      ),
      'network failure must not write has_market=false'
    );
  } finally {
    globalThis.fetch = original;
    delete globalThis.__marketDb;
  }
});

test('live scan fetches each station market only once, caches zero stock for missing requested goods, and normalizes names', async () => {
  const original = globalThis.fetch;
  let markets = 0;
  globalThis.fetch = async (url) => ({
    ok: true,
    json: async () =>
      String(url).includes('/stations/market')
        ? (markets++,
          {
            commodities: [
              {
                name: 'steel',
                stock: 42,
                buyPrice: 101,
                sellPrice: 80,
                demand: 0,
              },
            ],
          })
        : {
            stations: [
              {
                name: 'Station',
                type: 'Coriolis',
                haveMarket: true,
                marketId: 123,
              },
            ],
          },
  });
  globalThis.__marketDb = database({
    job: job({ mode: 'build', build_type: 'no_truss' }),
  });
  try {
    const response = await step.POST(request({ job_id: 'job-1' }));
    assert.equal(response.status, 200);
    assert.equal(markets, 1);
    assert.equal(response.body.result[0].commodities[0].name, 'Steel');
    assert.equal(response.body.result[0].commodities[0].sell_price, 101);
    const cached = globalThis.__marketDb.writes.find(
      (write) => write.table === 'market_search_cache'
    ).value;
    assert.equal(
      cached.length,
      catalog.constructionCommodities('no_truss').length
    );
    assert.equal(cached.find((row) => row.commodity_name === 'Water').stock, 0);
  } finally {
    globalThis.fetch = original;
    delete globalThis.__marketDb;
  }
});

test('market start sanitizes Supabase fetch-failure responses rather than returning raw fetch failed', async () => {
  globalThis.__marketDb = {from(){return {
    insert(){return this;},select(){return this;},
    single:async()=>({data:null,error:{message:'TypeError: fetch failed'}}),
  };}};
  try {
    const response = await start.POST(request({ref_system:'Sol',radius:50,mode:'single',commodity:'Steel'}));
    assert.equal(response.status,503);
    assert.doesNotMatch(response.body.error,/fetch failed/);
    assert.match(response.body.error,/базе данных/);
  } finally {delete globalThis.__marketDb;}
});

test('standalone market search handles symbol/display spelling, valid limits and unavailable database', async () => {
  const search = await import(await bundleFile({entry:'src/app/api/market/search/route.ts',stubs:{'next/server':server,'@/lib/supabaseServer':dbStub}}));
  const filters=[];
  globalThis.__marketDb={from(){const query={select(){return query;},ilike(key,value){filters.push([key,value]);return query;},gt(){return query;},order(key){filters.push(['order',key]);return query;},limit(value){filters.push(['limit',value]);return query;},then(resolve,reject){return Promise.resolve({data:[],error:null}).then(resolve,reject);}};return query;}};
  try {
    const response=await search.GET(new Request('http://test.local?commodity=computercomponents&limit=bad'));
    assert.equal(response.status,200);
    assert.ok(filters.some(([key,value])=>key==='commodity_name' && value==='%Computer%Components%'));
    assert.ok(filters.some(([key,value])=>key==='limit' && value===50));
    assert.ok(filters.some(([key,value])=>key==='order' && value==='buy_price'));
    globalThis.__marketDb={from(){throw new TypeError('fetch failed');}};
    const failed=await search.GET(new Request('http://test.local?commodity=Steel'));
    assert.equal(failed.status,503);assert.doesNotMatch(failed.body.error,/fetch failed/);
  }finally{delete globalThis.__marketDb;}
});
