/**
 * Кэш сборок esbuild для тестов (`scripts/tests/helpers/bundle.mjs`).
 *
 * От кэша зависит скорость всего набора, поэтому проверяются именно его
 * гарантии: одинаковый вход не пересобирается, правка любого исходника из
 * сборки сбрасывает кэш, а разные заглушки не переиспользуют чужую сборку.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundleFile, bundleStats } from './helpers/bundle.mjs';

function fixture(initial) {
  const dir = mkdtempSync(join(tmpdir(), 'edrc-bundle-cache-'));
  const file = join(dir, 'fixture.ts');
  writeFileSync(file, initial);
  return { dir, file, entry: `export { value } from '${file}';\n` };
}

test('кэш сборок: повторный вызов не пересобирает, а правка исходника пересобирает', async () => {
  const { dir, file, entry } = fixture('export const value = 1;\n');
  try {
    const builtBefore = bundleStats.built;
    const cachedBefore = bundleStats.cached;

    const first = await bundleFile({ entrySource: entry });
    assert.equal(bundleStats.built, builtBefore + 1, 'первый вызов собирает');
    assert.match(readFileSync(first, 'utf8'), /value = 1/, 'в сборке видно исходник');

    const second = await bundleFile({ entrySource: entry });
    assert.equal(second, first, 'тот же вход — тот же файл сборки');
    assert.equal(bundleStats.built, builtBefore + 1, 'повторно не пересобираем');
    assert.equal(bundleStats.cached, cachedBefore + 1, 'взят кэш');

    // Правка исходника меняет размер файла — кэш обязан пересобраться.
    writeFileSync(file, 'export const value = 222222;\n');
    const third = await bundleFile({ entrySource: entry });
    assert.equal(third, first, 'ключ сборки от входа не меняется');
    assert.equal(bundleStats.built, builtBefore + 2, 'изменившийся исходник сбрасывает кэш');
    assert.match(readFileSync(third, 'utf8'), /value = 222222/, 'сборка перечитала исходник');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('кэш сборок: разные заглушки не переиспользуют чужую сборку', async () => {
  const { dir, entry } = fixture('export const value = 7;\n');
  try {
    const withStub = await bundleFile({ entrySource: entry, stubs: { 'next/link': 'export default function A() { return null; }' } });
    const withOtherStub = await bundleFile({ entrySource: entry, stubs: { 'next/link': 'export default function B() { return null; }' } });
    assert.notEqual(withStub, withOtherStub, 'заглушка входит в ключ сборки');

    const again = await bundleFile({ entrySource: entry, stubs: { 'next/link': 'export default function A() { return null; }' } });
    assert.equal(again, withStub, 'та же заглушка — та же сборка');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
