#!/usr/bin/env node
/**
 * Превью слоя туманностей без браузера.
 *
 * Считает те же клубы, что и `NebulaField.tsx` (общий модуль
 * `src/lib/nebulaClouds.ts`), и рисует их в PNG тем же способом, что и шейдер:
 * экранные билборды, атлас 2×2, аддитивное накопление для светящихся облаков и
 * затемнение фона для тёмных. Нужно, чтобы проверять вид слоя (яркость,
 * силуэты, масштаб) там, где нет WebGL, и чтобы подбирать константы.
 *
 * Композитинг повторяет сцену карты:
 *   1. звёзды каталожного облака;  2. тёмные туманности гасят фон;
 *   3. светящиеся туманности добавляют свет.
 *
 * Запуск:
 *   node scripts/preview-nebulae.mjs                 # .cache/nebula-preview/*.png
 *   node scripts/preview-nebulae.mjs --width 1600    # крупнее
 *   node scripts/preview-nebulae.mjs --only "Orion Nebula"
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { GALAXY_NEBULAE } from '../src/lib/galaxyNebulae.ts';
import {
  DARK_OPACITY,
  EMISSIVE_ADDITIVE,
  EMISSIVE_OPACITY,
  SCREEN_FADE_CURVE,
  SCREEN_FADE_FLOOR,
  SCREEN_MIN_PIXELS,
  TARGET_PEAK,
  buildNebulaBuckets,
  buildPuffAtlasData,
} from '../src/lib/nebulaClouds.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, '.cache/nebula-preview');

// Должно совпадать с eliteToThreeCentered из @/lib/ed3dCanon: three.z = SAGA.z - elite.z.
const SAGA = { x: 25.21875, y: -20.90625, z: 25899.96875 };
const project = (nebula) => ({
  x: nebula.x - SAGA.x,
  y: nebula.y - SAGA.y,
  z: SAGA.z - nebula.z,
});

const args = process.argv.slice(2);
/** Светящийся газ: «дымка» (как на карте) или аддитивное свечение — для сравнения. */
const additiveGas = args.includes('--additive') ? true : EMISSIVE_ADDITIVE;
const argOf = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? Number(args[index + 1]) : fallback;
};
const WIDTH = Math.max(320, Math.round(argOf('--width', 1200)));

/* ── PNG ─────────────────────────────────────────────────────────────────── */

function crc32(buffer) {
  let crc = ~0;
  for (let i = 0; i < buffer.length; i++) {
    crc ^= buffer[i];
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function writePng(file, width, height, rgb) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 3 + 1);
    raw[rowStart] = 0; // фильтр «none»
    for (let x = 0; x < width * 3; x++) {
      raw[rowStart + 1 + x] = Math.max(0, Math.min(255, Math.round(rgb[y * width * 3 + x] * 255)));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // бит на канал
  ihdr[9] = 2;   // truecolor
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]));
}

/** Линейная яркость → sRGB: рендерер отдаёт кадр так же (SRGBColorSpace). */
const toSrgb = (value) =>
  value <= 0.0031308 ? 12.92 * value : 1.055 * Math.pow(Math.max(0, value), 1 / 2.4) - 0.055;

/* ── Рендер ──────────────────────────────────────────────────────────────── */

const ATLAS = buildPuffAtlasData();

/**
 * Считает запузыренные слои один раз: они не зависят от ракурса,
 * а разных ракурсов в прогоне несколько — так превью остаётся быстрым.
 */
let bucketCache = null;
function getBuckets(nebulae) {
  const key = `${additiveGas ? 'add' : 'veil'}:`
    + (nebulae.length === GALAXY_NEBULAE.length ? 'all' : nebulae.map((n) => n.name).join('|'));
  if (!bucketCache || bucketCache.key !== key) {
    bucketCache = {
      key,
      value: buildNebulaBuckets(
        nebulae,
        new Set(['emission', 'reflection', 'cluster', 'planetary', 'remnant', 'dark']),
        project,
        additiveGas,
      ),
    };
  }
  return bucketCache.value;
}

function drawBucket(target, mask, bucket, opacity, centerX, centerZ, scale, width, height, mode) {
  const puffs = bucket.sizes.length;
  for (let i = 0; i < puffs; i++) {
    const cx = (bucket.centers[i * 3] - centerX) * scale + width / 2;
    const cz = (bucket.centers[i * 3 + 2] - centerZ) * scale + height / 2;
    const radius = (bucket.sizes[i] / 2) * scale;
    // Те же константы, что в шейдре карты: облако не пропадает при отдалении —
    // держим минимальный экранный радиус и приглушаем «далёкие» клубы.
    const MIN_PIXELS = SCREEN_MIN_PIXELS;
    const DISTANT_FADE_CURVE = SCREEN_FADE_CURVE;
    const DISTANT_FADE_FLOOR = SCREEN_FADE_FLOOR;
    let puffScale = 1;
    let distant = 1;
    // pixels — диаметр клуба в пикселях, как `iSize * uPixelScale / depth` в шейдере.
    const pixels = radius * 2;
    if (pixels < MIN_PIXELS) {
      puffScale = MIN_PIXELS / Math.max(pixels, 0.0001);
      distant = Math.max(
        DISTANT_FADE_FLOOR,
        Math.min(1, Math.pow(Math.max(0, pixels) / MIN_PIXELS, DISTANT_FADE_CURVE)),
      );
    }
    const drawRadius = radius * puffScale;
    if (drawRadius < 0.6) continue;
    const x0 = Math.max(0, Math.floor(cx - drawRadius));
    const x1 = Math.min(width - 1, Math.ceil(cx + drawRadius));
    const y0 = Math.max(0, Math.floor(cz - drawRadius));
    const y1 = Math.min(height - 1, Math.ceil(cz + drawRadius));
    if (x1 < x0 || y1 < y0) continue;

    const alpha = bucket.alphas[i] * opacity * distant;
    const tile = bucket.tiles[i];
    const tileX = (tile % 2) * (ATLAS.size / 2);
    const tileY = Math.floor(tile / 2) * (ATLAS.size / 2);
    const rot = bucket.rotations[i];
    const cos = Math.cos(-rot);
    const sin = Math.sin(-rot);
    const r = bucket.colors[i * 3];
    const g = bucket.colors[i * 3 + 1];
    const b = bucket.colors[i * 3 + 2];
    const half = drawRadius * 2;

    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        // uv внутри клуба (0…1) с поворотом — как в шейдере.
        const lx = (px - cx) / half + 0.5;
        const ly = (py - cz) / half + 0.5;
        const rx = (lx - 0.5) * cos - (ly - 0.5) * sin + 0.5;
        const ry = (lx - 0.5) * sin + (ly - 0.5) * cos + 0.5;
        if (rx < 0 || rx > 1 || ry < 0 || ry > 1) continue;
        // Границы именно своей плитки: обрезка по краю атласа уводила выборку
        // в пустую полосу и «съедала» три четверти клубов.
        const tx = Math.min(tileX + ATLAS.size / 2 - 1, Math.floor(tileX + rx * (ATLAS.size / 2)));
        const ty = Math.min(tileY + ATLAS.size / 2 - 1, Math.floor(tileY + ry * (ATLAS.size / 2)));
        const tex = ATLAS.alpha[ty * ATLAS.size + tx];
        const a = alpha * tex;
        if (a < 0.0025) continue;

        const pixel = py * width + px;
        // Буфер газа — RGBA: premultiplied свет + плотность, поэтому шаг 4.
        const index = pixel * 4;
        if (mode === 'add') {
          target[index] += r * a;
          target[index + 1] += g * a;
          target[index + 2] += b * a;
        } else if (mode === 'veil') {
          // «Дымка»: облако непрозрачно для звёзд ровно настолько, насколько
          // плотное; накапливаем premultiplied-цвет и суммарную плотность.
          const k = target[index + 3];
          const over = a * (1 - k);
          target[index] += r * over;
          target[index + 1] += g * over;
          target[index + 2] += b * over;
          target[index + 3] = k + over;
        } else {
          // mask — плотность затемнения, одна компонента на пиксель.
          mask[pixel] = 1 - (1 - mask[pixel]) * (1 - a);
        }
      }
    }
  }
}

function render({
  centerX, centerZ, span, title, nebulae = GALAXY_NEBULAE,
  drawStars = true, quiet = false, writeFile = true,
}) {
  const height = Math.round(WIDTH * 0.62);
  const scale = WIDTH / span; // пикселей на световой год
  const pixels = WIDTH * height;

  // Слой газа: у «дымки» — premultiplied свет в RGB и плотность в альфе;
  // при аддитивном режиме альфа не используется.
  const gas = new Float32Array(pixels * 4);
  const darkMask = new Float32Array(pixels);
  const { emissive, dark } = getBuckets(nebulae);
  drawBucket(gas, darkMask, dark, DARK_OPACITY, centerX, centerZ, scale, WIDTH, height, 'dark');
  drawBucket(
    gas, darkMask, emissive, EMISSIVE_OPACITY,
    centerX, centerZ, scale, WIDTH, height,
    additiveGas ? 'add' : 'veil',
  );

  // Звёзды каталожного облака — фон, по которому видно работу тёмных туманностей.
  const rgb = new Float32Array(pixels * 3);
  if (drawStars) {
    let seed = 20260101;
    const rnd = () => {
      seed = (seed + 0x6d2b79f5) >>> 0;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let i = 0; i < 26000; i++) {
      const angle = rnd() * Math.PI * 2;
      const r = Math.pow(rnd(), 0.62) * 52000;
      const px = Math.round((Math.cos(angle) * r - centerX) * scale + WIDTH / 2);
      const py = Math.round((Math.sin(angle) * r - centerZ) * scale + height / 2);
      if (px < 0 || px >= WIDTH || py < 0 || py >= height) continue;
      const brightness = 0.35 + rnd() * 0.65;
      const index = (py * WIDTH + px) * 3;
      rgb[index] += brightness * 0.85;
      rgb[index + 1] += brightness * 0.88;
      rgb[index + 2] += brightness;
    }
  }

  // Композит: сначала тёмные гасят фон, затем светящиеся добавляют свет.
  const encoded = new Float32Array(pixels * 3);
  let gasPeak = 0;
  let darkPeak = 0;
  for (let i = 0; i < pixels; i++) {
    const dim = 1 - darkMask[i];
    if (darkMask[i] > darkPeak) darkPeak = darkMask[i];
    // «Дымка» закрывает звёзды пропорционально своей плотности.
    const cover = additiveGas ? 0 : gas[i * 4 + 3];
    for (let c = 0; c < 3; c++) {
      const light = gas[i * 4 + c];
      const value = rgb[i * 3 + c] * dim * (1 - cover) + light;
      if (light > gasPeak) gasPeak = light;
      encoded[i * 3 + c] = toSrgb(value);
    }
  }

  if (writeFile) {
    const file = path.join(OUT_DIR, `${title}.png`);
    writePng(file, WIDTH, height, encoded);
  }

  if (!quiet) {
    console.log(
      `  свет газа: пик ${toSrgb(gasPeak).toFixed(3)} sRGB (${gasPeak.toFixed(3)} линейно)`
      + `, плотность тёмных ${darkPeak.toFixed(3)}`,
    );
    if (writeFile) {
      console.log(`${title}: ${WIDTH}×${height}, охват ${span} св. лет → ${path.relative(ROOT, OUT_DIR)}/${title}.png`);
    }
  }

  return { gasPeak, darkPeak, pixels: { rgb: encoded, width: WIDTH, height } };
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const wantSheet = args.includes('--sheet');

/** Сводный лист 2×2: удобно отправить одним файлом на просмотр. */
function writeSheet(tiles, title) {
  const gap = 4;
  const tileW = tiles[0].width;
  const tileH = tiles[0].height;
  const width = tileW * 2 + gap;
  const height = tileH * 2 + gap;
  const sheet = new Float32Array(width * height * 3);
  tiles.forEach((tile, index) => {
    const ox = (index % 2) * (tileW + gap);
    const oy = Math.floor(index / 2) * (tileH + gap);
    for (let y = 0; y < tileH; y++) {
      for (let x = 0; x < tileW; x++) {
        for (let c = 0; c < 3; c++) {
          sheet[((y + oy) * width + x + ox) * 3 + c] = tile.rgb[(y * tileW + x) * 3 + c];
        }
      }
    }
  });
  const file = path.join(OUT_DIR, `${title}.png`);
  writePng(file, width, height, sheet);
  console.log(`сводный лист: ${path.relative(ROOT, file)} (${width}×${height})`);
}

/* ── Обзорные виды ───────────────────────────────────────────────────────── */

if (!only) {
  const views = [
    { title: 'galaxy', centerX: 0, centerZ: 0, span: 100000 },
    // Охват дефолтной камеры карты: высота 2*35000*tan(22.5°) ≈ 29000 св. лет.
    { title: 'map', centerX: 0, centerZ: 0, span: 29000 },
    { title: 'bubble', centerX: project({ x: 0, y: 0, z: 0 }).x, centerZ: project({ x: 0, y: 0, z: 0 }).z, span: 6000 },
    // Центр кадра — сама туманность: Sol в системе координат карты смещён
    // относительно Sgr A*, и промах «на глаз» уводит кадр мимо объекта.
    { title: 'orion', nebula: 'Orion Nebula', span: 3000 },
    { title: 'heart-soul', nebula: 'Heart and Soul Nebulae', span: 4000 },
    { title: 'barnards-loop', nebula: "Barnard's Loop", span: 2600 },
    { title: 'coalsack', nebula: 'Coalsack Nebula', span: 1500 },
  ];

  const rendered = [];
  for (const view of views) {
    if (view.nebula) {
      const nebula = GALAXY_NEBULAE.find((item) => item.name === view.nebula);
      const center = project(nebula);
      view.centerX = center.x;
      view.centerZ = center.z;
    }
    const result = render(view);
    rendered.push({ title: view.title, rgb: result.pixels.rgb, width: result.pixels.width, height: result.pixels.height });
  }

  if (wantSheet) {
    // Первые четыре вида: вся Галактика, окрестности Sol, Орион и Сердце с Душой.
    writeSheet(rendered.slice(0, 4).map((item) => ({ rgb: item.rgb, width: item.width, height: item.height })), 'sheet');
  }
}

/* ── Диагностика по каждому объекту ──────────────────────────────────────── */

const list = only
  ? GALAXY_NEBULAE.filter((nebula) => nebula.name === only)
  : GALAXY_NEBULAE.filter((n) => n.major || n.kind === 'dark');

console.log(only
  ? `\nЯркость «${only}»:`
  : '\nПиковая яркость облаков: факт против цели для своего типа (линейная):');
for (const nebula of list) {
  const center = project(nebula);
  const span = Math.max(300, nebula.size * 3.2);
  const stats = render({
    centerX: center.x, centerZ: center.z, span,
    title: only ? `single-${nebula.name.replace(/[^A-Za-z0-9]+/g, '-')}` : 'single',
    nebulae: [nebula], drawStars: false, quiet: true, writeFile: Boolean(only),
  });
  const value = nebula.kind === 'dark' ? stats.darkPeak : stats.gasPeak;
  // Цель у каждого типа своя (TARGET_PEAK): яркая эмиссионная туманность и
  // слабое отражение не могут сравниваться по одному порогу.
  const target = TARGET_PEAK[nebula.kind] ?? 0.3;
  const flag = value < target * 0.92 ? '!' : ' ';
  console.log(
    ` ${flag} ${nebula.name.padEnd(30)} ${value.toFixed(3)} / цель ${target.toFixed(2)}`
    + `  (${nebula.kind}, ${nebula.size} св. лет)`,
  );
}
if (only) {
  const nebula = list[0];
  const center = project(nebula);
  console.log(`  картинка: ${path.relative(ROOT, OUT_DIR)}/single-${nebula.name.replace(/[^A-Za-z0-9]+/g, '-')}.png`);
}
