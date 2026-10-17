import type { Metadata } from 'next';
import ProjectView from '@/components/Architect/projects/ProjectView';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Проект систем — Архитектор — ED Ring Colony',
  // Проект закрытый: страница не для поисковиков.
  robots: { index: false, follow: false },
};

export default async function ArchitectProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ProjectView projectId={decodeURIComponent(id)} />;
}
