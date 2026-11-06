import { translations } from './translations';

/**
 * Активная локаль для чистых функций форматирования (даты, числа, единицы),
 * которые вызываются вне компонентов и не могут получить `t` из контекста.
 * Значение выставляет I18nProvider при каждом рендере.
 */
let activeLocale = 'ru';

export function setFormatLocale(locale: string | null | undefined): void {
  const base = (locale || 'ru').split('-')[0].toLowerCase();
  activeLocale = translations[base] ? base : 'ru';
}

export function getFormatLocale(): string {
  return activeLocale;
}

/** Перевод строки вне React-дерева: тем же каталогом, что и `t` из контекста. */
export function formatTranslate(key: string, params?: Record<string, string | number>): string {
  const dict = translations[activeLocale] || translations['ru'];
  const template = dict[key] ?? translations['ru'][key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (
    name in params ? String(params[name]) : match
  ));
}
