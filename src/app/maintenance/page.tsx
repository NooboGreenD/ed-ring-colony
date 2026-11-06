import type { Metadata } from 'next';

import MaintenanceScreen from '@/components/MaintenanceScreen';
import { getServerI18n } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerI18n();

  return {
    title: t('meta.maintenanceTitle'),
    description: t('meta.maintenanceDescription'),
  // Заглушка не должна попадать в индекс: это временное состояние сайта.
  robots: { index: false, follow: false },
  };
}

/**
 * Страница-заглушка. Прокси переписывает на неё все не-служебные маршруты,
 * пока активен признак технических работ (см. src/proxy.ts), поэтому она
 * обязана быть самодостаточной: свой фон на весь экран поверх шапки и сайдбара.
 */
export default function MaintenancePage() {
  return <MaintenanceScreen />;
}
