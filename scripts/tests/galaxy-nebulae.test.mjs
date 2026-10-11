import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GALAXY_NEBULAE,
  MAJOR_NEBULAE,
  NEBULA_KIND_LABELS,
  nebulaByName,
  nebulaDistanceTo,
} from '../../src/lib/galaxyNebulae.ts';
import {
  ALPHA_MAX,
  ALPHA_MIN,
  ATLAS_PEAK,
  MAX_PUFFS,
  DETAIL_SIZE,
  EMISSIVE_ADDITIVE,
  TONE_SATURATION,
  alphaScaleFor,
  buildNebulaBuckets,
  buildNebulaPuffs,
  buildPuffAtlasData,
  emptyPuffBucket,
  gameToneRgb,
  mixWhite,
  puffCountFor,
} from '../../src/lib/nebulaClouds.ts';

/* ──────────────────────────────────────────────────────────────────────────
   Каталог туманностей и облака на карте галактики.

   Проверяем две вещи, на которых слой и держится:
   1. Данные. Координаты в Elite Dangerous — это направление на объект с неба
      (RA/Dec) плюс игровое расстояние от Sol, поэтому |(x, y, z)| обязан
      совпадать с заявленным расстоянием; для объектов, где известна система из
      игры (EDSM), позиция должна быть именно её.
   2. Геометрию облака. Раскладка клубов детерминированная (одинаковая на
      каждом кадре), силуэт соответствует типу (кольцо у Петли Барнарда, нити у
      Вуали), альфы посчитаны так, чтобы маленькая планетарная туманность не
      терялась рядом с огромной эмиссионной.
   ────────────────────────────────────────────────────────────────────────── */

const project = (nebula) => ({
  x: nebula.x,
  y: nebula.y,
  z: nebula.z,
});

test('каталог: координаты согласованы с расстоянием от Sol', () => {
  assert.ok(GALAXY_NEBULAE.length >= 130, `туманностей ${GALAXY_NEBULAE.length}`);

  for (const nebula of GALAXY_NEBULAE) {
    const radius = Math.hypot(nebula.x, nebula.y, nebula.z);
    assert.ok(Number.isFinite(radius), `${nebula.name}: координаты не числа`);
    assert.ok(
      Math.abs(radius - nebula.distance) < 2,
      `${nebula.name}: |координаты| ${radius.toFixed(1)} против расстояния ${nebula.distance}`,
    );
    assert.ok(
      nebula.distance > 100 && nebula.distance < 60000,
      `${nebula.name}: расстояние ${nebula.distance} вне игрового диапазона`,
    );
    assert.ok(NEBULA_KIND_LABELS[nebula.kind], `${nebula.name}: неизвестный тип ${nebula.kind}`);
    assert.ok(
      nebula.size >= 60 && nebula.size <= 900,
      `${nebula.name}: диаметр ${nebula.size} св. лет вне диапазона карты`,
    );
  }
});

test('каталог: известные туманности стоят на своих системах из игры', () => {
  // Координаты систем — EDSM (данные самой игры). Облако обязано накрывать
  // систему, иначе на карте туманность окажется не там, где её видно в игре.
  const anchors = [
    ['Pleiades Nebula', { x: -81.78125, y: -149.4375, z: -343.375 }, 120],
    ['Witch Head Nebula', { x: 359.84375, y: -385.53125, z: -718.375 }, 120],
    ['Orion Nebula', { x: 593.3125, y: -433.53125, z: -1065.03125 }, 120],
    ['California Nebula', { x: -337.90625, y: -211.9375, z: -927.03125 }, 120],
    ['Bubble Nebula', { x: -6570.5, y: 29.84375, z: -2680.28125 }, 120],
    ['Heart and Soul Nebulae', { x: -5150.90625, y: 98.625, z: -5326.6875 }, 120],
    ['Veil Nebula West', { x: -1398.25, y: -193.5625, z: 418.90625 }, 120],
    ['NGC 1501', { x: -2071.59375, y: 413.75, z: -2915.03125 }, 120],
  ];

  for (const [name, point, tolerance] of anchors) {
    const nebula = nebulaByName(name);
    assert.ok(nebula, `${name} нет в каталоге`);
    assert.equal(nebula.positionSource, 'game-system', `${name}: позиция не по системе игры`);
    assert.ok(
      nebulaDistanceTo(nebula, point) <= tolerance,
      `${name}: центр облака в ${nebulaDistanceTo(nebula, point).toFixed(0)} св. годах от системы`,
    );
  }
});

test('каталог: без игры позиция считается по каталогу и остаётся в конусе', () => {
  // У туманностей без системы из игры позиция обязана лежать по тому же лучу
  // зрения, что и астрономический расчёт (расхождение — только по расстоянию).
  for (const nebula of GALAXY_NEBULAE) {
    if (nebula.positionSource !== 'astro') continue;
    const a = Math.hypot(nebula.x, nebula.y, nebula.z);
    const b = Math.hypot(nebula.astro.x, nebula.astro.y, nebula.astro.z);
    const cos = (nebula.x * nebula.astro.x + nebula.y * nebula.astro.y + nebula.z * nebula.astro.z) / (a * b);
    assert.ok(cos > 0.999, `${nebula.name}: направление отличается от каталога (cos=${cos.toFixed(4)})`);
  }
});

test('каталог: имена уникальны, подписей немного', () => {
  const names = new Set(GALAXY_NEBULAE.map((nebula) => nebula.name));
  assert.equal(names.size, GALAXY_NEBULAE.length, 'есть дубликаты названий');
  assert.ok(MAJOR_NEBULAE.length >= 12 && MAJOR_NEBULAE.length <= 40, `подписей ${MAJOR_NEBULAE.length}`);
  for (const nebula of MAJOR_NEBULAE) {
    assert.ok(nebula.ru && nebula.ru !== nebula.name, `${nebula.name}: нет русской подписи`);
  }
});

/* ── Облака ──────────────────────────────────────────────────────────────── */

test('облако: раскладка детерминированная и в пределах буфера', () => {
  for (const name of ['Orion Nebula', 'The Lupus Dark Regions', 'Helix Nebula', "Barnard's Loop"]) {
    const nebula = nebulaByName(name);
    assert.ok(nebula, `${name} нет в каталоге`);
    const first = emptyPuffBucket();
    const second = emptyPuffBucket();
    buildNebulaPuffs(nebula, project(nebula), [], first);
    buildNebulaPuffs(nebula, project(nebula), [], second);

    assert.deepEqual(first.centers, second.centers, `${name}: раскладка не детерминированная`);
    assert.ok(first.sizes.length <= MAX_PUFFS + 16, `${name}: клубов ${first.sizes.length}`);

    for (let i = 0; i < first.sizes.length; i++) {
      assert.ok(Number.isFinite(first.centers[i * 3]), `${name}: центр клуба не число`);
      assert.ok(first.sizes[i] > 0 && first.sizes[i] <= nebula.size * 1.4, `${name}: размер клуба ${first.sizes[i]}`);
      assert.ok(
        first.alphas[i] >= ALPHA_MIN - 1e-9 && first.alphas[i] <= ALPHA_MAX + 1e-9,
        `${name}: альфа клуба ${first.alphas[i]}`,
      );
      for (let c = 0; c < 3; c++) {
        const channel = first.colors[i * 3 + c];
        assert.ok(channel >= 0 && channel <= 1, `${name}: канал цвета ${channel}`);
      }
      assert.ok(first.tiles[i] >= 0 && first.tiles[i] < 4, `${name}: плитка атласа ${first.tiles[i]}`);
    }
  }
});

test('облако: клубы не выходят далеко за объявленный диаметр', () => {
  const nebula = nebulaByName('Orion Nebula');
  const center = project(nebula);
  const bucket = emptyPuffBucket();
  buildNebulaPuffs(nebula, center, [], bucket);

  let maxOffset = 0;
  for (let i = 0; i < bucket.sizes.length; i++) {
    // Смещение от центра облака: гало и купол выходят за диаметр, но не втрое.
    const offset = Math.hypot(
      bucket.centers[i * 3] - center.x,
      bucket.centers[i * 3 + 2] - center.z,
    );
    maxOffset = Math.max(maxOffset, offset + bucket.sizes[i] / 2);
  }
  assert.ok(
    maxOffset < nebula.size * 1.6,
    `облако расползлось на ${maxOffset.toFixed(0)} св. лет при диаметре ${nebula.size}`,
  );
});

test('облако: дуга Петли Барнарда — кольцо, нити Вуали — вытянутые', () => {
  // Петля Барнарда в игре — дуга вокруг Пояса Ориона, поэтому клубы должны
  // стоять по окружности, а не заполнять диск.
  const arc = nebulaByName("Barnard's Loop");
  const arcBucket = emptyPuffBucket();
  buildNebulaPuffs(arc, project(arc), [], arcBucket);
  let ringPuffs = 0;
  let innerPuffs = 0;
  for (let i = 0; i < arcBucket.sizes.length; i++) {
    const r = Math.hypot(arcBucket.centers[i * 3], arcBucket.centers[i * 3 + 2]);
    if (r > arc.size * 0.3) ringPuffs++;
    else innerPuffs++;
  }
  assert.ok(ringPuffs > innerPuffs * 4, `дуга: в кольце ${ringPuffs}, внутри ${innerPuffs}`);

  // У Вуали и Карандаша клубы ложатся вдоль оси: разброс вдоль в разы больше.
  for (const name of ['Veil Nebula West', 'Pencil Nebula NGC 2736']) {
    const nebula = nebulaByName(name);
    assert.ok(nebula, `${name} нет в каталоге`);
    assert.equal(nebula.shape, 'filament', `${name}: ожидалась форма filament`);
    const bucket = emptyPuffBucket();
    buildNebulaPuffs(nebula, project(nebula), [], bucket);

    // Нить может лежать по диагонали, поэтому вытянутость считаем по
    // собственным числам ковариации, а не по разбросу вдоль осей экрана.
    const xs = [];
    const zs = [];
    for (let i = 0; i < bucket.sizes.length; i++) {
      xs.push(bucket.centers[i * 3]);
      zs.push(bucket.centers[i * 3 + 2]);
    }
    const meanX = xs.reduce((sum, v) => sum + v, 0) / xs.length;
    const meanZ = zs.reduce((sum, v) => sum + v, 0) / zs.length;
    let xx = 0;
    let zz = 0;
    let xz = 0;
    for (let i = 0; i < xs.length; i++) {
      xx += (xs[i] - meanX) ** 2;
      zz += (zs[i] - meanZ) ** 2;
      xz += (xs[i] - meanX) * (zs[i] - meanZ);
    }
    const trace = xx + zz;
    const det = xx * zz - xz * xz;
    const root = Math.sqrt(Math.max(0, (trace / 2) ** 2 - det));
    const long = trace / 2 + root;
    const short = Math.max(1e-6, trace / 2 - root);
    assert.ok(long / short > 2.5, `${name}: вытянутость ${(long / short).toFixed(2)}`);
  }
});

test('облако: малые туманности получают крупные клубы, а не «скопление точек»', () => {
  const planetary = nebulaByName('Helix Nebula');
  const emission = nebulaByName('Orion Nebula');
  const planetaryPuffs = puffCountFor(planetary);
  const emissionPuffs = puffCountFor(emission);

  assert.ok(planetaryPuffs < 40, `планетарная: клубов ${planetaryPuffs}`);
  assert.ok(emissionPuffs > 100, `эмиссионная: клубов ${emissionPuffs}`);

  // Средний размер клуба в долях диаметра облака — у планетарной он заметно больше.
  const fraction = (nebula) => {
    const bucket = emptyPuffBucket();
    buildNebulaPuffs(nebula, project(nebula), [], bucket);
    const total = bucket.sizes.reduce((sum, size) => sum + size, 0);
    return total / bucket.sizes.length / nebula.size;
  };
  assert.ok(
    fraction(planetary) > fraction(emission) * 1.5,
    `доля размера клуба: планетарная ${fraction(planetary).toFixed(2)}, эмиссионная ${fraction(emission).toFixed(2)}`,
  );
});

test('облако: яркость нормируется по фактическому пику', () => {
  // Аддитивный слой: множитель = цель / фактическая сумма.
  assert.ok(Math.abs(alphaScaleFor(2, true, 0.5) - 0.25) < 1e-9);
  // Тёмный слой гасит по формуле 1-(1-a)^n, отсюда логарифм.
  assert.ok(Math.abs(alphaScaleFor(2, false, 0.5) - (-Math.log(0.5) / 2)) < 1e-9);
  // Пустая сумма не должна давать бесконечность.
  assert.equal(alphaScaleFor(0, true, 0.5), 1);
  assert.ok(alphaScaleFor(0.001, true, 0.5) <= 1.4);
});

test('атлас клубов: четыре плитки, пик совпадает с константой', () => {
  const atlas = buildPuffAtlasData();
  assert.equal(atlas.size, 256);
  assert.equal(atlas.tileCount, 4);
  assert.equal(atlas.alpha.length, 256 * 256);

  let peak = 0;
  for (const value of atlas.alpha) {
    assert.ok(value >= 0 && value <= 1, `альфа атласа ${value}`);
    if (value > peak) peak = value;
  }
  assert.ok(
    Math.abs(peak - ATLAS_PEAK) < 1e-6,
    `пик атласа ${peak} против константы ${ATLAS_PEAK}: нормировка яркости разъедется`,
  );

  // Каждая плитка должна быть непустой: пустая плитка = пропавшие клубы.
  for (let tile = 0; tile < 4; tile++) {
    const ox = (tile % 2) * 128;
    const oy = Math.floor(tile / 2) * 128;
    let lit = 0;
    for (let y = 0; y < 128; y++) {
      for (let x = 0; x < 128; x++) {
        if (atlas.alpha[(y + oy) * 256 + (x + ox)] > 0.05) lit++;
      }
    }
    assert.ok(lit > 3000, `плитка ${tile}: светящихся пикселей ${lit}`);
  }
});

test('ведра: тёмные туманности отделяются от светящихся', () => {
  const { emissive, dark } = buildNebulaBuckets(
    GALAXY_NEBULAE,
    new Set(['emission', 'planetary', 'dark']),
    project,
  );
  assert.ok(emissive.sizes.length > 1000, `светящихся клубов ${emissive.sizes.length}`);
  assert.ok(dark.sizes.length > 300, `тёмных клубов ${dark.sizes.length}`);

  // Тёмные клубы рисуются обычным смешиванием и должны быть заметно плотнее
  // по альфе, иначе они просто не гасят звёзды за собой.
  const avg = (values) => values.reduce((sum, v) => sum + v, 0) / values.length;
  assert.ok(
    avg(dark.alphas) > avg(emissive.alphas),
    `средняя альфа: тёмные ${avg(dark.alphas).toFixed(3)}, светящиеся ${avg(emissive.alphas).toFixed(3)}`,
  );
});

test('игровой тон: цвет туманности приглушается, но не сереет', () => {
  // Насыщенная маджента каталога: у облака должен остаться оттенок, но
  // разброс каналов обязан заметно сократиться — иначе на карте получается неон.
  const source = [0.9, 0.05, 0.2];
  const toned = gameToneRgb(source, 'emission');
  const spread = (rgb) => Math.max(...rgb) - Math.min(...rgb);
  assert.ok(spread(toned) < spread(source) * 0.6, `разброс ${spread(toned).toFixed(3)}`);
  assert.ok(spread(toned) > 0.12, 'оттенок туманности совсем потерялся');
  // Цвет уходит в молочную дымку: самый яркий канал остаётся светлым.
  assert.ok(Math.max(...toned) > 0.5, `светлота упала до ${Math.max(...toned).toFixed(3)}`);

  // Функция должна быть чистой: один и тот же цвет — один и тот же результат.
  assert.deepEqual(gameToneRgb(source, 'emission'), toned);

  // Тёмные облака белым не разбавляем: иначе силуэт перестаёт быть тёмным.
  const dark = gameToneRgb([0.02, 0.01, 0.008], 'dark');
  assert.ok(Math.max(...dark) < 0.06, `тёмное облако посветлело до ${Math.max(...dark).toFixed(3)}`);
  assert.ok(mixWhite([0.5, 0.2, 0.2], 1)[2] > 0.9, 'mixWhite(…, 1) обязан давать прохладный белый');
});

test('структура облака: спутники клубов и предел числа инстансов', () => {
  const orion = nebulaByName('Orion Nebula');
  const bucket = emptyPuffBucket();
  buildNebulaPuffs(orion, { x: 0, y: 0, z: 0 }, [], bucket);

  const sizes = [...bucket.sizes].sort((a, b) => a - b);
  const median = sizes[Math.floor(sizes.length / 2)];
  // Часть клубов — мелкие спутники крупных: без них облако на близком плане
  // выглядит ватным комком, но и в россыпь точек превращаться не должно.
  assert.ok(
    sizes[0] < median * 0.6,
    `самый мелкий клуб ${sizes[0].toFixed(1)} против медианы ${median.toFixed(1)}: спутников нет`,
  );
  assert.ok(
    sizes[0] >= orion.size * 0.18 * DETAIL_SIZE * 0.5,
    `спутник слишком мелкий (${sizes[0].toFixed(1)} св. лет) — снова точки`,
  );

  // Вся сцена рисуется одним instanced-мешем: облаков много, но их суммарное
  // число должно оставаться в разумных для карты пределах.
  const project = (nebula) => ({ x: nebula.x, y: nebula.y, z: nebula.z });
  const { emissive, dark } = buildNebulaBuckets(
    GALAXY_NEBULAE,
    new Set(['emission', 'reflection', 'cluster', 'planetary', 'remnant', 'dark']),
    project,
  );
  const total = emissive.sizes.length + dark.sizes.length;
  assert.ok(total > 3000 && total < 30000, `всего клубов на карте ${total}`);
});

test('режим отрисовки газа: «дымка» включена по умолчанию', () => {
  // Аддитивный газ светится поверх звёзд и читается как свечение, а не как
  // облако. По умолчанию облако рисуется обычным смешиванием (EMISSIVE_ADDITIVE
  // = false), как на карте в игре; альтернативный режим остаётся только для
  // сравнения в превью.
  assert.equal(EMISSIVE_ADDITIVE, false);

  const orion = nebulaByName('Orion Nebula');
  const project = (nebula) => ({ x: nebula.x, y: nebula.y, z: nebula.z });
  const veil = buildNebulaBuckets([orion], new Set(['emission']), project, false);
  const glow = buildNebulaBuckets([orion], new Set(['emission']), project, true);
  const avg = (values) => values.reduce((sum, v) => sum + v, 0) / values.length;
  assert.ok(
    avg(veil.emissive.alphas) > avg(glow.emissive.alphas),
    'дымке нужны более плотные клубы, иначе облако исчезает вместе со звёздами',
  );
});
