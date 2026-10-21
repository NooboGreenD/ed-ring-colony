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
export {catalogGroupName, MOUNT_NAMES} from '@/lib/outfitting/i18n';
export {moduleLabel, defaultBuild} from '@/lib/outfitting/build';
export {modulesForSlot, buildSlots, computeStats} from '@/lib/outfitting/calc';
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
  assert.equal(Object.values(data.modules).flat().length, 980);
  assert.equal(Object.keys(data.groups).length, 88);
  assert.equal(Object.values(data.ships).flatMap((ship) => ship.bulkheads).length, 242);
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

test('all source ships validate without loss, including short utility defaults and special hardpoints', () => {
  for (const ship of Object.values(base.ships)) {
    assert.deepEqual(lib.validateCatalogValue('ship', ship.id, ship, base), ship, ship.id);
  }
  const ship = base.ships.type_11_prospector;
  const slot = lib.buildSlots(base, lib.defaultBuild(base, ship.id)).find((entry) => entry.key === 'H0');
  assert.equal(slot.class, 3);
  assert.equal(slot.special, 'Mining');
  assert.ok(lib.modulesForSlot(base, ship, slot).some((module) => module.grp === 'abl'));
  assert.ok(lib.modulesForSlot(base, ship, slot).some((module) => module.grp === 'pwa'), 'mining hardpoints may explicitly permit utility scanners');
  assert.ok(!lib.modulesForSlot(base, ship, slot).some((module) => module.grp === 'pl'));
  const modified = structuredClone(base);
  modified.ships.type_11_prospector.defaults.hardpoints[0] = base.modules.pl[0].id;
  assert.equal(lib.defaultBuild(modified, ship.id).hardpoints[0], null, 'stock module must respect special slot restrictions');
});

test('custom ships work in the stock builder and retain their armour when edited, archived and restored', () => {
  const source = base.ships.sidewinder;
  const ship = structuredClone(source);
  ship.id = 'test_ship'; ship.properties.name = 'Испытатель';
  ship.slots.internal.push({ class: 3, name: 'Cargo', eligible: { cr: 1 } });
  ship.defaults.internal.push(0);
  const state0 = initial();
  let state = apply(state0, operation('create', 'ship', ship.id, { ...ship, archived: true }));
  assert.deepEqual(state0, initial());
  let data = lib.mergeCatalog(base, state);
  assert.equal(data.ships.test_ship.archived, undefined, 'availability is server-owned');
  assert.equal(data.ships.test_ship.properties.name, 'Испытатель');
  assert.equal(data.ships.test_ship.slots.internal.length, source.slots.internal.length + 1);
  assert.equal(lib.defaultBuild(data, ship.id).internal.length, ship.slots.internal.length);
  assert.equal(lib.buildSlots(data, lib.defaultBuild(data, ship.id)).at(-1).special, 'Cargo');
  assert.ok(Number.isFinite(lib.computeStats(data, lib.defaultBuild(data, ship.id)).armour));
  const armour = { ...source.bulkheads[1], id: 'extra_armour', name: 'Пробная броня' };
  state = apply(state, operation('create', 'bulkhead', 'test_ship:extra_armour', armour));
  data = lib.mergeCatalog(base, state);
  state = apply(state, operation('update', 'ship', ship.id, { ...data.ships.test_ship, properties: { ...data.ships.test_ship.properties, speed: 310 } }));
  assert.equal(state.changes['ship/test_ship'].value.bulkheads.length, source.bulkheads.length, 'armour overlays must not be absorbed by hull edits');
  state = apply(state, operation('delete', 'ship', ship.id));
  data = lib.mergeCatalog(base, state);
  assert.equal(data.ships.test_ship.archived, true);
  assert.equal(data.ships.test_ship.bulkheads.at(-1).id, 'extra_armour');
  assert.equal(lib.defaultBuild(data, 'test_ship').ship, 'test_ship', 'old build links still resolve');
  assert.throws(() => apply(state, operation('create', 'ship', ship.id, ship)), /ID уже существует/);
  state = apply(state, operation('restore', 'ship', ship.id));
  data = lib.mergeCatalog(base, state);
  assert.equal(data.ships.test_ship.archived, undefined);
  assert.equal(data.ships.test_ship.properties.speed, 310);
  assert.equal(state.history[0].label, 'Испытатель');
  assert.throws(() => apply(state, operation('reset', 'ship', ship.id)), /Исходная запись/);
});

test('source ship edits and armour changes remain independent across reset and upstream rebuild', () => {
  const original = base.ships.sidewinder;
  const armourKey = `${original.id}:${original.bulkheads[1].id}`;
  let state = apply(initial(), operation('update', 'bulkhead', armourKey, { ...original.bulkheads[1], name: 'Новый сплав' }));
  let data = lib.mergeCatalog(base, state);
  state = apply(state, operation('update', 'ship', original.id, { ...data.ships.sidewinder,
    properties: { ...data.ships.sidewinder.properties, name: 'Новое имя' } }));
  assert.equal(lib.mergeCatalog(base, state).ships.sidewinder.bulkheads[1].name, 'Новый сплав');
  state = apply(state, operation('reset', 'bulkhead', armourKey));
  assert.deepEqual(lib.mergeCatalog(base, state).ships.sidewinder.bulkheads[1], original.bulkheads[1]);
  state = apply(state, operation('delete', 'ship', original.id));
  const upstream = structuredClone(base);
  upstream.ships.sidewinder.bulkheads[1].cost = 12345;
  assert.equal(lib.mergeCatalog(upstream, state).ships.sidewinder.archived, true);
  assert.equal(lib.mergeCatalog(upstream, state).ships.sidewinder.bulkheads[1].cost, 12345);
  state = lib.applyCatalogCommands(upstream, state, [operation('restore', 'ship', original.id)], 'CMDR Test');
  assert.equal(lib.mergeCatalog(upstream, state).ships.sidewinder.properties.name, 'Новое имя');
  state = lib.applyCatalogCommands(upstream, state, [operation('reset', 'ship', original.id)], 'CMDR Test');
  assert.deepEqual(lib.mergeCatalog(upstream, state).ships.sidewinder, upstream.ships.sidewinder);
});

test('unsaved slots can be physically removed from the middle of a new ship', () => {
  const ship = structuredClone(base.ships.sidewinder);
  ship.id = 'light_ship'; ship.properties.name = 'Без лишних слотов';
  ship.slots.hardpoints.splice(1, 1); ship.defaults.hardpoints.splice(1, 1);
  ship.slots.internal.splice(2, 1); ship.defaults.internal.splice(2, 1);
  const state = apply(initial(), operation('create', 'ship', ship.id, ship));
  const saved = lib.mergeCatalog(base, state).ships.light_ship;
  assert.deepEqual(saved.slots.hardpoints, ship.slots.hardpoints);
  assert.deepEqual(saved.slots.internal, ship.slots.internal);
  assert.deepEqual(saved.defaults, ship.defaults);
  assert.equal(lib.defaultBuild(lib.mergeCatalog(base, state), ship.id).internal.length, ship.slots.internal.length);
  assert.equal(base.ships.sidewinder.slots.internal.length, 7);
});

test('archiving individual existing slots preserves old builds, factory defaults and their indices', () => {
  const source = base.ships.sidewinder;
  const oldBuild = lib.defaultBuild(base, source.id);
  assert.ok(oldBuild.internal[0] && oldBuild.hardpoints[1], 'use stock slots containing modules');
  const oldStats = lib.computeStats(base, oldBuild);
  const hull = structuredClone(source);
  hull.slots.internal[0] = { class: source.slots.internal[0], archived: true };
  hull.slots.internal[6] = { ...source.slots.internal[6], archived: true };
  hull.slots.hardpoints[1] = { class: source.slots.hardpoints[1], archived: true };
  let state = apply(initial(), operation('update', 'ship', source.id, hull));
  let data = lib.mergeCatalog(base, state);
  assert.equal(data.ships.sidewinder.slots.internal.length, source.slots.internal.length);
  assert.equal(data.ships.sidewinder.slots.hardpoints.length, source.slots.hardpoints.length);
  assert.deepEqual(data.ships.sidewinder.defaults, source.defaults, 'restoring a slot retains its stock module');
  assert.equal(lib.defaultBuild(data, source.id).internal[0], null, 'no stock module for new builds');
  assert.equal(lib.defaultBuild(data, source.id).internal[6], null);
  assert.equal(lib.defaultBuild(data, source.id).hardpoints[1], null);
  assert.deepEqual(data.ships.sidewinder.slots.internal[6], { ...source.slots.internal[6], archived: true }, 'special slot restrictions survive archival');
  const slots = lib.buildSlots(data, oldBuild);
  for (const key of ['I0', 'I6', 'H1']) {
    const slot = slots.find((entry) => entry.key === key);
    assert.equal(slot.archived, true);
    assert.ok(slot.module, `old build module in ${key} is retained`);
    assert.deepEqual(lib.modulesForSlot(data, data.ships.sidewinder, slot), [], 'cannot install modules into an archived slot');
  }
  assert.deepEqual(lib.computeStats(data, oldBuild), oldStats, 'old modules still contribute to stats');
  assert.throws(() => apply(state, operation('update', 'ship', source.id, { ...data.ships.sidewinder,
    slots: { ...data.ships.sidewinder.slots, internal: data.ships.sidewinder.slots.internal.slice(1) },
  })), /архивирование/);
  const tampered = structuredClone(data.ships.sidewinder);
  tampered.slots.internal[0].class = 1;
  assert.throws(() => apply(state, operation('update', 'ship', source.id, tampered)), /удалённый слот нельзя менять/);
  tampered.slots.internal[0].class = source.slots.internal[0];
  tampered.slots.internal[6].eligible = { hr: 1 };
  assert.throws(() => apply(state, operation('update', 'ship', source.id, tampered)), /удалённый слот нельзя менять/);
  const restored = structuredClone(data.ships.sidewinder);
  restored.slots.internal[0] = source.slots.internal[0];
  restored.slots.internal[6] = source.slots.internal[6];
  restored.slots.hardpoints[1] = source.slots.hardpoints[1];
  state = apply(state, operation('update', 'ship', source.id, restored));
  data = lib.mergeCatalog(base, state);
  assert.deepEqual(lib.defaultBuild(data, source.id), oldBuild);
});

test('invalid ships, armour tampering, removed slot indices and last-ship deletion are rejected atomically', () => {
  const source = structuredClone(base.ships.sidewinder);
  const withChange = (change) => { const next = structuredClone(source); next.id = 'sidewinder_copy'; change(next); return next; };
  for (const change of [
    (s) => { s.id = 'not_the_key'; }, (s) => { s.properties.name = ''; },
    (s) => { s.properties.class = 4; }, (s) => { s.properties.crew = 0; },
    (s) => { s.properties.hullMass = -1; }, (s) => { s.properties.hullCost = 'infinite'; },
    (s) => { s.properties.fighterHangars = 'yes'; }, (s) => { s.retailCost = -1; },
    (s) => { s.slots.standard.pop(); s.defaults.standard.pop(); },
    (s) => { s.slots.standard[0] = { class: 2, archived: true }; },
    (s) => { s.slots.internal[0] = { class: 2, archived: 'yes' }; },
    (s) => { s.slots.hardpoints[0] = 8; }, (s) => { s.defaults.internal.push(0); },
    (s) => { s.slots.internal[0] = { class: 3, eligible: { missing_group: 1 } }; },
    (s) => { s.slots.internal[0] = { class: 3, eligible: { pl: 1 } }; },
    (s) => { s.bulkheads.push({ ...s.bulkheads[0] }); },
    (s) => { s.bulkheads[0].archived = true; },
  ]) assert.throws(() => apply(initial(), operation('create', 'ship', 'sidewinder_copy', withChange(change))), lib.CatalogError);
  const malicious = JSON.parse('{"properties":{"__proto__":{"polluted":true}}}');
  assert.throws(() => lib.validateCatalogValue('ship', 'sidewinder', { ...source, ...malicious }, base), /Недопустимое имя/);
  for (const key of ['constructor', '__proto__', 'ABC', 'foo:bar']) {
    assert.throws(() => lib.parseCatalogCommands({ revision: 0, commands: [operation('create', 'ship', key, source)] }));
  }
  assert.throws(() => apply(initial(), operation('update', 'ship', 'sidewinder', { ...source, bulkheads: source.bulkheads.slice(1) })), /Броню|базовая броня/i);
  assert.throws(() => apply(initial(), operation('update', 'ship', 'sidewinder', { ...source,
    slots: { ...source.slots, internal: source.slots.internal.slice(0, -1) },
    defaults: { ...source.defaults, internal: source.defaults.internal.slice(0, -1) },
  })), /Для удаления сохранённого слота используйте архивирование/);
  const tiny = { ...base, ships: { sidewinder: source } };
  assert.throws(() => lib.applyCatalogCommands(tiny, initial(), [operation('delete', 'ship', 'sidewinder')], 'CMDR Test'), /последний доступный корабль/);
  assert.deepEqual(base.ships.sidewinder, source);
});

test('batching ship creation with armour and special group obeys dependencies and is atomic', () => {
  const ship = structuredClone(base.ships.sidewinder);
  ship.id = 'new_hull'; ship.properties.name = 'Новый корпус';
  ship.slots.internal.push({ class: 1, name: 'Custom', eligible: { custom_fit: 1 } });
  ship.defaults.internal.push(0);
  const group = operation('create', 'group', 'custom_fit', { name: 'Тест', category: 'internal' });
  const create = operation('create', 'ship', ship.id, ship);
  const state = apply(initial(), group, create);
  assert.match(lib.groupDeletionReason(lib.mergeCatalog(base, state), 'custom_fit'), /особыми слотами/);
  assert.throws(() => apply(state, operation('delete', 'group', 'custom_fit')), /особыми слотами/);
  assert.throws(() => apply(initial(), create, group), /группа custom_fit не найдена/);
  assert.throws(() => apply(initial(), group, create, operation('delete', 'group', 'pp')), /обязательными слотами/);
  const armour = { ...ship.bulkheads[1], id: 'custom_armour' };
  const done = apply(state, operation('create', 'bulkhead', 'new_hull:custom_armour', armour));
  assert.equal(lib.mergeCatalog(base, done).ships.new_hull.bulkheads.at(-1).id, 'custom_armour');
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
  for (const updates of [{ class: 9 }, { class: 1.5 }, { rating: 'AA' }, { mass: -1 }, { cost: '120' }, { power: NaN }, { mount: 'unknown' }, { id: 'different' }, { grp: 'ls' }, { merc: 1 }, { damagedist: { T: '1' } }, { fireint: 0 }, { preEngineered: { grade: 6 } }, { preEngineered: { blueprints: ['not_a_blueprint'] } }, { ships: ['not_a_ship'] }, { ships: ['anaconda', 'anaconda'] }, { name: 'x'.repeat(161) }]) {
    assert.throws(() => lib.validateCatalogValue('module', 'pp:test_module', { ...value, ...updates }, base), lib.CatalogError);
  }
  assert.throws(() => lib.validateCatalogValue('module', 'unknown:test_module', { ...value, grp: 'unknown' }, base), /Группа не найдена/);
  assert.throws(() => lib.validateCatalogValue('bulkhead', 'unknown:test_module', { id: 'test_module', grp: 'bh' }, base), /Корабль не найден/);
});

test('admin mount labels follow game symbols and the public shipyard: G is gimballed, T is turret', () => {
  // Буквы — из игровых символов (Hpt_…_Gimbal_… → G, Hpt_…_Turret_… → T);
  // до web 2.25.1 таблица и редактор админки подписывали G и T наоборот.
  assert.deepEqual(Object.keys(lib.CATALOG_MOUNTS), ['F', 'G', 'T']);
  assert.match(lib.CATALOG_MOUNTS.G.title, /наводящ/);
  assert.match(lib.CATALOG_MOUNTS.T.title, /турел/);
  for (const [mount, label] of Object.entries(lib.CATALOG_MOUNTS)) {
    // «(фикс.)» → «фикс», «(наводящееся)» → «наво»: у админки и публичной верфи одна основа слова.
    const stem = lib.MOUNT_NAMES.ru[mount].replace(/[().]/g, '').slice(0, 4);
    assert.ok(label.title.startsWith(stem), `${mount}: «${label.title}» расходится с верфью «${lib.MOUNT_NAMES.ru[mount]}»`);
    assert.ok(label.short.toLowerCase().startsWith(stem), `${mount}: «${label.short}» расходится с верфью «${lib.MOUNT_NAMES.ru[mount]}»`);
  }
  // Запись принимает ровно эти буквы.
  for (const mount of Object.keys(lib.CATALOG_MOUNTS)) {
    assert.equal(lib.validateCatalogValue('module', 'pp:test_module', { ...moduleValue(), mount }, base).mount, mount);
  }
  for (const mount of ['', 'X', 'g', 'toString', 'constructor']) {
    assert.throws(() => lib.validateCatalogValue('module', 'pp:test_module', { ...moduleValue(), mount }, base), /Крепление: F, G или T/, JSON.stringify(mount));
  }
  // Таблица и редактор не держат своих слов для букв — только CATALOG_MOUNTS.
  for (const file of ['src/components/Admin/OutfittingAdmin.tsx', 'src/components/Admin/OutfittingEditor.tsx']) {
    const source = readFileSync(join(ROOT, file), 'utf8');
    assert.match(source, /CATALOG_MOUNTS/, file);
    assert.doesNotMatch(source, /'Турель'|'Навод\.'|'Фикс\.'|— наводящееся|— турель|— фиксированное/, file);
  }
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

test('admin ship writes persist in the existing store and public catalogue has no audit metadata', async () => {
  const hull = structuredClone(base.ships.sidewinder);
  hull.id = 'api_ship'; hull.properties.name = 'Корабль API';
  const write = await response(await lib.admin.POST(request({ revision: 0, commands: [operation('create', 'ship', hull.id, hull)] })));
  assert.equal(write.status, 200);
  assert.equal(write.body.changes[0].kind, 'ship');
  assert.equal(write.body.history[0].label, 'Корабль API');
  assert.equal(JSON.parse(readFileSync(process.env.OUTFITTING_DATA_FILE, 'utf8')).changes['ship/api_ship'].value.id, hull.id);
  const publicData = await response(await lib.publicCatalog.GET());
  assert.equal(publicData.status, 200);
  assert.equal(publicData.body.ships.api_ship.properties.name, 'Корабль API');
  assert.equal(publicData.body.history, undefined);
  const archive = await response(await lib.admin.POST(request({ revision: 1, commands: [operation('delete', 'ship', hull.id)] })));
  assert.equal(archive.status, 200);
  assert.equal(archive.body.data.ships.api_ship.archived, true);
  assert.equal((await response(await lib.publicCatalog.GET())).body.ships.api_ship.archived, true);
  assert.equal((await lib.admin.POST(request({ revision: 1, commands: [operation('update', 'ship', hull.id, hull)] }))).status, 409);
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

test('development preview is allowed only when no database is configured and no bearer is supplied', async () => {
  process.env.NODE_ENV = 'development'; lib.auth.user = null;
  assert.equal((await lib.requireCatalogAdmin(new Request('https://site.example/api/admin/outfitting'))).actor, 'CMDR Preview (local)');
  assert.equal((await lib.requireCatalogAdmin(new Request('https://site.example/api/admin/outfitting', { headers: { authorization: 'Bearer invalid' } }))).response.status, 401);

  // A public URL/anon key is enough to reach the database API. Do not grant
  // local preview-admin rights just because the privileged key is absent.
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://db.example.test';
  assert.equal((await lib.requireCatalogAdmin(new Request('https://site.example/api/admin/outfitting'))).response.status, 401);
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'public-anon-key';
  assert.equal((await lib.requireCatalogAdmin(new Request('https://site.example/api/admin/outfitting'))).response.status, 401);
  delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

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
