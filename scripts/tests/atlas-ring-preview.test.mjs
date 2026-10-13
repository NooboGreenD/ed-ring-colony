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
  for (const tilt of [-180, -90, -45, 0, 15, 45, 90, 135, 180]) {
    for (const axis of [0, 45, 90, 180, 270, 359]) {
    for (const center of [m.SAGA, { x: -9000, y: 500, z: 18000 }]) {
      const basis = m.ringBasis3D(m.SOL, center, tilt * Math.PI / 180, axis * Math.PI / 180);
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
  }
  const center = m.SAGA;
  const plain = { cx: center.x, cy: center.y, cz: center.z, radius: 100 };
  const first = m.atlasRingPointToThree(plain, 0);
  near(first[0], 100); near(first[2], 0);
  near(m.atlasRingPointToThree(plain, Math.PI / 2)[2], -100);
});

test('кольцо: высота ограничена толщиной диска, невозможный наклон не смещает центр к краю', async () => {
  const m = await load();
  for (const baseY of [-9000, -20.90625, 0, 800, 9000]) {
    for (const tilt of [-180, -90, -15, 0, 15, 90, 180]) {
      for (const height of [-5000, 0, 5000]) {
        const swing = 23000 * Math.abs(Math.sin(tilt * Math.PI / 180));
        const offset = m.ringHeightOffset(baseY, 23000, tilt, height);
        assert.ok(offset >= -5000 && offset <= 5000);
        const lower = Math.max(-5000, -6000 - baseY + swing);
        const upper = Math.min(5000, 6000 - baseY - swing);
        if (lower <= upper) {
          assert.ok(baseY + offset + swing <= 6000 + 1e-8);
          assert.ok(baseY + offset - swing >= -6000 - 1e-8);
          near(offset, Math.max(lower, Math.min(upper, height)));
        } else {
          near(offset, Math.max(-5000, Math.min(5000, -baseY)));
        }
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


test('кольцо: любая ось и сторона дают ортонормальный базис, радиус и замкнутый контур', async () => {
  const m = await load();
  for (const start of [m.SOL, m.SAGA]) {
    for (const tilt of [-180, -80, -30, 0, 30, 90, 180]) {
      for (const axis of [0, 45, 90, 180, 270]) {
        const b = m.ringBasis3D(start, m.SAGA, tilt * Math.PI / 180, axis * Math.PI / 180);
        const u = [b.ux, b.uy, b.uz], v = [b.vx, b.vy, b.vz], n = [b.nx, b.ny, b.nz];
        const dot = (a,b) => a.reduce((sum, x, i) => sum + x*b[i], 0);
        near(dot(u,u), 1); near(dot(v,v), 1); near(dot(n,n), 1);
        near(dot(u,v), 0); near(dot(u,n), 0); near(dot(v,n), 0);
        const first = m.ringPointAtAngle3D(m.SAGA, b, 1000, 0);
        const last = m.ringPointAtAngle3D(m.SAGA, b, 1000, 2*Math.PI);
        for (const key of ['x','y','z']) near(first[key], last[key]);
        for (const angle of [0, .7, 1.5, 4.2]) {
          const p = m.ringPointAtAngle3D(m.SAGA, b, 1000, angle);
          near(Math.hypot(p.x-m.SAGA.x,p.y-m.SAGA.y,p.z-m.SAGA.z), 1000);
        }
      }
    }
  }
});

test('кольцо: знак наклона отражает высоту, а ось поворачивает направление без изменения размера', async () => {
  const m = await load();
  const center = {x:0,y:0,z:0}, start = {x:1000,y:0,z:0};
  const right = m.ringBasis3D(start, center, Math.PI/6);
  const left = m.ringBasis3D(start, center, -Math.PI/6);
  near(right.vy, -left.vy); near(right.vx, left.vx); near(right.vz,left.vz);
  near(right.uy,0);
  const across = m.ringBasis3D(start,center,Math.PI/6,Math.PI/2);
  near(across.vy,0); near(across.uy,.5);
  near(right.ux,1); near(right.uz,0); near(right.vy,-.5); near(right.vz,Math.cos(Math.PI/6));
});
