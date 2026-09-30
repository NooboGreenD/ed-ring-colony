'use client';

/**
 * Заголовок раздела инженеров: страница серверная (метаданные), а язык
 * интерфейса известен только в браузере.
 */

import { useI18n } from '@/lib/i18n/I18nContext';

export default function EngineersHeader() {
  const { t } = useI18n();
  return (
    <>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>{t('engineers.title')}</h1>
      <p style={{ color: 'var(--muted)', fontSize: 13, marginTop: 0, marginBottom: 16, maxWidth: 820, lineHeight: 1.6 }}>
        {t('engineers.intro')}
      </p>
    </>
  );
}
