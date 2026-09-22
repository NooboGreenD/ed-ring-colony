/**
 * Единое чтение локализованных полей (`title_ru`, `manifest_en`, …) из строк
 * Supabase.
 *
 * Колонки переводов добавлены миграцией, но на «минимальных» базах их может не
 * быть, поэтому все читатели сайтов должны работать по одному правилу:
 * колонка текущей локали → базовая колонка → пусто. Список имён в `select()`
 * намеренно не используется этими хелперами — запросы берут `*`.
 */
// Список языков берётся из общего ядра (scripts/lib), а не из Next-обёртки:
// тогда хелпер читают и роуты, и `node --test` без алиаса `@/`.
import { SUPPORTED_TRANSLATION_LANGS } from '../../scripts/lib/translate.mjs';

const SAFE_LOCALES = new Set<string>(SUPPORTED_TRANSLATION_LANGS);

/** Site default: всё, что не переводилось, остаётся русским. */
export const DEFAULT_CONTENT_LOCALE = 'ru';

/** Локаль приходит из query/URL и подставляется в имя колонки — только белый список. */
export function safeContentLocale(value: string | null | undefined): string {
  const locale = (value || '').toLowerCase().split('-')[0];
  return SAFE_LOCALES.has(locale) ? locale : DEFAULT_CONTENT_LOCALE;
}

export function localizedValue(
  row: Record<string, unknown> | null | undefined,
  base: string,
  locale: string,
): string {
  if (!row) return '';
  const translated = row[`${base}_${locale}`];
  if (typeof translated === 'string' && translated.trim()) return translated;
  const fallback = row[base];
  return typeof fallback === 'string' ? fallback : '';
}

/**
 * Есть ли у строки перевод хотя бы в одной из колонок `field_<lang>`.
 * Нужен админке и мониторингу, чтобы отличить «переведено» от «пусто».
 */
export function missingTranslationLangs(
  row: Record<string, unknown> | null | undefined,
  fields: string[],
): string[] {
  if (!row) return [...SUPPORTED_TRANSLATION_LANGS];
  return SUPPORTED_TRANSLATION_LANGS.filter((lang) =>
    fields.some((field) => {
      const value = row[`${field}_${lang}`];
      return typeof value !== 'string' || !value.trim();
    }),
  );
}
