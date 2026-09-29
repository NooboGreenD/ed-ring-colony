import type { Metadata } from 'next';
import OutfittingWorkspace from '@/components/Outfitting/OutfittingWorkspace';

export const metadata: Metadata = {
  title: 'Верфь — сборка кораблей | ED Ring Colony',
  description:
    'Конструктор сборок кораблей Elite Dangerous: слоты, модули, инженерия, дальность прыжка, щит, броня и баланс энергии. Актуальные цифры из открытого набора Coriolis.',
};

export default function OutfittingPage() {
  return (
    <main style={{ maxWidth: 1400, margin: '0 auto', padding: '24px 16px 48px' }}>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>Верфь</h1>
      <p style={{ color: 'var(--muted)', fontSize: 13, marginTop: 0, marginBottom: 16, maxWidth: 820, lineHeight: 1.6 }}>
        Соберите корабль под задачу: колонизационный грузовик, дальний разведчик или боевой борт. Верфь считает
        дальность прыжка, скорость, щит, броню и баланс энергии по тем же формулам, что и игра, и учитывает
        инженерные чертежи. Сборка живёт в адресной строке — ссылку можно отправить в эскадрилью.
      </p>
      <OutfittingWorkspace />
    </main>
  );
}
