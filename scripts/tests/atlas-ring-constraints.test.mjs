/**
 * Требования к Галактическому кольцу — проверяются на сквозной симуляции.
 *
 *   • прыжок между соседними системами маршрута — не больше 14,99 св.л.;
 *   • опорные точки через 480–490 св.л., жёсткий предел 500 св.л.;
 *   • отклонение опоры от окружности кольца — до 50 (допуск 100) св.л.;
 *   • поиск с радиусом 50 и 3000 св.л. проходит шагами в пределах времени шага.
 *
 * Модуль собирается esbuild-ом. Вместо Supabase и внешних API подставляется
 * синтетическая галактика (детерминированный генератор), а таблица сессий
 * эмулируется в памяти. Это проверяет геометрию и логику, а не сеть.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

const STUBS = {
  'supabaseAdmin.ts': `
    const rowsOf = (table) => {
      const tables = globalThis.__ringTestTables;
      if (!tables[table]) tables[table] = new Map();
      return tables[table];
    };
    function builder(table) {
      let filterId = null;
      let payload = null;
      let mode = 'select';
      const run = async (single) => {
        const store = rowsOf(table);
        if (mode === 'insert') {
          const id = 'session-' + (store.size + 1);
          store.set(id, { id, ...payload });
          return { data: { id }, error: null };
        }
        if (mode === 'update') {
          const row = store.get(filterId);
          if (!row) return { data: null, error: { message: 'not found' } };
          Object.assign(row, payload);
          return { data: null, error: null };
        }
        const row = filterId == null ? null : (store.get(filterId) || null);
        if (single && !row) return { data: null, error: { message: 'no rows' } };
        return { data: row, error: null };
      };
      const api = {
        select() { return api; },
        insert(row) { mode = 'insert'; payload = row; return api; },
        update(row) { mode = 'update'; payload = row; return api; },
        eq(column, value) { if (column === 'id') filterId = value; return api; },
        single() { return run(true); },
        maybeSingle() { return run(false); },
        then(resolve, reject) { return run(false).then(resolve, reject); },
      };
      return api;
    }
    export const supabaseAdmin = {
      from: (table) => builder(table),
      rpc: async () => ({ data: null, error: { message: 'no rpc in test' } }),
    };
  `,
  'galaxySystemsDb.ts': `
    const world = () => globalThis.__ringTestWorld;
    export const catalogIsComplete = (stats) => !!stats && stats.partial !== true && stats.systems_count >= 1000000;
    export const getGalaxyStats = async () => ({ systems_count: 2000000, partial: false });
    export const findSystemByName = async (name) => {
      const key = String(name).trim().toLowerCase();
      const hit = world().named.get(key);
      return hit ? { ...hit } : null;
    };
    export const findSystemsInCube = async ({ x, y, z, half, limit = 800 }) => {
      world().cubeCalls++;
      const rows = world().systems.filter((s) =>
        Math.abs(s.x - x) <= half && Math.abs(s.y - y) <= half && Math.abs(s.z - z) <= half);
      rows.sort((a, b) => ((a.x - x) ** 2 + (a.y - y) ** 2 + (a.z - z) ** 2) - ((b.x - x) ** 2 + (b.y - y) ** 2 + (b.z - z) ** 2));
      return rows.slice(0, Math.min(limit, 2000)).map((s) => ({ name: s.name, x: s.x, y: s.y, z: s.z }));
    };
    export const findSystemsByNames = async () => new Map();
    export const findStarCandidates = async () => [];
    export const systemById64 = async () => null;
    export const rowWorldType = () => null;
  `,
  'atlasSystemCache.ts': `
    export const boxAround = () => ({ minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 });
    export const listCachedSystemsNear = async () => { globalThis.__ringTestWorld.cacheCalls++; return []; };
    export const listCachedSystemsInBox = async () => [];
    export const saveCachedSystems = async (rows) => rows.length;
    export const listCachedBodiesInBox = async () => [];
    export const saveCachedBodies = async () => 0;
  `,
  'spanshClient.ts': `
    export const spanshSearch = async () => null;
    export const spanshNearest = async () => null;
    export const spanshSystemsNear = async () => [];
  `,
};

async function loadRingModule() {
  const esbuild = await import('esbuild');
  const dir = mkdtempSync(join(ROOT, '.tmp-atlas-ring-constraints-'));
  const outfile = join(dir, 'ring.mjs');

  const stubPlugin = {
    name: 'atlas-ring-constraints-stubs',
    setup(build) {
      const pattern = new RegExp(`\\./(${Object.keys(STUBS).map((name) => name.replace('.', '\\.')).join('|')})$`);
      build.onResolve({ filter: pattern }, (args) => ({ path: args.path, namespace: 'ring-stub' }));
      build.onLoad({ filter: /.*/, namespace: 'ring-stub' }, (args) => ({
        contents: STUBS[args.path.replace('./', '')],
        loader: 'ts',
      }));
    },
  };

  await esbuild.build({
    entryPoints: [join(ROOT, 'src/lib/atlasRingSearch.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile,
    plugins: [stubPlugin],
    alias: { '@': join(ROOT, 'src') },
    loader: { '.ts': 'ts' },
    logLevel: 'silent',
  });

  const mod = await import(`${outfile}?t=${Date.now()}`);
  return { mod, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Детерминированный генератор (mulberry32): тесты воспроизводимы. */
function prng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Галактика вокруг центра (0,0,0): плотная полоса на кольце радиуса R и
 * участок-пустота, чтобы часть опор и сегментов пришлось закрывать расчётом.
 */
function buildWorld({ ringRadius, count, seed, voidFrom, voidTo }) {
  const random = prng(seed);
  const systems = [];
  for (let index = 0; index < count; index++) {
    const angle = random() * Math.PI * 2;
    if (angle > voidFrom && angle < voidTo) continue;
    const radial = ringRadius + (random() - 0.5) * 600;
    systems.push({
      name: `Sys ${index}`,
      x: Math.cos(angle) * radial,
      y: (random() - 0.5) * 400,
      z: Math.sin(angle) * radial,
    });
  }
  const start = { name: 'Sol', x: ringRadius, y: 0, z: 0 };
  const center = { name: 'Sagittarius A*', x: 0, y: 0, z: 0 };
  systems.push({ ...start, name: 'Sol' });
  const named = new Map([
    ['sol', start],
    ['sagittarius a*', center],
  ]);
  return { systems, named, cubeCalls: 0, cacheCalls: 0 };
}

async function runRing(mod, { ringRadius, searchRadius, world }) {
  globalThis.__ringTestWorld = world;
  globalThis.__ringTestTables = {};
  const plan = await mod.planRingSession({ startSystem: 'Sol', ringRadius, searchRadius }, null);
  let steps = 0;
  let maxStepMs = 0;
  let done = false;
  while (!done) {
    const began = Date.now();
    const step = await mod.stepRingSession(plan.sessionId, mod.DEFAULT_STEP_SECTORS);
    maxStepMs = Math.max(maxStepMs, Date.now() - began);
    steps++;
    done = step.done;
    assert.ok(steps < 500, 'шаги не сходятся к концу кольца');
  }
  const result = await mod.finalizeRingSession(plan.sessionId);
  return { plan, result, steps, maxStepMs };
}

function assertRingRequirements(mod, result, ringRadius) {
  const center = { x: 0, y: 0, z: 0 };
  const route = result.route;
  // 1. Прыжок между соседними системами.
  let worstJump = 0;
  for (let index = 1; index < route.length; index++) {
    const jump = mod.distance3(route[index - 1], route[index]);
    worstJump = Math.max(worstJump, jump);
    assert.ok(jump <= 14.99 + 1e-6, `прыжок ${route[index - 1].name} → ${route[index].name} = ${jump.toFixed(3)} св.л.`);
  }
  assert.ok(worstJump <= 14.99 + 1e-6);

  // 2. Опорные точки: шаг не больше 500 и в основном 480–490.
  const anchors = route.filter((point) => point.isAnchor);
  assert.ok(anchors.length >= 3, `опор ${anchors.length}`);
  const spacings = [];
  for (let index = 1; index < anchors.length; index++) {
    spacings.push(mod.distance3(anchors[index - 1], anchors[index]));
  }
  for (const value of spacings) assert.ok(value <= 500, `шаг опор ${value.toFixed(1)} св.л. больше 500`);
  // «Точнее» 480–490 — цель, а не жёсткий предел: в разреженных местах реальная
  // система может оказаться в 470–479 или 491–500 (это допустимо и видно в статистике).
  // Поэтому порог мягкий; жёсткий предел 500 проверен выше.
  const inRange = spacings.filter((value) => value >= 480 && value <= 490).length;
  assert.ok(inRange / spacings.length >= 0.8, `в диапазоне 480–490: ${inRange} из ${spacings.length}`);

  // 3. Отклонение опор от окружности: допуск 100 св.л.
  for (const anchor of anchors) {
    const deviation = mod.ringDeviation(anchor, center, ringRadius);
    assert.ok(deviation <= 100 + 1e-6, `опора ${anchor.name} ушла на ${deviation.toFixed(1)} св.л.`);
  }

  // Итоговая проверка сборки совпадает с независимым пересчётом.
  assert.equal(result.validation.jumpViolations, 0);
  assert.equal(result.validation.anchorSpacingViolations, 0);
  assert.equal(result.validation.deviationViolations, 0);
  assert.ok(result.validation.withinSpec, 'validation.withinSpec должен быть true');
}

test('кольцо: число сегментов даёт шаг опор не больше 490 св.л.', async () => {
  const { mod, cleanup } = await loadRingModule();
  try {
    for (const radius of [1500, 2000, 5000, 9000, 23000, 24800, 30000, 45000]) {
      const sectors = mod.computeSectorCount(radius);
      const arc = (2 * Math.PI * radius) / sectors;
      assert.ok(arc <= 490 + 1e-9, `R=${radius}: шаг ${arc.toFixed(2)}`);
      // С радиусом от 5000 св.л. в интервал 480–490 всегда попадает целое число сегментов.
      if (radius >= 5000) assert.ok(arc >= 480, `R=${radius}: шаг ${arc.toFixed(2)} меньше 480`);
    }
    // Для стандартного кольца шаг попадает в 480–490 (проверяем точное число).
    const standard = mod.computeSectorCount(23000);
    const arc = (2 * Math.PI * 23000) / standard;
    assert.ok(arc >= 480 && arc <= 490, `шаг стандартного кольца ${arc}`);
  } finally {
    cleanup();
  }
});

test('кольцо: отклонение от окружности считается перпендикулярно, а не до цели', async () => {
  const { mod, cleanup } = await loadRingModule();
  try {
    const center = { x: 0, y: 0, z: 0 };
    assert.equal(mod.ringDeviation({ x: 1000, y: 0, z: 0 }, center, 1000), 0);
    assert.ok(Math.abs(mod.ringDeviation({ x: 1040, y: 0, z: 0 }, center, 1000) - 40) < 1e-9, 'сдвиг наружу на 40');
    assert.ok(Math.abs(mod.ringDeviation({ x: 0, y: 30, z: 1000 }, center, 1000) - 30) < 1e-9, 'сдвиг по высоте на 30');
    // Сдвиг вдоль кольца отклонением не считается.
    assert.ok(mod.ringDeviation({ x: 0, y: 0, z: 1000 }, center, 1000) < 1e-9);
  } finally {
    cleanup();
  }
});

test('кольцо: выбор опоры отсекает дальше 100 св.л. и шаг больше 500', async () => {
  const { mod, cleanup } = await loadRingModule();
  try {
    const center = { x: 0, y: 0, z: 0 };
    const target = { x: 5000, y: 0, z: 0 };
    const previous = { x: 5000, y: 0, z: -485 };
    const candidates = [
      { name: 'Far radial', x: 5000, y: 0, z: 100, source: 'catalog' }, // отклонение 0 (на окружности), но шаг от предыдущей ~ 585
      { name: 'Off ring 150', x: 5150, y: 0, z: -10, source: 'catalog' }, // отклонение 150 — отсечь
      { name: 'Good', x: 5000, y: 0, z: -485 + 485, source: 'catalog' }, // шаг 485 от previous
    ];
    const choice = mod.chooseAnchor({ target, center, ringRadius: 5000, previous, candidates, used: new Set() });
    assert.ok(choice, 'кандидат найден');
    assert.equal(choice.system.name, 'Good', 'выбрана опора с шагом 480–490 и отклонением в норме');
    assert.equal(choice.tier, 0);

    const onlyBad = mod.chooseAnchor({ target, center, ringRadius: 5000, previous, candidates: [candidates[1]], used: new Set() });
    assert.equal(onlyBad, null, 'опора дальше 100 св.л. от окружности отбрасывается');
  } finally {
    cleanup();
  }
});

test('кольцо: расчётная опора стоит точно на шаге 485 от предыдущей опоры', async () => {
  const { mod, cleanup } = await loadRingModule();
  try {
    const center = { x: 0, y: 0, z: 0 };
    const basis = { ux: 1, uz: 0 };
    // Предыдущая опора сместилась на 80 св.л. наружу — цель на окружности слишком далеко.
    const previous = { x: 5080, y: 0, z: -200 };
    const point = mod.ringPointAtDistance(center, basis, 5000, previous, 0.05, 485);
    assert.ok(point, 'точка на окружности найдена');
    assert.ok(Math.abs(mod.distance3(point, previous) - 485) < 1e-6, 'шаг равен 485');
    assert.ok(Math.abs(mod.ringDeviation(point, center, 5000)) < 1e-6, 'точка лежит на окружности');
  } finally {
    cleanup();
  }
});

test('кольцо: проверка маршрута видит нарушения и не штрафует подход к старту', async () => {
  const { mod, cleanup } = await loadRingModule();
  try {
    const center = { x: 0, y: 0, z: 0 };
    const start = { name: 'Sol', x: 7000, y: 0, z: 0 }; // на 2000 св.л. вне окружности 5000
    const anchor = (name, x, z) => ({ name, x, y: 0, z, source: 'catalog', isAnchor: true });
    // Цепочка прыжков по 10 св.л. между точками: прыжки в норме по построению.
    const line = (a, b) => {
      const steps = Math.max(1, Math.ceil(mod.distance3(a, b) / 10));
      const points = [];
      for (let index = 1; index < steps; index++) {
        const t = index / steps;
        points.push({ name: `mid-${points.length}`, x: a.x + (b.x - a.x) * t, y: a.y, z: a.z + (b.z - a.z) * t, source: 'catalog' });
      }
      return points;
    };
    const A = anchor('A', 5000, 0);
    const bridgeEnd = { name: 'bridge', x: 5200, y: 0, z: 0, source: 'catalog' }; // радиально на 200 св.л. от окружности — нарушение
    const B = anchor('B', 5000, 480);
    const approachPts = line(start, A);
    const aToBridge = line(A, bridgeEnd);
    const bridgeToB = line(bridgeEnd, B);
    const back = line(B, start);
    const route = [start, ...approachPts, A, ...aToBridge, bridgeEnd, ...bridgeToB, B, ...back, start];
    const approach = route.map((_, index) => index <= approachPts.length || index >= route.length - back.length - 1);
    const validation = mod.validateRingRoute({ route, approach, center, ringRadius: 5000, start });
    assert.equal(validation.jumpViolations, 0, 'все прыжки в норме');
    assert.ok(validation.maxJump <= 14.99, `максимальный прыжок ${validation.maxJump}`);
    assert.ok(validation.deviationViolations > 0, 'точка моста вне допуска обнаружена');
    assert.equal(validation.withinSpec, false);
    assert.equal(validation.anchorSpacingViolations, 0, 'шаг опор 480 не нарушает предел 500');
    assert.ok(validation.startOffset > 1900 && validation.startOffset < 2100, `смещение старта ${validation.startOffset}`);

    // Прыжок 1000 св.л. ловится отдельно.
    const broken = mod.validateRingRoute({
      route: [start, A, { name: 'far', x: 4000, y: 0, z: 0, source: 'catalog' }],
      approach: [true, false, true],
      center,
      ringRadius: 5000,
      start,
    });
    assert.ok(broken.jumpViolations >= 1, 'прыжок больше 14,99 св.л. обнаружен');
  } finally {
    cleanup();
  }
});

test('кольцо: сквозной поиск на стандартном радиусе соблюдает все требования', async () => {
  const { mod, cleanup } = await loadRingModule();
  try {
    const ringRadius = 5000;
    const world = buildWorld({ ringRadius, count: 60000, seed: 7, voidFrom: 1.0, voidTo: 1.25 });
    const { result, steps, maxStepMs } = await runRing(mod, { ringRadius, searchRadius: 500, world });
    assert.ok(steps >= 2, 'поиск прошёл несколькими шагами');
    assert.ok(maxStepMs < 20_000, `шаг занял ${maxStepMs} мс`);
    assertRingRequirements(mod, result, ringRadius);
  } finally {
    cleanup();
  }
});

test('кольцо: радиус поиска 50 и 3000 св.л. не ломает требования и укладывается в шаг', async () => {
  const { mod, cleanup } = await loadRingModule();
  try {
    const ringRadius = 4000;
    for (const searchRadius of [50, 3000]) {
      const world = buildWorld({ ringRadius, count: 50000, seed: 11 + searchRadius, voidFrom: 2.0, voidTo: 2.2 });
      const { result, maxStepMs } = await runRing(mod, { ringRadius, searchRadius, world });
      assert.ok(maxStepMs < 20_000, `радиус ${searchRadius}: шаг ${maxStepMs} мс`);
      assertRingRequirements(mod, result, ringRadius);
    }
  } finally {
    cleanup();
  }
});
