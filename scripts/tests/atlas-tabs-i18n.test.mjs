/**
 * Вкладки Atlas: каждый `labelKey`/`hintKey` обязан существовать во всех локалях.
 *
 * Тест появился после реального дефекта: у вкладки «PowerPlay» ключ
 * `atlas.tabPowerplay` завели только в списке вкладок, но забыли в словарях.
 * `t()` при отсутствии перевода возвращает сам ключ — интерфейс молча печатал
 * `atlas.tabPowerplay` вместо названия, и заметить это можно было только
 * переключив язык или открыв вкладку.
 *
 * Проверки:
 *   1. у каждой вкладки из `src/app/atlas/page.tsx` есть подпись и подсказка
 *      во всех семи локалях;
 *   2. значение не равно ключу (иначе видно `atlas.tab…` вместо названия);
 *   3. подстановки `{name}` в подсказке те же, что в русском оригинале;
 *   4. в модулях интерфейса PowerPlay нет русских строк: панель показывает
 *      текст ошибки как есть, поэтому запасное сообщение берётся из каталога.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const I18N_DIR = path.join(ROOT, 'src/lib/i18n');
const LOCALES = ['ru', 'en', 'de', 'it', 'ko', 'zh', 'ja'];

/** Словари: базовый и подключённые к нему разделы (см. sectionTranslations). */
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
];

const CYRILLIC = /[А-Яа-яЁё]/;
const PLACEHOLDER = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;

/** Разбор словаря: `xx: { 'key': 'value', … }` (как в i18n-locale-parity). */
function dictionaries(file) {
  const source = fs.readFileSync(path.join(I18N_DIR, file), 'utf8');
  const result = {};
  let current = null;
  for (const line of source.split('\n')) {
    const start = line.match(/^  ([a-z]{2}): \{$/);
    if (start) {
      current = start[1];
      result[current] = result[current] ?? new Map();
      continue;
    }
    if (current && /^  \},$/.test(line)) {
      current = null;
      continue;
    }
    if (!current) continue;
    const entry = line.match(/^    '([^']+)':\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"),\s*$/);
    if (entry) result[current].set(entry[1], entry[2] ?? entry[3]);
  }
  return result;
}

/** Все переводы сайта, слитые по локалям: ключ → значение. */
function merged() {
  const all = {};
  for (const locale of LOCALES) all[locale] = new Map();
  for (const file of DICTIONARIES) {
    let parsed;
    try {
      parsed = dictionaries(file);
    } catch {
      continue;
    }
    for (const [locale, entries] of Object.entries(parsed)) {
      if (!all[locale]) continue;
      for (const [key, value] of entries) all[locale].set(key, value);
    }
  }
  return all;
}

/** Вкладки Atlas: пары «ключ подписи — ключ подсказки» из списка TABS. */
function atlasTabs() {
  const page = fs.readFileSync(path.join(ROOT, 'src/app/atlas/page.tsx'), 'utf8');
  const start = page.indexOf('const TABS');
  assert.ok(start >= 0, 'в src/app/atlas/page.tsx не найден список TABS');
  const block = page.slice(start, page.indexOf('];', start));
  return [...block.matchAll(/id: '([^']+)'[\s\S]*?labelKey: '([^']+)'[\s\S]*?hintKey: '([^']+)'/g)]
    .map((match) => ({ id: match[1], labelKey: match[2], hintKey: match[3] }));
}

function placeholders(text) {
  return [...String(text).matchAll(PLACEHOLDER)].map((match) => match[1]).sort();
}

test('у каждой вкладки Atlas есть подпись и подсказка во всех локалях', () => {
  const tabs = atlasTabs();
  assert.ok(tabs.length >= 9, `в TABS найдено подозрительно мало вкладок: ${tabs.length}`);

  const dictionary = merged();
  const missing = [];
  for (const tab of tabs) {
    for (const key of [tab.labelKey, tab.hintKey]) {
      for (const locale of LOCALES) {
        if (!dictionary[locale].has(key)) missing.push(`${locale}: ${key} (вкладка ${tab.id})`);
      }
    }
  }
  assert.deepEqual(missing, [], `вкладка Atlas без перевода:\n${missing.join('\n')}`);
});

test('название вкладки не печатается ключом', () => {
  const dictionary = merged();
  const asKey = [];
  for (const tab of atlasTabs()) {
    for (const locale of LOCALES) {
      const value = dictionary[locale].get(tab.labelKey);
      if (value === tab.labelKey) asKey.push(`${locale}: ${tab.labelKey}`);
    }
  }
  assert.deepEqual(asKey, [], `перевод равен ключу:\n${asKey.join('\n')}`);
});

test('подстановки в подсказках вкладок совпадают с русским оригиналом', () => {
  const dictionary = merged();
  const broken = [];
  for (const tab of atlasTabs()) {
    const expected = placeholders(dictionary.ru.get(tab.hintKey) ?? '');
    for (const locale of LOCALES) {
      const found = placeholders(dictionary[locale].get(tab.hintKey) ?? '');
      if (found.join(',') !== expected.join(',')) broken.push(`${locale}: ${tab.hintKey}`);
    }
  }
  assert.deepEqual(broken, [], `подстановки разошлись:\n${broken.join('\n')}`);
});

test('в интерфейсе PowerPlay нет русских строк в коде', () => {
  // Панель печатает текст ошибки как есть (`{error || t(...)}`), поэтому любая
  // русская строка в этих модулях видна на любом языке. Перевод — только ключом.
  const files = [
    'src/hooks/usePowerplayLayer.ts',
    'src/components/Atlas/AtlasPowerplayPanel.tsx',
    'src/components/GalaxyMap/PowerplayGlyph.tsx',
    'src/components/GalaxyMap/PowerplaySystemCard.tsx',
  ];
  const found = [];
  for (const file of files) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\s)\/\/.*$/gm, '');
    const lines = source.split('\n');
    lines.forEach((line, index) => {
      const literal = line.match(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/);
      const text = literal ? (literal[1] ?? literal[2] ?? '') : '';
      if (CYRILLIC.test(text)) found.push(`${file}:${index + 1}: ${text}`);
    });
  }
  assert.deepEqual(found, [], `русский текст в интерфейсе:\n${found.join('\n')}`);
});
