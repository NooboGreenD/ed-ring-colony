/**
 * Подстановки в переводах: `t('key', { … })` обязан передать всё, что просит шаблон.
 *
 * Тест появился после реального дефекта: в админке PowerPlay сообщение
 * «Архив и куски удалены с сервера — освобождено {bytes}» печаталось с
 * плейсхолдером внутри — вызов передавал `freed`, а шаблон ждал `bytes`.
 * Компилятор такое не ловит: ключ — строка, параметры — объект. Видно было
 * только глазами на живом сайте, причём на любом языке.
 *
 * Проверки:
 *   1. у каждого `t('key', { … })` с литеральным ключом есть все подстановки,
 *      которые встречаются в русском шаблоне;
 *   2. ключ вообще есть в словаре (иначе `t()` вернёт сам ключ);
 *   3. в русском шаблоне нет подстановок, которых нет ни в одной локали
 *      (иначе перевод терял бы значение) — это уже проверяет
 *      `i18n-locale-parity`, здесь только перекрёстная страховка.
 *
 * Вызовы с динамическим ключом (`t(\`x.${y}\`)`) и с параметрами не в
 * литеральном объекте пропускаются: их можно проверить только исполнением.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const I18N_DIR = path.join(ROOT, 'src/lib/i18n');
const LOCALES = ['ru', 'en', 'de', 'it', 'ko', 'zh', 'ja'];

const DICTIONARIES = [
  'translations.ts',
  'engineers.ts',
  'outfitting.ts',
  'outfittingAnalysis.ts',
  'outfittingSpecials.ts',
  'orreryTips.ts',
  'exchangeText.ts',
  'planMessages.ts',
  'architectLabels.ts',
  'commodities.ts',
  'carrierJumps.ts',
  'carrierCard.ts',
];

const PLACEHOLDER = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;

/** Словари по локалям: ключ → значение (файлы разделов дополняют базовый). */
function dictionaries() {
  const all = {};
  for (const locale of LOCALES) all[locale] = new Map();
  for (const file of DICTIONARIES) {
    let source;
    try {
      source = fs.readFileSync(path.join(I18N_DIR, file), 'utf8');
    } catch {
      continue;
    }
    let current = null;
    for (const line of source.split('\n')) {
      const start = line.match(/^  ([a-z]{2}): \{$/);
      if (start) {
        current = start[1];
        continue;
      }
      if (current && /^  \},$/.test(line)) {
        current = null;
        continue;
      }
      if (!current || !all[current]) continue;
      const entry = line.match(/^    '([^']+)':\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"),\s*$/);
      if (entry) all[current].set(entry[1], entry[2] ?? entry[3]);
    }
  }
  return all;
}

/** Файлы исходников, где вообще встречается `t(`. */
function sourceFiles() {
  const files = [];
  const walk = (dir) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) {
        if (item.name === 'node_modules' || item.name.startsWith('.')) continue;
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(item.name)) continue;
      const relative = path.relative(ROOT, full).split(path.sep).join('/');
      if (relative.startsWith('src/lib/i18n/')) continue;
      files.push(relative);
    }
  };
  walk(path.join(ROOT, 'src'));
  return files.sort();
}

/** Имена параметров из литерального объекта `{ a, b: 1 }`. */
function paramNames(object) {
  const names = new Set();
  for (const match of object.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:/g)) names.add(match[1]);
  // Сокращённая запись: `{ cmdr }` — имя без двоеточия.
  for (const match of object.matchAll(/(?:^|,)\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?=,|$)/g)) names.add(match[1]);
  return names;
}

const CALL = /\bt\(\s*'([a-zA-Z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)'\s*,\s*\{([^{}]*)\}/gs;

test('t() передаёт все подстановки, которые просит шаблон', () => {
  const dictionary = dictionaries();
  const problems = [];
  for (const file of sourceFiles()) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const match of source.matchAll(CALL)) {
      const [, key, object] = match;
      const template = dictionary.ru.get(key);
      if (template === undefined) continue; // о пропаже ключа — отдельная проверка
      const required = new Set([...template.matchAll(PLACEHOLDER)].map((item) => item[1]));
      const given = paramNames(object);
      const missing = [...required].filter((name) => !given.has(name));
      if (missing.length === 0) continue;
      const line = source.slice(0, match.index).split('\n').length;
      problems.push(`${file}:${line} ${key} — вызов не передаёт ${missing.join(', ')}`);
    }
    if (problems.length > 40) break;
  }
  assert.deepEqual(problems, [], `подстановки не совпадают с шаблоном:\n${problems.join('\n')}`);
});

test('каждый ключ из t() есть в словаре', () => {
  const dictionary = dictionaries();
  const missing = [];
  for (const file of sourceFiles()) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    // Ключи берём и из вызовов с параметрами, и из простых `t('a.b')`.
    const pattern = /\bt\(\s*'([a-zA-Z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)'/g;
    for (const match of source.matchAll(pattern)) {
      const key = match[1];
      if (dictionary.ru.has(key)) continue;
      const line = source.slice(0, match.index).split('\n').length;
      missing.push(`${file}:${line} ${key}`);
    }
  }
  assert.deepEqual(missing, [], `t() по ключу, которого нет в словаре:\n${missing.join('\n')}`);
});

test('подстановки шаблона одинаковы во всех локалях', () => {
  const dictionary = dictionaries();
  const broken = [];
  for (const [key, template] of dictionary.ru) {
    const expected = [...template.matchAll(PLACEHOLDER)].map((item) => item[1]).sort().join(',');
    for (const locale of LOCALES) {
      if (locale === 'ru') continue;
      const value = dictionary[locale].get(key);
      if (value === undefined) continue; // о пропаже перевода — i18n-locale-parity
      const found = [...value.matchAll(PLACEHOLDER)].map((item) => item[1]).sort().join(',');
      if (found !== expected) broken.push(`${locale}: ${key} — ждали {${expected}}, в переводе {${found}}`);
    }
  }
  assert.deepEqual(broken, [], `подстановки перевода разошлись:\n${broken.join('\n')}`);
});
