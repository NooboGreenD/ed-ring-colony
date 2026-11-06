/**
 * Заглушка `@/lib/i18n/I18nContext` для jsdom-тестов интерфейса.
 *
 * Сборка теста идёт без провайдера локали, поэтому `t` из контекста возвращал
 * бы сам ключ. Здесь он смотрит в русский словарь — ровно так видит страницу
 * пилот с локалью по умолчанию.
 */
export const I18N_CONTEXT_STUB = `
import * as React from 'react';
import { translations } from '@/lib/i18n/translations';

const ru = (translations.ru || {}) as Record<string, string>;

export function translate(key: string, params?: Record<string, string | number>): string {
  const template = ru[key] ?? key;
  if (!params) return template;
  return template.replace(/\\{(\\w+)\\}/g, (match, name) => (name in params ? String(params[name]) : match));
}

export function useI18n() {
  return {
    locale: 'ru',
    setLocale: () => {},
    t: translate,
    supportedLocales: ['ru'],
    localeNames: {},
    localeFlags: {},
  };
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  return children;
}
`;
