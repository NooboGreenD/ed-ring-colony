import type { Metadata } from 'next';
import ArchitectWorkspace from '@/components/Architect/ArchitectWorkspace';
import { getServerI18n } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerI18n();

  return {
    title: t('meta.architectTitle'),
    description: t('meta.architectDescription'),
  };
}

export default function ArchitectPage() {
  return <ArchitectWorkspace />;
}
