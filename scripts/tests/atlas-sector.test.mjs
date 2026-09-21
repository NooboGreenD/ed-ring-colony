import test from 'node:test';
import assert from 'node:assert/strict';
import regionPack from '../../src/lib/galacticRegions.json' with { type: 'json' };

test('Atlas Galactic Sector Registry Data Integrity', async (t) => {
  await t.test('все 42 канонических региона кодекса присутствуют в базе данных', () => {
    assert.equal(regionPack.regions.length, 42);
    const ids = regionPack.regions.map((r) => r.id);
    for (let i = 1; i <= 42; i++) {
      assert.ok(ids.includes(i), `Регион ID ${i} должен присутствовать`);
    }
  });

  await t.test('каждый регион имеет непустой массив вершин полигона границы', () => {
    for (const region of regionPack.regions) {
      assert.ok(region.path.length >= 3, `Регион ${region.name} должен иметь >= 3 вершин`);
      for (const [x, z] of region.path) {
        assert.ok(Number.isFinite(x), `Координата X точки полигона должна быть числом`);
        assert.ok(Number.isFinite(z), `Координата Z точки полигона должна быть числом`);
      }
    }
  });

  await t.test('регион 18 (Inner Orion Spur) охватывает Солнечную систему Sol (0,0,0)', () => {
    const reg18 = regionPack.regions.find((r) => r.id === 18);
    assert.ok(reg18, 'Регион 18 должен существовать');
    assert.equal(reg18.name, 'Inner Orion Spur');

    const SAGA = { x: 25.21875, y: -20.90625, z: 25899.96875 };
    const xs = reg18.path.map((p) => p[0] + SAGA.x);
    const zs = reg18.path.map((p) => p[1] + SAGA.z);
    const min_x = Math.min(...xs);
    const max_x = Math.max(...xs);
    const min_z = Math.min(...zs);
    const max_z = Math.max(...zs);

    assert.ok(min_x <= 0 && max_x >= 0, 'Sol X=0 должен лежать внутри Bounding Box региона 18');
    assert.ok(min_z <= 0 && max_z >= 0, 'Sol Z=0 должен лежать внутри Bounding Box региона 18');
  });

  await t.test('регион 1 (Galactic Centre) охватывает центр галактики Sagittarius A*', () => {
    const reg1 = regionPack.regions.find((r) => r.id === 1);
    assert.ok(reg1, 'Регион 1 должен существовать');
    assert.equal(reg1.name, 'Galactic Centre');

    const SAGA = { x: 25.21875, y: -20.90625, z: 25899.96875 };
    const xs = reg1.path.map((p) => p[0] + SAGA.x);
    const zs = reg1.path.map((p) => p[1] + SAGA.z);
    const min_x = Math.min(...xs);
    const max_x = Math.max(...xs);
    const min_z = Math.min(...zs);
    const max_z = Math.max(...zs);

    assert.ok(min_x <= SAGA.x && max_x >= SAGA.x, 'Sgr A* X должен лежать внутри Bounding Box региона 1');
    assert.ok(min_z <= SAGA.z && max_z >= SAGA.z, 'Sgr A* Z должен лежать внутри Bounding Box региона 1');
  });
});
