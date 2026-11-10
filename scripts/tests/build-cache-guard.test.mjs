/**
 * Страж кэша сборки Turbopack (`deploy/docker-next-cache-guard.sh`).
 *
 * Прод-инцидент 10.11.2026: `docker compose build web` трижды падал на
 * `Error [TurbopackInternalError]: read_task_output: task TaskId 7 no longer
 * exists (it was garbage collected)` — ещё до разбора кода. Кэш-маунт
 * `.next/cache` переживает смену версии Next, и записи прежнего Turbopack
 * Turbopack читает как свои. Страж живёт внутри слоя builder: сверяет версию
 * Next с маркером рядом с кэшем и чистит каталог ДО сборки.
 *
 * Здесь проверяется ровно его контракт:
 *   • маркер совпал с установленной версией — кэш не трогаем (тёплая сборка);
 *   • версия сменилась / маркера нет — кэш вычищен и маркер переписан;
 *   • NEXT_BUILD_CACHE=off — чистим всегда, режим «холодная сборка».
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TEST_ROOT } from './helpers/bundle.mjs';

const GUARD = join(TEST_ROOT, 'deploy', 'docker-next-cache-guard.sh');
const MARKER = '.edrc-next-version';

/** Временный «builder»: node_modules/next с версией и кэш-маунт с мусором. */
function sandbox({ installed, marker, cacheFiles = ['chunk.bin', 'data/0001.sst'] }) {
  const root = mkdtempSync(join(tmpdir(), 'edrc-cache-guard-'));
  mkdirSync(join(root, 'node_modules', 'next'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'next', 'package.json'), JSON.stringify({ version: installed }));
  const cache = join(root, 'cache');
  mkdirSync(join(cache, 'data'), { recursive: true });
  for (const file of cacheFiles) {
    mkdirSync(join(cache, file, '..'), { recursive: true });
    writeFileSync(join(cache, file), 'stale');
  }
  if (marker != null) writeFileSync(join(cache, MARKER), marker);
  return { root, cache };
}

function runGuard(root, cache, env = {}) {
  return execFileSync('sh', [GUARD, cache], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

const files = (cache) => readdirSync(cache).sort();

test('страж кэша: версия совпала — тёплый кэш остаётся', () => {
  const { root, cache } = sandbox({ installed: '16.4.2', marker: '16.4.2' });
  try {
    const output = runGuard(root, cache);
    assert.match(output, /совпадает с маркером/);
    assert.deepEqual(files(cache), [MARKER, 'chunk.bin', 'data'], 'кэш не тронут');
    assert.equal(readFileSync(join(cache, MARKER), 'utf8'), '16.4.2');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('страж кэша: версия Next сменилась — кэш вычищен до сборки', () => {
  const { root, cache } = sandbox({ installed: '16.4.2', marker: '16.3.1' });
  try {
    const output = runGuard(root, cache);
    assert.match(output, /чищу/);
    assert.deepEqual(files(cache), [MARKER], 'от кэша остался только маркер');
    assert.equal(readFileSync(join(cache, MARKER), 'utf8'), '16.4.2');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('страж кэша: маркера нет (старый кэш-маунт) — тоже чистим', () => {
  const { root, cache } = sandbox({ installed: '16.4.2', marker: null });
  try {
    runGuard(root, cache);
    assert.deepEqual(files(cache), [MARKER]);
    assert.equal(readFileSync(join(cache, MARKER), 'utf8'), '16.4.2');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('страж кэша: NEXT_BUILD_CACHE=off — всегда холодная сборка', () => {
  const { root, cache } = sandbox({ installed: '16.4.2', marker: '16.4.2' });
  try {
    const output = runGuard(root, cache, { NEXT_BUILD_CACHE: 'off' });
    assert.match(output, /NEXT_BUILD_CACHE=off/);
    assert.deepEqual(files(cache), [MARKER]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('страж кэша: неизвестная версия Next — каталог не трогаем', () => {
  const root = mkdtempSync(join(tmpdir(), 'edrc-cache-guard-'));
  const cache = join(root, 'cache');
  mkdirSync(cache, { recursive: true });
  writeFileSync(join(cache, 'chunk.bin'), 'keep');
  try {
    runGuard(root, cache);
    assert.deepEqual(files(cache), ['chunk.bin']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
