import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = fileURLToPath(new URL('../..', import.meta.url));

const STUBS = {
    './supabaseAdmin.ts': `export const supabaseAdmin = { from: () => {
      let id = null, inserted = null, updated = null;
      const api = {
        select() { return api; }, eq(_, value) { id = value; return api; },
        insert(value) { inserted = value; return api; },
        update(value) { updated = value; return api; },
        then(resolve, reject) {
          Object.assign(globalThis.__orientationRows.get(id), updated);
          return Promise.resolve({error:null}).then(resolve,reject);
        },
        async single() {
          const key = 'ring-' + globalThis.__orientationRows.size;
          globalThis.__orientationRows.set(key, {id:key, ...inserted});
          return {data:{id:key},error:null};
        },
        async maybeSingle() { return {data:globalThis.__orientationRows.get(id) || null,error:null}; },
      }; return api;
    } };`,
    './galaxySystemsDb.ts': `
      export const findSystemByName = async name => name === 'Sol'
        ? {name:'Sol',x:0,y:0,z:0} : {name, x:25.21875,y:-20.90625,z:25899.96875};
      export const catalogIsComplete = () => true;
      export const findSystemsInCube = async () => [];
      export const getGalaxyStats = async () => ({systems_count:1000000});`,
    './atlasSystemCache.ts': `export const listCachedSystemsNear = async () => [];
      export const saveCachedSystems = async () => 0;`,
    './spanshClient.ts': `export const spanshNearest = async () => null;
      export const spanshSearch = async () => null; export const spanshSystemsNear = async () => [];`,
};
async function load() {
  const dir = mkdtempSync(join(ROOT,'.tmp-ring-orientation-'));
  const outfile = join(dir,'ring.mjs');
  try {
    await build({ entryPoints:[join(ROOT,'src/lib/atlasRingSearch.ts')], bundle:true, format:'esm',
      platform:'node', outfile, logLevel:'silent', plugins:[{
        name:'orientation-stubs', setup(build) {
          build.onResolve({filter:/^\.\/(supabaseAdmin|galaxySystemsDb|atlasSystemCache|spanshClient)\.ts$/}, args => ({path:args.path,namespace:'stub'}));
          build.onLoad({filter:/.*/,namespace:'stub'}, args => ({contents:STUBS[args.path],loader:'ts'}));
        }
      }] });
    return {mod:await import(outfile),cleanup:() => rmSync(dir,{recursive:true,force:true})};
  } catch (error) { rmSync(dir,{recursive:true,force:true}); throw error; }
}

test('кольцо: сторона и ось сохраняются, восстанавливаются и возвращаются из готовой сессии', async () => {
  const {mod:m, cleanup} = await load();
  globalThis.__orientationRows = new Map();
  try {
    for (const [tilt, axis] of [[-45, 135], [90, 270], [0, 359], [30, 405]]) {
      const plan = await m.planRingSession({startSystem:'Sol',ringRadius:1000,heightOffset:1000,tiltDegrees:tilt,tiltAxisDegrees:axis});
      const row = globalThis.__orientationRows.get(plan.sessionId);
      assert.equal(row.tilt_degrees ?? 0, tilt);
      assert.equal(row.tilt_axis_degrees, axis % 360);
      const restored = await m.loadRingSession(plan.sessionId);
      assert.equal(restored.tiltDegrees, tilt);
      assert.equal(restored.tiltAxisDegrees, axis % 360);
      assert.deepEqual(restored.basis3D, plan.basis3D);
      assert.deepEqual(restored.ringCenter, plan.ringCenter);
      row.status = 'completed';
      row.route = [plan.start, {...plan.start,x:plan.start.x+10,name:'Next'}, plan.start];
      const result = await m.finalizeRingSession(plan.sessionId);
      assert.equal(result.tiltAxisDegrees, axis % 360);
      assert.equal(result.tiltDegrees, tilt);
      assert.deepEqual(result.basis3D, plan.basis3D);
      const rerun = await m.replanRingSession(plan.sessionId, {deviationLimit:150});
      assert.equal(rerun.tiltDegrees, tilt);
      assert.equal(rerun.tiltAxisDegrees, axis % 360);
      assert.deepEqual(rerun.basis3D, plan.basis3D);
      assert.deepEqual((await m.loadRingSession(plan.sessionId)).basis3D, plan.basis3D);
    }
    const flat = await m.planRingSession({startSystem:'Sol',ringRadius:1000});
    const oldRow = globalThis.__orientationRows.get(flat.sessionId);
    delete oldRow.tilt_axis_degrees;
    assert.equal((await m.loadRingSession(flat.sessionId)).tiltAxisDegrees, 0, 'старые сессии не меняют ориентацию');
  } finally { delete globalThis.__orientationRows; cleanup(); }
});
