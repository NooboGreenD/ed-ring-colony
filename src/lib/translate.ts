/**
 * Тонкая обёртка над общим модулем перевода (scripts/lib/translate.mjs).
 *
 * Логика перевода живёт в одном месте и переиспользуется
 * Next.js-роутами и автономными скриптами GitHub Actions.
 * Здесь сохранены прежние сигнатуры, чтобы не ломать админку и крон-роуты.
 */

import {
  buildTranslationUpdate,
  hasTranslateCredentials,
  translateArticleFields as translateArticleFieldsCore,
  translateTexts as translateTextsCore,
} from '../../scripts/lib/translate.mjs';

export const SUPPORTED_TRANSLATION_LANGS = ['ru', 'en', 'de', 'it', 'ko', 'zh', 'ja'] as const;
export type TranslationLang = (typeof SUPPORTED_TRANSLATION_LANGS)[number];

export interface TranslationResult {
  title: Record<TranslationLang, string>;
  body: Record<TranslationLang, string>;
  translatedAt: string;
}

export { hasTranslateCredentials };

/**
 * Переводит массив текстов на один язык (batch, с повторами и нарезкой
 * длинных текстов). Используется админкой (/api/translate).
 */
export async function translateTexts(
  texts: string[],
  targetLang: TranslationLang,
  sourceLang = 'en'
): Promise<string[]> {
  return translateTextsCore(texts, targetLang, sourceLang);
}

/**
 * Переводит заголовок и тело на все поддерживаемые языки.
 * Язык оригинала копируется без обращения к API; падение одного языка
 * не отменяет остальные переводы.
 */
export async function translateToAllLangs(
  title: string,
  body: string,
  sourceLang: string = 'en'
): Promise<TranslationResult> {
  const result = await translateArticleFieldsCore({
    title,
    body,
    sourceLang,
    langs: SUPPORTED_TRANSLATION_LANGS,
  });

  return {
    title: result.title as Record<TranslationLang, string>,
    body: result.body as Record<TranslationLang, string>,
    translatedAt: result.translatedAt,
  };
}

/**
 * Язык оригинала по умолчанию. В `galnet_news` базовые колонки приходят с
 * Galnet на английском, а в `news` редактор пишет по-русски (см. миграции:
 * русские значения остаются в базовых полях, переводы — в `*_en` и т.д.).
 * Раньше для обеих таблиц жёстко стоял 'en', и Yandex получал русский текст
 * с просьбой «перевести с английского» — отсюда пустые или мусорные блоки.
 */
export const TABLE_SOURCE_LANG: Record<'news' | 'galnet_news', string> = {
  news: 'ru',
  galnet_news: 'en',
};

/**
 * Переводит статью и сохраняет переводы в указанную таблицу.
 * Поддерживаемые таблицы: `news` и `galnet_news`.
 */
export async function translateAndSaveArticle(
  table: 'news' | 'galnet_news',
  articleId: number | string,
  title: string,
  body: string,
  supabase: any,
  sourceLang?: string | null
): Promise<{ missingLangs: string[] }> {
  const lang = (sourceLang || TABLE_SOURCE_LANG[table] || 'en').trim().toLowerCase();
  const translation = await translateArticleFieldsCore({
    title,
    body,
    sourceLang: lang,
    langs: SUPPORTED_TRANSLATION_LANGS,
  });

  const updateData = buildTranslationUpdate(translation, SUPPORTED_TRANSLATION_LANGS);

  // `translation_status` уже посчитан в buildTranslationUpdate по факту
  // полученного: 'completed', если закрыты все языки, иначе 'partial' —
  // такая строка останется в очереди крона и её доберёт кнопка в админке.
  const missing = SUPPORTED_TRANSLATION_LANGS.filter(
    (code) => !(String((updateData as any)[`title_${code}`] ?? '').trim()
      && String((updateData as any)[`body_${code}`] ?? '').trim())
  );

  const { error } = await supabase.from(table).update(updateData).eq('id', articleId);
  if (error) throw error;

  return { missingLangs: missing };
}
