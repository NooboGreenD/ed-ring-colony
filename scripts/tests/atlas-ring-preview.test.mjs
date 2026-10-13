import test from 'node:test';
import assert from 'node:assert/strict';
import { bundleFile } from './helpers/bundle.mjs';

const load = async () => import(await bundleFile({ entrySource: `
  export * from '@/lib/atlasRingGeometry';
  export * from '@/lib/atlasRingMapGeometry';
  export * from '@/lib/ed3dCanon';
  export * from '@/lib/atlasRingPreview';
  export * from '@/lib/atlasSearchProgress';
` }));
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);

test('кольцо: контур совпадает с точками поиска, а не отражается по Z при наклоне', async () => {
  const m = await load();
  for (const tilt of [0, 15, 45, 90, 135, 180]) {
    for (const center of [m.SAGA, { x: -9000, y: 500, z: 18000 }]) {
      const basis = m.ringBasis3D(m.SOL, center, tilt * Math.PI / 180);
      const ring = { cx: center.x, cy: center.y, cz: center.z, radius: 23000, basis };
      for (let sector = 0; sector <= 32; sector++) {
        const angle = sector * Math.PI / 16;
        const target = m.ringPointAtAngle3D(center, basis, ring.radius, angle);
        const routePoint = m.eliteToThreeCentered(target);
        const contourPoint = m.atlasRingPointToThree(ring, angle);
        [routePoint.x, routePoint.y, routePoint.z].forEach((value, i) => near(value, contourPoint[i]));
        near(contourPoint[2], m.SAGA.z - target.z);
      }
    }
  }
  const center = m.SAGA;
  const plain = { cx: center.x, cy: center.y, cz: center.z, radius: 100 };
  const first = m.atlasRingPointToThree(plain, 0);
  near(first[0], 100); near(first[2], 0);
  near(m.atlasRingPointToThree(plain, Math.PI / 2)[2], -100);
});

test('кольцо: превью повторяет ограничение высоты серверной сессии', async () => {
  const m = await load();
  for (const baseY of [-9000, -20.90625, 0, 800, 9000]) {
    for (const tilt of [0, 15, 90, 180]) {
      for (const height of [-5000, 0, 5000]) {
        const swing = 23000 * Math.abs(Math.sin(tilt * Math.PI / 180));
        const max = Math.min(5000, Math.max(-5000, 6000 - baseY - swing));
        const min = Math.max(-5000, Math.min(5000, -6000 - baseY + swing));
        near(m.ringHeightOffset(baseY, 23000, tilt, height), Math.min(max, Math.max(min, height)));
      }
    }
  }
});

test('кольцо: превью не запускает прогресс и не удаляет закреплённый результат', async () => {
  const m = await load();
  m.resetAtlasSearchProgress();
  m.startAtlasSearchProgress({ kind: 'ring' });
  m.finishAtlasSearchProgress({ summary: 'готово' });
  const result = m.readAtlasSearchResult();
  const progress = m.readAtlasSearchProgress();
  let updates = 0;
  const unsubscribe = m.subscribeAtlasRingPreview(() => updates++);
  m.publishAtlasRingPreview({ cx: 0, cy: 0, cz: 0, radius: 100 });
  assert.equal(m.readAtlasRingPreview().radius, 100);
  m.publishAtlasRingPreview(null);
  assert.equal(updates, 2);
  assert.equal(m.readAtlasSearchResult(), result);
  assert.equal(m.readAtlasSearchProgress(), progress);
  unsubscribe();
  m.resetAtlasSearchProgress();
});

test('кольцо: API превью только разрешает координаты и не создаёт поисковую сессию', async () => {
  const endpoint = await import(await bundleFile({
    entry: 'src/app/api/atlas/ring-route/preview/route.ts',
    stubs: {
      'next/server': `export const NextResponse = { json: (body, options = {}) => ({ body, status: options.status || 200 }) };`,
      '@/lib/atlasRingSearch': `export async function resolveRingSystem(name) {
        globalThis.__ringPreviewNames.push(name);
        if (name === 'missing') return null;
        if (name === 'error') throw new Error('offline');
        return { name, x: 1, y: 2, z: 3 };
      }`,
    },
  }));
  globalThis.__ringPreviewNames = [];
  try {
    const get = params => endpoint.GET(new Request(`http://example.test/api/atlas/ring-route/preview?${params}`));
    assert.equal((await get('')).status, 400);
    assert.equal(globalThis.__ringPreviewNames.length, 0);
    const defaultCenter = await get('start_system=Sol');
    assert.equal(defaultCenter.status, 200);
    assert.deepEqual(globalThis.__ringPreviewNames, ['Sol', 'Sagittarius A*']);
    assert.equal(defaultCenter.body.center.name, 'Sagittarius A*');
    assert.equal((await get('start_system=Sol&center_system=Colonia')).body.center.name, 'Colonia');
    assert.equal((await get('start_system=missing')).status, 404);
    assert.equal((await get('start_system=error')).status, 503);
  } finally {
    delete globalThis.__ringPreviewNames;
  }
});
