import type { Metadata } from 'next';
import ProjectView from '@/components/Architect/projects/ProjectView';
import { getServerI18n } from '@/lib/i18n/server';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerI18n();

  return {
    title: t('meta.architectProjectTitle'),
    // Проект закрытый: страница не для поисковиков.
    robots: { index: false, follow: false },
  };
}

export default async function ArchitectProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ProjectView projectId={decodeURIComponent(id)} />;
}
