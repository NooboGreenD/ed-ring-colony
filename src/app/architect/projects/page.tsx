import type { Metadata } from 'next';
import ProjectsHub from '@/components/Architect/projects/ProjectsHub';
import { getServerI18n } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerI18n();

  return {
    title: t('meta.architectProjectsTitle'),
    description: t('meta.architectProjectsDescription'),
  };
}

export default function ArchitectProjectsPage() {
  return <ProjectsHub />;
}
