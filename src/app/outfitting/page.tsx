import type { Metadata } from 'next';
import OutfittingHeader from '@/components/Outfitting/OutfittingHeader';
import OutfittingWorkspace from '@/components/Outfitting/OutfittingWorkspace';
import { getServerI18n } from '@/lib/i18n/server';

// Метаданные отдаются до того, как станет известен язык браузера, поэтому
// заголовок двуязычный: так страницу находят и русским, и английским запросом.
export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerI18n();

  return {
    title: t('meta.outfittingTitle'),
    description: t('meta.outfittingDescription'),
  };
}

export default function OutfittingPage() {
  return (
    <main style={{ maxWidth: 1400, margin: '0 auto', padding: '24px 16px 48px' }}>
      <OutfittingHeader />
      <OutfittingWorkspace />
    </main>
  );
}
