import { cookies } from 'next/headers';
import { translations, SUPPORTED_LOCALES } from './translations';

const COOKIE_KEY = 'ed-ring-locale';

/** Локаль из cookie — её ставит LanguageSwitcher и I18nProvider. */
export function normalizeServerLocale(raw: string | null | undefined): string {
  if (!raw) return 'ru';
  const base = raw.split('-')[0].toLowerCase();
  return SUPPORTED_LOCALES.includes(base as (typeof SUPPORTED_LOCALES)[number]) ? base : 'ru';
}

export type ServerT = (key: string, params?: Record<string, string | number>) => string;

/**
 * Перевод строк в серверных компонентах и `generateMetadata`.
 *
 * Локаль берётся из cookie: страницы, которым нужен перевод, читают её на
 * каждом запросе, поэтому рендер становится динамическим.
 */
export async function getServerI18n(): Promise<{ locale: string; t: ServerT }> {
  const store = await cookies();
  const locale = normalizeServerLocale(store.get(COOKIE_KEY)?.value);
  const dict = translations[locale] || translations['ru'];
  const t: ServerT = (key, params) => {
    const template = dict[key] ?? translations['ru'][key] ?? key;
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (match, name: string) => (
      name in params ? String(params[name]) : match
    ));
  };
  return { locale, t };
}
