'use client';

/**
 * Заголовок раздела верфи.
 *
 * Сама страница серверная (ей нужны метаданные), а язык интерфейса живёт в
 * браузере — поэтому шапку рисует маленький клиентский компонент.
 */

import { useI18n } from '@/lib/i18n/I18nContext';

export default function OutfittingHeader() {
  const { t } = useI18n();
  return (
    <>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>{t('outfitting.title')}</h1>
      <p style={{ color: 'var(--muted)', fontSize: 13, marginTop: 0, marginBottom: 16, maxWidth: 820, lineHeight: 1.6 }}>
        {t('outfitting.intro')}
      </p>
    </>
  );
}
