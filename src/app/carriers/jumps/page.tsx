import type { Metadata } from 'next';
import { CarrierJumpsPage } from '@/components/Carriers/CarrierJumpsPage';
import { getServerI18n } from '@/lib/i18n/server';

/**
 * «Авианосцы перед прыжком» (`/carriers/jumps`).
 *
 * Страница живёт по прямой ссылке: в меню её пока не выводим. Смысл — увидеть
 * заказы прыжка до вылета и подписаться на носитель, чтобы не пропустить
 * перенос или смену цели.
 *
 * Вкладки: «Прыжки» — живые заказы (`CarrierJumpBoard`), «Расписание» —
 * календарь планов (`CarrierJumpCalendar`). Обе живут в клиентском
 * `CarrierJumpsPage`: переключение не должно сбрасывать введённое, а выбранное
 * расписание записывается в адрес — публичной ссылкой делятся.
 */
export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerI18n();
  return {
    title: t('meta.carrierJumpsTitle'),
    description: t('meta.carrierJumpsDescription'),
    robots: { index: false, follow: true },
  };
}

export default async function CarrierJumpsRoute() {
  const { t } = await getServerI18n();
  return (
    <main style={{ maxWidth: 1400, margin: '0 auto', padding: '24px 16px 48px' }}>
      <div className="card" style={{ width: '100%' }}>
        <h1>{t('cj.title')}</h1>
        <p className="cj-intro">{t('cj.intro')}</p>
        <p className="cj-source">{t('cj.sourceNote')}</p>
        <CarrierJumpsPage />
      </div>
    </main>
  );
}
