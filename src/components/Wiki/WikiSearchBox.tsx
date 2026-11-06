'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { IconSearch } from '@/components/Icons';
import { useI18n } from '@/lib/i18n/I18nContext';

export default function WikiSearchBox() {
  const { t } = useI18n();
  const [q, setQ] = useState('');
  const router = useRouter();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (q.trim()) router.push(`/wiki/search?q=${encodeURIComponent(q.trim())}`);
  }

  return (
    <form onSubmit={handleSubmit} style={{ position: 'relative', maxWidth: 400 }}>
      <input
        value={q}
        onChange={e => setQ(e.target.value)}
        placeholder={t('wsearch.placeholder')}
        style={{ width: '100%', paddingLeft: 36, fontSize: 13 }}
      />
      <IconSearch size={14} color="var(--muted)" style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)' }} />
    </form>
  );
}
