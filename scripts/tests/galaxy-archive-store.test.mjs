import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

import {
  PARTS_SUFFIX,
  archiveKeepAfterImport,
  checkDiskSpace,
  cleanupBeforeDownload,
  cleanupGalaxyStorage,
  diskCheckEnabled,
  diskUsage,
  getGalaxyStorageStatus,
  listArchives,
  pruneArchives,
  pruneShards,
  releaseArchiveAfterImport,
} from '../../src/lib/galaxyArchiveStore.ts';
import { unpackArchiveToShards } from '../../src/lib/galaxyShards.ts';

/**
 * Архивы и шарды живут на отдельном диске сервера, и места там конечное
 * количество: полный дамп 5.9 ГиБ, его шарды — ещё столько же (сырой
 * systems.json был бы 32+ ГБ, поэтому он не пишется на диск никогда).
 * Правило простое: предыдущий дамп удаляется перед загрузкой следующего, а
 * сам архив — сразу после успешного импорта.
 */

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'spansh-store-'));
}

function makeArchive(dir, file, bytes = 1024) {
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, file);
  fs.writeFileSync(target, Buffer.alloc(bytes, 7));
  return target;
}

function dumpGz(count) {
  const lines = [];
  for (let n = 0; n < count; n++) {
    lines.push(
      `{"id64":${1000 + n},"name":"Store System ${n}","coords":{"x":${n},"y":0,"z":${n}},` +
        '"needsPermit":false,"updateTime":"2026-09-28T12:00:00Z"}',
    );
  }
  return gzipSync(Buffer.from(`[\n${lines.join(',\n')}\n]\n`));
}

// ─────────────────────────── инвентаризация ───────────────────────────

test('listArchives видит все варианты дампа и недокачанные файлы', () => {
  const dir = tmp();
  makeArchive(dir, 'systems.json.gz', 4096);
  makeArchive(dir, 'systems_1day.json.gz', 512);
  fs.writeFileSync(path.join(dir, `systems.json.gz${PARTS_SUFFIX}`), '{}');
  fs.writeFileSync(path.join(dir, 'README.txt'), 'не дамп');

  const found = listArchives(dir);
  assert.deepEqual(
    found.map((item) => item.variant).sort(),
    ['1day', 'full'],
  );
  assert.equal(found.find((item) => item.variant === 'full').partial, true);
  assert.equal(found.find((item) => item.variant === '1day').partial, false);
  assert.equal(found.find((item) => item.variant === 'full').bytes, 4096);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('diskUsage отвечает даже для ещё не созданного каталога', () => {
  const dir = tmp();
  const usage = diskUsage(path.join(dir, 'ещё', 'нет', 'такого'));
  assert.ok(usage, 'статистика берётся с ближайшего существующего родителя');
  assert.ok(usage.total > 0);
  assert.ok(usage.free >= 0);
  assert.ok(usage.free <= usage.total);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ─────────────────────── удаление предыдущего дампа ───────────────────────

test('перед новым дампом удаляются предыдущие и их sidecar-планы', () => {
  const dir = tmp();
  makeArchive(dir, 'systems.json.gz', 8192);
  makeArchive(dir, 'systems_1month.json.gz', 2048);
  const keep = makeArchive(dir, 'systems_1day.json.gz', 256);
  fs.writeFileSync(path.join(dir, `systems.json.gz${PARTS_SUFFIX}`), '{"parts":[]}');

  const lines = [];
  const result = pruneArchives({ dir, keep: ['1day'], log: (line) => lines.push(line), env: {} });

  assert.ok(fs.existsSync(keep), 'файл, который сейчас качаем, остаётся');
  assert.ok(!fs.existsSync(path.join(dir, 'systems.json.gz')));
  assert.ok(!fs.existsSync(path.join(dir, `systems.json.gz${PARTS_SUFFIX}`)), 'план сегментов уходит вместе с файлом');
  assert.ok(!fs.existsSync(path.join(dir, 'systems_1month.json.gz')));
  assert.ok(result.freed >= 8192 + 2048, 'освобождённые байты посчитаны');
  assert.equal(result.removed.length, 3, 'два архива и один sidecar');
  assert.ok(lines.some((line) => /Удалён предыдущий дамп systems\.json\.gz/.test(line)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('закреплённый GALAXY_IMPORT_FILE не удаляется никогда', () => {
  const dir = tmp();
  const pinned = makeArchive(dir, 'systems.json.gz', 1024);
  makeArchive(dir, 'systems_1week.json.gz', 512);

  pruneArchives({ dir, keep: ['1day'], env: { GALAXY_IMPORT_FILE: pinned } });
  assert.ok(fs.existsSync(pinned), 'файл оператора трогать нельзя');
  assert.ok(!fs.existsSync(path.join(dir, 'systems_1week.json.gz')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('шарды чужого архива удаляются, свои — остаются', async () => {
  const dir = tmp();
  const archive = path.join(dir, 'systems.json.gz');
  fs.writeFileSync(archive, dumpGz(30));
  const shards = path.join(dir, 'shards');
  await unpackArchiveToShards({ archive, dir: shards, rowsPerShard: 10 });
  const before = fs.readdirSync(shards).length;
  assert.ok(before >= 4, 'три шарда и манифест');

  // Манифест соответствует архиву — чистка не трогает ничего.
  assert.equal(pruneShards({ dir: shards, archive, env: {} }).freed, 0);
  assert.equal(fs.readdirSync(shards).length, before);

  // Архив сменился — шарды описывают данные, которых уже нет.
  fs.writeFileSync(archive, dumpGz(40));
  const lines = [];
  const result = pruneShards({ dir: shards, archive, log: (line) => lines.push(line), env: {} });
  assert.ok(result.freed > 0);
  assert.equal(fs.readdirSync(shards).filter((name) => name.endsWith('.tsv.gz')).length, 0);
  assert.ok(lines.some((line) => /шарды предыдущего дампа/i.test(line)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('cleanupBeforeDownload освобождает и архивы, и шарды за один вызов', async () => {
  const dir = tmp();
  const full = path.join(dir, 'systems.json.gz');
  fs.writeFileSync(full, dumpGz(20));
  const shards = path.join(dir, 'shards');
  await unpackArchiveToShards({ archive: full, dir: shards, rowsPerShard: 10 });
  makeArchive(dir, 'systems_6months.json.gz', 4096);

  // Качаем суточную дельту: ни полный архив, ни его шарды больше не нужны.
  const result = cleanupBeforeDownload({ variant: '1day', dir, shards, env: {}, log: () => {} });
  assert.ok(result.freed > 0);
  assert.equal(listArchives(dir).length, 0);
  assert.equal(fs.readdirSync(shards).filter((name) => name.endsWith('.tsv.gz')).length, 0);
  assert.ok(result.free === null || result.free > 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('GALAXY_SHARDS_KEEP=1 защищает шарды от автоудаления', async () => {
  const dir = tmp();
  const archive = path.join(dir, 'systems.json.gz');
  fs.writeFileSync(archive, dumpGz(20));
  const shards = path.join(dir, 'shards');
  await unpackArchiveToShards({ archive, dir: shards, rowsPerShard: 10 });
  fs.rmSync(archive);

  const kept = cleanupBeforeDownload({
    variant: '1day',
    dir,
    shards,
    env: { GALAXY_SHARDS_KEEP: '1' },
    log: () => {},
  });
  assert.equal(kept.freed, 0);
  assert.equal(fs.readdirSync(shards).filter((name) => name.endsWith('.tsv.gz')).length, 2);

  // Без флага те же осиротевшие шарды уходят перед новой загрузкой.
  const dropped = cleanupBeforeDownload({ variant: '1day', dir, shards, env: {}, log: () => {} });
  assert.ok(dropped.freed > 0);
  assert.equal(fs.readdirSync(shards).filter((name) => name.endsWith('.tsv.gz')).length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ─────────────────────── место на диске ───────────────────────

test('нехватка места ловится до загрузки, а не через сутки через ENOSPC', () => {
  const dir = tmp();
  const usage = diskUsage(dir);
  assert.ok(usage);

  // Вариант заведомо больше свободного места: проверка обязана отказать.
  const huge = checkDiskSpace({ variant: 'full', dir, have: 0, withShards: true, env: {} });
  const fits = usage.free > 13 * 1024 ** 3;
  assert.equal(huge.ok, fits);
  if (!fits) {
    assert.match(huge.message, /Недостаточно места/);
    assert.match(huge.message, /GALAXY_DISK_CHECK=0/);
  }

  // Уже скачанные байты уменьшают потребность.
  const small = checkDiskSpace({ variant: '1day', dir, env: {} });
  assert.equal(small.ok, true);
  assert.ok(small.need > 0);
  const resumed = checkDiskSpace({ variant: '1day', dir, have: 999 * 1024 * 1024, env: {} });
  assert.equal(resumed.need, 0);

  // Явное отключение проверки всегда разрешает загрузку.
  assert.equal(diskCheckEnabled({ GALAXY_DISK_CHECK: '0' }), false);
  assert.equal(
    checkDiskSpace({ variant: 'full', dir, withShards: true, env: { GALAXY_DISK_CHECK: '0' } }).ok,
    true,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

// ─────────────────────── архив после импорта ───────────────────────

test('после успешного импорта архив удаляется вместе с планом сегментов', () => {
  const dir = tmp();
  const archive = makeArchive(dir, 'systems.json.gz', 16384);
  fs.writeFileSync(`${archive}${PARTS_SUFFIX}`, '{"parts":[]}');

  const lines = [];
  const result = releaseArchiveAfterImport({ path: archive, log: (line) => lines.push(line), env: {} });
  assert.equal(result.kept, false);
  assert.ok(result.freed >= 16384);
  assert.ok(!fs.existsSync(archive));
  assert.ok(!fs.existsSync(`${archive}${PARTS_SUFFIX}`));
  assert.ok(lines.some((line) => /удалён после успешного импорта/.test(line)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('GALAXY_ARCHIVE_KEEP=1 и закреплённый файл сохраняют архив', () => {
  const dir = tmp();
  const archive = makeArchive(dir, 'systems.json.gz', 2048);

  const kept = releaseArchiveAfterImport({ path: archive, env: { GALAXY_ARCHIVE_KEEP: '1' } });
  assert.equal(kept.kept, true);
  assert.equal(kept.reason, 'GALAXY_ARCHIVE_KEEP=1');
  assert.ok(fs.existsSync(archive));
  assert.equal(archiveKeepAfterImport({ GALAXY_ARCHIVE_KEEP: '1' }), true);
  assert.equal(archiveKeepAfterImport({}), false);

  const pinned = releaseArchiveAfterImport({ path: archive, env: { GALAXY_IMPORT_FILE: archive } });
  assert.equal(pinned.kept, true);
  assert.match(pinned.reason, /GALAXY_IMPORT_FILE/);
  assert.ok(fs.existsSync(archive));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('удаление несуществующего архива — не ошибка', () => {
  const result = releaseArchiveAfterImport({ path: '/нет/такого/файла.gz', env: {} });
  assert.equal(result.freed, 0);
  assert.equal(result.kept, false);
  assert.equal(releaseArchiveAfterImport({ path: null, env: {} }).freed, 0);
});

// ─────────────────────── статус и ручная очистка ───────────────────────

test('статус диска показывает архивы, шарды и общий объём', async () => {
  const dir = tmp();
  const archive = path.join(dir, 'systems.json.gz');
  fs.writeFileSync(archive, dumpGz(25));
  const shards = path.join(dir, 'shards');
  await unpackArchiveToShards({ archive, dir: shards, rowsPerShard: 10 });

  const status = getGalaxyStorageStatus({ GALAXY_ARCHIVE_DIR: dir, GALAXY_SHARDS_DIR: shards });
  assert.equal(status.dir, dir);
  assert.equal(status.archives.length, 1);
  assert.ok(status.archives_bytes > 0);
  assert.equal(status.shards_files, 3);
  assert.ok(status.shards_bytes > 0);
  assert.equal(status.total_bytes, status.archives_bytes + status.shards_bytes);
  assert.equal(status.keep_archive, false);
  assert.ok(status.disk === null || status.disk.total > 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ручная очистка сносит лишнее и может забрать шарды', async () => {
  const dir = tmp();
  const archive = path.join(dir, 'systems.json.gz');
  fs.writeFileSync(archive, dumpGz(20));
  const shards = path.join(dir, 'shards');
  await unpackArchiveToShards({ archive, dir: shards, rowsPerShard: 10 });
  makeArchive(dir, 'systems_1week.json.gz', 4096);
  const env = { GALAXY_ARCHIVE_DIR: dir, GALAXY_SHARDS_DIR: shards };

  // keep: полный дамп — его шарды тоже обязаны уцелеть.
  const first = cleanupGalaxyStorage({ keep: ['full'], env, log: () => {} });
  assert.ok(first.freed >= 4096);
  assert.ok(fs.existsSync(archive));
  assert.equal(first.storage.shards_files, 2);

  // Второй проход с dropShards убирает и шарды.
  const second = cleanupGalaxyStorage({ keep: ['full'], dropShards: true, env, log: () => {} });
  assert.ok(second.freed > 0);
  assert.equal(second.storage.shards_files, 0);
  assert.ok(fs.existsSync(archive), 'архив из keep по-прежнему на месте');
  fs.rmSync(dir, { recursive: true, force: true });
});
