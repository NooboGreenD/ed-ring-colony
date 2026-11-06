'use client';

import React from 'react';
import { useI18n, type TranslationParams } from '@/lib/i18n/I18nContext';

/**
 * Перевод одной строки внутри серверного компонента.
 * Клиентский островок, чтобы подписи жили в общем каталоге.
 */
export function Tr({ k, params }: { k: string; params?: TranslationParams }) {
  const { t } = useI18n();
  return <>{t(k, params)}</>;
}

/** Дата в текущей локали — для серверных компонентов. */
export function LocaleDate({ value, withTime = false }: { value: string | number | Date; withTime?: boolean }) {
  const { locale } = useI18n();
  const date = value instanceof Date ? value : new Date(value);
  return <>{withTime ? date.toLocaleString(locale) : date.toLocaleDateString(locale)}</>;
}
