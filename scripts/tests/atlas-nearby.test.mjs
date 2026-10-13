import test from 'node:test';
import assert from 'node:assert/strict';
import { bundleFile } from './helpers/bundle.mjs';
const geometry = await import(
  await bundleFile({ entry: 'src/lib/atlasNearby.ts' })
);
const stub = `export const supabaseAdmin={from:table=>globalThis.__nearbyDb.from(table)};`;
const server = `export const NextResponse={json:(body,options={})=>({body,status:options.status||200})};`;
const api = await import(
  await bundleFile({
    entry: 'src/app/api/atlas/nearby/route.ts',
    stubs: { 'next/server': server, '@/lib/supabaseAdmin': stub },
  })
);
const center = { name: 'Sol', x: 0, y: 0, z: 0, id64: '10477373803' };
const records = (count) =>
  Array.from({ length: count }, (_, i) => ({
    name: `System ${i + 1}`,
    id64: String(100000 + i),
    x: i / count,
    y: 0,
    z: 0,
  }));
function database({
  catalog = [],
  cache = [],
  cap = 1000,
  partial = false,
  failedTable = null,
} = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      let from = 0,
        to = 999;
      const filters = [];
      const query = {
        select() {
          return query;
        },
        order(key) {
          calls.push({ table, order: key });
          return query;
        },
        abortSignal() {
          return query;
        },
        eq(key, value) {
          filters.push([key, value]);
          return query;
        },
        gte() {
          return query;
        },
        lte() {
          return query;
        },
        range(start, end) {
          from = start;
          to = end;
          calls.push({ table, from, to });
          return query;
        },
        maybeSingle: async () =>
          table === 'galaxy_systems_meta'
            ? {
                data: { value: { systems_count: 2000000, partial } },
                error: null,
              }
            : {
                data:
                  table === 'galaxy_systems' && table !== failedTable
                    ? center
                    : null,
                error: null,
              },
        then(resolve, reject) {
          if (table === failedTable)
            return Promise.resolve({
              data: null,
              error: { message: 'database unavailable' },
            }).then(resolve, reject);
          const source = table === 'galaxy_systems' ? catalog : cache;
          return Promise.resolve({
            data: source.slice(from, Math.min(to + 1, from + cap)),
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

test('nearby geometry: sphere/cube boundaries, shifted centers, invalid coordinates and precision-safe IDs', () => {
  assert.ok(geometry.inNearbyVolume({ ...center, x: 1 }, center, 'sphere', 1));
  assert.ok(
    !geometry.inNearbyVolume(
      { ...center, x: 1, y: 1, z: 1 },
      center,
      'sphere',
      1
    )
  );
  assert.ok(
    geometry.inNearbyVolume({ ...center, x: 1, y: 1, z: 1 }, center, 'cube', 1)
  );
  assert.ok(
    !geometry.inNearbyVolume({ ...center, x: 1.001 }, center, 'cube', 1)
  );
  assert.ok(
    geometry.inNearbyVolume(
      { name: 'Edge', x: 101, y: 200, z: 300 },
      { name: 'Shifted', x: 100, y: 200, z: 300 },
      'sphere',
      1
    )
  );
  assert.equal(
    geometry.nearbyPoint({ name: 'Null', x: null, y: 0, z: 0 }),
    null
  );
  assert.equal(
    geometry.nearbyPoint({ name: 'NaN', x: 'bad', y: 0, z: 0 }),
    null
  );
  assert.equal(
    geometry.nearbyPoint({ ...center, id64: '18446744073709551615' }).id64,
    '18446744073709551615'
  );
  assert.equal(
    geometry.nearbyPoint({ ...center, id64: Number('18446744073709551615') })
      .id64,
    undefined
  );
});

test('nearby merge: deduplicates names and ID64 aliases, records coordinate conflicts, filters by preferred coordinates', () => {
  const result = geometry.mergeNearbySystems(center, 'sphere', 1, [
    {
      source: 'catalog',
      systems: [
        { name: 'Alpha', id64: '1', x: 0.5, y: 0, z: 0 },
        { name: 'Outside', id64: '2', x: 2, y: 0, z: 0 },
      ],
    },
    {
      source: 'cache',
      systems: [
        { name: ' ALPHA ', id64: '1', x: 0.6, y: 0, z: 0 },
        { name: 'Alias', id64: '1', x: 0.5, y: 0, z: 0 },
        { name: 'Outside', id64: '2', x: 0.2, y: 0, z: 0 },
      ],
    },
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'Alpha');
  assert.equal(result[0].x, 0.5);
  assert.equal(result[0].coordinate_conflict, true);
  assert.deepEqual(result[0].sources, ['catalog', 'cache']);
  assert.ok(result[0].aliases.includes('Alias'));
});

test('nearby API rejects invalid shapes and radii outside 1–50 before accessing sources', async () => {
  for (const body of [
    null,
    { reference_system: 'Sol', shape: 'cube', radius: 0 },
    { reference_system: 'Sol', shape: 'sphere', radius: 51 },
    { reference_system: 'Sol', shape: 'bad', radius: 10 },
    { reference_system: '', shape: 'cube', radius: 1 },
    { reference_system: 'Sol', shape: 'sphere', radius: '10' },
  ]) {
    assert.equal((await api.POST(request(body))).status, 400);
  }
});

test('nearby search reads all 20,051 catalog systems under a lower server cap, retains center and survives external outages', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError('fetch failed');
  };
  const points = records(20051);
  globalThis.__nearbyDb = database({ catalog: points, cap: 137 });
  try {
    const response = await api.POST(
      request({ reference_system: 'Sol', shape: 'sphere', radius: 1 })
    );
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.systems.length, 20052);
    assert.equal(response.body.systems.at(-1).name, 'System 20051');
    assert.ok(response.body.systems.some((point) => point.name === 'Sol'));
    assert.equal(
      response.body.sources.find((source) => source.id === 'catalog').status,
      'ok'
    );
    assert.equal(
      response.body.sources.filter((source) => source.status === 'unavailable')
        .length,
      3
    );
    assert.ok(globalThis.__nearbyDb.calls.some((call) => call.from === 20051));
  } finally {
    globalThis.fetch = original;
    delete globalThis.__nearbyDb;
  }
});

test('nearby search consults both EDSM shapes and every Spansh page despite local results, including cube corners', async () => {
  const original = globalThis.fetch;
  const calls = [];
  const live = records(251);
  globalThis.fetch = async (url, options) => {
    calls.push({
      url: String(url),
      body: options.body ? JSON.parse(options.body) : null,
    });
    if (String(url).includes('spansh')) {
      const page = JSON.parse(options.body).page;
      return {
        ok: true,
        json: async () => ({
          count: 251,
          results: live
            .slice(page * 100, (page + 1) * 100)
            .map((record) => ({ record })),
        }),
      };
    }
    return {
      ok: true,
      json: async () => [
        { name: 'Corner', coords: { x: 1, y: 1, z: 1 } },
        { name: 'Outside', coords: { x: 1.01, y: 0, z: 0 } },
      ],
    };
  };
  globalThis.__nearbyDb = database({
    catalog: [center],
    cache: [{ system_name: 'Cached', x: 0, y: 1, z: 0 }],
    partial: true,
  });
  try {
    const response = await api.POST(
      request({ reference_system: 'Sol', shape: 'cube', radius: 1 })
    );
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.count, 254);
    assert.ok(response.body.systems.some((point) => point.name === 'Corner'));
    assert.ok(!response.body.systems.some((point) => point.name === 'Outside'));
    assert.equal(
      response.body.sources.find((source) => source.id === 'catalog').status,
      'partial'
    );
    assert.deepEqual(
      calls.filter((call) => call.body).map((call) => call.body.page),
      [0, 1, 2]
    );
    assert.ok(calls.some((call) => call.url.includes('sphere-systems')));
    assert.ok(calls.some((call) => call.url.includes('cube-systems')));
    assert.ok(
      calls
        .filter((call) => call.body)
        .every((call) => Number(call.body.filters.distance.max) >= Math.sqrt(3))
    );
  } finally {
    globalThis.fetch = original;
    delete globalThis.__nearbyDb;
  }
});

test('nearby search keeps valid Spansh pages after a later-page failure and marks the source partial', async () => {
  const original = globalThis.fetch;
  const points = records(100);
  globalThis.fetch = async (url, options) => {
    if (!String(url).includes('spansh'))
      return { ok: true, json: async () => [] };
    if (JSON.parse(options.body).page > 0) throw new TypeError('fetch failed');
    return { ok: true, json: async () => ({ count: 200, results: points }) };
  };
  globalThis.__nearbyDb = database({ catalog: [center] });
  try {
    const response = await api.POST(
      request({ reference_system: 'Sol', shape: 'sphere', radius: 1 })
    );
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.count, 101);
    assert.equal(
      response.body.sources.find((source) => source.id === 'spansh').status,
      'partial'
    );
    assert.ok(
      response.body.warnings.some((warning) => warning.includes('spansh'))
    );
  } finally {
    globalThis.fetch = original;
    delete globalThis.__nearbyDb;
  }
});
