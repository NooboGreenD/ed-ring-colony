import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';

const ROOT = process.cwd();
const dir = mkdtempSync(join(ROOT, '.tmp-outfitting-catalog-'));
const originalEnv = Object.fromEntries(['NODE_ENV', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_INTERNAL_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'OUTFITTING_DATA_FILE', 'BILLING_PREVIEW_ADMIN'].map((key) => [key, process.env[key]]));
after(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
writeFileSync(join(dir, 'next-server.mjs'), `export const NextResponse = { json: (body, init = {}) => new Response(JSON.stringify(body), { ...init, headers: { 'content-type': 'application/json', ...init.headers } }) };`);
writeFileSync(join(dir, 'auth.mjs'), `
export const auth = { user: null, profile: null, error: null, calls: [] };
export async function authFromRequest() {
  return {user:auth.user,supabase:{from(table){auth.calls.push({table});return {select(fields){auth.calls.at(-1).fields=fields;return this;},eq(key,value){auth.calls.at(-1).filter=[key,value];return this;},async maybeSingle(){return {data:auth.profile,error:auth.error};}};}}};
}`);
writeFileSync(join(dir, 'db.mjs'), `
export const db = { row: null, error: null, calls: [], race: false };
export function createAdminClient() {
  return {from(table){const call={table,filters:[],patch:null};db.calls.push(call);return {
    select(){return this;},update(patch){call.patch=patch;return this;},eq(key,value){call.filters.push([key,value]);return this;},
    async maybeSingle(){
      if(db.error)return {data:null,error:db.error};
      if(!call.patch)return {data:structuredClone(db.row),error:null};
      if(db.race){db.row.revision++;db.race=false;}
      if(!db.row || call.filters.some(([key,value])=>db.row[key]!==value))return {data:null,error:null};
      Object.assign(db.row,structuredClone(call.patch));return {data:{revision:db.row.revision},error:null};
    }
  };}};
}`);
writeFileSync(join(dir, 'entry.ts'), `
export * from '@/lib/outfitting/catalog';
export * from '@/lib/outfitting/catalogStore';
export {requireCatalogAdmin} from '@/lib/outfitting/catalogAuth';
export {catalogGroupName} from '@/lib/outfitting/i18n';
export {moduleLabel, defaultBuild} from '@/lib/outfitting/build';
export {modulesForSlot, buildSlots} from '@/lib/outfitting/calc';
export * as admin from '@/app/api/admin/outfitting/route';
export * as publicCatalog from '@/app/api/outfitting/catalog/route';
export {auth} from './auth.mjs';export {db} from './db.mjs';
`);
await build({ entryPoints: [join(dir, 'entry.ts')], outfile: join(dir, 'bundle.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', alias: {
  '@': join(ROOT, 'src'), 'next/server': join(dir, 'next-server.mjs'),
  '@/lib/supabaseServer': join(dir, 'auth.mjs'), '@/lib/supabaseAdmin': join(dir, 'db.mjs'),
} });
const lib = await import(join(dir, 'bundle.mjs'));
const base = JSON.parse(readFileSync(join(ROOT, 'public/data/outfitting.json'), 'utf8'));
const initial = () => structuredClone(lib.EMPTY_CATALOG_STATE);
const moduleValue = (id = 'test_module') => ({ id, grp: 'pp', name: 'Тестовый реактор', class: 2, rating: 'A', mass: 1.2, power: 0, cost: 42000, pgen: 20, integrity: 100 });
const operation = (action, kind, key, value) => ({ action, kind, key, value });
const apply = (state, ...commands) => lib.applyCatalogCommands(base, state, commands, 'CMDR Test', '2026-10-10T12:00:00Z');
const request = (body, options = {}) => new Request('https://site.example/api/admin/outfitting', { method: 'POST', headers: { 'content-type': 'application/json', ...options.headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const response = async (r) => ({ status: r.status, body: await r.json(), cache: r.headers.get('cache-control') });

beforeEach(() => {
  process.env.NODE_ENV = 'test';
  delete process.env.SUPABASE_SERVICE_ROLE_KEY; delete process.env.SUPABASE_INTERNAL_URL; delete process.env.NEXT_PUBLIC_SUPABASE_URL; delete process.env.BILLING_PREVIEW_ADMIN;
  process.env.OUTFITTING_DATA_FILE = join(dir, 'catalog.json');
  rmSync(process.env.OUTFITTING_DATA_FILE, { force: true });
  Object.assign(lib.auth, { user: { id: 'admin-user' }, profile: { role: 'admin', cmdr_name: 'CMDR Tester' }, error: null, calls: [] });
  Object.assign(lib.db, { row: { id: 1, revision: 0, changes: {}, history: [], updated_at: null }, error: null, calls: [], race: false });
});

test('unmodified catalogue includes every source module, group and ship without mutating source', () => {
  const data = lib.mergeCatalog(base, initial());
  assert.equal(Object.values(data.modules).flat().length, 973);
  assert.equal(Object.keys(data.groups).length, 88);
  assert.equal(Object.values(data.ships).flatMap((ship) => ship.bulkheads).length, 236);
  assert.equal(data.catalogRevision, 0);
  assert.equal(base.catalogRevision, undefined);
  assert.deepEqual(data.modules, base.modules);
});

test('create, update/rename and duplicate preserve every extra field', () => {
  const value = moduleValue();
  let state = apply(initial(), operation('create', 'module', 'pp:test_module', { ...value, requirements: { test_material: 2 }, sourceName: 'Original name', eff: 0.35 }));
  const created = lib.mergeCatalog(base, state).modules.pp.find((entry) => entry.id === value.id);
  state = apply(state, operation('update', 'module', 'pp:test_module', { ...created, name: 'Новый реактор', mass: 2.4 }));
  const edited = lib.mergeCatalog(base, state).modules.pp.find((entry) => entry.id === value.id);
  assert.equal(edited.name, 'Новый реактор'); assert.equal(edited.mass, 2.4);
  assert.deepEqual(edited.requirements, { test_material: 2 }); assert.equal(edited.eff, 0.35);
  state = apply(state, operation('create', 'module', 'pp:test_copy', { ...edited, id: 'test_copy', name: 'Копия' }));
  assert.equal(lib.mergeCatalog(base, state).modules.pp.find((entry) => entry.id === 'test_copy').pgen, 20);
  assert.equal(state.revision, 3); assert.equal(state.history.length, 3);
  assert.equal(state.history[0].actor, 'CMDR Test');
});

test('deletion is a tombstone; restore retains edits; reset uses the CURRENT source', () => {
  const original = base.modules.pp[1];
  const key = `pp:${original.id}`;
  let state = apply(initial(), operation('update', 'module', key, { ...original, name: 'Ручное название' }));
  state = apply(state, operation('delete', 'module', key));
  assert.ok(!lib.mergeCatalog(base, state).modules.pp.some((entry) => entry.id === original.id));
  const upstream = structuredClone(base); upstream.modules.pp[1].cost = 123456;
  assert.ok(!lib.mergeCatalog(upstream, state).modules.pp.some((entry) => entry.id === original.id), 'upstream rebuild cannot resurrect a tombstone');
  state = apply(state, operation('restore', 'module', key));
  assert.equal(lib.mergeCatalog(base, state).modules.pp[1].name, 'Ручное название');
  state = lib.applyCatalogCommands(upstream, state, [operation('reset', 'module', key)], 'CMDR Test');
  assert.equal(lib.mergeCatalog(upstream, state).modules.pp[1].cost, 123456);
  assert.equal(Object.keys(state.changes).length, 0);
});

test('duplicate IDs, including archived custom IDs, are rejected; groups scope module IDs', () => {
  const value = moduleValue();
  let state = apply(initial(), operation('create', 'module', 'pp:test_module', value));
  assert.throws(() => apply(state, operation('create', 'module', 'pp:test_module', value)), (error) => error.status === 409);
  state = apply(state, operation('delete', 'module', 'pp:test_module'));
  assert.throws(() => apply(state, operation('create', 'module', 'pp:test_module', value)), /ID уже существует/);
  state = apply(state, operation('restore', 'module', 'pp:test_module'));
  assert.equal(lib.mergeCatalog(base, state).modules.pp.at(-1).name, value.name);
  assert.throws(() => apply(state, operation('reset', 'module', 'pp:test_module')), (error) => error.status === 404);
  state = apply(state, operation('create', 'module', 't:test_module', { ...value, grp: 't' }));
  assert.ok(lib.mergeCatalog(base, state).modules.t.find((entry) => entry.id === value.id));
});

test('custom groups support module installation; renaming source groups is visible in the public shipyard', () => {
  let state = apply(initial(), operation('create', 'group', 'new_tools', { name: 'Спецоборудование', category: 'internal' }), operation('create', 'module', 'new_tools:test_tools', { ...moduleValue('test_tools'), grp: 'new_tools', class: 1 }));
  let data = lib.mergeCatalog(base, state);
  const ship = data.ships.sidewinder;
  const slots = lib.buildSlots(data, lib.defaultBuild(data, ship.id));
  const slot = slots.find((entry) => entry.section === 'internal' && !entry.special);
  assert.ok(lib.modulesForSlot(data, ship, slot).some((entry) => entry.grp === 'new_tools'));
  state = apply(state, operation('update', 'group', 'pp', { ...base.groups.pp, name: 'Реакторы эскадрильи' }));
  data = lib.mergeCatalog(base, state);
  assert.equal(lib.catalogGroupName(data, 'en', 'pp'), 'Реакторы эскадрильи');
  assert.match(lib.moduleLabel(data, data.modules.pp[1], 'ru'), /Реакторы эскадрильи/);
  assert.throws(() => apply(state, operation('create', 'group', 'new_core', { name: 'Новый основной', category: 'core' })), /Новые группы/);
});

test('protected, engineering-dependent and populated groups cannot be deleted or recategorised', () => {
  assert.throws(() => apply(initial(), operation('delete', 'group', 'pp')), (error) => error.status === 409);
  assert.ok(lib.groupDeletionReason(base, 'fsd'));
  let state = apply(initial(), operation('create', 'group', 'new_tools', { name: 'Tools', category: 'internal' }), operation('create', 'module', 'new_tools:tool', { ...moduleValue('tool'), grp: 'new_tools' }));
  assert.throws(() => apply(state, operation('delete', 'group', 'new_tools')), /Сначала удалите/);
  assert.throws(() => apply(state, operation('update', 'group', 'new_tools', { name: 'Tools', category: 'hardpoint' })), /Категорию/);
  state = apply(state, operation('delete', 'module', 'new_tools:tool'), operation('delete', 'group', 'new_tools'));
  assert.ok(!lib.mergeCatalog(base, state).groups.new_tools);
  assert.throws(() => apply(state, operation('restore', 'module', 'new_tools:tool')), /Группа не найдена/);
  state = apply(state, operation('restore', 'group', 'new_tools'), operation('restore', 'module', 'new_tools:tool'));
  assert.ok(lib.mergeCatalog(base, state).modules.new_tools.some((entry) => entry.id === 'tool'));
});

test('armour edits and deletions retain source and custom build indices', () => {
  const ship = base.ships.sidewinder;
  const second = ship.bulkheads[1];
  let state = apply(initial(), operation('update', 'bulkhead', `${ship.id}:${second.id}`, { ...second, mass: 10, name: 'Новая броня' }), operation('delete', 'bulkhead', `${ship.id}:${second.id}`));
  let data = lib.mergeCatalog(base, state);
  assert.equal(data.ships[ship.id].bulkheads.length, ship.bulkheads.length);
  assert.equal(data.ships[ship.id].bulkheads[1].id, second.id);
  assert.equal(data.ships[ship.id].bulkheads[1].mass, 10); assert.equal(data.ships[ship.id].bulkheads[1].archived, true);
  const custom = { ...second, id: 'test_armour', name: 'Custom' };
  state = apply(state, operation('create', 'bulkhead', `${ship.id}:${custom.id}`, custom));
  const index = lib.mergeCatalog(base, state).ships[ship.id].bulkheads.length - 1;
  state = apply(state, operation('delete', 'bulkhead', `${ship.id}:${custom.id}`), operation('create', 'bulkhead', `${ship.id}:another_armour`, { ...custom, id: 'another_armour' }));
  data = lib.mergeCatalog(base, state);
  assert.equal(data.ships[ship.id].bulkheads[index].id, custom.id); assert.equal(data.ships[ship.id].bulkheads[index].archived, true);
  state = apply(state, operation('restore', 'bulkhead', `${ship.id}:${custom.id}`));
  assert.equal(lib.mergeCatalog(base, state).ships[ship.id].bulkheads[index].archived, false);
  assert.throws(() => apply(state, operation('delete', 'bulkhead', `${ship.id}:${ship.bulkheads[0].id}`)), /Базовую броню/);
});

test('invalid batches roll back every operation, including history and revision', () => {
  const state = initial();
  assert.throws(() => apply(state, operation('create', 'module', 'pp:test_module', moduleValue()), operation('delete', 'group', 'fsd')), /обязательными слотами/);
  assert.deepEqual(state, initial());
  assert.throws(() => lib.parseCatalogCommands({ revision: 0, commands: Array.from({ length: 101 }, () => operation('delete', 'group', 'pp')) }), /100 операций/);
});

test('every existing module validates without loss, including factory modules', () => {
  for (const module of Object.values(base.modules).flat()) {
    const validated = lib.validateCatalogValue('module', `${module.grp}:${module.id}`, module, base);
    assert.deepEqual(validated, module, `${module.grp}:${module.id}`);
  }
});

test('validation rejects invalid types, renamed technical IDs, unknown groups/ships and invalid factory settings', () => {
  const value = moduleValue();
  for (const updates of [{ class: 9 }, { class: 1.5 }, { rating: 'AA' }, { mass: -1 }, { cost: '120' }, { power: NaN }, { mount: 'unknown' }, { id: 'different' }, { grp: 'ls' }, { merc: 1 }, { damagedist: { T: '1' } }, { fireint: 0 }, { preEngineered: { grade: 6 } }, { preEngineered: { blueprints: ['not_a_blueprint'] } }, { name: 'x'.repeat(161) }]) {
    assert.throws(() => lib.validateCatalogValue('module', 'pp:test_module', { ...value, ...updates }, base), lib.CatalogError);
  }
  assert.throws(() => lib.validateCatalogValue('module', 'unknown:test_module', { ...value, grp: 'unknown' }, base), /Группа не найдена/);
  assert.throws(() => lib.validateCatalogValue('bulkhead', 'unknown:test_module', { id: 'test_module', grp: 'bh' }, base), /Корабль не найден/);
});

test('prototype pollution, malicious keys, unbounded nesting and invalid commands are rejected', () => {
  const injected = JSON.parse('{"requirements":{"__proto__":{"polluted":true}}}');
  assert.throws(() => lib.validateCatalogValue('module', 'pp:test_module', { ...moduleValue(), ...injected }, base), /Недопустимое имя/);
  for (const key of ['constructor', '__proto__', 'prototype']) {
    assert.throws(() => lib.parseCatalogCommands({ revision: 0, commands: [operation('create', 'group', key, { name: 'Unsafe', category: 'internal' })] }));
    assert.throws(() => lib.parseCatalogCommands({ revision: 0, commands: [operation('create', 'module', `${key}:test_module`, moduleValue())] }));
  }
  let nested = 0; for (let i = 0; i < 10; i++) nested = { child: nested };
  assert.throws(() => lib.validateCatalogValue('module', 'pp:test_module', { ...moduleValue(), nested }, base), /вложенность/);
  for (const body of [null, {}, { revision: -1, commands: [] }, { revision: 0, commands: [operation('hack', 'module', 'pp:test_module')] }]) assert.throws(() => lib.parseCatalogCommands(body));
  assert.equal({}.polluted, undefined);
});

test('API CRUD persists locally, public API immediately sees edits and never discloses audit data', async () => {
  const read = await response(await lib.admin.GET(new Request('https://site.example/api/admin/outfitting')));
  assert.equal(read.status, 200); assert.equal(read.body.storage, 'local'); assert.equal(read.cache, 'no-store');
  const write = await response(await lib.admin.POST(request({ revision: 0, commands: [operation('create', 'module', 'pp:test_module', moduleValue())] })));
  assert.equal(write.status, 200); assert.equal(write.body.revision, 1);
  assert.equal(write.body.history[0].actor, 'CMDR Tester');
  assert.deepEqual(lib.auth.calls.at(-1).filter, ['id', 'admin-user']);
  const file = JSON.parse(readFileSync(process.env.OUTFITTING_DATA_FILE, 'utf8'));
  assert.equal(file.changes['module/pp:test_module'].value.name, 'Тестовый реактор');
  const publicResult = await response(await lib.publicCatalog.GET());
  assert.equal(publicResult.status, 200); assert.equal(publicResult.body.catalogRevision, 1);
  assert.ok(publicResult.body.modules.pp.some((entry) => entry.id === 'test_module'));
  assert.equal(publicResult.body.history, undefined); assert.equal(publicResult.body.changes, undefined);
  const stale = await response(await lib.admin.POST(request({ revision: 0, commands: [operation('delete', 'module', 'pp:test_module')] })));
  assert.equal(stale.status, 409); assert.equal((await lib.readCatalogState()).revision, 1);
});

test('anonymous production and staff roles cannot read/write, even with preview host or billing preview flag', async () => {
  process.env.NODE_ENV = 'production'; process.env.BILLING_PREVIEW_ADMIN = '1';
  lib.auth.user = null;
  const read = await lib.admin.GET(new Request('https://3000-test.e2b.app/api/admin/outfitting'));
  assert.equal(read.status, 401);
  const write = await lib.admin.POST(request({ revision: 0, commands: [operation('create', 'module', 'pp:test_module', moduleValue())] }));
  assert.equal(write.status, 401);
  lib.auth.user = { id: 'staff-user' };
  for (const role of ['user', 'moderator', 'support_manager']) {
    lib.auth.profile = { role, cmdr_name: 'Staff' };
    assert.equal((await lib.admin.GET(new Request('https://site.example/api/admin/outfitting'))).status, 403);
    assert.equal((await lib.admin.POST(request({ revision: 0, commands: [] }))).status, 403);
  }
  lib.auth.error = { message: 'offline' };
  assert.equal((await lib.admin.GET(new Request('https://site.example/api/admin/outfitting'))).status, 503);
  assert.equal(lib.db.calls.length, 0);
});

test('development preview is allowed only without a service key or supplied bearer', async () => {
  process.env.NODE_ENV = 'development'; lib.auth.user = null;
  assert.equal((await lib.requireCatalogAdmin(new Request('https://site.example/api/admin/outfitting'))).actor, 'CMDR Preview (local)');
  assert.equal((await lib.requireCatalogAdmin(new Request('https://site.example/api/admin/outfitting', { headers: { authorization: 'Bearer invalid' } }))).response.status, 401);
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'configured-key';
  assert.equal((await lib.requireCatalogAdmin(new Request('https://site.example/api/admin/outfitting'))).response.status, 401);
});

test('API handles malformed JSON and body/operation limits without saving', async () => {
  for (const [body, status] of [['{broken', 400], [{}, 400], [{ revision: 0, commands: [operation('create', 'module', 'pp:test_module', { ...moduleValue(), cost: -1 })] }, 400]]) {
    assert.equal((await lib.admin.POST(request(body))).status, status);
  }
  assert.equal((await lib.admin.POST(request('{}', { headers: { 'content-length': '1000001' } }))).status, 413);
  assert.equal((await lib.admin.POST(request('{}', { headers: { 'content-type': 'text/plain' } }))).status, 415);
  assert.equal((await lib.readCatalogState()).revision, 0);
});

test('Supabase writes are CAS updates; races and unavailable DB never fall back to disk', async () => {
  process.env.NODE_ENV = 'production'; process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://database.example'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
  const state = apply(initial(), operation('create', 'module', 'pp:test_module', moduleValue()));
  await lib.saveCatalogState(0, state);
  assert.ok(lib.db.calls.at(-1).filters.some(([key, value]) => key === 'revision' && value === 0));
  assert.equal((await lib.readCatalogState()).revision, 1);
  lib.db.race = true;
  await assert.rejects(lib.saveCatalogState(1, { ...state, revision: 2 }), (error) => error.status === 409);
  lib.db.error = { code: 'PGRST205', message: 'table missing' };
  assert.equal((await lib.admin.GET(new Request('https://site.example/api/admin/outfitting'))).status, 503);
  assert.equal((await lib.publicCatalog.GET()).status, 503);
  await assert.rejects(lib.saveCatalogState(2, state), /Примените миграцию/);
});

test('production without a service key can read source but cannot save local data', async () => {
  process.env.NODE_ENV = 'production';
  assert.equal(lib.catalogStorage(), 'source');
  const publicResult = await response(await lib.publicCatalog.GET()); assert.equal(publicResult.status, 200);
  const write = await lib.admin.POST(request({ revision: 0, commands: [operation('create', 'module', 'pp:test_module', moduleValue())] }));
  assert.equal(write.status, 503); assert.equal((await lib.readCatalogState()).revision, 0);
});

test('local persistence is atomic and conflicts never overwrite the current file', async () => {
  const state = apply(initial(), operation('create', 'module', 'pp:test_module', moduleValue()));
  await lib.saveCatalogState(0, state);
  await assert.rejects(lib.saveCatalogState(0, { ...state, revision: 2 }), (error) => error.status === 409);
  assert.equal((await lib.readCatalogState()).revision, 1);
  writeFileSync(process.env.OUTFITTING_DATA_FILE, '{broken');
  await assert.rejects(lib.readCatalogState());
});

test('history is bounded and catalogue migration gives no browser database privileges', () => {
  let state = initial();
  for (let i = 0; i < 110; i++) state = apply(state, operation('update', 'module', `pp:${base.modules.pp[1].id}`, { ...base.modules.pp[1], cost: i }));
  assert.equal(state.history.length, 100); assert.equal(state.revision, 110);
  const sql = readFileSync(join(ROOT, 'supabase/migrations/20261010010000_outfitting_catalog.sql'), 'utf8');
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/); assert.match(sql, /REVOKE ALL .* FROM anon, authenticated/);
  assert.match(sql, /GRANT SELECT, UPDATE .* TO service_role/);
  assert.ok(!/CREATE POLICY/i.test(sql));
});
