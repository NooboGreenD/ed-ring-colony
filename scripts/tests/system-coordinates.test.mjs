import test from 'node:test';
import assert from 'node:assert/strict';
import { bundleFile } from './helpers/bundle.mjs';
const server = `export const NextResponse={json:(body,options={})=>({body,status:options.status||200})};`;
const db = `export const supabaseAdmin={from:table=>globalThis.__coordsDb.from(table)};`;
const stubs = { 'next/server': server, '@/lib/supabaseAdmin': db };
const route = await import(
  await bundleFile({ entry: 'src/app/api/route/resolve/route.ts', stubs })
);
const legacy = await import(
  await bundleFile({ entry: 'src/app/api/edsm/batch/route.ts', stubs })
);
const hubs = await import(
  await bundleFile({ entry: 'src/app/api/hubs/resolve/route.ts', stubs })
);
const client = await import(
  await bundleFile({ entry: 'src/lib/updateSystemCoordinates.ts' })
);
const types = await import(
  await bundleFile({ entry: 'src/lib/systemCoordinateTypes.ts' })
);
const request = (names) =>
  new Request('http://test.local', {
    method: 'POST',
    body: JSON.stringify({ names }),
  });
function catalog(rows = [], failed = false) {
  const calls = [];
  return {
    calls,
    from() {
      let offset = 0,
        keys = [];
      const query = {
        select() {
          return query;
        },
        order() {
          return query;
        },
        abortSignal(signal) {
          assert.ok(signal);
          return query;
        },
        in(_, values) {
          keys = values;
          calls.push(values);
          return query;
        },
        range(from) {
          offset = from;
          return query;
        },
        then(resolve, reject) {
          return Promise.resolve({
            data: failed
              ? null
              : rows
                  .filter((row) =>
                    keys.includes(types.coordinateNameKey(row.name))
                  )
                  .slice(offset, offset + 1000),
            error: failed ? { message: 'fetch failed' } : null,
          }).then(resolve, reject);
        },
      };
      return query;
    },
  };
}
const response = (data) => ({ ok: true, status: 200, json: async () => data });

test('coordinate validation rejects missing/null/empty/infinite/boolean axes but accepts origin and negative coordinates', () => {
  for (const value of [
    null,
    {},
    { x: null, y: 0, z: 0 },
    { x: '', y: 0, z: 0 },
    { x: false, y: 0, z: 0 },
    { x: NaN, y: 0, z: 0 },
    { x: 0, y: Infinity, z: 0 },
  ])
    assert.equal(types.readSystemCoordinates(value), null);
  assert.deepEqual(types.readSystemCoordinates({ x: 0, y: 0, z: 0 }), {
    x: 0,
    y: 0,
    z: 0,
  });
  assert.deepEqual(
    types.readSystemCoordinates({ coords: { x: -1, y: '2.5', z: 0 } }),
    { x: -1, y: 2.5, z: 0 }
  );
});

test('route resolves EDSM first, preserves requested spelling and ignores unrequested systems without contacting Spansh', async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.__coordsDb = catalog();
  globalThis.fetch = async (url, options) => {
    calls.push(String(url));
    assert.ok(options.signal);
    return response([
      { name: 'Alpha Sector', coords: { x: 0, y: -1, z: 2 } },
      { name: 'Unrequested', coords: { x: 99, y: 99, z: 99 } },
    ]);
  };
  try {
    const result = await route.POST(
      request([' aLPHA  Sector ', 'ALPHA SECTOR'])
    );
    assert.equal(result.status, 200);
    assert.equal(result.body.resolved, 2);
    assert.deepEqual(result.body.results[' aLPHA  Sector '], {
      x: 0,
      y: -1,
      z: 2,
    });
    assert.equal(result.body.sources['ALPHA SECTOR'], 'edsm');
    assert.equal(result.body.results.Unrequested, undefined);
    assert.equal(globalThis.__coordsDb.calls.length, 0);
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = original;
    delete globalThis.__coordsDb;
  }
});

test('route, legacy project and hub endpoints share catalog/live Spansh fallback with exact-name matching', async () => {
  const original = globalThis.fetch;
  globalThis.__coordsDb = catalog([{ name: 'Catalog', x: -10, y: 0, z: 5 }]);
  globalThis.fetch = async (url) => {
    if (String(url).includes('edsm'))
      return response([
        { name: 'EDSM', coords: { x: 1, y: 2, z: 3 } },
        { name: 'Catalog', coords: { x: null, y: 0, z: 0 } },
      ]);
    const name = new URL(String(url)).searchParams.get('q');
    return response({
      results: [
        { record: { name: name + ' Nearby', x: 999, y: 999, z: 999 } },
        ...(name === 'Live'
          ? [{ record: { name: 'LIVE', coords: { x: 4, y: 0, z: -4 } } }]
          : []),
      ],
    });
  };
  try {
    for (const endpoint of [route, legacy]) {
      const result = await endpoint.POST(
        request(['EDSM', 'Catalog', 'Live', 'Missing'])
      );
      assert.equal(result.status, 200);
      assert.equal(result.body.resolved, 3);
      assert.equal(result.body.sources.EDSM, 'edsm');
      assert.equal(result.body.sources.Catalog, 'spansh_catalog');
      assert.equal(result.body.sources.Live, 'spansh');
      assert.deepEqual(result.body.results.Live, { x: 4, y: 0, z: -4 });
      assert.equal(result.body.results.Missing, undefined);
      assert.deepEqual(result.body.unresolved, ['Missing']);
    }
    const hub = await hubs.GET(new Request('http://test.local?name=Live'));
    assert.equal(hub.status, 200);
    assert.equal(hub.body.system_name, 'LIVE');
    assert.equal(hub.body.source, 'spansh');
    assert.equal(hub.body.x, 4);
    const absent = await hubs.GET(
      new Request('http://test.local?name=Missing')
    );
    assert.equal(absent.status, 404);
  } finally {
    globalThis.fetch = original;
    delete globalThis.__coordsDb;
  }
});

test('EDSM outages retry then resolve via live Spansh even without a configured local catalog', async () => {
  const original = globalThis.fetch;
  let edsmCalls = 0;
  globalThis.__coordsDb = catalog([], true);
  globalThis.fetch = async (url) => {
    if (String(url).includes('edsm')) {
      edsmCalls++;
      throw new TypeError('fetch failed');
    }
    return response({ results: [{ name: 'Fallback', x: 0, y: 0, z: 0 }] });
  };
  try {
    const result = await legacy.POST(request(['Fallback']));
    assert.equal(result.status, 200);
    assert.equal(result.body.resolved, 1);
    assert.equal(edsmCalls, 2);
    assert.equal(result.body.sources.Fallback, 'spansh');
    assert.equal(result.body.warnings.length, 2);
    assert.ok(
      result.body.warnings.every((warning) => !warning.includes('fetch failed'))
    );
    globalThis.fetch = async () => {
      throw new TypeError('fetch failed');
    };
    const hub = await hubs.GET(new Request('http://test.local?name=Fallback'));
    assert.equal(hub.status, 503);
    assert.match(hub.body.error, /EDSM и Spansh/);
  } finally {
    globalThis.fetch = original;
    delete globalThis.__coordsDb;
  }
});

test('all endpoints validate input before contacting sources; batches are bounded at 100 names', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('unexpected upstream call');
  };
  try {
    for (const names of [
      [],
      [''],
      [null],
      [123],
      ['x'.repeat(201)],
      Array.from({ length: 101 }, (_, i) => 'System ' + i),
    ])
      assert.equal((await route.POST(request(names))).status, 400);
    assert.equal(
      (
        await legacy.POST(
          new Request('http://test.local', {
            method: 'POST',
            body: 'invalid json',
          })
        )
      ).status,
      400
    );
    assert.equal(
      (await hubs.GET(new Request('http://test.local'))).status,
      400
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('browser batch updater reaches all 20,051 missing rows with <=10-name lookups, skips existing origin and counts failed writes honestly', async () => {
  const original = globalThis.fetch;
  const lookups = [];
  const writes = [];
  let finalProgress = 0;
  globalThis.fetch = async (_, options) => {
    const names = JSON.parse(options.body).names;
    lookups.push(names);
    return response({
      results: Object.fromEntries(
        names.map((name) => [name, { x: 1, y: 2, z: 3 }])
      ),
      sources: Object.fromEntries(names.map((name) => [name, 'spansh'])),
      warnings: [],
    });
  };
  const rows = Array.from({ length: 20051 }, (_, i) => ({
    id: i + 1,
    system_name: 'System ' + (i + 1),
    x: null,
    y: null,
    z: null,
  }));
  try {
    const result = await client.updateSystemCoordinates(
      [{ id: 0, system_name: 'Origin', x: 0, y: 0, z: 0 }, ...rows],
      async (row, coords) => {
        if (row.id === 20050) throw new Error('write denied');
        writes.push({ id: row.id, coords });
      },
      {
        onProgress: (done) => {
          finalProgress = done;
        },
      }
    );
    assert.equal(result.total, 20051);
    assert.equal(result.updated, 20050);
    assert.equal(result.failed, 1);
    assert.equal(result.sources.spansh, 20050);
    assert.equal(result.unresolved, 0);
    assert.equal(finalProgress, 20051);
    assert.ok(lookups.every((names) => names.length <= 10));
    assert.ok(writes.some((write) => write.id === 20051));
    assert.ok(!writes.some((write) => write.id === 0));
  } finally {
    globalThis.fetch = original;
  }
});

test('browser updater checks HTTP errors before writes and never writes null/invalid/missing coordinates', async () => {
  const original = globalThis.fetch;
  const writes = [];
  const rows = ['Missing', 'Null', 'Valid'].map((system_name, id) => ({
    id,
    system_name,
  }));
  try {
    globalThis.fetch = async () => ({
      ok: false,
      status: 503,
      json: async () => ({ error: 'source unavailable' }),
    });
    await assert.rejects(
      () =>
        client.updateSystemCoordinates(rows, async (row) => {
          writes.push(row.id);
        }),
      /source unavailable/
    );
    assert.equal(writes.length, 0);
    globalThis.fetch = async () =>
      response({
        results: { Null: { x: null, y: 0, z: 0 }, Valid: { x: 0, y: 0, z: 0 } },
        sources: { Valid: 'edsm' },
        warnings: ['Spansh недоступен'],
      });
    const result = await client.updateSystemCoordinates(rows, async (row) => {
      writes.push(row.id);
    });
    assert.deepEqual(writes, [2]);
    assert.equal(result.unresolved, 2);
    assert.equal(result.updated, 1);
    assert.equal(result.warnings.length, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test('project coordinate-only API reads all 20,051 stored rows without inheriting coordinates from the global route', async () => {
  const mod = await import(
    await bundleFile({
      entry: 'src/app/api/projects/[id]/systems/route.ts',
      stubs: {
        'next/server': server,
        '@/lib/supabaseServer': `export const createClient=async()=>({});`,
        '@/lib/supabaseAdmin': `export const createAdminClient=()=>globalThis.__projectCoordsDb;`,
      },
    })
  );
  const rows = Array.from({ length: 20051 }, (_, i) => ({
    id: i + 1,
    system_name: 'System ' + (i + 1),
    x: null,
    y: null,
    z: null,
  }));
  const calls = [];
  globalThis.__projectCoordsDb = {
    from(table) {
      assert.equal(table, 'project_systems');
      let from = 0,
        to = 999;
      const query = {
        select(columns) {
          assert.equal(columns, 'id,system_name,x,y,z');
          return query;
        },
        eq(key, value) {
          assert.equal(key, 'project_id');
          assert.equal(value, 7);
          return query;
        },
        order() {
          return query;
        },
        range(start, end) {
          from = start;
          to = end;
          calls.push(start);
          return query;
        },
        then(resolve, reject) {
          return Promise.resolve({
            data: rows.slice(from, to + 1),
            error: null,
          }).then(resolve, reject);
        },
      };
      return query;
    },
  };
  try {
    const response = await mod.GET(
      new Request('http://test.local?coordinates_only=1'),
      { params: Promise.resolve({ id: '7' }) }
    );
    assert.equal(response.status, 200);
    assert.equal(response.body.systems.length, 20051);
    assert.equal(response.body.systems.at(-1).id, 20051);
    assert.equal(response.body.systems.at(-1).x, null);
    assert.equal(calls.at(-1), 20051);
  } finally {
    delete globalThis.__projectCoordsDb;
  }
});

test('Spansh fallback resolves exact ID64-only search hits through the dump, but rejects mismatched names and rounded IDs', async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.__coordsDb = catalog();
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes('edsm')) return response([]);
    if (String(url).includes('/dump/'))
      return response({
        system: {
          name: String(url).endsWith('/1') ? 'Wrong name' : 'Dump',
          coords: { x: -1, y: 0, z: 1 },
        },
      });
    const name = new URL(String(url)).searchParams.get('q');
    return response({
      results: [
        {
          record: {
            name,
            id64:
              name === 'Dump'
                ? '18446744073709551615'
                : name === 'Wrong'
                  ? '1'
                  : Number('18446744073709551615'),
          },
        },
      ],
    });
  };
  try {
    const result = await route.POST(request(['Dump', 'Wrong', 'Rounded']));
    assert.equal(result.status, 200);
    assert.equal(result.body.resolved, 1);
    assert.deepEqual(result.body.results.Dump, { x: -1, y: 0, z: 1 });
    assert.deepEqual(result.body.unresolved, ['Wrong', 'Rounded']);
    assert.ok(calls.some((url) => url.endsWith('/18446744073709551615')));
    assert.equal(calls.filter((url) => url.includes('/dump/')).length, 2);
  } finally {
    globalThis.fetch = original;
    delete globalThis.__coordsDb;
  }
});
