import type { Metadata } from 'next';
import ArchitectWorkspace from '@/components/Architect/ArchitectWorkspace';

export const metadata: Metadata = {
  title: 'Архитектор системы — ED Ring Colony',
  description:
    'Планировщик застройки системы под колонизацию: наземные слоты тел, очки системы T2/T3, порядок стройки, товары и тоннаж перевозок. Тестовый режим.',
};

export default function ArchitectPage() {
  return <ArchitectWorkspace />;
}
