import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';

import {
  POINTS_BYTES_PER_POINT,
  POINTS_HEADER_SIZE,
  POINTS_MAX_DEFAULT,
  PointsBuilder,
  galaxyPointsMax,
  id64FromParts,
  parsePointsFile,
  pointSampleStride,
} from '../../src/lib/galaxySystems.ts';
import { runGalaxyImport } from '../../src/lib/galaxyImport.ts';

/* ──────────────────────────────────────────────────────────────────────────
   Каталог — это вся галактика: Spansh `systems.json.gz` (5.9 GiB) содержит
   ~2×10⁸ систем (EDAstro: 203 642 699). Облако точек «по одной на систему»
   заняло бы гигабайты в оперативке веб-процесса и не влезло бы в 50-МБ бакет,
   поэтому оно строится равномерной выборкой. Проверки ниже фиксируют
   контракт выборки: ограниченная память, равномерность, честная статистика.
   ────────────────────────────────────────────────────────────────────────── */

const point = (n) => ({ x: n, y: -n, z: n * 0.5, id64: String(1000 + n), starType: 'g' });

// ─────────────────────── параметры выборки ───────────────────────

test('шаг выборки: 1, пока каталог помещается в лимит', () => {
  assert.equal(pointSampleStride(1_200_000, POINTS_MAX_DEFAULT), 1);
  assert.equal(pointSampleStride(0, POINTS_MAX_DEFAULT), 1);
  assert.equal(pointSampleStride(203_642_699, 0), 1, 'лимит 0 = выборка выключена');
});

test('шаг выборки для всей галактики', () => {
  const stride = pointSampleStride(203_642_699, POINTS_MAX_DEFAULT);
  assert.equal(stride, Math.ceil(203_642_699 / POINTS_MAX_DEFAULT));
  assert.ok(stride > 150 && stride < 200, `шаг ${stride}`);
  assert.ok(203_642_699 / stride <= POINTS_MAX_DEFAULT, 'точек не больше лимита');
});

test('лимит облака по умолчанию влезает в бакет 50 МБ', () => {
  const bytes = POINTS_HEADER_SIZE + POINTS_MAX_DEFAULT * POINTS_BYTES_PER_POINT;
  assert.ok(bytes < 50 * 1024 * 1024, `${bytes} байт`);
  assert.ok(bytes > 30 * 1024 * 1024, 'и при этом облако не вырождается');
});

test('GALAXY_POINTS_MAX переопределяет лимит, мусор отбрасывается', () => {
  assert.equal(galaxyPointsMax({}), POINTS_MAX_DEFAULT);
  assert.equal(galaxyPointsMax({ GALAXY_POINTS_MAX: '500' }), 500);
  assert.equal(galaxyPointsMax({ GALAXY_POINTS_MAX: '0' }), 0, '0 = одна точка на систему');
  assert.equal(galaxyPointsMax({ GALAXY_POINTS_MAX: 'много' }), POINTS_MAX_DEFAULT);
});

// ─────────────────────── PointsBuilder ───────────────────────

test('без лимита поведение прежнее: точка на каждую систему', () => {
  const builder = new PointsBuilder(64);
  for (let i = 0; i < 1000; i++) builder.add(point(i));

  assert.equal(builder.size, 1000);
  assert.equal(builder.sampleStride, 1);
  assert.equal(builder.sampled, false);
  assert.equal(parsePointsFile(builder.build()).count, 1000);
});

test('с лимитом память ограничена, а выборка равномерна', () => {
  const max = 1000;
  const total = 200_000;
  const builder = new PointsBuilder(1_000_000, max);
  for (let i = 0; i < total; i++) builder.add(point(i));

  assert.ok(builder.size <= max, `точек ${builder.size} при лимите ${max}`);
  assert.ok(builder.size >= max / 2, 'выборка не вырождается в несколько точек');
  assert.equal(builder.sampleStride & (builder.sampleStride - 1), 0, 'шаг — степень двойки');
  assert.ok(builder.sampleStride >= total / max / 2, `шаг ${builder.sampleStride}`);

  // Равномерность: последняя система всегда в облаке, а не только начало дампа.
  const parsed = parsePointsFile(builder.build());
  assert.equal(parsed.count, builder.size);
  const lastIndex = (parsed.count - 1) * 3;
  assert.equal(parsed.positions[lastIndex], total - 1, 'последняя система на месте');
  assert.equal(id64FromParts(parsed.id64Hi[parsed.count - 1], parsed.id64Lo[parsed.count - 1]), String(1000 + total - 1));
  // И середина диапазона тоже представлена, а не только первые N.
  const xs = Array.from(parsed.positions.filter((_, i) => i % 3 === 0));
  assert.ok(Math.max(...xs) > total * 0.9, 'выборка доходит до конца каталога');
  assert.ok(Math.min(...xs) < total * 0.1, 'и начинается с начала');
});

test('лимит не теряет класс звезды и id64 при уплотнении', () => {
  const builder = new PointsBuilder(4, 4);
  for (let i = 0; i < 100; i++) {
    builder.add({ x: i, y: 0, z: 0, id64: String(18446744073709551000n + BigInt(i)), starType: i % 2 ? 'neutron' : 'black_hole' });
  }
  const parsed = parsePointsFile(builder.build());

  assert.ok(parsed.count <= 4);
  for (let i = 0; i < parsed.count; i++) {
    assert.ok(parsed.starTypes[i] >= 0);
    assert.ok(BigInt(id64FromParts(parsed.id64Hi[i], parsed.id64Lo[i])) > 18446744073709550000n, 'id64 пережил уплотнение');
  }
});

// ─────────────────────── пайплайн импорта ───────────────────────

const STARS = ['G (White-Yellow) Star', 'M (Red dwarf) Star', 'Neutron Star', null];

function dumpResponse(count) {
  const lines = [];
  for (let n = 0; n < count; n++) {
    const star = STARS[n % STARS.length];
    lines.push(
      `{"id64":${10477373803 + n},"name":"Synthetic-System-${n}"` +
        `${star ? `,"mainStar":${JSON.stringify(star)}` : ''}` +
        `,"coords":{"x":${(n % 100) * 10.5},"y":${((n % 37) - 18) * 3.25},"z":${-(n % 53) * 7.75}}` +
        `,"needsPermit":false,"updateTime":"2026-09-20T00:00:00Z"}`,
    );
  }
  const buffer = gzipSync(Buffer.from(`[\n${lines.join('\n')}\n]\n`));
  const source = new Readable({ read() {} });
  source.push(buffer);
  source.push(null);
  return new Response(Readable.toWeb(source), { status: 200 });
}

function memoryWriter() {
  const rows = new Map();
  let nextId = 1;
  let batch = [];
  let written = 0;
  const flush = async () => {
    for (const row of batch) {
      if (!rows.has(row.name_lc)) rows.set(row.name_lc, { id: nextId++, ...row });
    }
    written += batch.length;
    batch = [];
    return rows.size;
  };
  return {
    backend: 'memory',
    get written() {
      return written;
    },
    async add(row) {
      batch.push(row);
    },
    flush,
    async countRows() {
      await flush();
      return rows.size;
    },
    async readPoints(onPoint) {
      let count = 0;
      for (const row of [...rows.values()].sort((a, b) => a.id - b.id)) {
        count++;
        onPoint({ x: row.x, y: row.y, z: row.z, id64: row.id64, starType: row.star_type });
      }
      return count;
    },
    async close() {
      batch = [];
    },
  };
}

test('импорт с лимитом отдаёт выборку и честный счётчик строк', async () => {
  const total = 5000;
  const result = await runGalaxyImport({
    writer: memoryWriter(),
    fetchImpl: async () => dumpResponse(total),
    maxPoints: 500,
  });

  assert.equal(result.processed, total);
  assert.equal(result.systemsCount, total);
  assert.ok(result.points, 'облако построено');
  assert.equal(result.points.rows, total, 'прочитаны все строки таблицы');
  assert.ok(result.points.count <= 500, `точек ${result.points.count}`);
  assert.ok(result.points.stride > 1, 'выборка отмечена шагом');
  assert.equal(parsePointsFile(toArrayBuffer(result.points.buffer)).count, result.points.count);
});

test('импорт без лимита (GALAXY_POINTS_MAX=0) строит полное облако', async () => {
  const total = 500;
  const result = await runGalaxyImport({
    writer: memoryWriter(),
    fetchImpl: async () => dumpResponse(total),
    maxPoints: 0,
  });

  assert.equal(result.points.count, total);
  assert.equal(result.points.stride, 1);
  assert.equal(result.points.rebuiltFromTable, false, 'полное облако собирается на лету');
});

function toArrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}
