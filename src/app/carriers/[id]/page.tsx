import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { CarrierCardPage } from '@/components/Carriers/CarrierCardPage';
import { carrierCardId } from '@/lib/carrierCard';
import { getServerI18n } from '@/lib/i18n/server';

/**
 * Карточка авианосца (`/carriers/<MarketID>`).
 *
 * Страница публичная: отметка носителя видна в игре любому пилоту, значит и
 * здесь нет ничего закрытого — система, тело, службы и статистика прыжков.
 * Груза и финансов на ней нет никогда: это данные капитана. Сюда ведут ссылки
 * из карточки системы (`/system/<name>` → «Авианосцы») и из уведомления о
 * прыжке подписанного носителя.
 *
 * В адресе — только MarketID: позывной носитель может сменить (и даже быть
 * продан), а MarketID остаётся навсегда. Поэтому мусорный адрес — сразу 404,
 * без клиентского поиска и «попробуйте ещё раз».
 */
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { t } = await getServerI18n();
  const { id } = await params;
  const carrierId = carrierCardId(decodeURIComponent(id));
  if (!carrierId) return { title: t('meta.carrierCardTitle'), robots: { index: false, follow: false } };
  return {
    title: t('meta.carrierCardTitle'),
    description: t('meta.carrierCardDescription', { id: carrierId }),
    robots: { index: false, follow: true },
  };
}

export default async function CarrierCardRoute({ params }: { params: Promise<{ id: string }> }) {
  const { t } = await getServerI18n();
  const { id } = await params;
  const carrierId = carrierCardId(decodeURIComponent(id));
  if (!carrierId) notFound();
  return (
    <main style={{ maxWidth: 1280, margin: '0 auto', padding: '24px 16px 48px' }}>
      <div className="card" style={{ width: '100%' }}>
        <p className="cj-intro">{t('ccd.intro')}</p>
        <CarrierCardPage carrierId={carrierId} />
      </div>
    </main>
  );
}
