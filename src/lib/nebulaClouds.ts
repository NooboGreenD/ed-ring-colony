/**
 * Геометрия облаков туманностей для 3D-карты галактики.
 *
 * Модуль намеренно без three/react: это чистая математика, из которой
 * собирается облако — сколько «клубов», где они лежат, какого размера и цвета.
 * Рендер (`components/GalaxyMap/NebulaField.tsx`) только упаковывает результат
 * в instanced-геометрию, а `scripts/preview-nebulae.mjs` умеет отрисовать то же
 * самое в картинку без браузера — так слой проверяется и тестом, и глазами.
 *
 * Идея внешнего вида: облако — не спрайт и не облако точек, а набор крупных
 * мягких клубов, которые перекрываются и вместе дают полупрозрачный газ.
 */

import type { GalaxyNebula, NebulaKind } from './galaxyNebulae';

/* ── Яркость и размеры: главные ручки внешнего вида ─────────────────────── */

export const EMISSIVE_OPACITY = 1;    // общий множитель света облаков (0…1)
/**
 * Как рисуется светящийся газ. `true` — аддитивно: облако только добавляет свет
 * и звёзды за ним просвечивают. `false` — «дымка»: облако само полупрозрачное
 * (обычное смешивание), звёзды за ним тускнеют, как в игре. Второй режим даёт
 * плотный объём вместо свечения, поэтому именно он используется на карте.
 */
export const EMISSIVE_ADDITIVE = false;
export const DARK_OPACITY = 1;         // общий множитель плотности тёмных облаков
/**
 * Размер клуба (доля диаметра облака) зависит от их числа: маленькая
 * планетарная туманность из полусотни мелких клубов выглядит как «скопление
 * точек», поэтому у компактных объектов клубы крупные и их немного.
 */
export const PUFF_SIZE_MIN = 0.18;
export const PUFF_SIZE_MAX = 0.58;
export const PUFF_SIZE_TARGET = 28;    // число клубов, при котором доля диаметра = 0.34
export const PUFF_SIZE_JITTER = 0.22;  // разброс размера клубов вокруг базового
/**
 * Мелкий спутник у части клубов. На близком плане облако из одних только
 * крупных «шариков» выглядит ватным; спутники добавляют волокнистую структуру,
 * но не превращаются в россыпь точек, потому что их вес мал и они привязаны
 * к родительскому клубу.
 */
export const DETAIL_CHANCE = 0.55;     // доля клубов со спутником
export const DETAIL_SIZE = 0.42;       // размер спутника от родительского клуба
export const DETAIL_WEIGHT = 0.3;      // вес спутника относительно родителя
/**
 * Крупномасштабная неоднородность: облако не должно быть ровным комком. Шум по
 * положению клуба делает светлые «сгустки» и тёмные «просветы», а часть клубов
 * в самых разреженных местах вообще убирается.
 */
export const STRUCTURE_SCALE = 0.02;   // обратная длина волны сгустков (1/св. год)
export const STRUCTURE_MIN = 0.35;     // во сколько раз слабеет клуб в просвете
export const STRUCTURE_SPAN = 1.35;    // насколько клуб сильнее в сгустке
export const STRUCTURE_HOLE = 0.22;    // ниже этого шума клуб не ставим вовсе
export const MAX_PUFFS = 340;          // базовых клубов на одну туманность (со спутниками — до ~1.6×)
export const PUFFS_PER_LY = 1 / 7;     // добавка клубов на световой год диаметра
export const HALO_MIN_SIZE = 160;      // с какого диаметра добавляется гало
export const HALO_ALPHA_SCALE = 0.18;  // гало намеренно тусклее обычных клубов
/**
 * Игровой тон: в Elite Dangerous облако на карте — молочная дымка, а не неон.
 * Каталожные цвета (насыщенная маджента, лайм, оранж) приглушаются по
 * насыщенности, слегка поднимаются по светлоте и подмешиваются к прохладному
 * белому — так у туманности остаётся свой оттенок, но она перестаёт «светиться».
 */
export const TONE_SATURATION = 0.55;   // множитель насыщенности каталожного цвета
export const TONE_LIGHT_LIFT = 0.22;   // подъём светлоты к белому: 0…1 от остатка
export const TONE_WHITE_MIX = 0.18;    // доля прохладного белого в цвете клуба
export const TONE_WHITE: [number, number, number] = [0.82, 0.84, 1.0]; // линейный прохладный белый
/** Подмешивание белого к куполу: у широкой дымки оттенок почти теряется. */
export const DOME_WHITE_MIX = 0.3;
export const ATLAS_TILE = 128;         // сторона плитки атласа 2×2, пиксели
export const ALPHA_MIN = 0.004;        // ниже этого клуб неотличим от фона
export const ALPHA_MAX = 0.9;          // выше — клуб превращается в плотное пятно
/**
 * Пик альфы в атласе клубов. Ниже единицы намеренно: у клуба не должно быть
 * плотного ядра, иначе в облаке видны отдельные круги, а не сплошной газ.
 * Значение использует и нормировка яркости, поэтому менять его безопасно.
 */
export const ATLAS_PEAK = 0.62;

/**
 * Целевая яркость ядра облака. Для светящихся туманностей это линейный свет в
 * самом ярком канале: 0.3…0.5 — облако отчётливо видно на звёздном фоне и оно
 * не выжигает карту в белое пятно. Для тёмных — плотность затемнения фона.
 */
export const TARGET_PEAK: Record<NebulaKind, number> = {
  emission: 0.26,
  reflection: 0.22,
  cluster: 0.21,
  planetary: 0.33,
  remnant: 0.20,
  dark: 0.42,
};

/**
 * Относительный вес клуба до нормировки: ядро ярче периферии.
 */
export const CORE_WEIGHT = 0.7;

/**
 * Число клубов по типу. У планетарных туманностей клубов мало и они крупные —
 * на карте такая туманность должна выглядеть одной мягкой точкой с ярким ядром,
 * а не россыпью мелких пятен.
 */
const PUFFS_BASE_BY_KIND: Record<NebulaKind, number> = {
  emission: 130,
  reflection: 84,
  cluster: 110,
  dark: 100,
  planetary: 18,
  remnant: 46,
};

/** Добавка клубов за световой год диаметра: крупные облака получают детали. */
const PUFFS_PER_LY_BY_KIND: Record<NebulaKind, number> = {
  emission: 1 / 6,
  reflection: 1 / 8,
  cluster: 1 / 7,
  dark: 1 / 8,
  planetary: 0,
  remnant: 1 / 8,
};

export type Vec3 = { x: number; y: number; z: number };

export type PuffBucket = {
  centers: number[];
  sizes: number[];
  colors: number[];
  alphas: number[];
  rotations: number[];
  tiles: number[];
};

export const emptyPuffBucket = (): PuffBucket => ({
  centers: [], sizes: [], colors: [], alphas: [], rotations: [], tiles: [],
});

/**
 * Множитель альфы, при котором центр облака даёт целевую яркость.
 *
 * Считать его заранее нельзя: сколько газа накопится в центре, зависит от
 * расположения клубов. Зато после раскладки это чистая арифметика, поэтому
 * множитель считается по факту — так маленькие и крупные туманности выглядят
 * одинаково «плотными», а не «одна яркая, другая еле видна».
 *
 * Свет: `свет = Σ αᵢ·texᵢ·colorᵢ` (аддитивное смешивание).
 * Тёмные: `1 - Π(1 - αᵢ·texᵢ) ≈ 1 - exp(-Σ αᵢ·texᵢ)` — отсюда логарифм.
 */
export function alphaScaleFor(sum: number, additive: boolean, target: number): number {
  if (!(sum > 0)) return 1;
  const scale = additive
    ? target / sum
    : -Math.log(Math.max(1e-4, 1 - target)) / sum;
  return Math.max(0, Math.min(1.4, scale));
}

/**
 * Число клубов. Растёт медленно: если считать клубы строго по площади, крупные
 * облака получаются плотнее мелких и «выжигают» карту, а мелкие — теряются.
 */
export function puffCountFor(nebula: GalaxyNebula): number {
  const base = PUFFS_BASE_BY_KIND[nebula.kind] ?? 60;
  const perLy = PUFFS_PER_LY_BY_KIND[nebula.kind] ?? PUFFS_PER_LY;
  const byArea = Math.round(nebula.size * perLy);
  return Math.min(MAX_PUFFS, Math.max(8, base + byArea));
}

/* ── Случайность ─────────────────────────────────────────────────────────── */

export function hashString(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Трилинейный value-noise: форма облака не должна быть симметричным эллипсом. */
export function makeValueNoise(seed: number) {
  const rng = mulberry32(seed);
  const size = 32;
  const grid = new Float32Array(size * size * size);
  for (let i = 0; i < grid.length; i++) grid[i] = rng();

  const fade = (t: number) => t * t * (3 - 2 * t);
  const at = (x: number, y: number, z: number) =>
    grid[((z & 31) * size + (y & 31)) * size + (x & 31)];

  return (x: number, y: number, z: number) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const zi = Math.floor(z);
    const tx = fade(x - xi);
    const ty = fade(y - yi);
    const tz = fade(z - zi);
    const c000 = at(xi, yi, zi);
    const c100 = at(xi + 1, yi, zi);
    const c010 = at(xi, yi + 1, zi);
    const c110 = at(xi + 1, yi + 1, zi);
    const c001 = at(xi, yi, zi + 1);
    const c101 = at(xi + 1, yi, zi + 1);
    const c011 = at(xi, yi + 1, zi + 1);
    const c111 = at(xi + 1, yi + 1, zi + 1);
    const x00 = c000 + (c100 - c000) * tx;
    const x10 = c010 + (c110 - c010) * tx;
    const x01 = c001 + (c101 - c001) * tx;
    const x11 = c011 + (c111 - c011) * tx;
    const y0 = x00 + (x10 - x00) * ty;
    const y1 = x01 + (x11 - x01) * ty;
    return y0 + (y1 - y0) * tz;
  };
}

/* ── HSL: цвет клуба должен слегка гулять вокруг базового ────────────────── */

/** sRGB-канал → линейный: three работает в линейном пространстве, цвета в каталоге заданы в sRGB. */
function srgbToLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
}

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace('#', '');
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value;
  const num = Number.parseInt(full, 16);
  return [
    srgbToLinear(((num >> 16) & 255) / 255),
    srgbToLinear(((num >> 8) & 255) / 255),
    srgbToLinear((num & 255) / 255),
  ];
}

/** Доля прохладного белого в цвете (линейное пространство). */
export function mixWhite(rgb: [number, number, number], amount: number): [number, number, number] {
  return [
    rgb[0] + (TONE_WHITE[0] - rgb[0]) * amount,
    rgb[1] + (TONE_WHITE[1] - rgb[1]) * amount,
    rgb[2] + (TONE_WHITE[2] - rgb[2]) * amount,
  ];
}

/** Линейный RGB → HSL (h в 0…1). Та же математика, что в shiftRgb. */
function rgbToHsl(rgb: [number, number, number]): [number, number, number] {
  const [r, g, b] = rgb;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d <= 0) return [0, 0, l];
  const sat = d / Math.max(1e-6, 1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = (((g - b) / d) % 6 + 6) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, sat, l];
}

function hslToRgb(h: number, sat: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * sat;
  const x = c * (1 - Math.abs(((h * 6) % 2) - 1));
  const m = l - c / 2;
  let out: [number, number, number];
  const sixth = h * 6;
  if (sixth < 1) out = [c, x, 0];
  else if (sixth < 2) out = [x, c, 0];
  else if (sixth < 3) out = [0, c, x];
  else if (sixth < 4) out = [0, x, c];
  else if (sixth < 5) out = [x, 0, c];
  else out = [c, 0, x];
  return [out[0] + m, out[1] + m, out[2] + m];
}

/**
 * Игровой цвет туманности: гасит насыщенность каталога и подмешивает белый.
 * Тёмные облака возвращаются как есть — см. комментарий внутри.
 */
export function gameToneRgb(rgb: [number, number, number], kind: NebulaKind): [number, number, number] {
  // Тёмные облака рисуются обычным смешиванием поверх звёзд: любое осветление
  // цвета превращает силуэт в серый туман, поэтому тон к ним не применяется.
  if (kind === 'dark') return rgb;

  const [h, sat, l] = rgbToHsl(rgb);
  const toned = hslToRgb(h, sat * TONE_SATURATION, l + (1 - l) * TONE_LIGHT_LIFT);
  return mixWhite(toned, TONE_WHITE_MIX);
}

export function shiftRgb(rgb: [number, number, number], hueShift: number, satShift: number, lightShift: number): [number, number, number] {
  const [h, sat, l] = rgbToHsl(rgb);
  const hh = (h + hueShift + 1) % 1;
  const ss = Math.max(0, Math.min(1, sat + satShift));
  const ll = Math.max(0, Math.min(1, l + lightShift));
  return hslToRgb(hh, ss, ll);
}

/* ── Атлас клубов: четыре варианта мягкого сгустка 2×2 ───────────────────── */

/**
 * Плитки атласа в виде массива альфы (0…1). Рендер превращает это в текстуру,
 * превью — в картинку, поэтому функция без DOM.
 */
export function buildPuffAtlasData(): { size: number; tileCount: number; alpha: Float32Array } {
  const tile = ATLAS_TILE;
  const size = tile * 2;
  const alpha = new Float32Array(size * size);
  const noise = makeValueNoise(1337);

  for (let variant = 0; variant < 4; variant++) {
    const ox = (variant % 2) * tile;
    const oy = Math.floor(variant / 2) * tile;
    // Низкая частота и всего три октавы: клуб должен быть мягким сгустком, а не
    // «ватным шариком» с крапом — крап на карте читается как скопление точек.
    const freq = 1.7 + variant * 0.55;
    for (let y = 0; y < tile; y++) {
      for (let x = 0; x < tile; x++) {
        const u = (x + 0.5) / tile - 0.5;
        const v = (y + 0.5) / tile - 0.5;
        const r = Math.min(1, Math.hypot(u, v) * 2);
        const base = Math.pow(Math.max(0, 1 - r), 2.1);
        let fbm = 0;
        let amp = 0.55;
        let f = freq;
        for (let octave = 0; octave < 3; octave++) {
          fbm += noise(u * f + variant * 7.3, v * f - variant * 3.1, variant * 5.7) * amp;
          amp *= 0.45;
          f *= 2.1;
        }
        const value = Math.max(0, Math.min(1, base * (0.7 + 0.5 * fbm)));
        alpha[(y + oy) * size + (x + ox)] = value;
      }
    }
  }
  // Нормируем атлас на общий пик: нормировка яркости облака рассчитывает
  // текстуру как ATLAS_PEAK и обязана оставаться верной при правках формы.
  let peak = 0;
  for (const value of alpha) if (value > peak) peak = value;
  if (peak > 0) {
    const gain = ATLAS_PEAK / peak;
    for (let i = 0; i < alpha.length; i++) alpha[i] *= gain;
  }

  return { size, tileCount: 4, alpha };
}

/* ── Сборка облака ───────────────────────────────────────────────────────── */

/**
 * Раскладывает клубы одной туманности в буфер.
 *
 * shape задаёт силуэт: cloud — обычное облако, arc — разомкнутое кольцо (Петля
 * Барнарда), filament — нити (Вуаль, Карандаш), elongated — вытянутое облако,
 * silhouette — плотный силуэт с резким краем (Конская голова).
 */
export function buildNebulaPuffs(
  nebula: GalaxyNebula,
  center: Vec3,
  extraCenters: Vec3[],
  bucket: PuffBucket,
  emissiveAdditive: boolean = EMISSIVE_ADDITIVE,
): void {
  const rng = mulberry32(hashString(nebula.name));
  const noise = makeValueNoise(hashString(`${nebula.name}:shape`));
  const structure = makeValueNoise(hashString(`${nebula.name}:structure`));
  const baseRgb = gameToneRgb(hexToRgb(nebula.color), nebula.kind);
  const radius = nebula.size / 2;
  const isDark = nebula.kind === 'dark';
  const count = puffCountFor(nebula);
  const shape = nebula.shape ?? 'cloud';
  const anchors = [center, ...extraCenters];
  // У каждого лепестка (Сердце и Душа) — своя плотность клубов: иначе составная
  // туманность получается вдвое бледнее одиночной.
  const perAnchor = count;

  // Ось вытянутых облаков: по второму лепестку (Сердце и Душа), иначе по имени.
  const lobe = extraCenters.length
    ? { x: extraCenters[0].x - center.x, y: 0, z: extraCenters[0].z - center.z }
    : null;
  const lobeLength = lobe ? Math.hypot(lobe.x, lobe.z) : 0;
  const axis = lobe && lobeLength > 1
    ? { x: lobe.x / lobeLength, z: lobe.z / lobeLength }
    : (() => {
        const angle = rng() * Math.PI * 2;
        return { x: Math.cos(angle), z: Math.sin(angle) };
      })();
  const side = { x: -axis.z, z: axis.x };
  const arcStart = rng() * Math.PI * 2;

  // Доля диаметра облака, которую занимает один клуб. Чем больше клубов, тем
  // мельче каждый — иначе облако превращается в стопку круглых пятен.
  const puffFraction = Math.max(
    PUFF_SIZE_MIN,
    Math.min(PUFF_SIZE_MAX, 0.55 * Math.sqrt(PUFF_SIZE_TARGET / count)),
  );

  // Клубы этой туманности собираем отдельно: альфа считается после раскладки,
  // когда известно, сколько газа реально накрывает центр облака.
  const pending: Array<{ x: number; y: number; z: number; size: number; rgb: [number, number, number]; weight: number }> = [];

  const emit = (x: number, y: number, z: number, core: number, sizeScale = 1, weightScale = 1) => {
    const rgb = shiftRgb(
      baseRgb,
      (rng() - 0.5) * 0.03,
      (rng() - 0.5) * 0.1,
      (rng() - 0.5) * 0.08 + core * 0.08,
    );
    pending.push({
      x, y, z,
      size: nebula.size * puffFraction * sizeScale
        * (1 - PUFF_SIZE_JITTER / 2 + rng() * PUFF_SIZE_JITTER),
      rgb,
      weight: (0.55 + rng() * 0.75) * (0.6 + core * CORE_WEIGHT * 1.07) * weightScale,
    });
    // Поворот и плитка атласа не зависят от альфы — берём их сразу.
    bucket.rotations.push(rng() * Math.PI * 2);
    bucket.tiles.push(Math.floor(rng() * 4));
  };

  /** Позиция клуба относительно центра; null — здесь дыра в облаке. */
  const place = (): { x: number; y: number; z: number; core: number } | null => {
    if (shape === 'arc') {
      const angle = arcStart + rng() * Math.PI * 1.72; // кольцо с разрывом
      const ringR = radius * (0.82 + rng() * 0.36);
      return {
        x: Math.cos(angle) * ringR,
        y: (rng() - 0.5) * radius * 0.25,
        z: Math.sin(angle) * ringR,
        core: 0.35,
      };
    }

    if (shape === 'filament') {
      const along = (rng() - 0.5) * 2 * radius;
      const across = (rng() - 0.5) * radius * 0.36;
      return {
        x: axis.x * along + side.x * across,
        y: (rng() - 0.5) * radius * 0.16,
        z: axis.z * along + side.z * across,
        core: 0.4,
      };
    }

    // Плотное ядро, рыхлая периферия; у силуэтов край резче.
    const t = Math.pow(rng(), shape === 'silhouette' ? 0.75 : 0.55);
    const r = t * radius;
    const angle = rng() * Math.PI * 2;
    const stretch = shape === 'elongated' ? 1.9 : 1;
    const x = Math.cos(angle) * r * stretch;
    const y = (rng() - 0.5) * radius * (nebula.kind === 'planetary' ? 0.34 : 0.62);
    const z = Math.sin(angle) * r;

    const sample = noise(x * 0.012, y * 0.012, z * 0.012);
    const core = Math.max(0, 1 - t);
    if (shape !== 'silhouette' && rng() > sample * 0.8 + core * 0.55 + 0.18) return null;

    return { x, y, z, core };
  };

  for (const anchor of anchors) {
    for (let i = 0; i < perAnchor; i++) {
      const placed = place();
      if (!placed) continue;
      // Сгустки и просветы по всей туманности: без этого облако — ровный комок.
      const grain = structure(
        (anchor.x + placed.x) * STRUCTURE_SCALE,
        (anchor.y + placed.y) * STRUCTURE_SCALE,
        (anchor.z + placed.z) * STRUCTURE_SCALE,
      );
      if (grain < STRUCTURE_HOLE) continue;
      const weightScale = STRUCTURE_MIN + STRUCTURE_SPAN * Math.min(1, grain);
      emit(
        anchor.x + placed.x, anchor.y + placed.y, anchor.z + placed.z,
        placed.core, 1, weightScale,
      );
      // Спутник рядом с родителем: та же логика раскладки, но мельче и тише.
      if (rng() < DETAIL_CHANCE) {
        const spread = nebula.size * puffFraction * 0.35;
        emit(
          anchor.x + placed.x + (rng() - 0.5) * spread,
          anchor.y + placed.y + (rng() - 0.5) * spread * 0.6,
          anchor.z + placed.z + (rng() - 0.5) * spread,
          placed.core,
          DETAIL_SIZE,
          DETAIL_WEIGHT * weightScale,
        );
      }
    }

    // Разреженное гало: крупные туманности видно и на дальнем плане карты.
    if (nebula.size >= HALO_MIN_SIZE && !isDark) {
      for (let i = 0; i < 7; i++) {
        const angle = rng() * Math.PI * 2;
        const r = radius * (1.05 + rng() * 0.5);
        emit(
          anchor.x + Math.cos(angle) * r,
          anchor.y + (rng() - 0.5) * radius * 0.4,
          anchor.z + Math.sin(angle) * r,
          0,
        );
        // Гало намеренно тусклее обычных клубов и шире — иначе облако «светит»
        // слишком широко и размывает границу туманности на карте.
        const last = pending.length - 1;
        pending[last].weight *= HALO_ALPHA_SCALE;
        pending[last].size *= 1.6;
      }
    }
  }

  // Купол: широкий тусклый клуб на всё облако. Без него между деталями видны
  // промежутки и туманность выглядит набором отдельных пятен.
  pending.push({
    x: center.x,
    y: center.y,
    z: center.z,
    size: nebula.size * 1.15,
    rgb: isDark ? baseRgb : mixWhite(baseRgb, DOME_WHITE_MIX),
    weight: 0.22,
  });
  bucket.rotations.push(0);
  bucket.tiles.push(0);

  flushNebula(nebula, pending, bucket, emissiveAdditive);
}

/**
 * Записывает клубы в буфер, подобрав альфу так, чтобы пик облака дал целевую
 * яркость: у маленькой планетарной туманности и у огромной Петли Барнарда газ
 * должен читаться одинаково плотным.
 *
 * Пик ищется по центрам клубов: сколько света накопится в середине каждого из
 * них, зависит от соседей, а не только от самого клуба. Считать это заранее
 * формулой нельзя — облако раскладывается случайно, поэтому и считаем по факту.
 */
function flushNebula(
  nebula: GalaxyNebula,
  pending: Array<{ x: number; y: number; z: number; size: number; rgb: [number, number, number]; weight: number }>,
  bucket: PuffBucket,
  emissiveAdditive: boolean,
): void {
  const isDark = nebula.kind === 'dark';
  const target = TARGET_PEAK[nebula.kind] ?? 0.4;

  let peak = 0;
  for (let i = 0; i < pending.length; i++) {
    const anchor = pending[i];
    let sum = 0;
    for (let j = 0; j < pending.length; j++) {
      const puff = pending[j];
      const radius = puff.size / 2;
      const distance = Math.hypot(anchor.x - puff.x, anchor.y - puff.y, anchor.z - puff.z);
      if (distance >= radius) continue;
      // Пик текстуры клуба и его вклад в самый яркий канал цвета.
      const tex = ATLAS_PEAK * Math.pow(1 - distance / radius, 2.1);
      const color = isDark ? 1 : Math.max(puff.rgb[0], puff.rgb[1], puff.rgb[2]);
      sum += puff.weight * tex * Math.max(0.05, color);
    }
    if (sum > peak) peak = sum;
  }

  const additive = isDark ? false : emissiveAdditive;
  const scale = alphaScaleFor(Math.max(1e-6, peak), additive, target);
  const opacity = isDark ? DARK_OPACITY : EMISSIVE_OPACITY;

  for (const puff of pending) {
    bucket.centers.push(puff.x, puff.y, puff.z);
    bucket.sizes.push(puff.size);
    bucket.colors.push(puff.rgb[0], puff.rgb[1], puff.rgb[2]);
    bucket.alphas.push(
      Math.max(ALPHA_MIN, Math.min(ALPHA_MAX, puff.weight * scale * opacity)),
    );
  }
}

/** Собирает оба ведра (светящиеся и тёмные) для списка туманностей. */
export function buildNebulaBuckets(
  nebulae: GalaxyNebula[],
  allowedKinds: Set<string>,
  project: (nebula: GalaxyNebula) => Vec3,
  emissiveAdditive: boolean = EMISSIVE_ADDITIVE,
): { emissive: PuffBucket; dark: PuffBucket } {
  const emissive = emptyPuffBucket();
  const dark = emptyPuffBucket();

  for (const nebula of nebulae) {
    if (!allowedKinds.has(nebula.kind)) continue;
    const center = project(nebula);
    const extra = (nebula.lobes ?? []).map((lobe) => project({ ...nebula, x: lobe.x, y: lobe.y, z: lobe.z }));
    buildNebulaPuffs(
      nebula,
      center,
      extra,
      nebula.kind === 'dark' ? dark : emissive,
      emissiveAdditive,
    );
  }

  return { emissive, dark };
}
