import test from 'node:test';
import assert from 'node:assert/strict';
import { bundleFile } from './helpers/bundle.mjs';

const pagination = async () => import(await bundleFile({ entry: 'src/lib/readAllRows.ts' }));
const records = count => Array.from({ length: count }, (_, i) => ({ id: i + 1,
  system_name: `System ${i + 1}`, sort_order: Math.floor(i / 2), x: i, y: 0, z: 0, status: 'planned', progress: 0 }));

test('large route: read all 20,051 rows and handle a lower PostgREST cap', async () => {
  const { readAllRows } = await pagination();
  for (const cap of [1000, 137]) {
    const source = records(20051), offsets = [];
    const result = await readAllRows(async (from, to) => {
      offsets.push(from);
      assert.equal(to - from + 1, 1000);
      return { data: source.slice(from, from + cap), error: null };
    });
    assert.equal(result.error, null);
    assert.deepEqual(result.data, source);
    assert.equal(new Set(result.data.map(row => row.id)).size, 20051);
    assert.equal(offsets.at(-1), 20051);
  }
});

test('large route: no partial success when page 2 fails; empty routes are supported', async () => {
  const { readAllRows } = await pagination();
  const error = { message: 'database unavailable' };
  assert.deepEqual(await readAllRows(async from => from === 0
    ? { data: records(1000), error: null } : { data: null, error }), { data: null, error });
  assert.deepEqual(await readAllRows(async () => ({ data: [], error: null })), { data: [], error: null });
});

const SERVER_STUB = `
export const NextResponse = { json: (body, init = {}) => ({ body, status: init.status || 200 }) };
`;
const DATABASE_STUB = `
export const createClient = async () => globalThis.__largeRouteDb;
export const createAdminClient = () => globalThis.__largeRouteDb;
`;
function database(tables) {
  const calls = [];
  return { calls, from(table) {
    let from = 0, to = 999, filter = null;
    const api = {
      select() { return api; },
      eq(column, value) { filter = { column, value }; return api; },
      order(column) { calls.push({table,order:column}); return api; },
      range(start, end) { from = start; to = end; calls.push({table,from,to}); return api; },
      then(resolve, reject) {
        let rows = tables[table] || [];
        if (filter) rows = rows.filter(row => row[filter.column] === filter.value);
        return Promise.resolve({ data: rows.slice(from, Math.min(to + 1, from + 1000)), error: null }).then(resolve, reject);
      },
    };
    return api;
  } };
}

test('large route: public map API includes the final system and its progress', async () => {
  const mod = await import(await bundleFile({ entry: 'src/app/api/route/route.ts', stubs: {
    'next/server': SERVER_STUB, '@/lib/supabaseServer': DATABASE_STUB,
  } }));
  const points = records(20051);
  const progress = points.map(row => ({system_name:row.system_name,progress:row.id === 20051 ? 100 : 0,updated_at:'2026-10-13'}));
  globalThis.__largeRouteDb = database({route_systems:points,system_progress:progress});
  try {
    const response = await mod.GET();
    assert.equal(response.status,200);
    assert.equal(response.body.points.length,20051);
    assert.equal(response.body.points.at(-1).status,'done');
    assert.equal(response.body.points.at(-1).progress,100);
    assert.ok(globalThis.__largeRouteDb.calls.some(call => call.order === 'id'));
  } finally { delete globalThis.__largeRouteDb; }
});

test('large route: squadron project is not truncated at 15,000 and metadata reaches its last point', async () => {
  const mod = await import(await bundleFile({ entry: 'src/app/api/projects/[id]/systems/route.ts', stubs: {
    'next/server': SERVER_STUB, '@/lib/supabaseServer': DATABASE_STUB, '@/lib/supabaseAdmin': DATABASE_STUB,
  } }));
  const points = records(20051);
  globalThis.__largeRouteDb = database({project_systems: points.map(row => ({...row,project_id:7})),
    route_systems: points, system_progress: points.map(row => ({system_name:row.system_name,progress:100,updated_at:'2026-10-13'}))});
  try {
    const response = await mod.GET(new Request('http://example.test'), {params:Promise.resolve({id:'7'})});
    assert.equal(response.status,200);
    assert.equal(response.body.systems.length,20051);
    assert.equal(response.body.systems.at(-1).route_system.id,20051);
    assert.equal(response.body.systems.at(-1).progress,100);
  } finally { delete globalThis.__largeRouteDb; }
});

test('large route: Raven progress writeback finds a final row, preserves legacy whitespace and escapes LIKE wildcards', async () => {
  const {persistRavenSystemProgress}=await import(await bundleFile({entry:'src/lib/systemProgress.ts'}));
  const rows=records(20051);
  rows.at(-1).system_name='  Foo  _% Bar  ';
  rows.push({id:20052,system_name:'Foo ABC Bar'});
  const writes=[],queries=[];
  const matches=(name,pattern)=>{
    const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    let regex='^';
    for(let i=0;i<pattern.length;i++){
      const ch=pattern[i];
      if(ch==='\\' && i+1<pattern.length)regex+=escape(pattern[++i]);
      else regex+=ch==='%'?'.*':ch==='_'?'.':escape(ch);
    }
    return new RegExp(regex+'$','i').test(name);
  };
  const db={from(table){
    let pattern='',offset=0,to=999;
    const query={
      select(){return query;},ilike(_,value){pattern=value;return query;},order(){return query;},
      range(from,end){offset=from;to=end;return query;},
      upsert:async value=>{writes.push({table,value});return {error:null};},
      update(value){return {in:async(_,ids)=>{writes.push({table,value,ids});return {error:null};}};},
      then(resolve,reject){
        assert.ok(pattern,'each lookup must filter by name, not download the whole route');
        queries.push({table,pattern});
        const result=(table==='route_systems'?rows:[]).filter(row=>matches(row.system_name,pattern));
        return Promise.resolve({data:result.slice(offset,to+1),error:null}).then(resolve,reject);
      },
    };return query;
  }};
  const result=await persistRavenSystemProgress(db,'foo _% bar',{systemName:'FOO _% BAR',progress:100,projects:[]});
  assert.deepEqual(result.warnings,[]);
  assert.equal(result.updatedRouteSystems,1);
  assert.equal(result.cacheSystemName,'  Foo  _% Bar  ');
  assert.deepEqual(writes.find(write=>write.table==='route_systems').ids,[20051]);
  assert.ok(queries.every(query=>query.pattern.includes('\\_\\%')));
});
