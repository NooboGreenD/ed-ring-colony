/**
 * Сохранение найденного кольца в проект эскадрильи
 * (`POST /api/atlas/ring-route/save`).
 *
 * Проверяется настоящий маршрут: права (лидер/офицер), чтение маршрута из
 * сессии, отсев расчётных точек, пропуск уже сохранённых систем, продолжение
 * порядка облёта и вставка пачками — кольцо это тысячи строк, и один запрос
 * к PostgREST их не переварит.
 *
 * Supabase и Next подменяются заглушками через общий кэш сборок, поэтому тест
 * не ходит ни в базу, ни в сеть.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { bundleFile } from './helpers/bundle.mjs';

const NEXT_SERVER_STUB = `
export class NextResponse extends Response {
  static json(body, init) {
    return new Response(JSON.stringify(body), {
      status: (init && init.status) || 200,
      headers: { 'content-type': 'application/json' },
    });
  }
}
`;

/**
 * Заглушка Supabase: хранит «базу» в globalThis, чтобы тест задавал состав
 * проекта и читал то, что маршрут вставил.
 */
const SUPABASE_STUB = `
function state() {
  globalThis.__ringSave ||= { user: 'pilot-1', membership: 'leader', projectSystems: [], maxOrder: 0, inserts: [] };
  return globalThis.__ringSave;
}

function query(table) {
  const rows = () => (table === 'project_systems' ? state().projectSystems : []);
  const api = {
    select: () => api,
    eq: () => api,
    order: () => api,
    limit: () => api,
    single: async () => {
      if (table === 'project_members') {
        return state().membership ? { data: { role: state().membership } } : { data: null };
      }
      return { data: { sort_order: state().maxOrder } };
    },
    maybeSingle: async () => ({ data: null }),
    insert: async (payload) => {
      const list = Array.isArray(payload) ? payload : [payload];
      state().inserts.push(list);
      state().projectSystems.push(...list);
      return { error: null };
    },
    then: (resolve, reject) => Promise.resolve({ data: rows(), error: null }).then(resolve, reject),
  };
  return api;
}

export const supabaseAdmin = { from: (table) => query(table) };
export function createAdminClient() { return supabaseAdmin; }
`;

const SUPABASE_SERVER_STUB = `
export async function createClient() {
  return {
    auth: {
      getUser: async () => ({
        data: { user: globalThis.__ringSave?.user ? { id: globalThis.__ringSave.user } : null },
      }),
    },
  };
}
`;

/** Маршрут кольца: три реальные системы, одна расчётная и один дубль проекта. */
const RING_SEARCH_STUB = `
export async function loadRingRoute(sessionId) {
  if (sessionId !== 'session-1') return null;
  return {
    sessionId,
    start: 'Sol',
    center: { x: 25.21875, y: -20.90625, z: 25899.96875 },
    ringRadius: 23000,
    searchRadius: 500,
    status: 'completed',
    anchors: [],
    route: [
      { name: 'Sol', x: 0, y: 0, z: 0, source: 'start' },
      { name: 'Alpha Centauri', x: 3.03, y: -0.09, z: 3.16, source: 'catalog' },
      { name: 'RING TRIANGULATED 12', x: 100, y: 0, z: 100, source: 'triangulated' },
      { name: 'Barnard Star', x: -0.17, y: 9.47, z: -4.9, source: 'cache' },
      { name: 'Existing In Project', x: 5, y: 5, z: 5, source: 'catalog' },
    ],
  };
}
`;

const mod = await import(await bundleFile({
  entry: 'src/app/api/atlas/ring-route/save/route.ts',
  stubs: {
    'next/server': NEXT_SERVER_STUB,
    '@/lib/supabaseServer': SUPABASE_SERVER_STUB,
    '@/lib/supabaseAdmin': SUPABASE_STUB,
    '@/lib/atlasRingSearch': RING_SEARCH_STUB,
  },
}));

function resetState(overrides = {}) {
  globalThis.__ringSave = {
    user: 'pilot-1',
    membership: 'leader',
    projectSystems: [],
    maxOrder: 0,
    inserts: [],
    ...overrides,
  };
  return globalThis.__ringSave;
}

function post(body) {
  return mod.POST(new Request('http://web:3000/api/atlas/ring-route/save', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

test('сохранение кольца: без входа и без прав в проект писать нельзя', async () => {
  resetState({ user: null });
  const anonymous = await post({ project_id: 7, session_id: 'session-1' });
  assert.equal(anonymous.status, 401);

  resetState({ membership: 'member' });
  const member = await post({ project_id: 7, session_id: 'session-1' });
  assert.equal(member.status, 403, 'рядовой участник проекта кольцо не сохраняет');
  assert.match((await member.json()).error, /лидер и офицеры/);
});

test('сохранение кольца: маршрут берётся из сессии, расчётные точки отсеиваются', async () => {
  const state = resetState({ maxOrder: 12 });

  const response = await post({ project_id: 7, session_id: 'session-1' });
  assert.equal(response.status, 200);
  const data = await response.json();

  assert.equal(data.ok, true);
  assert.equal(data.added, 4, 'все четыре реальные системы кольца');
  assert.equal(data.skipped_synthetic, 1, 'расчётная точка в проект не попала');
  assert.equal(data.ring_radius, 23000);

  const names = state.projectSystems.map((row) => row.system_name);
  assert.deepEqual(names, ['Sol', 'Alpha Centauri', 'Barnard Star', 'Existing In Project']);
  assert.deepEqual(
    state.projectSystems.map((row) => row.sort_order),
    [13, 14, 15, 16],
    'порядок облёта продолжается от уже сохранённых систем проекта',
  );
  const alpha = state.projectSystems.find((row) => row.system_name === 'Alpha Centauri');
  assert.equal(alpha.x, 3.03, 'координаты сохраняются вместе с системой');
  assert.equal(alpha.planned_status, 'planned');
  assert.match(alpha.notes, /радиус 23000/);
});

test('сохранение кольца: дубликаты проекта пропускаются, а флаг возвращает расчётные точки', async () => {
  const state = resetState({
    projectSystems: [{ system_name: 'alpha centauri', sort_order: 1 }],
    maxOrder: 1,
  });

  const withoutSynthetic = await post({ project_id: 7, session_id: 'session-1' });
  const first = await withoutSynthetic.json();
  assert.equal(first.skipped_duplicate, 1, 'система уже в проекте — второй раз не пишем');
  assert.equal(first.added, 3, 'Sol, Barnard Star и Existing In Project');

  const withSynthetic = await post({ project_id: 7, session_id: 'session-1', include_synthetic: true });
  const second = await withSynthetic.json();
  assert.equal(second.added, 1, 'осталась только расчётная точка');
  assert.ok(
    state.projectSystems.some((row) => row.system_name === 'RING TRIANGULATED 12'),
    'по явному флагу расчётные точки тоже сохраняются',
  );
});

test('сохранение кольца: пустой маршрут и неизвестная сессия — понятная ошибка, а не 500', async () => {
  resetState();
  const unknown = await post({ project_id: 7, session_id: 'nope' });
  assert.equal(unknown.status, 404);

  const empty = await post({ project_id: 7, route: [] });
  assert.equal(empty.status, 400);

  const broken = await post({ project_id: 'семь' });
  assert.equal(broken.status, 400, 'проект без числового идентификатора отклоняется');
});

test('сохранение кольца: длинный маршрут вставляется пачками', async () => {
  const state = resetState();
  const route = Array.from({ length: 1200 }, (_, index) => ({
    name: `System ${index}`,
    x: index,
    y: 0,
    z: -index,
    source: 'catalog',
  }));

  const response = await post({ project_id: 7, route, ring_radius: 12000 });
  const data = await response.json();
  assert.equal(data.added, 1200);
  assert.equal(state.inserts.length, 3, '1200 строк уходят тремя пачками по 500');
  assert.equal(state.inserts[0].length, 500);
  assert.equal(state.inserts[2].length, 200);
  assert.equal(state.projectSystems.length, 1200);
});
