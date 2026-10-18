import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';

import {
  DEFAULT_DOWNLOAD_SEGMENTS,
  SEGMENTED_MIN_BYTES,
  SegmentedDownloadUnsupported,
  downloadDump,
  downloadDumpSegmented,
  galaxyDownloadSegments,
  planDumpSegments,
  probeDumpSource,
  segmentStatePath,
} from '../../src/lib/galaxyImport.ts';

/**
 * Параллельная докачка: 5.9 ГиБ одним TCP-потоком с downloads.spansh.co.uk
 * шли на сервере около недели, за которую источник обновлялся семь раз.
 * Несколько Range-соединений — единственное, что ускоряет саму передачу,
 * поэтому здесь проверяется и быстрый путь, и каждое его отступление:
 * сервер без Range, обрыв посередине, перезапуск процесса.
 */

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'spansh-segments-'));
}

function startServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}/systems.json.gz` });
    });
  });
}

const stopServer = ({ server }) => new Promise((resolve) => server.close(resolve));

/**
 * Сервер с поддержкой Range. `dropAfter` рвёт соединение после N байт тела
 * (ровно так ведёт себя тонкий канал), `ignoreRange` — сервер без 206,
 * `noHead` — хост, не отвечающий на HEAD.
 */
function rangeServer(buffer, { dropAfter = 0, ignoreRange = false, noHead = false } = {}) {
  const state = { ranges: [], heads: 0, drops: 0 };
  let dropsLeft = dropAfter > 0 ? Infinity : 0;
  return {
    state,
    handler(req, res) {
      if (req.method === 'HEAD') {
        state.heads++;
        if (noHead) {
          res.writeHead(405);
          res.end();
          return;
        }
        res.writeHead(200, {
          'Content-Length': buffer.length,
          'Accept-Ranges': ignoreRange ? 'none' : 'bytes',
          'Last-Modified': 'Wed, 30 Sep 2026 03:00:00 GMT',
        });
        res.end();
        return;
      }
      state.ranges.push(req.headers.range ?? null);
      if (ignoreRange || !req.headers.range) {
        res.writeHead(200, { 'Content-Length': buffer.length });
        res.end(buffer);
        return;
      }
      const match = /bytes=(\d+)-(\d*)/.exec(req.headers.range);
      const start = Number(match[1]);
      const end = match[2] ? Number(match[2]) : buffer.length - 1;
      if (start >= buffer.length) {
        res.writeHead(416, { 'Content-Range': `bytes */${buffer.length}` });
        res.end();
        return;
      }
      const slice = buffer.subarray(start, end + 1);
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${buffer.length}`,
        'Content-Length': slice.length,
        'Last-Modified': 'Wed, 30 Sep 2026 03:00:00 GMT',
      });
      if (dropsLeft > 0 && slice.length > dropAfter) {
        dropsLeft--;
        state.drops++;
        // Отдать кусок и только потом рвать сокет: иначе undici не успевает
        // доставить байты, и тест проверял бы «мёртвую линию», а не обрыв.
        res.write(slice.subarray(0, dropAfter), () => setTimeout(() => req.socket.destroy(), 20));
        return;
      }
      res.end(slice);
    },
  };
}

/**
 * «Тело дампа»: валидный gzip, который НЕ сжимается (случайные байты), иначе
 * 300 КиБ текста превратились бы в пару сотен байт и сегментов бы не было.
 */
function payload(bytes = 512 * 1024) {
  return gzipSync(randomBytes(bytes));
}

test('planDumpSegments делит файл без дыр и перекрытий', () => {
  const segments = planDumpSegments(1000, 4);
  assert.equal(segments.length, 4);
  assert.deepEqual(segments[0], { start: 0, end: 249, done: 0 });
  assert.equal(segments.at(-1).end, 999);
  for (let i = 1; i < segments.length; i++) {
    assert.equal(segments[i].start, segments[i - 1].end + 1);
  }
  // Один сегмент — это обычная последовательная загрузка.
  assert.deepEqual(planDumpSegments(10, 1), [{ start: 0, end: 9, done: 0 }]);
  // Файл меньше числа сегментов не порождает пустых диапазонов.
  assert.ok(planDumpSegments(3, 8).every((segment) => segment.end >= segment.start));
});

test('galaxyDownloadSegments читает GALAXY_DOWNLOAD_SEGMENTS и держит разумные границы', () => {
  assert.equal(galaxyDownloadSegments({}), DEFAULT_DOWNLOAD_SEGMENTS);
  assert.equal(galaxyDownloadSegments({ GALAXY_DOWNLOAD_SEGMENTS: '8' }), 8);
  assert.equal(galaxyDownloadSegments({ GALAXY_DOWNLOAD_SEGMENTS: '0' }), 1);
  assert.equal(galaxyDownloadSegments({ GALAXY_DOWNLOAD_SEGMENTS: '999' }), 16);
  assert.equal(galaxyDownloadSegments({ GALAXY_DOWNLOAD_SEGMENTS: 'нет' }), DEFAULT_DOWNLOAD_SEGMENTS);
});

test('probeDumpSource узнаёт размер, Range и дату генерации дампа', async () => {
  const buffer = payload(64 * 1024);
  const { handler } = rangeServer(buffer);
  const server = await startServer(handler);
  try {
    const probe = await probeDumpSource(server.url);
    assert.equal(probe.total, buffer.length);
    assert.equal(probe.acceptsRanges, true);
    assert.equal(probe.lastModified, 'Wed, 30 Sep 2026 03:00:00 GMT');
  } finally {
    await stopServer(server);
  }
});

test('probeDumpSource обходится без HEAD (405) через однобайтовый Range', async () => {
  const buffer = payload(64 * 1024);
  const { handler, state } = rangeServer(buffer, { noHead: true });
  const server = await startServer(handler);
  try {
    const probe = await probeDumpSource(server.url);
    assert.equal(state.heads, 1);
    assert.equal(probe.total, buffer.length);
    assert.equal(probe.acceptsRanges, true);
  } finally {
    await stopServer(server);
  }
});

test('downloadDumpSegmented собирает файл из параллельных диапазонов', async () => {
  const dir = tmpDir();
  const buffer = payload(300 * 1024);
  const { handler, state } = rangeServer(buffer);
  const server = await startServer(handler);
  const dest = path.join(dir, 'systems.json.gz');
  try {
    const result = await downloadDumpSegmented({ url: server.url, dest, segments: 4 });
    assert.equal(result.bytes, buffer.length);
    assert.equal(result.segments, 4);
    assert.deepEqual(fs.readFileSync(dest), buffer);
    // Четыре диапазона — четыре соединения.
    assert.equal(state.ranges.filter((range) => range?.startsWith('bytes=')).length >= 4, true);
    // Файл состояния убирается после успеха.
    assert.ok(!fs.existsSync(segmentStatePath(dest)));
  } finally {
    await stopServer(server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('оборванный сегмент продолжает с места обрыва, а не с нуля', async () => {
  const dir = tmpDir();
  const buffer = payload(200 * 1024);
  const { handler, state } = rangeServer(buffer, { dropAfter: 4096 });
  const server = await startServer(handler);
  const dest = path.join(dir, 'systems.json.gz');
  try {
    const result = await downloadDumpSegmented({
      url: server.url,
      dest,
      segments: 2,
      retries: Infinity,
      sleep: async () => {},
    });
    assert.equal(result.bytes, buffer.length);
    assert.deepEqual(fs.readFileSync(dest), buffer);
    assert.ok(state.drops > 0, 'сервер действительно рвал соединения');
    // Докачка идёт Range-ами с ненулевого смещения — байты на диске не теряются.
    assert.ok(state.ranges.some((range) => /bytes=[1-9]\d*-/.test(range ?? '')));
  } finally {
    await stopServer(server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('перезапуск процесса продолжает загрузку по сохранённому плану сегментов', async () => {
  const dir = tmpDir();
  const buffer = payload(256 * 1024);
  const dest = path.join(dir, 'systems.json.gz');

  // Первая попытка: сервер отдаёт только половину каждого сегмента и падает.
  const broken = rangeServer(buffer, { dropAfter: 8192 });
  const first = await startServer(broken.handler);
  await assert.rejects(
    () =>
      downloadDumpSegmented({
        url: first.url,
        dest,
        segments: 2,
        retries: 0,
        maxStagnantFailures: 0,
        sleep: async () => {},
      }),
    /Скачивание не удалось/,
  );
  await stopServer(first);

  const plan = JSON.parse(fs.readFileSync(segmentStatePath(dest), 'utf8'));
  assert.equal(plan.total, buffer.length);
  assert.ok(plan.segments.some((segment) => segment.done > 0), 'прогресс сегментов сохранён на диск');
  const before = plan.segments.reduce((sum, segment) => sum + segment.done, 0);
  assert.ok(before > 0);

  // Второй запуск — новый процесс, тот же файл: докачивает остаток.
  const healthy = rangeServer(buffer);
  const second = await startServer(healthy.handler);
  try {
    const result = await downloadDumpSegmented({ url: second.url, dest, segments: 2, sleep: async () => {} });
    assert.equal(result.bytes, buffer.length);
    assert.deepEqual(fs.readFileSync(dest), buffer);
    // Докачивался только остаток: ни один запрос не начинался с нулевого байта.
    const starts = healthy.state.ranges.map((range) => Number(/bytes=(\d+)-/.exec(range ?? '')?.[1] ?? -1));
    assert.ok(starts.every((start) => start !== 0 || before === 0));
  } finally {
    await stopServer(second);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('сервер без Range отдаёт SegmentedDownloadUnsupported, а downloadDump молча падает в один поток', async () => {
  const dir = tmpDir();
  const buffer = payload(128 * 1024);
  const { handler } = rangeServer(buffer, { ignoreRange: true });
  const server = await startServer(handler);
  const dest = path.join(dir, 'systems.json.gz');
  try {
    await assert.rejects(
      () => downloadDumpSegmented({ url: server.url, dest, segments: 4 }),
      (error) => error instanceof SegmentedDownloadUnsupported,
    );

    const lines = [];
    const result = await downloadDump({ url: server.url, dest, segments: 4, log: (line) => lines.push(line) });
    assert.equal(result.segments, 1);
    assert.equal(result.bytes, buffer.length);
    assert.deepEqual(fs.readFileSync(dest), buffer);
    assert.ok(lines.some((line) => /одним потоком|Range/i.test(line)));
  } finally {
    await stopServer(server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('маленький файл (дельта) качается одним соединением', async () => {
  const dir = tmpDir();
  const buffer = payload(32 * 1024);
  assert.ok(buffer.length < SEGMENTED_MIN_BYTES);
  const { handler, state } = rangeServer(buffer);
  const server = await startServer(handler);
  const dest = path.join(dir, 'systems_1day.json.gz');
  try {
    const result = await downloadDump({ url: server.url, dest, segments: 8 });
    assert.equal(result.segments, 1);
    assert.equal(result.lastModified, 'Wed, 30 Sep 2026 03:00:00 GMT');
    assert.deepEqual(fs.readFileSync(dest), buffer);
    assert.equal(state.ranges.filter((range) => range && range !== 'bytes=0-0').length, 0);
  } finally {
    await stopServer(server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('битый архив удаляется вместе с планом сегментов', async () => {
  const dir = tmpDir();
  // Валидный gzip, который сервер отдаёт испорченным в середине.
  const buffer = payload(300 * 1024);
  const corrupted = Buffer.from(buffer);
  corrupted.fill(0, Math.floor(corrupted.length / 2), Math.floor(corrupted.length / 2) + 1024);
  const { handler } = rangeServer(corrupted);
  const server = await startServer(handler);
  const dest = path.join(dir, 'systems.json.gz');
  try {
    await assert.rejects(
      () => downloadDumpSegmented({ url: server.url, dest, segments: 4 }),
      /повредился|incorrect|unexpected/i,
    );
    assert.ok(!fs.existsSync(dest));
    assert.ok(!fs.existsSync(segmentStatePath(dest)));
  } finally {
    await stopServer(server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ── Упорядоченные куски (конвейер фракций) ────────────────────────────── */

test('planDumpPieces / rechunkDumpSegments / contiguousDumpBytes: куски по порядку, скачанное не теряется', async () => {
  const { planDumpPieces, rechunkDumpSegments, contiguousDumpBytes } = await import('../../src/lib/galaxyImport.ts');
  const pieces = planDumpPieces(10_000, 4096);
  assert.deepEqual(pieces.map((piece) => [piece.start, piece.end]), [[0, 4095], [4096, 8191], [8192, 9999]]);
  assert.equal(planDumpPieces(10, 1).length, 1, 'кусок не меньше 1 КБ');

  // Старый план: четыре больших части с разным прогрессом.
  const legacy = [
    { start: 0, end: 2499, done: 2500 },
    { start: 2500, end: 4999, done: 1000 },
    { start: 5000, end: 7499, done: 0 },
    { start: 7500, end: 9999, done: 2500 },
  ];
  const recut = rechunkDumpSegments(legacy, 1024);
  assert.equal(recut.reduce((sum, piece) => sum + piece.done, 0), 6000, 'все скачанные байты сохранены');
  for (let i = 1; i < recut.length; i++) assert.equal(recut[i].start, recut[i - 1].end + 1, 'без дыр и перекрытий');
  assert.equal(recut.at(-1).end, 9999);
  assert.ok(recut.filter((piece) => piece.done === 0).every((piece) => piece.end - piece.start + 1 <= 1024));

  assert.equal(contiguousDumpBytes(legacy), 3500, 'готовое начало: первая часть + 1000 байт второй');
  assert.equal(contiguousDumpBytes(recut), 3500);
  assert.equal(contiguousDumpBytes([{ start: 0, end: 99, done: 0 }, { start: 100, end: 199, done: 100 }]), 0, 'дыра в начале — читать нечего');
});

test('упорядоченные куски: N соединений, запросы «от-до» по порядку, готовое начало растёт без откатов', async () => {
  const dir = tmpDir();
  const buffer = payload(256 * 1024);
  const { handler, state } = rangeServer(buffer);
  const server = await startServer(handler);
  const dest = path.join(dir, 'systemsPopulated.json.gz');
  const contiguous = [];
  try {
    const result = await downloadDump({
      url: server.url,
      dest,
      segments: 3,
      pieceBytes: 16 * 1024,
      minSegmentedBytes: 0,
      progressIntervalMs: 250,
      onProgress: (info) => contiguous.push(info.contiguous),
    });
    assert.equal(result.segments, 3);
    assert.deepEqual(fs.readFileSync(dest), buffer);
    const ranges = state.ranges.filter((range) => range && range !== 'bytes=0-0');
    assert.equal(ranges.length, Math.ceil(buffer.length / (16 * 1024)), 'по запросу на кусок');
    assert.ok(ranges.every((range) => /^bytes=\d+-\d+$/.test(range)));
    const starts = ranges.map((range) => Number(/bytes=(\d+)-/.exec(range)[1]));
    assert.deepEqual([...starts].sort((a, b) => a - b), starts, 'куски берутся по порядку файла');
    assert.ok(contiguous.length > 0);
    for (let i = 1; i < contiguous.length; i++) assert.ok(contiguous[i] >= contiguous[i - 1], 'готовое начало не откатывается');
    assert.equal(contiguous.at(-1), buffer.length);
    assert.ok(!fs.existsSync(segmentStatePath(dest)));
  } finally {
    await stopServer(server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('сервер не даёт столько соединений (503): лишние отключаются, скачивание доходит до конца', async () => {
  const dir = tmpDir();
  const buffer = payload(192 * 1024);
  const inner = rangeServer(buffer);
  let inFlight = 0;
  let refused = 0;
  const server = await startServer((req, res) => {
    if (req.method === 'GET' && req.headers.range && req.headers.range !== 'bytes=0-0') {
      if (inFlight >= 2) {
        refused++;
        res.writeHead(503);
        res.end();
        return;
      }
      inFlight++;
      res.on('close', () => { inFlight--; });
      // Медленный ответ: два «разрешённых» соединения заняты, пока остальные стучатся.
      setTimeout(() => inner.handler(req, res), 15);
      return;
    }
    inner.handler(req, res);
  });
  const dest = path.join(dir, 'systemsPopulated.json.gz');
  const lines = [];
  try {
    const result = await downloadDump({
      url: server.url,
      dest,
      segments: 4,
      pieceBytes: 8 * 1024,
      minSegmentedBytes: 0,
      retries: Infinity,
      maxStagnantFailures: 50,
      sleep: () => new Promise((resolve) => setTimeout(resolve, 5)),
      log: (line) => lines.push(line),
    });
    assert.equal(result.bytes, buffer.length);
    assert.deepEqual(fs.readFileSync(dest), buffer);
    assert.ok(refused > 0, 'сервер действительно отказывал');
    assert.ok(lines.some((line) => /не даёт столько соединений, продолжаю в [123]/.test(line)), lines.join('\n'));
  } finally {
    await stopServer(server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('strictSource: дамп пересобран посреди скачивания — DumpSourceChanged, недокачанное удалено', async () => {
  const { DumpSourceChanged, isDumpSourceChanged, downloadDumpFile } = await import('../../src/lib/galaxyImport.ts');
  const dir = tmpDir();
  const buffer = payload(128 * 1024);
  const OLD = 'Wed, 30 Sep 2026 03:00:00 GMT';
  const NEW = 'Thu, 01 Oct 2026 03:00:00 GMT';
  let gets = 0;
  let switchAfter = 3;
  const server = await startServer((req, res) => {
    const lastModified = gets >= switchAfter ? NEW : OLD;
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'Content-Length': buffer.length, 'Accept-Ranges': 'bytes', 'Last-Modified': lastModified });
      res.end();
      return;
    }
    gets++;
    const match = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
    const start = Number(match?.[1] ?? 0);
    const end = match?.[2] ? Number(match[2]) : buffer.length - 1;
    res.writeHead(match ? 206 : 200, {
      ...(match ? { 'Content-Range': `bytes ${start}-${end}/${buffer.length}` } : {}),
      'Content-Length': end - start + 1,
      'Last-Modified': lastModified,
    });
    res.end(buffer.subarray(start, end + 1));
  });
  const dest = path.join(dir, 'systemsPopulated.json.gz');
  try {
    // Параллельные куски: третий ответ уже от другого файла.
    await assert.rejects(
      () => downloadDump({ url: server.url, dest, segments: 2, pieceBytes: 8 * 1024, minSegmentedBytes: 0, strictSource: true, sleep: async () => {} }),
      (error) => isDumpSourceChanged(error) && error instanceof DumpSourceChanged && /изменился во время скачивания/.test(error.message),
    );
    assert.ok(!fs.existsSync(dest), 'байты старого файла удалены');
    assert.ok(!fs.existsSync(segmentStatePath(dest)), 'и план частей тоже');

    // Без strictSource каталог ведёт себя по-старому: ответы не сверяются.
    gets = 0;
    switchAfter = Infinity;
    const plain = await downloadDump({ url: server.url, dest, segments: 2, pieceBytes: 8 * 1024, minSegmentedBytes: 0, sleep: async () => {} });
    assert.equal(plain.bytes, buffer.length);
    fs.rmSync(dest, { force: true });

    // Один поток: докачка недокачанного файла сверяется с ожидаемым дампом.
    fs.writeFileSync(dest, buffer.subarray(0, 4096));
    gets = 0;
    switchAfter = 0;
    await assert.rejects(
      () => downloadDumpFile({ url: server.url, dest, verify: false, expectSource: { total: buffer.length, etag: null, lastModified: OLD } }),
      (error) => isDumpSourceChanged(error),
    );
    assert.ok(!fs.existsSync(dest), 'чужое начало удалено');
  } finally {
    await stopServer(server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('план частей на диске: один поток его не портит, а одно соединение продолжает его', async () => {
  const dir = tmpDir();
  const buffer = payload(128 * 1024);
  const dest = path.join(dir, 'systemsPopulated.json.gz');

  // Недокачанный параллельный файл: сервер рвёт каждый ответ.
  const broken = rangeServer(buffer, { dropAfter: 4096 });
  const first = await startServer(broken.handler);
  await assert.rejects(() => downloadDump({
    url: first.url, dest, segments: 2, pieceBytes: 16 * 1024, minSegmentedBytes: 0, retries: 0, maxStagnantFailures: 0, sleep: async () => {},
  }));
  await stopServer(first);
  assert.ok(fs.existsSync(segmentStatePath(dest)), 'план частей сохранён');
  assert.equal(fs.statSync(dest).size, buffer.length, 'файл выделен целиком — «одним потоком» он выглядел бы готовым');

  // Тот же сервер, одно соединение: план продолжается, а не выбрасывается.
  const healthy = rangeServer(buffer);
  const second = await startServer(healthy.handler);
  try {
    const result = await downloadDump({ url: second.url, dest, segments: 1, pieceBytes: 16 * 1024, minSegmentedBytes: 0, sleep: async () => {} });
    assert.deepEqual(fs.readFileSync(dest), buffer);
    assert.equal(result.segments, 1);
    const starts = healthy.state.ranges.filter((range) => range && range !== 'bytes=0-0').map((range) => Number(/bytes=(\d+)-/.exec(range)[1]));
    assert.ok(!starts.includes(0) || broken.state.ranges.length === 0, 'скачанное начало не качается заново');
  } finally {
    await stopServer(second);
  }

  // Ещё раз недокачанный файл, но теперь сервер без Range: файл начинается заново, а не «уже готов».
  const brokenAgain = rangeServer(buffer, { dropAfter: 4096 });
  const third = await startServer(brokenAgain.handler);
  fs.rmSync(dest, { force: true });
  await assert.rejects(() => downloadDump({
    url: third.url, dest, segments: 2, pieceBytes: 16 * 1024, minSegmentedBytes: 0, retries: 0, maxStagnantFailures: 0, sleep: async () => {},
  }));
  await stopServer(third);
  const noRange = rangeServer(buffer, { ignoreRange: true });
  const fourth = await startServer(noRange.handler);
  const lines = [];
  try {
    const result = await downloadDump({ url: fourth.url, dest, segments: 2, minSegmentedBytes: 0, log: (line) => lines.push(line) });
    assert.equal(result.segments, 1);
    assert.deepEqual(fs.readFileSync(dest), buffer, 'настоящий файл, а не выделенный с нулями');
    assert.ok(lines.some((line) => /не годятся для одного потока/.test(line)), lines.join('\n'));
    assert.ok(!fs.existsSync(segmentStatePath(dest)));
  } finally {
    await stopServer(fourth);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
