import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOrreryLayout,
  computeFocusView,
  extractStarKey,
  FOCUS_PAD,
  habitableZoneLs,
  orbitPoint,
  orbitalPath,
  overviewWindow,
  parseOrbitalElements,
  placeStructures,
  sceneAspect,
  sceneCamera,
  solveKepler,
  SPHERE_HAZE_SCALE,
  SPHERE_MATERIAL,
  SPHERE_MESH,
  sphereGeometry,
  starColorFromTemperature,
  starRadiusScale,
  summarizeLayout,
  toStructures,
  traceExtent,
  trueAnomaly,
} from '../../src/lib/systemOrrery.ts';

const DIST = 'Sol';

function planet(name, id, distanceLs, extra = {}) {
  return {
    body_name: name,
    body_id: id,
    body_type: 'Planet',
    sub_type: 'Rocky body',
    distance_ls: distanceLs,
    parents: [{ Star: 1 }],
    radius_m: 3_000_000,
    ...extra,
  };
}

function star(name, id, distanceLs, extra = {}) {
  return {
    body_name: name,
    body_id: id,
    body_type: 'Star',
    sub_type: 'Y (Brown) Star',
    distance_ls: distanceLs,
    radius_m: 7_000_000_000,
    surface_temp_k: 5778,
    ...extra,
  };
}

test('одиночная звезда: планеты расходятся по орбитам, порядок по дистанции сохраняется', () => {
  const layout = buildOrreryLayout([
    star('Sol', 1, 0),
    planet('Sol 1', 2, 20),
    planet('Sol 2', 3, 400),
    planet('Sol 3', 4, 9000),
  ], DIST);

  assert.equal(layout.stars.length, 1);
  const radiusOf = (name) => Math.hypot(...layout.positions[name]);
  assert.ok(radiusOf('Sol 1') < radiusOf('Sol 2'));
  assert.ok(radiusOf('Sol 2') < radiusOf('Sol 3'));
  // Планеты не должны вылезать за габарит сцены.
  for (const body of layout.bodies) {
    assert.ok(radiusOf(body.name) <= layout.span + 1e-6, `${body.name} вне сцены`);
  }
});

test('все тела системы остаются валидными точками (без NaN/Infinity)', () => {
  const layout = buildOrreryLayout([
    star('Sol', 1, 0),
    planet('Sol 1', 2, 0),
    planet('Sol 2', 3, 12),
    { body_name: 'Sol 3', body_type: 'Planet', distance_ls: null, parents: null },
  ], DIST);
  for (const point of Object.values(layout.positions)) {
    for (const value of point) assert.ok(Number.isFinite(value));
  }
});

test('луна прилипает к своей планете, а не к звезде', () => {
  const layout = buildOrreryLayout([
    star('Sol', 1, 0),
    planet('Sol 5', 2, 400),
    {
      body_name: 'Sol 5 a',
      body_id: 3,
      body_type: 'Moon',
      sub_type: 'Icy body',
      distance_ls: 400,
      parents: [{ Planet: 2 }, { Star: 1 }],
      radius_m: 800_000,
    },
  ], DIST);

  const moon = layout.positions['Sol 5 a'];
  const planetPoint = layout.positions['Sol 5'];
  const starPoint = layout.positions['Sol'];
  const distanceToPlanet = Math.hypot(moon[0] - planetPoint[0], moon[1] - planetPoint[1], moon[2] - planetPoint[2]);
  const distanceToStar = Math.hypot(moon[0] - starPoint[0], moon[1] - starPoint[1], moon[2] - starPoint[2]);
  assert.ok(distanceToPlanet < distanceToStar, 'луна должна быть ближе к планете');
  assert.equal(layout.byName['Sol 5 a'].kind, 'moon');
});

test('мультизвёздная система: тела группируются по своей звезде', () => {
  const records = [
    star('KELT A', 1, 0),
    star('KELT B', 2, 41_000, { parents: [{ Star: 1 }] }),
    star('KELT C', 3, 900_000, { parents: [{ Star: 1 }] }),
    { ...planet('KELT A 1', 10, 30), parents: [{ Star: 1 }] },
    { ...planet('KELT A 2', 11, 300), parents: [{ Star: 1 }] },
    { ...planet('KELT B 1', 20, 41_000), parents: [{ Star: 2 }] },
    { ...planet('KELT C 1', 30, 900_000), parents: [{ Star: 3 }] },
  ];
  const layout = buildOrreryLayout(records, 'KELT');
  assert.equal(layout.stars.length, 3);
  assert.equal(layout.clusters.length, 3);

  const clusters = Object.fromEntries(layout.clusters.map((cluster) => [cluster.starName, cluster.bodies.map((body) => body.name)]));
  assert.deepEqual(clusters['KELT A'].sort(), ['KELT A 1', 'KELT A 2'].sort());
  assert.deepEqual(clusters['KELT B'], ['KELT B 1']);
  assert.deepEqual(clusters['KELT C'], ['KELT C 1']);

  // Планета второй звезды лежит рядом со своей звездой, а не у главной.
  const planetPoint = layout.positions['KELT B 1'];
  const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  assert.ok(
    distance(planetPoint, layout.positions['KELT B']) < distance(planetPoint, layout.positions['KELT A']),
    'KELT B 1 обязана быть ближе к KELT B',
  );
});

test('десятки звёзд: карта не ломается, подписи урезаются, размеры уменьшаются', () => {
  const records = [];
  records.push(star('HIP A', 1, 0));
  for (let index = 0; index < 40; index += 1) {
    records.push(star(`HIP ${index + 2}`, index + 2, 5_000 * (index + 1), { parents: [{ Star: 1 }] }));
  }
  for (let index = 0; index < 12; index += 1) {
    records.push(planet(`HIP A ${index + 1}`, 500 + index, 50 * (index + 1)));
  }
  const layout = buildOrreryLayout(records, 'HIP');
  assert.equal(layout.stars.length, 41);
  assert.equal(layout.labelMode, 'focused', 'в плотной системе подписи только у фокуса');
  assert.ok(Math.max(...Object.values(layout.markerSizes)) <= 13);
  for (const [name, point] of Object.entries(layout.positions)) {
    for (const value of point) assert.ok(Number.isFinite(value), `${name} ушла в NaN`);
  }
  // Кластеры не должны наползать друг на друга сильнее, чем на 60% бюджета.
  for (const cluster of layout.clusters) {
    assert.ok(cluster.budget > 0);
    for (const body of cluster.bodies) {
      const point = layout.positions[body.name];
      const distance = Math.hypot(point[0] - cluster.center[0], point[1] - cluster.center[1], point[2] - cluster.center[2]);
      assert.ok(distance <= cluster.budget * 1.01, `${body.name} вылетела за бюджет кластера`);
    }
  }
});

test('наземная постройка сидит на визуальной поверхности тела', () => {
  const layout = buildOrreryLayout([
    star('Sol', 1, 0),
    planet('Sol 4', 2, 500),
  ], DIST);
  const structures = toStructures([
    { buildId: 'b1', buildName: 'Первая база', buildType: 'Поселение', progress: 40, complete: false, bodyName: 'Sol 4', totalRequired: 100000, totalProvided: 40000 },
    { buildId: 'b2', buildName: 'Второй форпост', buildType: 'Аванпост', progress: 100, complete: true, bodyName: 'Sol 4' },
  ]);
  const canvasPixels = 800;
  const halfSpan = layout.span;
  const placements = placeStructures(layout, structures, halfSpan, canvasPixels);
  const bodyPoint = layout.positions['Sol 4'];
  const unitsPerPx = (halfSpan * 2) / canvasPixels;
  const bodyRadiusUnits = ((layout.markerSizes['Sol 4'] ?? 7) / 2) * unitsPerPx;

  assert.equal(placements.length, 2);
  for (const placement of placements) {
    assert.equal(placement.anchorName, 'Sol 4');
    assert.ok(placement.onSurface, 'постройка на теле обязана считаться наземной');
    const distance = Math.hypot(
      placement.position[0] - bodyPoint[0],
      placement.position[1] - bodyPoint[1],
      placement.position[2] - bodyPoint[2],
    );
    // Было: фиксированные 3.5–8.5 unit'а, т.е. «в космосе». Стало: лимб планеты.
    assert.ok(distance <= bodyRadiusUnits * 3.5, `смещение ${distance.toFixed(2)} больше лимба ${bodyRadiusUnits.toFixed(2)}`);
  }
  // Две постройки на одном теле не должны наложиться друг на друга.
  const [first, second] = placements;
  assert.ok(Math.hypot(first.position[0] - second.position[0], first.position[1] - second.position[1]) > 0);
});

test('постройка без привязки к телу не теряетcя', () => {
  const layout = buildOrreryLayout([star('Sol', 1, 0), planet('Sol 4', 2, 500)], DIST);
  const placements = placeStructures(layout, toStructures([
    { buildId: 'x', buildName: 'Платформа', progress: 10, complete: false, bodyName: null },
  ]), layout.span, 800);
  assert.equal(placements.length, 1);
  assert.equal(placements[0].anchorName, null);
  assert.equal(placements[0].onSurface, false);
  assert.ok(placements[0].position.every(Number.isFinite));
});

test('фокус: каждый уровень приближает камеру и сужает разрез осей', () => {
  const records = [star('Sol', 1, 0)];
  for (let index = 0; index < 8; index += 1) records.push(planet(`Sol ${index + 1}`, 10 + index, 100 * (index + 1)));
  const layout = buildOrreryLayout(records, DIST);

  const overview = computeFocusView(layout, 'Sol 4', 0, 900);
  const cluster = computeFocusView(layout, 'Sol 4', 1, 900);
  const local = computeFocusView(layout, 'Sol 4', 2, 900);
  const close = computeFocusView(layout, 'Sol 4', 3, 900);
  assert.ok(overview && cluster && local && close);
  assert.ok(cluster.halfSpan < overview.halfSpan);
  assert.ok(local.halfSpan < cluster.halfSpan);
  assert.ok(close.halfSpan < local.halfSpan);
  assert.ok(close.eyeDistance < overview.eyeDistance, 'глаз должен подлетать ближе');
  const point = layout.positions['Sol 4'];
  assert.deepEqual(local.center, point);
  // Половина разреза обязана оставаться положительной — иначе Plotly ломает сцену.
  for (const view of [cluster, local, close]) assert.ok(view.halfSpan > 0);
});

test('фокус на неизвестном теле молча возвращает null', () => {
  const layout = buildOrreryLayout([star('Sol', 1, 0)], DIST);
  assert.equal(computeFocusView(layout, 'Нет такой планеты', 2, 800), null);
});

test('обитаемая зона растёт вместе со светимостью звезды', () => {
  const sun = buildOrreryLayout([star('Sol', 1, 0, { radius_m: 6.957e8, surface_temp_k: 5778 })], 'Sol');
  const giant = buildOrreryLayout([star('Big', 1, 0, { radius_m: 6.957e9, surface_temp_k: 4200 })], 'Big');
  const sunZone = habitableZoneLs(sun.byName.Sol);
  const giantZone = habitableZoneLs(giant.byName.Big);
  assert.ok(giantZone[1] > sunZone[1], 'звезда-гигант: HZ дальше');
  assert.ok(sunZone[0] > 300 && sunZone[0] < 600, `HZ Солнца должна быть у 1 а.е., получили ${sunZone[0]}`);
});

test('буквенное обозначение звезды разбирается из имени тела', () => {
  assert.equal(extractStarKey('Shinrarta Dezhra AB 5', 'Shinrarta Dezhra'), 'AB');
  assert.equal(extractStarKey('Sol A 3', 'Sol'), 'A');
  assert.equal(extractStarKey('Sol 16', 'Sol'), '');
});

test('сводка для подписей карточки системы', () => {
  const layout = buildOrreryLayout([
    star('Sol', 1, 0),
    star('Sol B', 2, 3000, { parents: [{ Star: 1 }] }),
    planet('Sol 1', 3, 40, { is_landable: true, bio_signals_count: 3 }),
    planet('Sol 2', 4, 400, { rings: [{ name: 'A', RingClass: 'Icy', InnerRad: 1000, OuterRad: 2000 }] }),
  ], 'Sol');
  const summary = summarizeLayout(layout, toStructures([
    { buildId: 'a', buildName: 'База', progress: 55, complete: false, bodyName: 'Sol 1' },
    { buildId: 'b', buildName: 'Порт', progress: 100, complete: true, bodyName: 'Sol 2' },
  ]));
  assert.deepEqual(summary, {
    stars: 2, planets: 2, moons: 0, landable: 1, bioBodies: 1, bioSignals: 3,
    ringedBodies: 1, structures: 2, activeSites: 1,
  });
});

test('тотальность раскладки: пустые и битые строки не роняют карту', () => {
  // Движок вызывается прямо из клиентского компонента: исключение здесь — это
  // «Application error: a client-side exception» вместо карты, поэтому он
  // обязан деградировать в пустую, но валидную раскладку.
  for (const rows of [[], null, undefined, [null, {}, { body_name: null, parents: 'не массив', rings: 5 }]]) {
    const layout = buildOrreryLayout(rows, 'Sol', {});
    assert.ok(layout, 'раскладка обязана вернуться');
    assert.ok(Array.isArray(layout.bodies));
    assert.ok(Array.isArray(layout.clusters));
    assert.ok(layout.span > 0, 'без тел масштаб всё равно числовой');
    const summary = summarizeLayout(layout, []);
    assert.equal(typeof summary.stars, 'number');
    assert.equal(computeFocusView(layout, 'Sol 999', 3), null, 'фокуса на несуществующем теле нет — и это не ошибка');
  }
});

/* ──────────────── камера и окна: 3D-сцена не должна ломаться ──────────────── */

test('sceneCamera: центр всегда 0 — иначе камера улетает в чёрный экран', () => {
  for (const view of ['iso', 'top', 'side']) {
    const camera = sceneCamera(view);
    assert.deepEqual(camera.center, { x: 0, y: 0, z: 0 });
    assert.equal(camera.projection.type, 'orthographic');
    const distance = Math.hypot(camera.eye.x, camera.eye.y, camera.eye.z);
    assert.ok(distance > 1, `|eye| = ${distance} должен выводить камеру за единичный бокс сцены`);
    assert.ok(distance < 4, `|eye| = ${distance} — камера слишком далеко, система станет точкой`);
  }
  assert.deepEqual(sceneCamera('top').up, { x: 0, y: 1, z: 0 }, 'вид сверху смотрит вдоль −z');
  assert.deepEqual(sceneCamera('iso').up, { x: 0, y: 0, z: 1 });
  // Азимут изометрии: x > 0, y < 0 — та же сторона, что и у карты в приложении.
  assert.ok(sceneCamera('iso').eye.x > 0 && sceneCamera('iso').eye.y < 0);
});

test('обзор вмещает все нарисованные точки, фокус остаётся окном вокруг цели', () => {
  const traces = [
    { x: [0, 120, -95], y: [0, 3, -40], z: [0, 1, -2] },
    { x: [null, 240], y: [null, -260], z: [null, 5] },
  ];
  const extent = traceExtent(traces);
  assert.equal(extent, 260, 'traceExtent берёт максимум по |координате| всех трасс');
  const span = overviewWindow(extent, 240);
  assert.ok(span >= extent, 'иначе часть орбит обрезается краем поля');
  assert.ok(span <= extent * 2, 'разрез не должен превращать систему в точку');
  assert.equal(traceExtent([]), 0);
  assert.ok(FOCUS_PAD > 1 && FOCUS_PAD < 1.2, 'запас окна фокуса — небольшой');
});

test('окно фокуса центрировано на позиции тела из раскладки', () => {
  const rows = [
    star('Sol A', 1, 0),
    planet('Sol 1', 2, 150, { semi_major_axis_ls: 5e10, eccentricity: 0.35, orbital_inclination: 8 }),
    planet('Sol 2', 3, 900, { eccentricity: 0.02 }),
  ];
  const layout = buildOrreryLayout(rows, 'Sol', {});
  const position = layout.positions['Sol 1'];
  assert.ok(position, 'тело должно попасть в раскладку');
  for (const zoom of [0, 1, 2, 3]) {
    const focus = computeFocusView(layout, 'Sol 1', zoom);
    assert.ok(focus, `фокус на Sol 1 для уровня ${zoom}`);
    const window = zoom === 0 ? layout.span : focus.halfSpan * FOCUS_PAD;
    assert.ok(window > 0 && Number.isFinite(window), `уровень ${zoom}: разрез окна`);
    assert.ok(window >= Math.max(...position.map((value) => Math.abs(value))) * 0.5 || zoom > 0,
              'в обзоре цель не должна вылезать за поле');
    if (zoom === 2 || zoom === 3) {
      assert.deepEqual(focus.center, position, 'окно фокуса центрировано ровно на позиции тела');
    }
    // Камера при этом смотрит в 0 — иначе координата цели в unit'ах системы
    // уводит вид в пустоту (чёрный экран вместо тела).
    assert.deepEqual(sceneCamera('iso').center, { x: 0, y: 0, z: 0 });
  }
});

test('обзор из трасс не меньше габарита тел', () => {
  const rows = [star('Sol A', 1, 0), planet('Sol 1', 2, 150), planet('Sol 2', 3, 4000)];
  const layout = buildOrreryLayout(rows, 'Sol', {});
  const coords = Object.values(layout.positions).flat();
  const span = overviewWindow(Math.max(...coords.map((value) => Math.abs(value))), layout.span);
  assert.ok(span >= Math.max(...coords.map((value) => Math.abs(value))));
});

test('тело в фокусе — шар, а не блин: кубический бокс и равные габариты', () => {
  const aspect = sceneAspect();
  assert.equal(aspect.aspectmode, 'manual', "'data' сплющивает плоскую по z систему вместе с планетами");
  assert.deepEqual(aspect.aspectratio, { x: 1, y: 1, z: 1 });

  const [segments, rings] = SPHERE_MESH;
  const mesh = sphereGeometry([10, -4, 2], 3.5, segments, rings);
  assert.equal(mesh.x.length, (segments + 1) * (rings + 1));
  assert.equal(mesh.i.length, 2 * segments * rings, 'индексы обязаны соответствовать вершинам');
  const center = { x: 10, y: -4, z: 2 };
  const radii = mesh.x.map((x, i) => Math.hypot(x - center.x, mesh.y[i] - center.y, mesh.z[i] - center.z));
  assert.ok(Math.max(...radii) - Math.min(...radii) < 1e-9, 'все вершины на равном расстоянии — это сфера');
  // Прозрачность съедает объём (просвечивают обратные грани), а плоское освещение
  // превращает шар в пятно: оба параметра закреплены движком.
  assert.equal(SPHERE_MATERIAL.opacity, 1);
  assert.equal(SPHERE_MATERIAL.flatshading, false);
  assert.ok(SPHERE_MATERIAL.lighting.diffuse > SPHERE_MATERIAL.lighting.ambient);
  assert.ok(SPHERE_MATERIAL.lightposition, 'косой источник света обязателен');
  assert.ok(SPHERE_HAZE_SCALE > 1 && SPHERE_HAZE_SCALE < 1.2, 'дымка — тонкая оболочка поверх тела');
});

/* ── Настоящая орбитальная механика ─────────────────────────────────── */

test('уравнение Кеплера: круговая орбита и вытянутая сходятся', () => {
  // e = 0 → E = M (иначе «реализм» ломает даже простейший случай).
  for (const M of [0, 0.5, 1.7, 3.14, 6.2]) {
    assert.ok(Math.abs(solveKepler(M, 0) - M) < 1e-12);
  }
  // Для e > 0 решение обязано удовлетворять M = E − e·sin E.
  for (const e of [0.1, 0.5, 0.9]) {
    for (const M of [0.3, 1.0, 2.5, 4.0, 5.9]) {
      const E = solveKepler(M, e);
      assert.ok(Math.abs(E - e * Math.sin(E) - M) < 1e-8, `e=${e} M=${M}`);
    }
  }
});

test('истинная аномалия: перицентр и апоцентр на своих местах', () => {
  const e = 0.6;
  assert.ok(Math.abs(trueAnomaly(0, e) - 0) < 1e-9, 'в перицентре ν = 0');
  assert.ok(Math.abs(Math.abs(trueAnomaly(Math.PI, e)) - Math.PI) < 1e-9, 'в апоцентре ν = π');
});

test('эллипс со звездой в фокусе: радиусы перицентра и апоцентра', () => {
  const a = 100;
  const e = 0.5;
  const focus = [0, 0, 0];
  const peri = orbitPoint(a, 0, { eccentricity: e, inclination: 0, periapsis: 0 }, focus);
  const apo = orbitPoint(a, Math.PI, { eccentricity: e, inclination: 0, periapsis: 0 }, focus);
  // r = a(1−e) и r = a(1+e) — главное отличие от прежних окружностей.
  assert.ok(Math.abs(Math.hypot(...peri) - a * (1 - e)) < 1e-9);
  assert.ok(Math.abs(Math.hypot(...apo) - a * (1 + e)) < 1e-9);
});

test('аргумент перицентра поворачивает орбиту в плоскости', () => {
  const a = 50;
  const elements = { eccentricity: 0.4, inclination: 0, periapsis: Math.PI / 2 };
  const peri = orbitPoint(a, 0, elements, [0, 0, 0]);
  assert.ok(Math.abs(peri[0]) < 1e-9, 'перицентр развёрнут на 90° — x = 0');
  assert.ok(peri[1] > 0);
});

test('наклонение поднимает орбиту из плоскости системы', () => {
  const elements = { eccentricity: 0.2, inclination: Math.PI / 6, periapsis: 0 };
  const path = orbitalPath(40, elements, [0, 0, 0], 48);
  const maxZ = Math.max(...path.map((point) => Math.abs(point[2])));
  assert.ok(maxZ > 0, 'орбита обязана выходить из плоскости XY');
  assert.ok(Math.abs(maxZ - 40 * 0.5) < 1.5, 'подъём соответствует sin(i)');
});

test('элементы читаются из raw_data журнала и из EDSM', () => {
  // Журнал: период в секундах, полуось в метрах.
  const fromJournal = parseOrbitalElements({
    body_name: 'Sol 3',
    raw_data: {
      Eccentricity: 0.0167,
      OrbitalInclination: 0.00005,
      Periapsis: 102.9,
      OrbitalPeriod: 31_558_149,
      MeanAnomaly: 358.6,
      AxialTilt: 23.44,
      SemiMajorAxis: 1.496e11,
    },
  });
  assert.ok(fromJournal.fromData);
  assert.ok(Math.abs(fromJournal.eccentricity - 0.0167) < 1e-9);
  assert.ok(Math.abs(fromJournal.periodDays - 365.25) < 0.5);
  assert.ok(Math.abs(fromJournal.axialTiltDeg - 23.44) < 1e-9);
  assert.ok(Math.abs(fromJournal.semiMajorAxisLs - 499.0) < 1.0, '1 а.е. ≈ 499 св. с');

  // EDSM: camelCase, период в СУТКАХ, полуось в АСТРОНОМИЧЕСКИХ ЕДИНИЦАХ,
  // эксцентриситет — `orbitalEccentricity`, средней аномалии нет вовсе.
  // Значения — настоящие из /api-system-v1/bodies для Марса.
  const fromEdsm = parseOrbitalElements({
    body_name: 'Sol 5',
    raw_data: {
      orbitalEccentricity: 0.0934,
      orbitalInclination: 1.85,
      argOfPeriapsis: 286.536985,
      orbitalPeriod: 686.9710016029861,
      semiMajorAxis: 1.5236785671113833,
      axialTilt: 0.439648,
    },
  });
  assert.ok(fromEdsm.fromData);
  // Период EDSM уже в сутках — переводить в секунды и обратно нельзя.
  assert.equal(fromEdsm.periodDays, 686.9710016029861);
  assert.ok(Math.abs(fromEdsm.semiMajorAxisLs - 1.5236785671113833 * 499.00478) < 1e-6, 'а.е. → св. с');
  assert.ok(Math.abs(fromEdsm.eccentricity - 0.0934) < 1e-9);
  assert.equal(fromEdsm.meanAnomalyDeg, 0, 'EDSM среднюю аномалию не отдаёт');

  // Долгая орбита в EDSM (> 1e5 суток) обязана остаться сутками:
  // различаем источник по имени поля, а не по величине.
  const longOrbit = parseOrbitalElements({
    body_name: 'HD 1 8',
    raw_data: { orbitalPeriod: 500_000, semiMajorAxis: 1200 },
  });
  assert.ok(Math.abs(longOrbit.periodDays - 500_000) < 1e-6);

  // Пустая запись: никаких элементов, карта строит прежнюю схему.
  const empty = parseOrbitalElements({ body_name: 'Sol 5' });
  assert.equal(empty.fromData, false);
  assert.equal(empty.eccentricity, 0);
});

test('карта строит настоящие эллипсы, когда элементы есть', () => {
  const layout = buildOrreryLayout([
    star('Sol', 1, 0),
    {
      ...planet('Sol 3', 2, 499),
      raw_data: { Eccentricity: 0.0167, OrbitalInclination: 0, Periapsis: 102.9, MeanAnomaly: 358.6, OrbitalPeriod: 31558149 },
    },
    planet('Sol 4', 3, 2298),
  ], 'Sol');

  const earth = layout.orbits.find((orbit) => orbit.name === 'Sol 3');
  const mars = layout.orbits.find((orbit) => orbit.name === 'Sol 4');
  assert.equal(earth.real, true, 'орбита с элементами помечена настоящей');
  assert.equal(earth.eccentricity, 0.0167);
  assert.ok(earth.periodDays > 360 && earth.periodDays < 370);
  assert.notEqual(mars.real, true, 'без элементов остаётся прежняя схема');

  // Тело стоит НА СВОЁМ ЭЛЛИПСЕ. Сверяем с фокальным уравнением конического
  // сечения r = a(1−e²)/(1+e·cos ν), а не с вершинами отсэмплированной
  // линии: планета обязана попадать между узлами сетки.
  const position = layout.positions['Sol 3'];
  const center = earth.center;
  const radius = Math.hypot(position[0] - center[0], position[1] - center[1], position[2] - center[2]);
  const e = 0.0167;
  const periapsisRad = (102.9 * Math.PI) / 180;
  const nu = Math.atan2(position[1] - center[1], position[0] - center[0]) - periapsisRad;
  const conic = (earth.radius * (1 - e * e)) / (1 + e * Math.cos(nu));
  assert.ok(Math.abs(radius - conic) < 1e-9, `планета не на эллипсе: ${radius} vs ${conic}`);

  const radii = earth.points.map((point) =>
    Math.hypot(point[0] - center[0], point[1] - center[1], point[2] - center[2]));
  const a = earth.radius;
  assert.ok(Math.min(...radii) >= a * (1 - e) - 1e-6, 'перицентр');
  assert.ok(Math.max(...radii) <= a * (1 + e) + 1e-6, 'апоцентр');
  assert.ok(Math.max(...radii) - Math.min(...radii) > 1e-3, 'орбита действительно вытянута, не окружность');

  // Порядок по дистанции сохраняется и в реальном режиме.
  assert.ok(Math.hypot(...layout.positions['Sol 3']) < Math.hypot(...layout.positions['Sol 4']));
});

test('настоящая орбита остаётся в габарите сцены', () => {
  // Вытянутая орбита (e = 0.9) не должна вылезать за SCENE_SPAN:
  // распределённый радиус трактуется как апоцентр.
  const layout = buildOrreryLayout([
    star('HD 1', 1, 0),
    {
      ...planet('HD 1 1', 2, 300),
      raw_data: { Eccentricity: 0.9, OrbitalInclination: 12, Periapsis: 40, MeanAnomaly: 200, OrbitalPeriod: 864000 },
    },
  ], 'HD 1');
  for (const point of Object.values(layout.positions)) {
    for (const value of point) {
      assert.ok(Number.isFinite(value));
      assert.ok(Math.abs(value) <= layout.span + 1e-6, 'тело вышло за сцену');
    }
  }
});

test('цвет звезды по температуре: красные карлики и голубые гиганты', () => {
  const cool = starColorFromTemperature(3000);
  const hot = starColorFromTemperature(20000);
  const solar = starColorFromTemperature(5778);
  assert.match(cool, /^rgb\(/);
  const parse = (rgb) => rgb.match(/\d+/g).map(Number);
  const [cr, cg, cb] = parse(cool);
  const [hr, hg, hb] = parse(hot);
  assert.ok(cr > cb, 'холодная звезда краснее');
  assert.ok(hb > hr, 'горячая звезда голубее');
  const [sr, sg, sb] = parse(solar);
  // Солнце (5778 K) — белое с лёгкой желтизной: синий канал ниже красного,
  // но все три близки к максимуму. Голубее красного оно не бывает.
  assert.ok(sr > 250 && sg > 235 && sb > 225, `почти белое: ${solar}`);
  assert.ok(sr >= sg && sg >= sb, 'тёплый белый: R ≥ G ≥ B');
  // Порядок от холодных к горячим: доля синего растёт.
  const blueShare = ([r, g, b]) => b / (r + g + b);
  assert.ok(blueShare(parse(cool)) < blueShare(parse(solar))
    && blueShare(parse(solar)) < blueShare(parse(hot)), 'чем горячее, тем голубее');
  assert.equal(starColorFromTemperature(0), null, 'без температуры цвет не выдумываем');
  assert.equal(starColorFromTemperature(-100), null);
});

test('радиус звезды растёт с её настоящим размером, но без безумия', () => {
  const small = starRadiusScale({ radiusM: 6.957e8 * 0.1, subType: 'M' });
  const solar = starRadiusScale({ radiusM: 6.957e8, subType: 'G' });
  const giant = starRadiusScale({ radiusM: 6.957e8 * 1000, subType: 'M' });
  assert.ok(small < solar && solar < giant, 'порядок размеров сохранён');
  assert.ok(giant < 3, 'сверхгигант не съедает сцену');
  assert.equal(starRadiusScale({ radiusM: 0, subType: '' }), 1, 'нет данных — масштаб 1');
});
