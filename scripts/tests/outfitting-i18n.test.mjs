/**
 * Полнота перевода раздела «Верфь».
 *
 * Раздел большой, и «забыли ключ в корейском» замечается только тогда, когда
 * пользователь видит в интерфейсе `outfitting.stats.cargo`. Поэтому проверяем
 * механически:
 *
 * 1. В каждом языке проекта есть все ключи раздела, и ни один не пустой.
 * 2. Ни один перевод не остался копией русского (кроме тех, где так и надо:
 *    единицы измерения, аббревиатуры).
 * 3. Плейсхолдеры (`{value}`, `{mass}`) не потерялись при переводе.
 * 4. Названия групп модулей покрывают весь справочник на всех языках.
 * 5. Слова инженерных чертежей переведены на всех языках одинаковым набором.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOCALES = ['ru', 'en', 'de', 'it', 'ko', 'zh', 'ja'];

let esbuild = null;
try {
  esbuild = await import('esbuild');
} catch {
  // devDependencies не установлены
}
const maybe = esbuild ? test : test.skip;

const tempDirs = [];
process.on('exit', () => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

async function loadLib() {
  const dir = mkdtempSync(join(ROOT, '.tmp-outfitting-i18n-'));
  tempDirs.push(dir);
  const entry = join(dir, 'entry.ts');
  const bundle = join(dir, 'lib.mjs');
  writeFileSync(
    entry,
    "export * from '@/lib/i18n/outfitting';\nexport * from '@/lib/outfitting/i18n';\n",
  );
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: bundle,
    alias: { '@': join(ROOT, 'src') },
    loader: { '.ts': 'ts' },
    logLevel: 'silent',
  });
  return import(bundle);
}

const libPromise = esbuild ? loadLib() : null;
const data = JSON.parse(readFileSync(join(ROOT, 'public', 'data', 'outfitting.json'), 'utf8'));

/** Ключи, где совпадение с русским законно: это символы, а не слова. */
const SAME_AS_RU_OK = new Set([
  'outfitting.unit.t',
  'outfitting.unit.mw',
  'outfitting.unit.ms',
  'outfitting.unit.mj',
  'outfitting.hl.pgen',
  'outfitting.hl.rate',
  'outfitting.hl.distributor',
]);

maybe('в каждом языке есть все ключи раздела верфи', async () => {
  const { outfittingTranslations } = await libPromise;
  const reference = Object.keys(outfittingTranslations.ru);
  assert.ok(reference.length > 90, 'ключей раздела должно быть не меньше 90');

  for (const locale of LOCALES) {
    const dict = outfittingTranslations[locale];
    assert.ok(dict, `нет словаря для языка ${locale}`);
    const missing = reference.filter((key) => !dict[key] || !String(dict[key]).trim());
    assert.deepEqual(missing, [], `в ${locale} не переведены ключи: ${missing.join(', ')}`);
    const extra = Object.keys(dict).filter((key) => !reference.includes(key));
    assert.deepEqual(extra, [], `в ${locale} лишние ключи: ${extra.join(', ')}`);
  }
});

maybe('переводы не остались русскими и не потеряли подстановки', async () => {
  const { outfittingTranslations } = await libPromise;
  const russian = outfittingTranslations.ru;

  for (const locale of LOCALES.filter((item) => item !== 'ru')) {
    const dict = outfittingTranslations[locale];
    for (const [key, value] of Object.entries(russian)) {
      if (!SAME_AS_RU_OK.has(key)) {
        assert.notEqual(dict[key], value, `${locale}: ключ ${key} не переведён`);
      }
      const placeholders = [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
      const translated = [...String(dict[key]).matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
      assert.deepEqual(translated, placeholders, `${locale}: ключ ${key} потерял подстановки`);
    }
  }
});

maybe('названия групп модулей есть для каждой группы справочника', async () => {
  const { GROUP_NAMES, groupName } = await libPromise;
  const ids = Object.keys(data.groups);
  assert.ok(ids.length >= 80, 'групп в справочнике должно быть не меньше 80');

  for (const locale of LOCALES) {
    const missing = ids.filter((id) => !GROUP_NAMES[locale]?.[id]);
    assert.deepEqual(missing, [], `в ${locale} нет названий групп: ${missing.join(', ')}`);
  }
  // Незнакомая группа не должна превращаться в голый идентификатор.
  assert.equal(groupName('en', 'pp'), 'Power Plant');
  assert.equal(groupName('fr', 'pp'), 'Power Plant', 'неизвестный язык откатывается на английский');
  assert.equal(groupName('en', 'zzz', 'Fallback'), 'Fallback');
});

maybe('слова чертежей и подвесов переведены на всех языках', async () => {
  const { BLUEPRINT_WORDS, BLUEPRINT_PREFIX, MOUNT_NAMES } = await libPromise;
  for (const table of [BLUEPRINT_WORDS, BLUEPRINT_PREFIX, MOUNT_NAMES]) {
    const reference = Object.keys(table.ru);
    for (const locale of LOCALES) {
      const missing = reference.filter((key) => !table[locale]?.[key]);
      assert.deepEqual(missing, [], `в ${locale} не хватает слов: ${missing.join(', ')}`);
    }
  }
});

maybe('подписи чертежей и модулей собираются на языке интерфейса', async () => {
  const dir = mkdtempSync(join(ROOT, '.tmp-outfitting-build-'));
  tempDirs.push(dir);
  const entry = join(dir, 'entry.ts');
  const bundle = join(dir, 'lib.mjs');
  writeFileSync(entry, "export * from '@/lib/outfitting/build';\n");
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: bundle,
    alias: { '@': join(ROOT, 'src') },
    loader: { '.ts': 'ts' },
    logLevel: 'silent',
  });
  const { blueprintLabel, moduleLabel } = await import(bundle);

  assert.equal(blueprintLabel('FSD_LongRange', 'ru'), 'FSD · дальнобойный');
  assert.equal(blueprintLabel('FSD_LongRange', 'en'), 'FSD · long range');
  assert.equal(blueprintLabel('FSD_LongRange', 'de'), 'FSA · Langstrecke');

  const shieldGenerator = (data.modules.sg ?? []).find((module) => module.class === 3);
  assert.ok(shieldGenerator, 'в справочнике должен быть генератор щита класса 3');
  assert.match(moduleLabel(data, shieldGenerator, 'ru'), /Генератор щита/);
  assert.match(moduleLabel(data, shieldGenerator, 'en'), /Shield Generator/);
  assert.equal(moduleLabel(data, null, 'ja'), '—');
});
