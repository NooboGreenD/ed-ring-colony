import type { Metadata } from 'next';
import EngineersHeader from '@/components/Engineers/EngineersHeader';
import EngineerTree from '@/components/Engineers/EngineerTree';
import { getServerI18n } from '@/lib/i18n/server';

// Язык интерфейса на этапе метаданных ещё неизвестен, поэтому заголовок
// двуязычный — страницу находят и русским, и английским запросом.
export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerI18n();

  return {
    title: t('meta.engineersTitle'),
    description: t('meta.engineersDescription'),
  };
}

export default function EngineersPage() {
  return (
    <main style={{ maxWidth: 1400, margin: '0 auto', padding: '24px 16px 48px' }}>
      <EngineersHeader />
      <EngineerTree />
    </main>
  );
}
