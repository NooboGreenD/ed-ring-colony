import type { Metadata } from 'next';
import ProjectsHub from '@/components/Architect/projects/ProjectsHub';

export const metadata: Metadata = {
  title: 'Проекты систем — Архитектор — ED Ring Colony',
  description:
    'Проекты систем: группа систем под колонизацию с общим прогрессом, участниками и модераторами, привязанными авианосцами и лидерами поставок.',
};

export default function ArchitectProjectsPage() {
  return <ProjectsHub />;
}
