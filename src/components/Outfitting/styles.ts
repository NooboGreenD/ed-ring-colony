/** Общие стили верфи: те же цвета и типографика, что и на остальном сайте. */

import type { CSSProperties } from 'react';

export const MONO = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';

export const PANEL: CSSProperties = {
  background: 'var(--panel)',
  border: '1px solid var(--line)',
  borderRadius: 3,
  padding: 12,
};

export const LABEL: CSSProperties = {
  fontSize: 10.5,
  letterSpacing: 2,
  textTransform: 'uppercase',
  color: 'var(--muted)',
  fontFamily: MONO,
};

export function button(active = false, accent = 'var(--orange)'): CSSProperties {
  return {
    background: active ? 'rgba(230,126,34,0.12)' : 'transparent',
    border: `1px solid ${active ? accent : 'var(--line)'}`,
    color: active ? accent : 'var(--muted)',
    borderRadius: 2,
    padding: '6px 10px',
    fontSize: 11,
    cursor: 'pointer',
    fontFamily: MONO,
    letterSpacing: 1,
    textTransform: 'uppercase',
    whiteSpace: 'nowrap',
    margin: 0,
  };
}

/** Разделители групп и дробной части берём из языка интерфейса. */
const NUMBER_LOCALES: Record<string, string> = {
  ru: 'ru-RU', en: 'en-GB', de: 'de-DE', it: 'it-IT', ko: 'ko-KR', zh: 'zh-CN', ja: 'ja-JP',
};

export function numberLocale(locale: string): string {
  return NUMBER_LOCALES[locale] ?? NUMBER_LOCALES.en;
}

/** Число в формате языка интерфейса: 12 345,6 / 12,345.6 */
export function num(value: number, digits = 1, locale = 'ru'): string {
  if (!Number.isFinite(value)) return '—';
  return value.toLocaleString(numberLocale(locale), { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** Кредиты: 142 456 440 CR */
export function credits(value: number, locale = 'ru'): string {
  if (!Number.isFinite(value)) return '—';
  return `${Math.round(value).toLocaleString(numberLocale(locale))} CR`;
}

/**
 * Форматтеры, привязанные к языку: удобнее, чем таскать локаль в каждый
 * вызов внутри разметки.
 */
export function formatters(locale: string) {
  return {
    num: (value: number, digits = 1) => num(value, digits, locale),
    credits: (value: number) => credits(value, locale),
    date: (value: string | number | Date) => {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString(numberLocale(locale));
    },
  };
}
