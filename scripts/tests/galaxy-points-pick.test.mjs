import test from 'node:test';
import assert from 'node:assert/strict';
import {
  POINT_CELL_MAX_LY,
  POINT_CELL_MIN_LY,
  buildPointGrid,
  cellHash,
  choosePointCellSize,
  classBitVisible,
  findPointCell,
  pickAlongRay,
  shaderMaskVisible,
} from '../../src/lib/galaxyPointsPick.ts';
import { STAR_CLASS_LIST } from '../../src/lib/galaxySystems.ts';

/* ──────────────────────────────────────────────────────────────────────────
   Сетка поиска по клику — CSR, отсортированная поразрядно (radix): массив
   индексов + смещения ячеек. Хэш-таблица с открытой адресацией на 2·10⁶ точках
   требовала ещё 64 МБ и могла зациклиться, поэтому здесь её нет. Проверки
   ниже держат главный инвариант: каждая точка лежит в корзине своего хэша,
   ровно один раз, и корзина находится бинарным поиском по ключу.
   ────────────────────────────────────────────────────────────────────────── */

test('shader mask matches the integer bit test for every class', () => {
  const masks = [0, 1, 0b1010, (1 << STAR_CLASS_LIST.length) - 1, 1 << 16, 1 << 17];
  for (const mask of masks) {
    for (let cls = 0; cls < STAR_CLASS_LIST.length; cls++) {
      assert.equal(
        shaderMaskVisible(mask, cls),
        classBitVisible(mask, cls),
        `mask ${mask} class ${cls}`,
      );
    }
  }
});

test('pickAlongRay: ближайшая к лучу точка, скрытый класс пропускается', () => {
  const positions = new Float32Array([
    0, 0, 100,
    2, 0, 100,
    0, 0, 80,
  ]);
  const grid = buildPointGrid(positions, 3, 50);
  const ray = { ox: 0, oy: 0, oz: 0, dx: 0, dy: 0, dz: 1 };
  const nearest = pickAlongRay(grid, positions, ray, { threshold: 5 });
  assert.equal(nearest?.index, 2);

  const types = new Uint8Array([4, 4, 8]);
  const hidden = pickAlongRay(grid, positions, ray, {
    threshold: 5,
    starTypes: types,
    visibleMask: classBitVisible(0xffff, 4) ? (1 << 4) : 0,
  });
  assert.equal(hidden?.index, 0);
});

test('pickAlongRay: экранная дистанция предпочитает точку под курсором', () => {
  const positions = new Float32Array([
    0, 0, 100,
    30, 0, 100,
  ]);
  const grid = buildPointGrid(positions, 2, 50);
  const camera = {
    position: { x: 0, y: 0, z: 0 },
    right: { x: 1, y: 0, z: 0 },
    up: { x: 0, y: 1, z: 0 },
    forward: { x: 0, y: 0, z: 1 },
    fovY: Math.PI / 4,
    width: 200,
    height: 200,
    clickX: 100,
    clickY: 100,
  };
  const hit = pickAlongRay(grid, positions, { ox: 0, oy: 0, oz: 0, dx: 0, dy: 0, dz: 1 }, {
    threshold: 40,
    camera,
    pixelRadius: 12,
  });
  assert.equal(hit?.index, 0);
  assert.ok((hit?.screenDistance ?? 99) < 1);
});

// ─────────────────────────── сама сетка ───────────────────────────

test('ячейки: разные координаты — разные ключи, пустая клетка не находится', () => {
  assert.notEqual(cellHash(0, 0, 0), cellHash(1, 0, 0));
  assert.equal(cellHash(3, 4, 5), cellHash(3, 4, 5), 'хэш детерминирован');

  const positions = new Float32Array([0, 0, 0, 1000, 1000, 1000]);
  const grid = buildPointGrid(positions, 2, 100);
  assert.equal(findPointCell(grid, 0, 0, 0), 0);
  assert.ok(findPointCell(grid, 10, 10, 10) >= 0, 'обитаемая клетка найдена');
  assert.equal(findPointCell(grid, 777, 333, 111), -1, 'пустой клетке нет корзины');
});

test('порядок в корзинах: каждая точка лежит в ячейке своего хэша', () => {
  // Детерминированный ЛКГ: 5000 точек в кубе 4000³.
  let state = 12345;
  const rnd = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  const count = 5000;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    positions[i * 3] = (rnd() - 0.5) * 4000;
    positions[i * 3 + 1] = (rnd() - 0.5) * 4000;
    positions[i * 3 + 2] = (rnd() - 0.5) * 4000;
  }
  const grid = buildPointGrid(positions, count);
  assert.ok(grid.cellSize >= POINT_CELL_MIN_LY && grid.cellSize <= POINT_CELL_MAX_LY);

  // CSR-инварианты: корзины покрывают все точки ровно один раз.
  const seen = new Uint8Array(count);
  let covered = 0;
  for (let cell = 0; cell < grid.cellKeys.length; cell++) {
    assert.ok(grid.starts[cell] <= grid.starts[cell + 1], 'смещения не убывают');
    for (let at = grid.starts[cell]; at < grid.starts[cell + 1]; at++) {
      const index = grid.order[at];
      assert.ok(index >= 0 && index < count, `индекс ${index} вне диапазона`);
      assert.equal(seen[index], 0, `точка ${index} попала в две корзины`);
      seen[index] = 1;
      covered++;
      const key = cellHash(
        Math.floor(positions[index * 3] / grid.cellSize),
        Math.floor(positions[index * 3 + 1] / grid.cellSize),
        Math.floor(positions[index * 3 + 2] / grid.cellSize),
      );
      assert.equal(grid.cellKeys[cell], key, 'корзина соответствует хэшу точки');
    }
  }
  assert.equal(covered, count, 'все точки в сетке');
});

test('размер ячейки подбирается под число точек, а не под галактику', () => {
  const sparse = new Float32Array([0, 0, 0, 10, 5, -7]);
  assert.equal(choosePointCellSize(sparse, 2), POINT_CELL_MIN_LY, 'мало точек — минимальный шаг');
  assert.equal(choosePointCellSize(sparse, 0), POINT_CELL_MIN_LY);

  let state = 7;
  const rnd = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  const count = 200_000;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    positions[i * 3] = (rnd() - 0.5) * 60_000;
    positions[i * 3 + 1] = (rnd() - 0.5) * 20_000;
    positions[i * 3 + 2] = (rnd() - 0.5) * 60_000;
  }
  const size = choosePointCellSize(positions, count);
  assert.ok(size > POINT_CELL_MIN_LY, `ячейка ${size} ly для 200k точек`);
  assert.ok(size < POINT_CELL_MAX_LY);
  // «8 точек на ячейка» — цель подбора: иначе либо длинные списки, либо 10⁶ корзин.
  const grid = buildPointGrid(positions, count, size);
  const density = count / grid.cellKeys.length;
  assert.ok(density > 1 && density < 60, `плотность ${density.toFixed(2)} точки на корзину`);
});

test('облако в 1 млн точек строится и отдаёт лучу свою точку', () => {
  // Решетка 100×100×100 в кубе ±5000 ly: 10⁶ точек, ровно одна на ось.
  const side = 100;
  const count = side * side * side;
  const positions = new Float32Array(count * 3);
  let at = 0;
  for (let i = 0; i < side; i++) {
    for (let j = 0; j < side; j++) {
      for (let k = 0; k < side; k++) {
        positions[at * 3] = i * 100 - 5000;
        positions[at * 3 + 1] = j * 100 - 5000;
        positions[at * 3 + 2] = k * 100 - 5000;
        at++;
      }
    }
  }
  assert.equal(at, count);

  const started = Date.now();
  const grid = buildPointGrid(positions, count);
  const tookMs = Date.now() - started;
  assert.equal(grid.order.length, count);
  assert.equal(grid.starts.length, grid.cellKeys.length + 1);
  // Прежняя реализация на 1.2 млн точек умирала по памяти; эта должна
  // укладываться в секунды на слабом контейнере (запас — в 10 раз).
  assert.ok(tookMs < 20_000, `сетка строилась ${tookMs} мс`);

  // Выстрел вдоль z сквозь (i=40, j=60): попадание — ближайшая по z точка оси.
  const hit = pickAlongRay(grid, positions, {
    ox: 40 * 100 - 5000,
    oy: 60 * 100 - 5000,
    oz: -20_000,
    dx: 0,
    dy: 0,
    dz: 1,
  }, { threshold: 1 });
  assert.ok(hit, 'точка найдена');
  assert.equal(positions[hit.index * 3], 40 * 100 - 5000);
  assert.equal(positions[hit.index * 3 + 1], 60 * 100 - 5000);
  assert.equal(positions[hit.index * 3 + 2], -5000, 'вдоль луча берётся первая точка');
});
