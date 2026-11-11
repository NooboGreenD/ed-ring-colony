import type { Metadata } from 'next';
import { CarrierDirectoryPage } from '@/components/Carriers/CarrierDirectoryPage';
import { CarrierGlyph } from '@/components/GalaxyMap/CarrierGlyph';
import { getServerI18n } from '@/lib/i18n/server';

/**
 * Каталог авианосцев (`/carriers`).
 *
 * Список всех известных носителей одной таблицей: учёт сайта плюс реестр EDDN.
 * Каждая строка ведёт в карточку авианосца (`/carriers/<MarketID>`), а кнопка в
 * шапке — на страницу прыжков (`/carriers/jumps`).
 *
 * Почему `noindex`: каталог открывается с любого фильтра, и поисковик завёл бы
 * десятки тысяч почти одинаковых страниц с `?page=`. Карточки носителей тоже
 * `noindex`, а полезная связь — от носителя к системе, а не наоборот.
 *
 * Данные грузит клиент: фильтры и страница живут в адресе, и браузер должен
 * показать список без перезагрузки. Сервер отдаёт только оболочку и тексты —
 * их берёт i18n, поэтому первый кадр уже на языке пилота.
 */
export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerI18n();
  return {
    title: t('meta.carrierCatalogTitle'),
    description: t('meta.carrierCatalogDescription'),
    robots: { index: false, follow: true },
  };
}

export default async function CarrierDirectoryRoute() {
  const { t } = await getServerI18n();
  return (
    <main style={{ maxWidth: 1400, margin: '0 auto', padding: '24px 16px 48px' }}>
      <div className="card" style={{ width: '100%' }}>
        <h1 className="cl-title">
          <CarrierGlyph size={26} color="currentColor" />
          {t('cl.title')}
        </h1>
        <p className="cj-intro">{t('cl.intro')}</p>
        <p className="cj-source">{t('cl.sourceNote')}</p>
        <CarrierDirectoryPage />
      </div>
    </main>
  );
}
