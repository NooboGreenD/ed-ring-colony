'use client';

import { useI18n } from '@/lib/i18n/I18nContext';

interface WikiArticleMetaProps {
  author?: string | null;
  views?: number | null;
  date: string;
}

/** Строка «автор · просмотры · дата» для списков вики. */
export default function WikiArticleMeta({ author, views, date }: WikiArticleMetaProps) {
  const { t, locale } = useI18n();

  return (
    <>
      {t('wa.meta', {
        author: author || t('wa.unknownAuthor'),
        count: views || 0,
        date: new Date(date).toLocaleDateString(locale),
      })}
    </>
  );
}
