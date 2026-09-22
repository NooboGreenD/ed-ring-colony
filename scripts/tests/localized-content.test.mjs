import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * Чтение локализованного контента (главная, подвал, лента) — общий слой для
 * сайта и админки.
 *
 * Здесь собраны ровно те правила, из-за которых правки в админке «не
 * применялись»: язык берётся из белого списка, перевод текущей локали важнее
 * базовой колонки, пустая строка ссылки означает «ссылки нет», а payload
 * записи обязан содержать и базовую колонку, и переводы.
 */

async function loadModule(relative) {
  try {
    return await import(relative);
  } catch (error) {
    return { __unavailable: String(error?.message || error) };
  }
}

const localized = await loadModule('../../src/lib/localizedContent.ts');
const footer = await loadModule('../../src/lib/siteFooter.ts');
// Импорт .ts требует Node ≥ 22.6 (stripping типов) — в старых рантаймах
// тесты честно пропускаются, а не падают.
const skip = localized.__unavailable || footer.__unavailable
  ? `нужен Node с поддержкой TypeScript: ${localized.__unavailable || footer.__unavailable}`
  : false;

test('locale whitelist: только известные языки попадают в имя колонки', { skip }, () => {
  assert.equal(localized.safeContentLocale('de-DE'), 'de');
  assert.equal(localized.safeContentLocale('JA'), 'ja');
  assert.equal(localized.safeContentLocale(''), 'ru');
  assert.equal(localized.safeContentLocale(null), 'ru');
  // Попытка протащить что-то кроме кода языка обязана откатиться к дефолту:
  // значение участвует в формировании имени колонки.
  assert.equal(localized.safeContentLocale('../../etc/passwd'), 'ru');
  assert.equal(localized.safeContentLocale('en), body_en'), 'ru');
  assert.equal(localized.safeContentLocale('pl'), 'ru', 'языка перевода нет — отдаём русский');
});

test('localizedValue: перевод локали → базовая колонка → пусто', { skip }, () => {
  const row = {
    title: 'Кольцо строится',
    title_de: 'Der Ring wird gebaut',
    title_it: '   ',
    body: 'Текст',
  };
  assert.equal(localized.localizedValue(row, 'title', 'de'), 'Der Ring wird gebaut');
  assert.equal(localized.localizedValue(row, 'title', 'it'), 'Кольцо строится', 'пустой перевод не показывается');
  assert.equal(localized.localizedValue(row, 'title', 'ja'), 'Кольцо строится');
  assert.equal(localized.localizedValue(row, 'body', 'ja'), 'Текст');
  assert.equal(localized.localizedValue(null, 'title', 'de'), '');
  assert.equal(localized.localizedValue({}, 'title', 'de'), '');
});

test('missingTranslationLangs: список языков без полного перевода', { skip }, () => {
  const row = {
    title_ru: 'r', body_ru: 'b',
    title_en: 'e', // body_en отсутствует → en не готов
    title_de: 'd', body_de: 'dd',
  };
  const missing = localized.missingTranslationLangs(row, ['title', 'body']);
  assert.ok(missing.includes('en'));
  assert.equal(missing.includes('de'), false);
  assert.ok(missing.includes('ja'));
  // Строки нет вообще → нужны все языки, иначе админка покажет «переведено».
  assert.equal(localized.missingTranslationLangs(null, ['title']).length, 7);
});

test('footerFromContent: правка админа видна на сайте в любой локали', { skip }, () => {
  const row = {
    footer_copyright: '© 2026 Кольцо',
    footer_copyright_de: '© 2026 Der Ring',
    footer_edsm: 'https://edsm.example/',
    footer_edsm_de: '',
    footer_discord: '',
    footer_discord_ru: 'https://discord.gg/edited',
  };
  assert.equal(footer.footerFromContent(row, 'de').copyright, '© 2026 Der Ring');
  assert.equal(footer.footerFromContent(row, 'ru').copyright, '© 2026 Кольцо');
  // Пустой перевод де не затирает базовую колонку — читатель остаётся с ссылкой.
  assert.equal(footer.footerFromContent(row, 'de').edsm, 'https://edsm.example/');
  // Базовая колонка пустая, но для ru есть значение: его и показываем.
  assert.equal(footer.footerFromContent(row, 'ru').discord, 'https://discord.gg/edited');
  assert.equal(footer.footerFromContent(row, 'en').discord, '', 'для en правок не было');
  // Совсем без записи — дефолты проекта, подвал не обязан быть пустым.
  const empty = footer.footerFromContent(null, 'ru');
  assert.match(empty.copyright, /Galaxy Ring Project/);
  assert.match(empty.inara, /inara\.cz/);
});

test('buildSiteContentPayload: пишем и базовые колонки, и переводы', { skip }, () => {
  const payload = footer.buildSiteContentPayload({
    footer_edsm: { ru: 'https://edsm.example/', en: 'https://edsm.example/en', de: '' },
    footer_copyright: { ru: '© 2026', en: '© 2026 EN' },
  });
  assert.equal(payload.footer_edsm, 'https://edsm.example/', 'база = русский, иначе старые читатели потеряют правку');
  assert.equal(payload.footer_edsm_ru, 'https://edsm.example/');
  assert.equal(payload.footer_edsm_en, 'https://edsm.example/en');
  assert.equal(payload.footer_edsm_de, '', 'пустой перевод пишется как есть — это осознанное «удалить»');
  assert.equal(payload.footer_copyright, '© 2026');
  assert.equal(payload.footer_copyright_en, '© 2026 EN');
});
