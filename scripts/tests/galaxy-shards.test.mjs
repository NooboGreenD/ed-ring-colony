import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

import {
  DEFAULT_ROWS_PER_SHARD,
  SHARD_MANIFEST,
  createGrowingReadStream,
  decodeShardRow,
  encodeShardRow,
  galaxyImportMode,
  getShardStatus,
  manifestMatchesArchive,
  readShardManifest,
  readShardRecords,
  runShardImport,
  shardFileName,
  shardsDir,
  unpackArchiveToShards,
} from '../../src/lib/galaxyShards.ts';
import { toGalaxySystemRow } from '../../src/lib/galaxySpanshStream.ts';

/**
 * Шарды — ответ на две боли полного дампа: gzip нельзя раскодировать с
 * середины (каждое «продолжить» перечитывало 6 ГиБ) и архив бесполезен, пока
 * не скачан целиком. Распаковка читает его один раз, импорт идёт по файлам,
 * возобновление стоит O(1), а `follow` позволяет распаковывать прямо во время
 * скачивания.
 */

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'spansh-shards-'));
}

function makeRecords(count) {
  const stars = ['G (White-Yellow) Star', 'Neutron Star', null];
  const out = [];
  for (let n = 0; n < count; n++) {
    out.push({
      id64Raw: String(18446744073709551000n + BigInt(n)),
      name: n % 5 === 0 ? `Shard System ${n}` : `Shard-System-${n}`,
      mainStar: stars[n % stars.length],
      coords: { x: n * 1.5, y: -n * 0.25, z: n * 3 },
      needsPermit: n % 3 === 0,
      updateTime: '2026-09-28T12:00:00Z',
    });
  }
  return out;
}

/** Одна запись на строку и настоящий id64 — ровно формат дампа Spansh. */
function dumpBuffer(records) {
  const lines = records.map(
    (r) => `{"id64":${r.id64Raw},"name":${JSON.stringify(r.name)}` +
      `${r.mainStar ? `,"mainStar":${JSON.stringify(r.mainStar)}` : ''}` +
      `,"coords":{"x":${r.coords.x},"y":${r.coords.y},"z":${r.coords.z}}` +
      `,"needsPermit":${r.needsPermit},"updateTime":${JSON.stringify(r.updateTime)}}`,
  );
  return Buffer.from(`[\n${lines.join(',\n')}\n]\n`);
}

const gzDump = (records) => gzipSync(dumpBuffer(records));

/** Таблица в памяти: upsert по name_lc, как в настоящем galaxy_systems. */
function memoryWriter(batchSize = 100) {
  const rows = new Map();
  let batch = [];
  let written = 0;
  const flush = async () => {
    if (batch.length === 0) return 0;
    for (const row of batch) rows.set(row.name_lc, row);
    const n = batch.length;
    written += n;
    batch = [];
    return n;
  };
  return {
    backend: 'memory',
    rows,
    get written() {
      return written;
    },
    deferred: 0,
    async add(row) {
      batch.push(row);
      if (batch.length >= batchSize) await flush();
    },
    flush,
    async retryDeferred() {},
    async countRows() {
      await flush();
      return rows.size;
    },
    async readPoints(onPoint) {
      let count = 0;
      for (const row of rows.values()) {
        count++;
        onPoint({ x: row.x, y: row.y, z: row.z, id64: row.id64, starType: row.star_type });
      }
      return count;
    },
    async close() {},
  };
}

// ─────────────────────────── формат строки ───────────────────────────

test('строка шарда переживает кодирование и разбор без потерь', () => {
  const row = toGalaxySystemRow({
    __id64Exact: '18446744073709551615', // > 2^53: число потеряло бы точность
    name: 'Col 285 Sector  AB-C\td1-23',
    mainStar: 'M (Red dwarf) Star',
    coords: { x: -1234.59375, y: 0, z: 25899.96875 },
    needsPermit: true,
    updateTime: '2026-09-28T12:00:00Z',
  });
  const decoded = decodeShardRow(encodeShardRow(row));
  assert.deepEqual(decoded, row);
  assert.equal(decoded.id64, '18446744073709551615');
  // Табуляция внутри имени не ломает TSV.
  assert.ok(decoded.name.includes('\t'));
});

test('NULL-поля и обратные слэши кодируются однозначно', () => {
  const row = toGalaxySystemRow({
    __id64Exact: '1',
    name: 'Back\\slash \\N system',
    coords: { x: 1, y: 2, z: 3 },
    // ни mainStar, ни needsPermit, ни updateTime
  });
  const line = encodeShardRow(row);
  const decoded = decodeShardRow(line);
  assert.equal(decoded.main_star, null);
  assert.equal(decoded.needs_permit, null);
  assert.equal(decoded.updated_at, null);
  assert.equal(decoded.name, 'Back\\slash \\N system');
  assert.equal(line.split('\t').length, 13);
});

test('битая строка не роняет импорт, а просто пропускается', () => {
  assert.equal(decodeShardRow(''), null);
  assert.equal(decodeShardRow('мусор'), null);
  assert.equal(decodeShardRow('1\t2\t3'), null);
});

test('имена шардов сортируются лексикографически вместе с порядком импорта', () => {
  assert.equal(shardFileName(1), 'shard-00001.tsv.gz');
  assert.equal(shardFileName(42), 'shard-00042.tsv.gz');
  const names = [1, 2, 10, 100].map(shardFileName);
  assert.deepEqual([...names].sort(), names);
});

test('shardsDir и GALAXY_IMPORT_MODE читаются из окружения', () => {
  assert.equal(shardsDir({ GALAXY_SHARDS_DIR: '/data/shards' }), '/data/shards');
  assert.ok(shardsDir({ GALAXY_ARCHIVE_DIR: '/data/spansh' }).endsWith(path.join('spansh', 'shards')));
  assert.equal(galaxyImportMode({}), 'stream');
  assert.equal(galaxyImportMode({ GALAXY_IMPORT_MODE: 'shards' }), 'shards');
});

// ─────────────────────────── распаковка ───────────────────────────

test('распаковка режет архив на шарды и описывает их манифестом', async () => {
  const dir = tmp();
  const archive = path.join(dir, 'systems.json.gz');
  fs.writeFileSync(archive, gzDump(makeRecords(250)));

  const manifest = await unpackArchiveToShards({ archive, dir: path.join(dir, 'shards'), rowsPerShard: 100 });
  assert.equal(manifest.complete, true);
  assert.equal(manifest.rows, 250);
  assert.equal(manifest.shards.length, 3);
  assert.deepEqual(manifest.shards.map((shard) => shard.rows), [100, 100, 50]);
  assert.equal(manifest.variant, 'full');

  // Манифест читается обратно и совпадает с содержимым каталога.
  const status = getShardStatus(path.join(dir, 'shards'));
  assert.equal(status.files, 3);
  assert.ok(status.bytes > 0);
  assert.ok(fs.existsSync(path.join(dir, 'shards', SHARD_MANIFEST)));

  // Все системы на месте и в исходном порядке.
  const names = [];
  for (const shard of manifest.shards) {
    for await (const row of readShardRecords(path.join(dir, 'shards', shard.file))) names.push(row.name);
  }
  assert.equal(names.length, 250);
  assert.equal(names[0], 'Shard System 0');
  assert.equal(names.at(-1), 'Shard-System-249');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('повторная распаковка того же архива ничего не делает', async () => {
  const dir = tmp();
  const archive = path.join(dir, 'systems.json.gz');
  fs.writeFileSync(archive, gzDump(makeRecords(50)));
  const shards = path.join(dir, 'shards');

  const first = await unpackArchiveToShards({ archive, dir: shards, rowsPerShard: 20 });
  const lines = [];
  const second = await unpackArchiveToShards({ archive, dir: shards, rowsPerShard: 20, log: (line) => lines.push(line) });
  assert.equal(second.rows, first.rows);
  assert.equal(second.shards.length, first.shards.length);
  assert.ok(lines.some((line) => /уже распакован/.test(line)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('прерванная распаковка продолжается, а не начинается заново', async () => {
  const dir = tmp();
  const archive = path.join(dir, 'systems.json.gz');
  fs.writeFileSync(archive, gzDump(makeRecords(120)));
  const shards = path.join(dir, 'shards');

  // Останавливаем распаковку после первого шарда.
  const controller = new AbortController();
  let rows = 0;
  await assert.rejects(
    () =>
      unpackArchiveToShards({
        archive,
        dir: shards,
        rowsPerShard: 30,
        signal: controller.signal,
        onProgress: () => {},
        now: () => {
          rows++;
          if (rows > 40) controller.abort();
          return Date.now();
        },
      }),
    /aborted|Unpack/i,
  );
  const partial = readShardManifest(shards);
  assert.ok(partial, 'манифест прерванной распаковки сохранён');
  assert.equal(partial.complete, false);
  assert.ok(partial.shards.length >= 1);
  const alreadyRead = partial.records_read;
  assert.ok(alreadyRead > 0);

  const lines = [];
  const finished = await unpackArchiveToShards({ archive, dir: shards, rowsPerShard: 30, log: (line) => lines.push(line) });
  assert.equal(finished.complete, true);
  assert.equal(finished.rows, 120);
  assert.ok(lines.some((line) => /Продолжаю распаковку/.test(line)));

  // Ни одной потерянной или задвоенной системы.
  const names = new Set();
  let total = 0;
  for (const shard of finished.shards) {
    for await (const row of readShardRecords(path.join(shards, shard.file))) {
      names.add(row.name);
      total++;
    }
  }
  assert.equal(total, 120);
  assert.equal(names.size, 120);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('шарды чужого архива выбрасываются, а не смешиваются с новыми', async () => {
  const dir = tmp();
  const archive = path.join(dir, 'systems.json.gz');
  const shards = path.join(dir, 'shards');
  fs.writeFileSync(archive, gzDump(makeRecords(40)));
  const first = await unpackArchiveToShards({ archive, dir: shards, rowsPerShard: 20 });
  assert.equal(first.rows, 40);
  assert.ok(manifestMatchesArchive(readShardManifest(shards), archive));

  // Новый дамп: другой размер и другое mtime.
  fs.writeFileSync(archive, gzDump(makeRecords(60)));
  fs.utimesSync(archive, new Date(), new Date(Date.now() + 1000));
  assert.ok(!manifestMatchesArchive(readShardManifest(shards), archive));

  const lines = [];
  const second = await unpackArchiveToShards({ archive, dir: shards, rowsPerShard: 20, log: (line) => lines.push(line) });
  assert.equal(second.rows, 60);
  assert.ok(lines.some((line) => /другому архиву/.test(line)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('follow: распаковка идёт, пока архив ещё дописывается', async () => {
  const dir = tmp();
  const archive = path.join(dir, 'systems.json.gz');
  const buffer = gzDump(makeRecords(80));
  const half = Math.floor(buffer.length / 2);
  fs.writeFileSync(archive, buffer.subarray(0, half));

  let downloading = true;
  const unpack = unpackArchiveToShards({
    archive,
    dir: path.join(dir, 'shards'),
    rowsPerShard: 25,
    follow: () => downloading,
  });

  // «Докачиваем» остаток через полсекунды — распаковка обязана его увидеть.
  setTimeout(() => {
    fs.appendFileSync(archive, buffer.subarray(half));
    downloading = false;
  }, 300);

  const manifest = await unpack;
  assert.equal(manifest.complete, true);
  assert.equal(manifest.rows, 80);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('createGrowingReadStream дочитывает файл, а не обрывается на EOF', async () => {
  const dir = tmp();
  const file = path.join(dir, 'growing.bin');
  fs.writeFileSync(file, 'первая часть ');
  let growing = true;
  const stream = createGrowingReadStream(file, { isGrowing: () => growing, pollMs: 50 });
  setTimeout(() => {
    fs.appendFileSync(file, 'вторая часть');
    growing = false;
  }, 200);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString('utf8'), 'первая часть вторая часть');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ─────────────────────────── импорт из шардов ───────────────────────────

test('импорт из шардов записывает весь каталог и строит облако точек', async () => {
  const dir = tmp();
  const archive = path.join(dir, 'systems.json.gz');
  fs.writeFileSync(archive, gzDump(makeRecords(150)));
  const shards = path.join(dir, 'shards');
  await unpackArchiveToShards({ archive, dir: shards, rowsPerShard: 50 });

  const writer = memoryWriter(40);
  const result = await runShardImport({ dir: shards, writer });
  assert.equal(result.processed, 150);
  assert.equal(result.systemsCount, 150);
  assert.equal(result.shardsDone, 3);
  assert.equal(result.shardsTotal, 3);
  assert.ok(result.points);
  assert.equal(result.points.rebuiltFromTable, false);
  assert.equal(result.points.rows, 150);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('возобновление стоит O(1): уже импортированные шарды не перечитываются', async () => {
  const dir = tmp();
  const archive = path.join(dir, 'systems.json.gz');
  fs.writeFileSync(archive, gzDump(makeRecords(100)));
  const shards = path.join(dir, 'shards');
  const manifest = await unpackArchiveToShards({ archive, dir: shards, rowsPerShard: 25 });
  assert.equal(manifest.shards.length, 4);

  const writer = memoryWriter(10);
  const result = await runShardImport({ dir: shards, writer, fromShard: 2 });
  // Прочитаны только два последних шарда; первые два помечены пропущенными.
  assert.equal(result.processed, 50);
  assert.equal(result.skipped, 50);
  assert.equal(result.resumedFrom, 2);
  assert.equal(result.shardsDone, 4);
  // Облако пересобрано из таблицы: поток видел только хвост дампа.
  assert.equal(result.points.rebuiltFromTable, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('прогресс отдаёт номер шарда — именно он и есть точка возобновления', async () => {
  const dir = tmp();
  const archive = path.join(dir, 'systems.json.gz');
  fs.writeFileSync(archive, gzDump(makeRecords(90)));
  const shards = path.join(dir, 'shards');
  await unpackArchiveToShards({ archive, dir: shards, rowsPerShard: 30 });

  const seen = [];
  await runShardImport({
    dir: shards,
    writer: memoryWriter(10),
    buildPoints: false,
    onProgress: (snapshot) => {
      seen.push(snapshot.shardIndex);
    },
  });
  // Счётчик только растёт и доходит до последнего шарда; «0» в начале — это
  // прогресс внутри первого, ещё не дописанного файла.
  assert.deepEqual([...seen].sort((a, b) => a - b), seen);
  assert.equal(seen.at(-1), 3);
  for (const index of [1, 2, 3]) assert.ok(seen.includes(index), `шард ${index} отметился в прогрессе`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('prune освобождает диск: импортированный шард удаляется', async () => {
  const dir = tmp();
  const archive = path.join(dir, 'systems.json.gz');
  fs.writeFileSync(archive, gzDump(makeRecords(60)));
  const shards = path.join(dir, 'shards');
  await unpackArchiveToShards({ archive, dir: shards, rowsPerShard: 20 });

  await runShardImport({ dir: shards, writer: memoryWriter(10), buildPoints: false, prune: true });
  assert.equal(getShardStatus(shards).files, 0);
  // Манифест остаётся: по нему видно, что каталог уже загружен.
  assert.ok(readShardManifest(shards).complete);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('пропавший шард называет себя, а не падает «undefined»', async () => {
  const dir = tmp();
  const archive = path.join(dir, 'systems.json.gz');
  fs.writeFileSync(archive, gzDump(makeRecords(40)));
  const shards = path.join(dir, 'shards');
  const manifest = await unpackArchiveToShards({ archive, dir: shards, rowsPerShard: 20 });
  fs.rmSync(path.join(shards, manifest.shards[1].file));

  await assert.rejects(
    () => runShardImport({ dir: shards, writer: memoryWriter(10), buildPoints: false }),
    /shard-00002\.tsv\.gz/,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('импорт без распакованных шардов объясняет, что делать', async () => {
  const dir = tmp();
  await assert.rejects(
    () => runShardImport({ dir: path.join(dir, 'shards'), writer: memoryWriter(10) }),
    /распакуйте архив/i,
  );
  assert.equal(DEFAULT_ROWS_PER_SHARD, 2_000_000);
  fs.rmSync(dir, { recursive: true, force: true });
});
