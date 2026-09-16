import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOrreryLayout,
  computeFocusView,
  extractStarKey,
  FOCUS_PAD,
  habitableZoneLs,
  overviewWindow,
  placeStructures,
  sceneCamera,
  summarizeLayout,
  toStructures,
  traceExtent,
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
