/**
 * Полнота перевода раздела «Инженеры».
 *
 * Проверяем то же, что и у верфи, но с поправкой на данные:
 *
 * 1. В каждом языке есть все ключи интерфейса раздела, подстановки на месте.
 * 2. Каждый инженер из `data.ts` переведён на каждый язык: есть discovery,
 *    meeting, unlock, focus, а referral — там, где он есть в оригинале.
 * 3. В переводах нет «забытого» русского текста и лишних инженеров.
 * 4. Умения Одиссеи переведены для всех 25 модификаций.
 * 5. `engineerText` и `engineerSkills` возвращают перевод, а для незнакомого
 *    языка честно откатываются на русский оригинал.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOCALES = ['ru', 'en', 'de', 'it', 'ko', 'zh', 'ja'];
const CYRILLIC = /[А-Яа-яЁё]/;

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
  const dir = mkdtempSync(join(ROOT, '.tmp-engineers-i18n-'));
  tempDirs.push(dir);
  const entry = join(dir, 'entry.ts');
  const bundle = join(dir, 'lib.mjs');
  writeFileSync(
    entry,
    "export * from '@/lib/i18n/engineers';\nexport * from '@/lib/engineers/i18n';\nexport { ENGINEERS } from '@/lib/engineers/data';\n",
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

/** Подписи, где совпадение с русским законно. */
const SAME_AS_RU_OK = new Set([]);

maybe('в каждом языке есть все ключи интерфейса раздела', async () => {
  const { engineersTranslations } = await libPromise;
  const reference = Object.keys(engineersTranslations.ru);
  assert.ok(reference.length >= 40, 'ключей интерфейса должно быть не меньше 40');

  for (const locale of LOCALES) {
    const dict = engineersTranslations[locale];
    assert.ok(dict, `нет словаря для языка ${locale}`);
    const missing = reference.filter((key) => !dict[key] || !String(dict[key]).trim());
    assert.deepEqual(missing, [], `в ${locale} не переведены ключи: ${missing.join(', ')}`);
    const extra = Object.keys(dict).filter((key) => !reference.includes(key));
    assert.deepEqual(extra, [], `в ${locale} лишние ключи: ${extra.join(', ')}`);
  }
});

maybe('подписи интерфейса переведены и сохранили подстановки', async () => {
  const { engineersTranslations } = await libPromise;
  const russian = engineersTranslations.ru;

  for (const locale of LOCALES.filter((item) => item !== 'ru')) {
    const dict = engineersTranslations[locale];
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

maybe('у каждого инженера есть перевод всех текстовых полей', async () => {
  const { ENGINEERS, engineerText } = await libPromise;
  assert.ok(ENGINEERS.length >= 38, 'инженеров должно быть не меньше 38');

  for (const locale of LOCALES.filter((item) => item !== 'ru')) {
    for (const engineer of ENGINEERS) {
      const fields = ['discovery', 'meeting', 'unlock', 'focus', ...(engineer.referral ? ['referral'] : [])];
      for (const field of fields) {
        const value = engineerText(locale, engineer, field);
        assert.ok(value && value.trim(), `${locale}/${engineer.id}: пустое поле ${field}`);
        if (field === 'meeting' && engineer[field] === '—') continue;
        assert.notEqual(value, engineer[field], `${locale}/${engineer.id}: поле ${field} не переведено`);
        assert.ok(!CYRILLIC.test(value), `${locale}/${engineer.id}: в поле ${field} остался русский текст`);
      }
    }
  }
});

maybe('умения Одиссеи переведены на всех языках', async () => {
  const { ENGINEERS, SKILL_NAMES, engineerSkills } = await libPromise;
  const russianSkills = new Set(ENGINEERS.flatMap((engineer) => engineer.skills ?? []));
  assert.ok(russianSkills.size >= 20, 'модификаций Одиссеи должно быть не меньше 20');

  for (const locale of LOCALES.filter((item) => item !== 'ru')) {
    const missing = [...russianSkills].filter((skill) => !SKILL_NAMES[locale]?.[skill]);
    assert.deepEqual(missing, [], `в ${locale} не переведены умения: ${missing.join(', ')}`);
  }

  const navarro = ENGINEERS.find((engineer) => engineer.id === 'navarro');
  assert.deepEqual(engineerSkills('en', navarro)?.[0], 'Reload Speed');
  assert.deepEqual(engineerSkills('ru', navarro), navarro.skills, 'русский список остаётся исходным');
  assert.equal(engineerSkills('en', ENGINEERS.find((engineer) => engineer.id === 'farseer')), undefined);
});

maybe('незнакомый язык откатывается на русский оригинал', async () => {
  const { ENGINEERS, engineerText, engineerSearchText } = await libPromise;
  const farseer = ENGINEERS.find((engineer) => engineer.id === 'farseer');
  assert.equal(engineerText('fr', farseer, 'focus'), farseer.focus);
  assert.equal(engineerText('en', farseer, 'meeting'), 'Exploration rank Scout or higher.');
  // Поиск должен находить инженера и по переводу, и по русскому исходнику.
  const haystack = engineerSearchText('en', farseer).toLowerCase();
  assert.ok(haystack.includes('deciat'));
  assert.ok(haystack.includes('explorer'));
  assert.ok(haystack.includes('двигатели'));
});
