import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPointGrid,
  classBitVisible,
  packCell,
  pickAlongRay,
  shaderMaskVisible,
} from '../../src/lib/galaxyPointsPick.ts';
import { STAR_CLASS_LIST } from '../../src/lib/galaxySystems.ts';

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
  assert.notEqual(packCell(0, 0, 0), packCell(1, 0, 0));
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
