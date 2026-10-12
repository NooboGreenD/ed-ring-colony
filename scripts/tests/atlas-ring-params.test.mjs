/**
 * Ввод параметров кольца с клавиатуры: разбор значений и подключение полей.
 * Ползунок и поле ввода управляют одним значением (RangeNumberField), поэтому
 * проверяем и чистую функцию разбора, и то, что оба параметра подключены к ней.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

async function loadParser() {
  const esbuild = await import('esbuild');
  const dir = mkdtempSync(join(ROOT, '.tmp-atlas-ring-params-'));
  const outfile = join(dir, 'params.mjs');
  await esbuild.build({
    entryPoints: [join(ROOT, 'src/lib/atlasRingParams.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile,
    logLevel: 'silent',
  });
  const mod = await import(outfile);
  return { parseRingParam: mod.parseRingParam, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('ввод с клавиатуры: числа с пробелами и запятой разбираются', async () => {
  const { parseRingParam, cleanup } = await loadParser();
  try {
    assert.equal(parseRingParam('23000', 100, 45000), 23000);
    assert.equal(parseRingParam('23 000', 100, 45000), 23000, 'пробел — разделитель тысяч');
    assert.equal(parseRingParam('  250  ', 50, 3000), 250);
    assert.equal(parseRingParam('1,5', 1, 10), 2, 'запятая как десятичный знак, округление до целого');
    assert.equal(parseRingParam(500, 50, 3000), 500, 'число вместо строки');
  } finally {
    cleanup();
  }
});

test('ввод с клавиатуры: пустое и нечисловое значение не применяется', async () => {
  const { parseRingParam, cleanup } = await loadParser();
  try {
    assert.equal(parseRingParam('', 100, 45000), null);
    assert.equal(parseRingParam('   ', 100, 45000), null);
    assert.equal(parseRingParam('abc', 100, 45000), null);
    assert.equal(parseRingParam(null, 100, 45000), null);
  } finally {
    cleanup();
  }
});

test('ввод с клавиатуры: значение зажимается в диапазон параметра', async () => {
  const { parseRingParam, cleanup } = await loadParser();
  try {
    assert.equal(parseRingParam('999999', 100, 45000), 45000, 'выше максимума — максимум');
    assert.equal(parseRingParam('-5', 100, 45000), 100, 'ниже минимума — минимум');
    assert.equal(parseRingParam('10', 50, 3000), 50, 'радиус поиска не меньше 50');
    assert.equal(parseRingParam('5000', 50, 3000), 3000, 'радиус поиска не больше 3000');
  } finally {
    cleanup();
  }
});

test('оба параметра кольца подключены к полю ввода с клавиатуры', () => {
  const finder = readFileSync(join(ROOT, 'src/components/Atlas/AtlasRingRouteFinder.tsx'), 'utf8');
  const field = readFileSync(join(ROOT, 'src/components/Atlas/RangeNumberField.tsx'), 'utf8');

  assert.ok(finder.includes('RangeNumberField'), 'кольцо использует общий компонент параметра');
  assert.ok(finder.includes('id="ring-radius"'), 'удаление от центра');
  assert.ok(finder.includes('id="ring-search-radius"'), 'радиус поиска');
  assert.ok(field.includes('type="range"'), 'ползунок сохранён');
  assert.ok(field.includes('type="number"'), 'поле ввода с клавиатуры есть');
  assert.ok(field.includes("event.key === 'Enter'"), 'Enter применяет значение');
  assert.ok(field.includes("event.key === 'Escape'"), 'Escape возвращает прежнее значение');
  assert.ok(field.includes('onBlur'), 'потеря фокуса применяет значение');
});
