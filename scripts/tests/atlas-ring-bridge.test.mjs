/**
 * Кольцо колонизации: расчётные точки — только когда реальных систем нет.
 *
 * Главная жалоба на прежний поиск была не только в «network error»: кольцо
 * почти целиком собиралось из триангуляции, хотя рядом проходили известные
 * системы. Поэтому проверяется именно поведение прокладки между опорными
 * точками: при наличии систем в коридоре маршрут обязан идти по ним.
 *
 * Модуль собирается esbuild-ом со заглушками хранилищ: тест проверяет
 * геометрию и жадный проход, а не работу Supabase.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

const STUBS = {
  'supabaseAdmin.ts': 'export const supabaseAdmin = {};',
  'galaxySystemsDb.ts': `
    export const catalogIsComplete = () => false;
    export const getGalaxyStats = async () => null;
    export const findSystemByName = async () => null;
    export const findSystemsInCube = async () => [];
    export const findSystemsByNames = async () => new Map();
    export const findStarCandidates = async () => [];
    export const systemById64 = async () => null;
    export const rowWorldType = () => null;
  `,
  'atlasSystemCache.ts': `
    export const boxAround = () => ({ minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 });
    export const listCachedSystemsNear = async () => [];
    export const listCachedSystemsInBox = async () => [];
    export const saveCachedSystems = async () => 0;
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
  const dir = mkdtempSync(join(ROOT, '.tmp-atlas-ring-'));
  const outfile = join(dir, 'ring.mjs');

  const stubPlugin = {
    name: 'atlas-ring-stubs',
    setup(build) {
      const pattern = new RegExp(`\\./(${Object.keys(STUBS).map((name) => name.replace('.', '\\.')).join('|')})$`);
      build.onResolve({ filter: pattern }, (args) => ({ path: args.path, namespace: 'atlas-stub' }));
      build.onLoad({ filter: /.*/, namespace: 'atlas-stub' }, (args) => {
        const key = args.path.replace('./', '');
        return { contents: STUBS[key], loader: 'ts' };
      });
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

  const mod = await import(outfile);
  return { mod, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const point = (name, x, y, z, extra = {}) => ({ name, x, y, z, ...extra });

test('кольцо: геометрия сегментов замкнута и повторяема', async () => {
  const { mod, cleanup } = await loadRingModule();
  try {
    const center = point('Sagittarius A*', 25.21875, -20.90625, 25899.96875);
    const start = point('Start', center.x + 1000, center.y, center.z);
    const sectors = mod.computeSectorCount(23000, 500);
    assert.ok(sectors >= 24 && sectors <= 720, `сегментов ${sectors}`);

    const first = mod.ringTarget(center, mod.ringBasis(start, center), 23000, 0, sectors);
    const last = mod.ringTarget(center, mod.ringBasis(start, center), 23000, sectors, sectors);
    const radius = Math.hypot(first.x - center.x, first.z - center.z);
    assert.ok(Math.abs(radius - 23000) < 1e-6, 'точка сегмента лежит на окружности');
    assert.ok(Math.hypot(last.x - first.x, last.z - first.z) < 1e-6, 'нулевой и последний сегмент совпадают');

    const segmentLength = mod.distance3(
      mod.ringTarget(center, mod.ringBasis(start, center), 23000, 0, sectors),
      mod.ringTarget(center, mod.ringBasis(start, center), 23000, 1, sectors),
    );
    assert.ok(segmentLength > 14.99, 'шаг сегмента больше прыжка — прокладка обязана работать');
  } finally {
    cleanup();
  }
});

test('кольцо: прокладка идёт по существующим системам, а не по прямой', async () => {
  const { mod, cleanup } = await loadRingModule();
  try {
    const from = point('A', 0, 0, 0);
    const to = point('B', 60, 0, 0);
    // Цепочка реальных систем через каждые ~15 св.л. — ровно то, что должно
    // попасть в маршрут вместо расчётных точек.
    const pool = [];
    for (let x = 15; x < 60; x += 15) pool.push(point(`Known-${x}`, x, 0, 0, { source: 'catalog' }));

    const bridge = mod.bridgeWithSystems(from, to, pool, { maxJump: 15, corridor: 30 });
    const names = bridge.map((item) => item.name);
    assert.deepEqual(names, ['Known-15', 'Known-30', 'Known-45'], `маршрут по реальным системам: ${names}`);
    assert.equal(bridge.filter((item) => item.source === 'triangulated').length, 0);
  } finally {
    cleanup();
  }
});

test('кольцо: расчётная точка появляется только там, где систем физически нет', async () => {
  const { mod, cleanup } = await loadRingModule();
  try {
    const from = point('A', 0, 0, 0);
    const to = point('B', 60, 0, 0);
    // Реальные системы есть только на первой половине пути; дальше — пустота.
    const pool = [point('Known-15', 15, 0, 0, { source: 'catalog' }), point('Known-30', 30, 0, 0, { source: 'cache' })];

    const bridge = mod.bridgeWithSystems(from, to, pool, { maxJump: 15, corridor: 30 });
    const real = bridge.filter((item) => item.source !== 'triangulated');
    const synthetic = bridge.filter((item) => item.source === 'triangulated');
    assert.deepEqual(real.map((item) => item.name), ['Known-15', 'Known-30']);
    // Реальные системы закрывают первые 30 св.л.; на оставшиеся 30 нужен один
    // расчётный шаг (45 св.л.), дальше цель достижима за максимальный прыжок.
    assert.equal(synthetic.length, 1, 'расчётных точек ровно столько, сколько нужно');
    assert.ok(synthetic.every((item) => item.name.startsWith('RING TRIANGULATED')), 'имя точки помечено как расчётное');
    assert.equal(new Set(bridge.map((item) => item.name)).size, bridge.length, 'имена точек уникальны');
  } finally {
    cleanup();
  }
});

test('кольцо: система вне коридора не затягивается в маршрут', async () => {
  const { mod, cleanup } = await loadRingModule();
  try {
    const from = point('A', 0, 0, 0);
    const to = point('B', 45, 0, 0);
    // «Крюк» в стороне: жадный проход обязан его игнорировать.
    const pool = [point('Detour', 20, 0, 400, { source: 'catalog' })];
    const bridge = mod.bridgeWithSystems(from, to, pool, { maxJump: 15, corridor: 30 });
    assert.ok(bridge.every((item) => item.name !== 'Detour'), 'система вне коридора не попала в маршрут');
    assert.equal(bridge.length, 2, 'путь в 45 св.л. закрыт двумя расчётными шагами');
  } finally {
    cleanup();
  }
});

test('кольцо: маршрут считается замкнутым только при совпадении концов', async () => {
  const { mod, cleanup } = await loadRingModule();
  try {
    const closed = [point('A', 0, 0, 0), point('B', 10, 0, 0), point('C', 20, 0, 0), point('A', 0, 0, 0)];
    assert.equal(mod.routeIsClosed(closed), true);
    assert.equal(mod.routeIsClosed([...closed.slice(0, 3), point('D', 5, 5, 5)]), false);
    assert.equal(mod.routeIsClosed([]), false);
  } finally {
    cleanup();
  }
});
