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
 * Переводит статью и сохраняет переводы в указанную таблицу.
 * Поддерживаемые таблицы: `news` и `galnet_news`.
 */
export async function translateAndSaveArticle(
  table: 'news' | 'galnet_news',
  articleId: number | string,
  title: string,
  body: string,
  supabase: any,
  sourceLang: string = 'en'
): Promise<void> {
  const translation = await translateArticleFieldsCore({
    title,
    body,
    sourceLang,
    langs: SUPPORTED_TRANSLATION_LANGS,
  });

  const updateData = buildTranslationUpdate(translation, SUPPORTED_TRANSLATION_LANGS);

  const { error } = await supabase.from(table).update(updateData).eq('id', articleId);
  if (error) throw error;

  // Частичный успех не считаем ошибкой — статья уже читаема на части языков.
}
