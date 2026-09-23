import type { Metadata } from 'next';

import MaintenanceScreen from '@/components/MaintenanceScreen';

export const metadata: Metadata = {
  title: 'Технические работы — ED Ring Colony',
  description: 'Идёт резервное копирование базы данных. Сайт вернётся в строй через несколько минут.',
  // Заглушка не должна попадать в индекс: это временное состояние сайта.
  robots: { index: false, follow: false },
};

/**
 * Страница-заглушка. Прокси переписывает на неё все не-служебные маршруты,
 * пока активен признак технических работ (см. src/proxy.ts), поэтому она
 * обязана быть самодостаточной: свой фон на весь экран поверх шапки и сайдбара.
 */
export default function MaintenancePage() {
  return <MaintenanceScreen />;
}
