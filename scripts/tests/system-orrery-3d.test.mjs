/**
 * Тесты движка 3D-карты системы (`src/lib/orrery3d`).
 *
 * Проверяем то, что видит пользователь и что легко сломать:
 *
 * 1. Пакет данных: постройки стоят на поверхности тела, зоны обитаемости
 *    посчитаны, сводка совпадает с телами, JSON сериализуется как есть.
 * 2. Сцена three.js: слои включаются/выключаются, фокус приглушает чужие
 *    орбиты, у каждого объекта наведения есть имя.
 * 3. Наведение лучом: попадание по телу и по постройке возвращает их имена.
 * 4. Камера: уровни приближения действительно приближают, переходы не дают
 *    NaN и короткой дуги вместо «сквозь центр».
 * 5. Движение по орбите: точка остаётся на нарисованной орбите.
 *
 * WebGL не нужен: сцена и камера — обычная математика three.js, а рендерер
 * поднимается только в браузере. Поэтому тесты идут в Node без jsdom.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let esbuild = null;
try {
  esbuild = await import('esbuild');
} catch {
  // devDependencies не установлены
}

const maybe = esbuild ? test : test.skip;

// Временные сборки движка: репозиторий должен оставаться чистым и после
// падения теста, поэтому папки сносим на выходе процесса.
const tempDirs = [];
process.on('exit', () => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

async function loadEngine() {
  const dir = mkdtempSync(join(ROOT, '.tmp-orrery3d-'));
  tempDirs.push(dir);
  const entry = join(dir, 'entry.ts');
  const bundle = join(dir, 'engine.mjs');
  writeFileSync(entry, "export * from '@/lib/orrery3d';\nexport * from '@/lib/systemOrrery';\n");
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: bundle,
    alias: { '@': join(ROOT, 'src') },
    loader: { '.ts': 'ts', '.tsx': 'tsx' },
    logLevel: 'silent',
  });
  const module = await import(bundle);
  return { module, dir };
}

const enginePromise = esbuild ? loadEngine() : null;

function star(name, id, distanceLs, extra = {}) {
  return {
    body_name: name,
    body_id: id,
    body_type: 'Star',
    sub_type: 'G (White-Yellow) Star',
    distance_ls: distanceLs,
    radius_m: 6.957e8,
    surface_temp_k: 5778,
    ...extra,
  };
}

function planet(name, id, distanceLs, extra = {}) {
  return {
    body_name: name,
    body_id: id,
    body_type: 'Planet',
    sub_type: 'Rocky body',
    distance_ls: distanceLs,
    parents: [{ Star: 1 }],
    radius_m: 3_000_000,
    surface_gravity: 7.5,
    ...extra,
  };
}

function moon(name, id, distanceLs, parentId, extra = {}) {
  return {
    body_name: name,
    body_id: id,
    body_type: 'Planet',
    sub_type: 'Rocky body',
    distance_ls: distanceLs,
    parents: [{ Planet: parentId }],
    radius_m: 1_500_000,
    ...extra,
  };
}

/** Система с одиночной звездой, планетами, луной, кольцами и стройплощадкой. */
function systemRecords() {
  return [
    star('TestSys', 1, 0),
    planet('TestSys 1', 2, 120, {
      sub_type: 'Earthlike body',
      is_landable: true,
      surface_temperature: 289,
      atmosphere: 'Thin Nitrogen',
      bio_signals_count: 4,
      semi_major_axis_ls: 600,
      eccentricity: 0.02,
      orbital_inclination: 1.5,
      orbital_period_days: 210,
      mean_anomaly: 40,
    }),
    planet('TestSys 2', 3, 900, {
      sub_type: 'Gas giant',
      semi_major_axis_ls: 2200,
      eccentricity: 0.08,
      orbital_period_days: 1600,
      mean_anomaly: 200,
      rings: [{ name: 'TestSys 2 A Ring', ringClass: 'Icy', innerRadiusKm: 78000, outerRadiusKm: 118000 }],
    }),
    moon('TestSys 2 a', 4, 950, 3, { semi_major_axis_ls: 9000, orbital_period_days: 12 }),
    planet('TestSys 3', 5, 4200, { sub_type: 'Icy body', semi_major_axis_ls: 14000, orbital_period_days: 9000 }),
  ];
}

/** Двойная звезда с телами у каждой — для проверки уровней приближения. */
function binaryRecords() {
  return [
    star('BinSys A', 1, 0, { sub_type: 'G (White-Yellow) Star' }),
    star('BinSys B', 6, 4200, { sub_type: 'M (Red dwarf) Star', surface_temp_k: 3200, radius_m: 2.5e8 }),
    planet('BinSys A 1', 2, 120, { sub_type: 'Rocky body', semi_major_axis_ls: 700 }),
    planet('BinSys A 2', 3, 900, { sub_type: 'Icy body', semi_major_axis_ls: 2600 }),
    planet('BinSys B 1', 7, 4400, { sub_type: 'Rocky body', semi_major_axis_ls: 900, parents: [] }),
  ];
}

function structuresFor() {
  return [
    {
      id: 'site-1',
      name: 'Planetary Construction Site: TestSys 1',
      type: 'Planetary Outpost',
      bodyName: 'TestSys 1',
      progress: 42,
      complete: false,
      requiredTons: 12000,
      providedTons: 5000,
      surface: true,
      resources: [{ name: 'Steel', required: 8000, provided: 3000 }],
    },
  ];
}

maybe('пакет: постройки привязаны к поверхности тела, зоны обитаемости посчитаны', async () => {
  const { module } = await enginePromise;
  const layout = module.buildOrreryLayout(systemRecords(), 'TestSys');
  const structures = module.toStructures([
    {
      buildId: 'site-1',
      buildName: 'Planetary Construction Site: TestSys 1',
      buildType: 'Planetary Outpost',
      bodyName: 'TestSys 1',
      progress: 42,
      totalRequired: 12000,
      totalProvided: 5000,
      resources: [{ name: 'Steel', required: 8000, provided: 3000 }],
    },
  ]);
  const payload = module.buildOrreryView(layout, structures, { systemName: 'TestSys' });

  assert.equal(payload.version, module.ORRERY_VIEW_VERSION);
  assert.equal(payload.system, 'TestSys');
  assert.equal(payload.bodies.length, layout.bodies.length);
  assert.equal(payload.summary.stars, 1);
  assert.equal(payload.summary.planets, 3);
  assert.equal(payload.summary.moons, 1);
  assert.equal(payload.summary.structures, 1);
  assert.equal(payload.summary.activeSites, 1);
  assert.equal(payload.summary.bioSignals, 4);

  const site = payload.structures[0];
  const anchor = payload.bodies.find((body) => body.name === 'TestSys 1');
  const distance = Math.hypot(
    site.position[0] - anchor.position[0],
    site.position[1] - anchor.position[1],
    site.position[2] - anchor.position[2],
  );
  // Постройка лежит на символической сфере тела: от радиуса до полутора радиусов.
  assert.ok(site.onSurface, 'постройка на поверхности');
  assert.ok(distance >= anchor.radius * 0.9, `постройка внутри тела: ${distance} < ${anchor.radius}`);
  assert.ok(distance <= anchor.radius * 1.2, `постройка улетела от тела: ${distance} > ${anchor.radius * 1.2}`);
  assert.equal(site.remainingTons, 7000);
  assert.deepEqual(anchor.structures, ['site-1']);

  assert.ok(payload.zones.length >= 1, 'зона обитаемости есть у звезды');
  for (const zone of payload.zones) {
    assert.ok(zone.inner > 0 && zone.outer > zone.inner, 'границы зоны упорядочены');
    assert.ok(zone.innerLs > 0 && zone.outerLs > zone.innerLs);
  }

  const earthlike = payload.bodies.find((body) => body.name === 'TestSys 1');
  assert.equal(earthlike.habitableBand, 'habitable', 'землеподобная планета в обитаемой зоне');
  assert.equal(payload.bodies.find((body) => body.name === 'TestSys 3').habitableBand, 'outer');

  // Пакет уходит в JSON без потерь — иначе автономный HTML не соберётся.
  const roundTrip = JSON.parse(JSON.stringify(payload));
  assert.deepEqual(roundTrip.bodies.length, payload.bodies.length);
  assert.equal(roundTrip.structures[0].position.length, 3);
});

maybe('пакет: у каждой орбиты есть точки, у каждой луны — своя орбита', async () => {
  const { module } = await enginePromise;
  const layout = module.buildOrreryLayout(systemRecords(), 'TestSys');
  const payload = module.buildOrreryView(layout, [], { systemName: 'TestSys' });

  assert.ok(payload.orbits.length >= 3, 'орбиты планет на месте');
  for (const orbit of payload.orbits) {
    assert.ok(orbit.points.length > 8);
    for (const point of orbit.points) {
      for (const value of point) assert.ok(Number.isFinite(value));
    }
  }
  assert.equal(payload.moonOrbits.length, 1);
  assert.equal(payload.moonOrbits[0].kind, 'moon');
  const moonBody = payload.bodies.find((body) => body.kind === 'moon');
  assert.equal(moonBody.parent, 'TestSys 2');
});

maybe('сцена: слои, приглушение фокуса и имена объектов наведения', async () => {
  const { module } = await enginePromise;
  const layout = module.buildOrreryLayout(systemRecords(), 'TestSys');
  const payload = module.buildOrreryView(layout, module.toStructures(structuresFor()), { systemName: 'TestSys' });
  const scene = module.buildOrreryScene(payload);

  assert.equal(scene.root.rotation.x, -Math.PI / 2, 'пакет в Z-вверх повёрнут в Y-вверх');
  assert.ok(scene.pickables.length >= payload.bodies.length, 'все тела ловят курсор');
  assert.equal(scene.bodyObjects.size, payload.bodies.length);
  assert.equal(scene.structureObjects.size, payload.structures.length);
  assert.ok(scene.labelAnchors.has('TestSys 1'), 'у тела есть точка подписи');

  scene.setLayer('moons', false);
  assert.equal(scene.groups.moons.visible, false);
  scene.setLayer('moons', true);
  assert.equal(scene.groups.moons.visible, true);
  scene.setLayer('structures', false);
  assert.equal(scene.groups.structures.visible, false);

  const orbitMaterial = scene.groups.orbits.children[0].material;
  const before = orbitMaterial.opacity;
  scene.setEmphasis('TestSys 1');
  const dimmed = scene.groups.orbits.children
    .filter((line) => line.userData.pick.name === 'TestSys 3')
    .map((line) => line.material.opacity);
  assert.ok(dimmed.every((value) => value < before), 'чужая орбита притухает');
  scene.setEmphasis(null);
  assert.equal(orbitMaterial.opacity, before, 'снятие фокуса возвращает яркость');

  const geometryCount = scene.groups.stars.children.length + scene.groups.planets.children.length;
  scene.dispose();
  assert.equal(scene.pickables.length, 0);
  assert.ok(geometryCount > 0);
});

maybe('наведение лучом: попадание по телу и по стройплощадке', async () => {
  const { module } = await enginePromise;
  const layout = module.buildOrreryLayout(systemRecords(), 'TestSys');
  const payload = module.buildOrreryView(layout, module.toStructures(structuresFor()), { systemName: 'TestSys' });
  const scene = module.buildOrreryScene(payload);

  const three = await import('three');
  const camera = new three.PerspectiveCamera(42, 1.6, 0.1, 100000);
  const frame = module.frameFor(payload, 'TestSys 2', 2, { aspect: 1.6 });
  const state = module.cameraStateFor(frame, 'iso');
  camera.position.set(...state.position);
  camera.up.set(...state.up);
  camera.lookAt(new three.Vector3(...state.target));
  camera.updateMatrixWorld(true);
  scene.root.updateMatrixWorld(true);

  const targetBody = payload.bodies.find((body) => body.name === 'TestSys 2');
  const bodyPosition = new three.Vector3(...module.toThree(targetBody.position));
  const rayToBody = new three.Raycaster(camera.position.clone(), bodyPosition.clone().sub(camera.position).normalize());
  const bodyHits = rayToBody.intersectObjects(scene.pickables, true);
  assert.ok(bodyHits.length > 0, 'луч попал в тело');
  const bodyInfo = module.pickInfoOf(bodyHits[0].object);
  assert.equal(bodyInfo.kind, 'body');
  assert.equal(bodyInfo.name, 'TestSys 2');

  const structure = payload.structures[0];
  const structurePosition = new three.Vector3(...module.toThree(structure.position));
  const rayToStructure = new three.Raycaster(camera.position.clone(), structurePosition.clone().sub(camera.position).normalize());
  const structureHits = rayToStructure.intersectObjects(scene.pickables, true);
  assert.ok(structureHits.length > 0, 'луч попал в стройплощадку');
  // Ближайшее пересечение может быть телом перед маркером — это нормально;
  // важно, что постройка тоже ловится и отдаёт свой id.
  const structureInfo = structureHits
    .map((hit) => module.pickInfoOf(hit.object))
    .find((info) => info?.kind === 'structure');
  assert.ok(structureInfo, 'постройка распознана лучом');
  assert.equal(structureInfo.name, structure.id);
});

maybe('камера: уровни приближения уменьшают кадр, переходы корректны', async () => {
  const { module } = await enginePromise;
  const layout = module.buildOrreryLayout(binaryRecords(), 'BinSys');
  const payload = module.buildOrreryView(layout, [], { systemName: 'BinSys' });

  const system = module.frameFor(payload, 'BinSys A 1', 0, { aspect: 1.6 });
  const cluster = module.frameFor(payload, 'BinSys A 1', 1, { aspect: 1.6 });
  const vicinity = module.frameFor(payload, 'BinSys A 1', 2, { aspect: 1.6 });
  const surface = module.frameFor(payload, 'BinSys A 1', 3, { aspect: 1.6 });

  assert.ok(system.halfSpan > cluster.halfSpan, 'кластер ближе системы');
  assert.ok(cluster.halfSpan >= vicinity.halfSpan, 'окрестность не шире кластера');
  assert.ok(surface.halfSpan <= vicinity.halfSpan, 'поверхность — самый близкий уровень');
  for (const frame of [system, cluster, vicinity, surface]) {
    assert.ok(frame.distance > 0 && Number.isFinite(frame.distance));
    const position = module.cameraPosition(frame, 'iso');
    for (const value of position) assert.ok(Number.isFinite(value));
  }

  // На узком экране (телефон) камера отходит дальше: сцена влезает по ширине.
  const narrow = module.frameFor(payload, 'BinSys A 1', 0, { aspect: 0.55 });
  assert.ok(narrow.distance > system.distance * 1.4, 'портретная ориентация учитывает ширину');

  const from = module.cameraStateFor(system, 'iso');
  const to = module.cameraStateFor(surface, 'iso');
  const mid = module.interpolateCamera(from, to, 0.5);
  for (const value of [...mid.position, ...mid.target, ...mid.up]) assert.ok(Number.isFinite(value));
  const start = module.interpolateCamera(from, to, 0);
  const end = module.interpolateCamera(from, to, 1);
  const distanceBetween = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  assert.ok(distanceBetween(start.target, from.target) < 1e-6, 'начало перехода — исходный кадр');
  assert.ok(distanceBetween(end.position, to.position) < 1e-6, 'конец перехода — целевой кадр');
  assert.ok(distanceBetween(end.target, to.target) < 1e-6);
  // Половина пути камеры — не в центре системы: дуга, а не «сквозь ноль».
  const midDistance = Math.hypot(mid.position[0], mid.position[1], mid.position[2]);
  assert.ok(midDistance > 0.2 * Math.hypot(...from.position));

  // Вид сверху не может смотреть вдоль собственного `up`.
  assert.deepEqual(module.cameraUp('top'), [0, 0, -1]);
  assert.deepEqual(module.cameraUp('iso'), [0, 1, 0]);
});

maybe('камера: обновление данных её не трогает, смена системы и масштаба — кадрирует', async () => {
  const { module } = await enginePromise;
  const layout = module.buildOrreryLayout(systemRecords(), 'TestSys');
  const payload = module.buildOrreryView(layout, [], { systemName: 'TestSys' });

  // Тот же пакет, пересчитанный заново (ре-рендер React, новые сканы) —
  // камеру не двигаем: из-за этого карта «постоянно возвращалась в исходное
  // состояние», стоило мышке шевельнуться.
  const again = module.buildOrreryView(layout, [], { systemName: 'TestSys' });
  assert.equal(module.shouldReframeCamera(payload, again, { focus: 'TestSys 2' }), false);
  assert.equal(module.shouldReframeCamera(payload, again, {}), false);

  // Первый показ — кадрируем: смотреть иначе не на что.
  assert.equal(module.shouldReframeCamera(null, payload, {}), true);
  // Явная просьба (кнопка «вся система») — кадрируем.
  assert.equal(module.shouldReframeCamera(payload, again, { resetCamera: true }), true);
  // Другая система.
  const other = module.buildOrreryView(module.buildOrreryLayout(binaryRecords(), 'BinSys'), [], { systemName: 'BinSys' });
  assert.equal(module.shouldReframeCamera(payload, other, {}), true);
  // Переключение масштаба: координаты меняются целиком.
  const linear = module.buildOrreryView(layout, [], { systemName: 'TestSys', scaleMode: 'linear' });
  assert.equal(module.shouldReframeCamera(payload, linear, {}), true);
  // Выбранное тело пропало из данных — камера смотрела бы в пустоту.
  const trimmed = { ...again, bodies: again.bodies.filter((body) => body.name !== 'TestSys 2') };
  assert.equal(module.shouldReframeCamera(payload, trimmed, { focus: 'TestSys 2' }), true);
  // Прилетел скан далёкого тела: границы чуть разъехались — это не повод.
  assert.equal(module.shouldReframeCamera(payload, { ...again, span: payload.span * 1.2 }, {}), false);
  assert.equal(module.shouldReframeCamera(payload, { ...again, span: payload.span * 3 }, {}), true);
});

maybe('движение: тело остаётся на нарисованной орбите', async () => {
  const { module } = await enginePromise;
  const layout = module.buildOrreryLayout(systemRecords(), 'TestSys');
  const payload = module.buildOrreryView(layout, [], { systemName: 'TestSys' });
  const body = payload.bodies.find((candidate) => candidate.name === 'TestSys 2');
  const orbit = payload.orbits.find((candidate) => candidate.name === 'TestSys 2');

  assert.deepEqual(module.positionAtTime(body, orbit, 0), body.position);
  for (const days of [30, 200, 1200]) {
    const point = module.positionAtTime(body, orbit, days);
    const nearest = Math.min(...orbit.points.map((path) => Math.hypot(
      path[0] - point[0], path[1] - point[1], path[2] - point[2],
    )));
    const tolerance = Math.max(1.5, orbit.radius * 0.04);
    assert.ok(nearest < tolerance, `через ${days} сут тело ушло с орбиты: ${nearest.toFixed(2)}`);
  }

  // Тело без настоящих элементов едет по своей окружности.
  const synthetic = payload.bodies.find((candidate) => candidate.name === 'TestSys 3');
  const syntheticOrbit = payload.orbits.find((candidate) => candidate.name === 'TestSys 3');
  const centre = syntheticOrbit.center;
  const base = Math.hypot(
    synthetic.position[0] - centre[0],
    synthetic.position[1] - centre[1],
    synthetic.position[2] - centre[2],
  );
  const moved = module.positionAtTime(synthetic, syntheticOrbit, 1000);
  const movedRadius = Math.hypot(moved[0] - centre[0], moved[1] - centre[1], moved[2] - centre[2]);
  assert.ok(Math.abs(movedRadius - base) < Math.max(0.5, base * 0.05), 'радиус орбиты сохранился');
});

maybe('пустая система: пакет и сцена собираются без тел', async () => {
  const { module } = await enginePromise;
  const payload = module.emptyOrreryView('Пусто');
  const scene = module.buildOrreryScene(payload);
  assert.equal(payload.bodies.length, 0);
  assert.equal(scene.pickables.length, 0);
  const frame = module.frameFor(payload, '', 0, { aspect: 1.6 });
  assert.ok(frame.distance > 0);
  scene.dispose();
});
