import type { Metadata } from 'next';
import OutfittingHeader from '@/components/Outfitting/OutfittingHeader';
import OutfittingWorkspace from '@/components/Outfitting/OutfittingWorkspace';

// Метаданные отдаются до того, как станет известен язык браузера, поэтому
// заголовок двуязычный: так страницу находят и русским, и английским запросом.
export const metadata: Metadata = {
  title: 'Верфь — сборка кораблей | Outfitting | ED Ring Colony',
  description:
    'Конструктор сборок кораблей Elite Dangerous: слоты, модули, инженерия, дальность прыжка, щит, броня и баланс энергии. Актуальные цифры из открытого набора Coriolis. Elite Dangerous ship build planner with full interface translation.',
};

export default function OutfittingPage() {
  return (
    <main style={{ maxWidth: 1400, margin: '0 auto', padding: '24px 16px 48px' }}>
      <OutfittingHeader />
      <OutfittingWorkspace />
    </main>
  );
}
