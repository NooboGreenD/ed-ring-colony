import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';

import {
  POINTS_BYTES_PER_POINT,
  POINTS_FILE_BUDGET,
  POINTS_HEADER_SIZE,
  POINTS_MAX_DEFAULT,
  POINTS_MAX_LIMIT,
  PointsBuilder,
  bytesForPoints,
  galaxyPointsMax,
  id64FromParts,
  parsePointsFile,
  pointSampleStride,
  pointsForBytes,
} from '../../src/lib/galaxySystems.ts';
import {
  POINTS_BUCKET_LIMIT_ASSUMED,
  finalizePointCloud,
  planPointCloud,
  pointsFileLimit,
  runGalaxyImport,
} from '../../src/lib/galaxyImport.ts';

/* ──────────────────────────────────────────────────────────────────────────
   Каталог — это вся галактика: Spansh `systems.json.gz` (5.9 GiB) содержит
   ~2×10⁸ систем (EDAstro: 203 642 699). Облако точек «по одной на систему»
   заняло бы гигабайты в оперативке веб-процесса и не влезло бы в бакет,
   поэтому оно строится равномерной выборкой. Проверки ниже фиксируют
   контракт: размер файла, потолок от доступного лимита, равномерность и
   честную статистику.

   Арифметика байтов закреплена здесь намеренно: `POINTS_FILE_BUDGET`,
   `pointsForBytes` и `bytesForPoints` — единственное место, где количество
   точек на карте связано с лимитом бакета. Изменение формата (размер записи)
   обязано пройти через эти тесты.
   ────────────────────────────────────────────────────────────────────────── */

const point = (n) => ({ x: n, y: -n, z: n * 0.5, id64: String(1000 + n), starType: 'g' });

// ─────────────────── арифметика файла edgs-v1 ───────────────────

test('размер файла = 12 + 29·N, и потолок ровно там, где перестаёт влезать', () => {
  assert.equal(POINTS_BYTES_PER_POINT, 29, '12 координат + 8 id64 + 1 класс + 8 запас');
  assert.equal(POINTS_HEADER_SIZE, 12);
  assert.equal(bytesForPoints(0), POINTS_HEADER_SIZE);
  assert.equal(bytesForPoints(1), POINTS_HEADER_SIZE + POINTS_BYTES_PER_POINT);

  assert.equal(pointsForBytes(POINTS_HEADER_SIZE + 3 * POINTS_BYTES_PER_POINT), 3);
  // Хвост меньше одной записи не даёт лишней точки.
  assert.equal(pointsForBytes(bytesForPoints(1000) + POINTS_BYTES_PER_POINT - 1), 1000);
  assert.equal(pointsForBytes(POINTS_HEADER_SIZE), 0);
  assert.equal(pointsForBytes(0), 0);

  // Круг: потолок бюджета — максимум точек, который в него влезает.
  assert.equal(POINTS_MAX_LIMIT, pointsForBytes(POINTS_FILE_BUDGET));
  assert.ok(bytesForPoints(POINTS_MAX_LIMIT) <= POINTS_FILE_BUDGET);
  assert.ok(bytesForPoints(POINTS_MAX_LIMIT + 1) > POINTS_FILE_BUDGET);
});

test('облако по умолчанию влезает в бюджет файла и в поднятый лимит бакета', () => {
  const bytes = bytesForPoints(POINTS_MAX_DEFAULT);
  assert.ok(bytes <= POINTS_FILE_BUDGET, `${bytes} байт при бюджете ${POINTS_FILE_BUDGET}`);
  // Старого лимита бакета (50 МиБ из 20260924000000_galaxy_systems_finish.sql)
  // больше не хватает — поэтому 20261009000000_galaxy_points_scale.sql поднимает
  // file_size_limit до 64 МиБ. Без миграции сборка упрётся в лимит файла, а не
  // в отказ storage.
  assert.ok(bytes > POINTS_BUCKET_LIMIT_ASSUMED, 'выборка стала больше старого бакета');
  assert.ok(bytes < 64 * 1024 * 1024, 'нового лимита хватает с запасом');
  assert.ok(bytes > 30 * 1024 * 1024, 'и при этом облако не вырождается');
});

test('лимит файла = min(лимит бакета, бюджет браузера)', () => {
  const gib = 1024 * 1024;
  assert.equal(pointsFileLimit({}, 50 * gib), 50 * gib, 'бакет меньше бюджета — берём бакет');
  assert.equal(pointsFileLimit({}, 200 * gib), POINTS_FILE_BUDGET, 'бакет больше — берём бюджет');
  assert.equal(pointsFileLimit({}, null), POINTS_BUCKET_LIMIT_ASSUMED, 'лимит неизвестен — старое значение');
  assert.equal(
    pointsFileLimit({ GALAXY_POINTS_BUCKET_BYTES: String(30 * gib) }, 50 * gib),
    30 * gib,
    'переменная окружения перекрывает недоступный запрос',
  );
  assert.equal(pointsFileLimit({ GALAXY_POINTS_BUCKET_BYTES: 'abc' }, 50 * gib), 50 * gib);
});

// ─────────────────────── параметры выборки ───────────────────────

test('шаг выборки: 1, пока каталог помещается в лимит', () => {
  assert.equal(pointSampleStride(1_200_000, POINTS_MAX_DEFAULT), 1);
  assert.equal(pointSampleStride(0, POINTS_MAX_DEFAULT), 1);
  assert.equal(pointSampleStride(203_642_699, 0), 1, 'лимит 0 = выборка выключена');
});

test('шаг выборки для всей галактики', () => {
  const stride = pointSampleStride(203_642_699, POINTS_MAX_DEFAULT);
  assert.equal(stride, Math.ceil(203_642_699 / POINTS_MAX_DEFAULT));
  assert.equal(stride, 102, 'около сотни строк на точку — и ровно столько, сколько нужно');
  assert.ok(203_642_699 / stride <= POINTS_MAX_DEFAULT, 'точек не больше лимита');
  assert.ok(stride < 1000, 'и карта не вырождается в несколько тысяч точек');
});

test('GALAXY_POINTS_MAX переопределяет лимит, мусор отбрасывается', () => {
  assert.equal(galaxyPointsMax({}), POINTS_MAX_DEFAULT);
  assert.equal(galaxyPointsMax({ GALAXY_POINTS_MAX: '500' }), 500);
  assert.equal(galaxyPointsMax({ GALAXY_POINTS_MAX: '0' }), 0, '0 = одна точка на систему');
  assert.equal(galaxyPointsMax({ GALAXY_POINTS_MAX: 'много' }), POINTS_MAX_DEFAULT);
  assert.equal(galaxyPointsMax({ GALAXY_POINTS_MAX: '-5' }), POINTS_MAX_DEFAULT);
  // Просьба больше потолка бюджета не создаёт файл, который никуда не влезает.
  assert.equal(galaxyPointsMax({ GALAXY_POINTS_MAX: '999999999' }), POINTS_MAX_LIMIT);
});

test('план сборки: потолок из бюджета, шаг из количества строк', () => {
  const gib = 1024 * 1024;
  const plan = planPointCloud(201_369_102, { maxPoints: POINTS_MAX_DEFAULT, budgetBytes: 50 * gib });
  assert.equal(plan.budgetBytes, 50 * gib);
  assert.equal(plan.ceilingPoints, pointsForBytes(50 * gib));
  assert.ok(plan.maxPoints <= plan.ceilingPoints, 'запрошенное количество урезано до того, что влезает');
  assert.equal(plan.stride, Math.ceil(201_369_102 / plan.maxPoints));
  assert.ok(plan.maxPoints * POINTS_BYTES_PER_POINT + POINTS_HEADER_SIZE <= 50 * gib);
  assert.equal(plan.limitedByBudget, plan.maxPoints < POINTS_MAX_DEFAULT);

  // Маленький каталог не режется: столько систем, сколько есть.
  const small = planPointCloud(50_000, { maxPoints: 500_000 });
  assert.equal(small.stride, 1);
  assert.equal(small.limitedByBudget, false);

  // Просьба сверх бюджета ограничивается бюджетом, а не бакетом наугад.
  const greedy = planPointCloud(201_369_102, { maxPoints: 90_000_000, budgetBytes: 50 * gib });
  assert.equal(greedy.maxPoints, pointsForBytes(50 * gib));
  assert.equal(greedy.limitedByBudget, true);
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
  const stride = builder.sampleStride;
  assert.ok(stride >= total / max, `шаг ${stride} не меньше отношения строк к точкам`);
  assert.equal(builder.sourceRows, total, 'строки источника считаются все, а не только сохранённые');

  // Равномерность: хвост каталога в облаке есть всегда — иначе «первые N систем»
  // вместо «каждая stride-я система» (именно так и терялась половина галактики).
  const parsed = parsePointsFile(builder.build());
  assert.equal(parsed.count, builder.size);
  const lastIndex = (parsed.count - 1) * 3;
  const lastX = parsed.positions[lastIndex];
  assert.ok(
    total - 1 - lastX < stride,
    `последняя точка на ${total - 1 - lastX} строк от конца (шаг ${stride})`,
  );
  assert.equal(
    id64FromParts(parsed.id64Hi[parsed.count - 1], parsed.id64Lo[parsed.count - 1]),
    String(1000 + lastX),
  );
  // И середина диапазона тоже представлена, а не только первые N.
  const xs = Array.from(parsed.positions.filter((_, i) => i % 3 === 0));
  assert.ok(Math.max(...xs) > total * 0.9, 'выборка доходит до конца каталога');
  assert.ok(Math.min(...xs) < total * 0.1, 'и начинается с начала');
  // Соседи выбраны с постоянным шагом — это выборка, а не усечение.
  for (let i = 1; i < Math.min(50, xs.length); i++) {
    assert.equal(xs[i] - xs[i - 1], xs[1] - xs[0], 'шаг не скачет');
  }
});

test('выборка на стороне базы: строки считаются по всему каталогу', () => {
  const total = 100_000;
  const stride = 40;
  const builder = new PointsBuilder(1_000, 2_500, stride);
  let read = 0;
  for (let id = 1; id <= total; id++) {
    if (id % stride !== 0) continue;
    read++;
    builder.addSampled(point(id));
  }
  assert.equal(read, total / stride);
  assert.equal(builder.size, read, 'уже прореженная выборка не прореживается второй раз');
  assert.equal(builder.sourceRows, total, 'шаг учится у источника, а не у выборки');
  assert.equal(builder.sampleStride, stride);
  assert.equal(builder.sampled, true);
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

// ─────────────────── сборка из таблицы (writer) ───────────────────

/** Писатель, который умеет читать выборку сам (путь `mod(id, stride)`). */
function samplingWriter(total, { supportsSampling = true } = {}) {
  return {
    backend: 'pg',
    get written() {
      return total;
    },
    async countRows() {
      return total;
    },
    async supportsSampledRead() {
      return supportsSampling;
    },
    async readPoints(onPoint, options = {}) {
      const stride = Math.max(1, Math.floor(options.stride ?? 1));
      let n = 0;
      for (let id = 1; id <= total; id++) {
        if (id % stride !== 0) continue;
        n++;
        onPoint(point(id));
      }
      return n;
    },
    async close() {},
  };
}

test('облако из таблицы берёт выборку у базы и честно считает строки', async () => {
  const total = 200_000;
  const cloud = await finalizePointCloud({
    writer: samplingWriter(total),
    streamed: null,
    pointsSeen: 0,
    systemsCount: total,
    maxPoints: 1000,
    complete: false,
    log: () => undefined,
  });

  assert.ok(cloud.count <= 1000, `точек ${cloud.count}`);
  assert.equal(cloud.rows, total, 'строк — весь каталог, а не выборка');
  assert.ok(cloud.stride > 1, `шаг ${cloud.stride} отмечен`);
  assert.ok(cloud.rebuiltFromTable, 'облако собрано из таблицы');
  assert.equal(parsePointsFile(toArrayBuffer(cloud.buffer)).count, cloud.count);

  const parsed = parsePointsFile(toArrayBuffer(cloud.buffer));
  const xs = Array.from(parsed.positions.filter((_, i) => i % 3 === 0));
  assert.ok(Math.max(...xs) >= total - 250, 'выборка доходит до конца каталога');
  assert.ok(new Set(xs).size === xs.length, 'точек-дублей нет');
});

test('писатель без выборки читает всё; обрезанное чтение — ошибка', async () => {
  const total = 50_000;
  const ok = await finalizePointCloud({
    writer: samplingWriter(total, { supportsSampling: false }),
    streamed: null,
    pointsSeen: 0,
    systemsCount: total,
    maxPoints: 500,
    complete: false,
    log: () => undefined,
  });
  assert.ok(ok.count <= 500);
  assert.equal(ok.rows, total, 'безвыборочное чтение видит все строки');

  // PostgREST с ограничением на строки ответа молча вернул бы часть каталога:
  // для пути без выборки это ошибка, а не «облако покороче».
  const truncated = {
    backend: 'supabase',
    get written() {
      return total;
    },
    async countRows() {
      return total;
    },
    async readPoints(onPoint) {
      for (let id = 1; id <= 1000; id++) onPoint(point(id));
      return 1000;
    },
    async close() {},
  };
  await assert.rejects(
    () =>
      finalizePointCloud({
        writer: truncated,
        streamed: null,
        pointsSeen: 0,
        systemsCount: total,
        maxPoints: 500,
        complete: false,
        log: () => undefined,
      }),
    /truncated/,
  );
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
    deferred: 0,
    async add(row) {
      batch.push(row);
    },
    flush,
    async retryDeferred() {},
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
