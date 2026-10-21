/**
 * Перевод меню: каждый ключ `nav.*` из словаря типов обязан существовать во всех
 * поддерживаемых локалях.
 *
 * Тест появился после реального дефекта: раздел Atlas не был добавлен в боковое
 * меню, а подписи мобильной навигации были захардкожены по-русски. Теперь
 * добавление пункта без перевода останавливает `npm test`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const types = fs.readFileSync(path.join(ROOT, 'src/lib/i18n/types.ts'), 'utf8');
const translations = fs.readFileSync(path.join(ROOT, 'src/lib/i18n/translations.ts'), 'utf8');

const LOCALES = ['ru', 'en', 'de', 'it', 'ko', 'zh', 'ja'];

/** Ключи, объявленные в union-типе TranslationKey. */
function declaredKeys() {
  return [...types.matchAll(/\|\s*'([^']+)'/g)].map((match) => match[1]);
}

/** Разбор словарей: `ru: { 'key': 'value', ... }` внутри baseTranslations. */
function localeDictionaries() {
  const dictionaries = {};
  const lines = translations.split('\n');
  let current = null;
  for (const line of lines) {
    const start = line.match(/^  ([a-z]{2}): \{$/);
    if (start) {
      current = start[1];
      dictionaries[current] = new Set();
      continue;
    }
    if (current && /^  \},$/.test(line)) {
      current = null;
      continue;
    }
    if (!current) continue;
    const key = line.match(/^\s+'([^']+)':/);
    if (key) dictionaries[current].add(key[1]);
  }
  return dictionaries;
}

test('словарь меню: все локали содержат объявленные ключи', () => {
  const dictionaries = localeDictionaries();
  for (const locale of LOCALES) {
    assert.ok(dictionaries[locale], `в translations.ts нет блока локали ${locale}`);
  }

  const missing = [];
  for (const key of declaredKeys()) {
    if (!key.startsWith('nav.')) continue;
    for (const locale of LOCALES) {
      if (!dictionaries[locale].has(key)) missing.push(`${locale}: ${key}`);
    }
  }
  assert.deepEqual(missing, [], `нет переводов:\n${missing.join('\n')}`);
});

test('словарь меню: каждый пункт Sidebar переведён во всех локалях', () => {
  const sidebar = fs.readFileSync(path.join(ROOT, 'src/components/Sidebar.tsx'), 'utf8');
  const dictionaries = localeDictionaries();
  // Подпункты используют labelKey — их тоже обязательно переводить.
  const keys = new Set([
    ...[...sidebar.matchAll(/(?:translation|labelKey): '([^']+)'/g)].map((match) => match[1]),
  ]);
  assert.ok(keys.size >= 15, `в Sidebar найдено подозрительно мало ключей: ${keys.size}`);

  const missing = [];
  for (const key of keys) {
    for (const locale of LOCALES) {
      if (!dictionaries[locale].has(key)) missing.push(`${locale}: ${key}`);
    }
  }
  assert.deepEqual(missing, [], `пункт меню без перевода:\n${missing.join('\n')}`);
});

test('страница целей сообщества переведена во всех локалях', () => {
  const dictionaries = localeDictionaries();
  const goalKeys = declaredKeys().filter((key) => key.startsWith('cg.'));
  assert.ok(goalKeys.length >= 10, 'ключи страницы целей сообщества не объявлены в типах');
  for (const locale of LOCALES) {
    for (const key of goalKeys) {
      assert.ok(dictionaries[locale].has(key), `${locale}: нет перевода ${key}`);
    }
  }
});

test('словарь меню: ключи мобильной навигации переведены', () => {
  const mobileNav = fs.readFileSync(path.join(ROOT, 'src/components/MobileNav.tsx'), 'utf8');
  const dictionaries = localeDictionaries();
  for (const match of mobileNav.matchAll(/translation: '([^']+)'/g)) {
    for (const locale of LOCALES) {
      assert.ok(dictionaries[locale].has(match[1]), `${locale}: нет перевода ${match[1]}`);
    }
  }
});
