/**
 * Локали сайта: словари шести языков обязаны совпадать с русским ключ в ключ.
 *
 * Тест появился после реального дефекта: у разделов «Техподдержка», «Магазин»,
 * «Биллинг» и «Комментарии» ключи завели только в `ru` и `en`. Русский
 * подставлялся молча — `t()` при отсутствии перевода берёт оригинал, — поэтому
 * немец, итальянец, кореец, китаец и японец видели русские подписи в рабочем
 * интерфейсе, и заметить это можно было только вручную, переключив язык.
 *
 * Проверки:
 *   1. набор ключей каждой локали равен русскому (нет «полураздела»);
 *   2. ни один перевод не пустой;
 *   3. подстановки `{name}` в переводе те же, что в оригинале — иначе
 *      `t('… {count} …')` напечатает литерал `{count}`;
 *   4. в переводе не осталось русских слов: строка, скопированная из `ru`,
 *      выглядит переведённой для теста, но не для командира. Исключение —
 *      ключи `lang.*`: название языка пишется на нём самом.
 *
 * Разбор построчный, как в `menu-i18n.test.mjs`: словари лежат в TS-файлах
 * объектами, и импортировать их без сборки нельзя.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const I18N_DIR = path.join(ROOT, 'src/lib/i18n');

/** Словари: базовый и подключённые к нему разделы (см. sectionTranslations). */
const DICTIONARIES = [
  'translations.ts',
  'engineers.ts',
  'outfitting.ts',
  'outfittingAnalysis.ts',
  'outfittingSpecials.ts',
];

const LOCALES = ['ru', 'en', 'de', 'it', 'ko', 'zh', 'ja'];

/** Названия языков пишутся на самих языках: «Русский» в `de` — это норма. */
const NATIVE_NAME_KEY = /^lang\./;

const CYRILLIC = /[А-Яа-яЁё]/;
const PLACEHOLDER = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;

/** Значение может быть в одинарных или двойных кавычках, с экранированием. */
const ENTRY = /^\s+'([^']+)':\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")\s*,\s*$/;

function dictionaries(file) {
  const source = fs.readFileSync(path.join(I18N_DIR, file), 'utf8');
  const result = {};
  let current = null;
  for (const line of source.split('\n')) {
    const start = line.match(/^  ([a-z]{2}): \{$/);
    if (start) {
      current = start[1];
      result[current] = new Map();
      continue;
    }
    if (current && /^  \},$/.test(line)) {
      current = null;
      continue;
    }
    if (!current) continue;
    const entry = line.match(ENTRY);
    if (entry) result[current].set(entry[1], entry[2] ?? entry[3]);
  }
  return result;
}

function placeholders(text) {
  return [...String(text).matchAll(PLACEHOLDER)].map((match) => match[1]).sort();
}

function describe(missing) {
  return missing.slice(0, 12).join(', ') + (missing.length > 12 ? `, … ещё ${missing.length - 12}` : '');
}

for (const file of DICTIONARIES) {
  const dict = dictionaries(file);
  const source = dict.ru;
  assert.ok(source && source.size > 0, `${file}: нет русского словаря — разбор сломался`);

  test(`${file}: у каждой локали тот же набор ключей, что в русском`, () => {
    for (const locale of LOCALES) {
      const target = dict[locale] ?? new Map();
      const missing = [...source.keys()].filter((key) => !target.has(key));
      const extra = [...target.keys()].filter((key) => !source.has(key));
      assert.deepEqual(missing, [],
        `${file}/${locale}: нет перевода — ${describe(missing)}`);
      assert.deepEqual(extra, [],
        `${file}/${locale}: ключей нет в русском словаре — ${describe(extra)}`);
    }
  });

  test(`${file}: ни один перевод не пустой`, () => {
    for (const locale of LOCALES) {
      for (const [key, value] of dict[locale] ?? new Map()) {
        assert.ok(String(value).trim(), `${file}/${locale}: пустой перевод ${key}`);
      }
    }
  });

  test(`${file}: подстановки в переводе совпадают с оригиналом`, () => {
    for (const locale of LOCALES) {
      if (locale === 'ru') continue;
      const target = dict[locale] ?? new Map();
      for (const [key, value] of source) {
        if (!target.has(key)) continue;
        assert.deepEqual(placeholders(target.get(key)), placeholders(value),
          `${file}/${locale}: подстановки не совпадают — ${key}`);
      }
    }
  });

  test(`${file}: перевод не остался русским текстом`, () => {
    for (const locale of LOCALES) {
      if (locale === 'ru') continue;
      const left = [...(dict[locale] ?? new Map())]
        .filter(([key, value]) => !NATIVE_NAME_KEY.test(key) && CYRILLIC.test(value))
        .map(([key, value]) => `${key} = ${JSON.stringify(value)}`);
      assert.deepEqual(left, [],
        `${file}/${locale}: русский текст в переводе — ${describe(left)}`);
    }
  });
}

/**
 * Обратная проверка: ключ, который код запрашивает, но которого нет в словаре.
 *
 * `t()` при отсутствии ключа возвращает сам ключ — то есть в интерфейсе
 * появляется `accountoken.created`. Именно так и случилось: в блоке токенов
 * личного кабинета стояло `t('accountoken.created')` вместо
 * `t('account.created')`, и вместо даты создания командир видел имя ключа.
 * Проверка ловит опечатку до того, как её увидит человек.
 *
 * Динамические ключи (шаблонные строки и склейки) здесь не проверяются: у них
 * нет литерала, который можно сверить.
 */
function sourceFiles(dir, result = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, result);
    else if (/\.(ts|tsx)$/.test(entry.name)) result.push(full);
  }
  return result;
}

function declaredKeys() {
  const keys = new Set();
  for (const file of DICTIONARIES) {
    for (const [key] of dictionaries(file).ru ?? new Map()) keys.add(key);
  }
  return keys;
}

test('все ключи, которые запрашивает код, есть в словаре', () => {
  const declared = declaredKeys();
  const missing = [];
  for (const file of sourceFiles(path.join(ROOT, 'src'))) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/\bt\(\s*['"]([A-Za-z0-9_.]+)['"]/g)) {
      if (!declared.has(match[1])) {
        missing.push(`${path.relative(ROOT, file)}: ${match[1]}`);
      }
    }
  }
  assert.deepEqual([...new Set(missing)], [],
    'ключ запрошен, но не объявлен — в интерфейсе будет имя ключа: ' + describe(missing));
});
