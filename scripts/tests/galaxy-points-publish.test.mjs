import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  POINTS_BYTES_PER_POINT,
  POINTS_HEADER_SIZE,
  POINTS_STORAGE_BUCKET,
  POINTS_STORAGE_OBJECT,
  encodePointsFile,
} from '../../src/lib/galaxySystems.ts';
import {
  looksLikePointsFile,
  pointsCacheDir,
  pointsCacheInfo,
  pointsCachePath,
  publishPointCloud,
  readPointsCache,
  storageErrorInfo,
  uploadPointsToStorage,
  writePointsCache,
} from '../../src/lib/galaxyPointsPublish.ts';

/* ──────────────────────────────────────────────────────────────────────────
   Публикация облака точек. Сборка каталога длинная (минуты чтения 2·10⁸ строк),
   а хранилище — сетевой сервис: ответ `503 Service Unavailable` ничего не
   говорит об облаке. Раньше один такой ответ означал «облака нет», и каждая
   следующая холодная сборка начинала с нуля. Отсюда контракт: файл всегда
   остаётся на диске данных, преходящие ошибки повторяются, а постоянные (отказ
   по размеру) — нет.
   ────────────────────────────────────────────────────────────────────────── */

const cloud = (points = 3) =>
  encodePointsFile(
    Array.from({ length: points }, (_, i) => ({
      x: i,
      y: i * 2,
      z: i * 3,
      id64: String(1000 + i),
      starType: 'g',
    })),
  );

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'galaxy-points-'));
}

// ─────────────────────────── кэш на диске ───────────────────────────

test('каталог кэша: GALAXY_POINTS_DIR важнее каталога архивов', () => {
  assert.equal(pointsCacheDir({ GALAXY_POINTS_DIR: '/tmp/points' }), '/tmp/points');
  assert.equal(pointsCacheDir({ GALAXY_ARCHIVE_DIR: '/data/dumps' }), join('/data/dumps', 'points'));
  assert.equal(pointsCacheDir({}), resolve(join('data/spansh', 'points')), 'относительный путь — от CWD процесса');
});

test('файл кэша переживает перезапись целиком и остаётся читаемым', () => {
  const dir = tempDir();
  try {
    const buffer = Buffer.from(cloud(5));
    const file = writePointsCache(buffer, dir, { count: 5, source: 'test' });
    assert.equal(file, pointsCachePath(dir));
    assert.equal(file, join(dir, POINTS_STORAGE_OBJECT));

    const found = readPointsCache(dir);
    assert.equal(found.buffer.length, buffer.length);
    assert.deepEqual([...found.buffer], [...buffer]);
    assert.equal(pointsCacheInfo(dir).count, 5);
    assert.equal(pointsCacheInfo(dir).valid, true);
    assert.ok(readdirSync(dir).includes('galaxy-systems-points.bin.meta.json'), 'sidecar с метаданными');
    assert.deepEqual(
      readdirSync(dir).filter((name) => name.endsWith('.tmp')),
      [],
      'временных файлов не остаётся',
    );

    // Перезапись: либо старое облако, либо новое — никогда «половина».
    writePointsCache(Buffer.from(cloud(9)), dir, { count: 9 });
    assert.equal(pointsCacheInfo(dir).count, 9);
    assert.equal(readPointsCache(dir).buffer.length, POINTS_HEADER_SIZE + 9 * POINTS_BYTES_PER_POINT);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('мусор вместо облака не принимается, и читается только заголовок', () => {
  const dir = tempDir();
  try {
    assert.equal(readPointsCache(dir), null, 'пустой каталог');
    assert.equal(pointsCacheInfo(dir), null);

    writeFileSync(pointsCachePath(dir), Buffer.from('это не edgs-v1'));
    assert.equal(looksLikePointsFile(Buffer.from('это не edgs-v1')), false);
    assert.equal(readPointsCache(dir), null, 'по содержимому, а не по имени файла');
    assert.equal(pointsCacheInfo(dir), null);

    // Обрезанный файл (полный диск) не считается пригодным облаком.
    const full = Buffer.from(cloud(20));
    writePointsCache(full, dir);
    writeFileSync(pointsCachePath(dir), full.subarray(0, full.length - 100));
    const info = pointsCacheInfo(dir);
    assert.equal(info.count, 20, 'заголовок читается всегда');
    assert.equal(info.valid, false, 'и заявленного количества байтов не хватает');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────── ошибки storage ───────────────────────────

test('503 — временная ошибка, отказ по размеру — постоянная', () => {
  for (const [error, expected] of [
    [{ message: 'Service Unavailable', statusCode: '503' }, 'transient'],
    [{ message: 'Bad Gateway', statusCode: '502' }, 'transient'],
    [{ message: 'timeout of 10000ms exceeded' }, 'transient'],
    [{ message: 'fetch failed' }, 'transient'],
    [{ message: 'connect ECONNREFUSED 127.0.0.1:54321' }, 'transient'],
    [{ message: 'size exceeds the maximum allowed for this bucket' }, 'permanent'],
    [{ message: 'payload too large', statusCode: '413' }, 'permanent'],
    [{ message: 'invalid key' }, 'neither'],
  ]) {
    const info = storageErrorInfo(error);
    assert.equal(
      info.transient ? 'transient' : info.permanent ? 'permanent' : 'neither',
      expected,
      `${error.message}: transient=${info.transient} permanent=${info.permanent}`,
    );
  }
  const nothing = storageErrorInfo(null);
  assert.equal(nothing.transient, false);
  assert.equal(nothing.permanent, false);
  assert.equal(nothing.status, null);
  assert.equal(storageErrorInfo({ originalError: { cause: { message: 'socket hang up' } } }).transient, true);
});

function client(responses) {
  const calls = [];
  return {
    calls,
    storage: {
      from(bucket) {
        assert.equal(bucket, POINTS_STORAGE_BUCKET);
        return {
          async upload(object, body, options) {
            calls.push({ object, bytes: body.length, options });
            const next = responses.shift();
            if (next instanceof Error) throw next;
            return next ?? { error: { message: 'Service Unavailable', statusCode: '503' } };
          },
        };
      },
    },
  };
}

test('загрузка повторяет преходящие сбои и не повторяет отказ по размеру', async () => {
  const buffer = Buffer.from(cloud(4));
  const waits = [];
  const okAfterTwo = client([
    { error: { message: 'Service Unavailable', statusCode: '503' } },
    { error: { message: 'Bad Gateway', statusCode: '502' } },
    { data: { path: POINTS_STORAGE_OBJECT }, error: null },
  ]);
  const result = await uploadPointsToStorage(buffer, {
    admin: okAfterTwo,
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
  assert.equal(result.uploaded, true);
  assert.equal(result.attempts, 3);
  assert.equal(result.error, null);
  assert.deepEqual(waits, [2000, 4000], 'экспоненциальная пауза');
  assert.deepEqual(
    okAfterTwo.calls.map((call) => [call.object, call.options.upsert]),
    [[POINTS_STORAGE_OBJECT, true], [POINTS_STORAGE_OBJECT, true], [POINTS_STORAGE_OBJECT, true]],
    'upsert: повторная запись тех же байтов идемпотентна',
  );

  const rejected = client([{ error: { message: 'size exceeds the maximum allowed', statusCode: '413' } }]);
  const refused = await uploadPointsToStorage(buffer, {
    admin: rejected,
    sleep: async () => assert.fail('постоянный отказ повторять нельзя'),
  });
  assert.equal(refused.uploaded, false);
  assert.equal(refused.attempts, 1);
  assert.equal(rejected.calls.length, 1);
});

test('файл больше лимита бакета не отправляется вовсе', async () => {
  const buffer = Buffer.from(cloud(4));
  const calls = [];
  const storageClient = {
    storage: {
      from: () => ({
        upload: async () => {
          calls.push(1);
          return { error: null };
        },
      }),
    },
  };
  const log = [];
  const result = await uploadPointsToStorage(buffer, {
    admin: storageClient,
    limitBytes: buffer.length - 1,
    log: (line) => log.push(line),
  });
  assert.equal(result.uploaded, false);
  assert.equal(result.attempts, 0);
  assert.deepEqual(calls, [], 'запроса в storage не было');
  assert.match(log.join('\n'), /больше лимита бакета/);
});

// ─────────────────────────── публикация целиком ───────────────────────────

test('сбой хранилища не отменяет сборку: облако остаётся на диске', async () => {
  const dir = tempDir();
  try {
    const buffer = Buffer.from(cloud(6));
    const failing = client([]);
    const publish = await publishPointCloud(buffer, {
      admin: failing,
      cacheDir: dir,
      retries: 1,
      sleep: async () => undefined,
      meta: { count: 6, source: 'test' },
    });
    assert.equal(publish.target, 'disk');
    assert.equal(publish.uploaded, false);
    assert.equal(publish.attempts, 2);
    assert.match(publish.error, /Service Unavailable/);
    assert.equal(publish.path, pointsCachePath(dir));
    assert.equal(pointsCacheInfo(dir).count, 6, 'карта может отдавать файл с диска');

    const ok = await publishPointCloud(buffer, {
      admin: client([{ data: { path: POINTS_STORAGE_OBJECT }, error: null }]),
      cacheDir: dir,
    });
    assert.equal(ok.target, 'storage');
    assert.equal(ok.uploaded, true);
    assert.equal(ok.error, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ни диска, ни хранилища — это единственная настоящая ошибка', async () => {
  // «Каталог» внутри обычного файла: mkdir даёт ENOTDIR мгновенно и на любой
  // системе (в отличие от /proc, где рекурсивный mkdir в Node зависает).
  const dir = tempDir();
  try {
    writeFileSync(join(dir, 'blocker'), 'x');
    const publish = await publishPointCloud(Buffer.from(cloud(2)), {
      admin: client([new Error('fetch failed')]),
      cacheDir: join(dir, 'blocker', 'points'),
      retries: 0,
      sleep: async () => assert.fail('последней попытки повторять некуда'),
      log: () => undefined,
    });
    assert.equal(publish.target, 'none');
    assert.equal(publish.uploaded, false);
    assert.equal(publish.path, null);
    assert.equal(publish.bytes, POINTS_HEADER_SIZE + 2 * POINTS_BYTES_PER_POINT, 'размер известен всегда');
    assert.match(publish.error, /fetch failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
