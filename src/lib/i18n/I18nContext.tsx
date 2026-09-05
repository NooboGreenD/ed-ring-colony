'use client';

import React, { createContext, useContext, useCallback, useState, useEffect } from 'react';
import { translations, SUPPORTED_LOCALES, LOCALE_NAMES, LOCALE_FLAGS } from './translations';

const STORAGE_KEY = 'ed-ring-locale';
const COOKIE_KEY = 'ed-ring-locale';

function normalizeLocale(raw: string | null): string {
  if (!raw) return 'ru';
  const base = raw.split('-')[0].toLowerCase();
  if (SUPPORTED_LOCALES.includes(base as any)) return base;
  return 'ru';
}

function getLocaleFromStorage(): string {
  if (typeof window === 'undefined') return 'ru';
  const stored = localStorage.getItem(STORAGE_KEY);
  return normalizeLocale(stored);
}

function setLocaleCookie(locale: string) {
  if (typeof document === 'undefined') return;
  document.cookie = `${COOKIE_KEY}=${locale};path=/;max-age=${60 * 60 * 24 * 365};SameSite=Lax`;
}

interface I18nContextType {
  locale: string;
  setLocale: (locale: string) => void;
  t: (key: string) => string;
  supportedLocales: string[];
  localeNames: Record<string, string>;
  localeFlags: Record<string, string>;
}

const I18nContext = createContext<I18nContextType>({
  locale: 'ru',
  setLocale: () => {},
  t: (key: string) => key,
  supportedLocales: SUPPORTED_LOCALES,
  localeNames: LOCALE_NAMES,
  localeFlags: LOCALE_FLAGS,
});

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState(() => getLocaleFromStorage());

  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) {
        const next = normalizeLocale(e.newValue);
        setLocaleState(next);
        setLocaleCookie(next);
      }
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, []);

  const setLocale = useCallback((newLocale: string) => {
    const normalized = normalizeLocale(newLocale);
    if (typeof window !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, normalized);
      setLocaleCookie(normalized);
      setLocaleState(normalized);
    }
  }, []);

  const t = useCallback(
    (key: string) => {
      const dict = translations[locale] || translations['ru'];
      return dict[key] ?? key;
    },
    [locale]
  );

  const value = {
    locale,
    setLocale,
    t,
    supportedLocales: SUPPORTED_LOCALES,
    localeNames: LOCALE_NAMES,
    localeFlags: LOCALE_FLAGS,
  };

  return (
    <I18nContext.Provider value={value}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  return useContext(I18nContext);
}
