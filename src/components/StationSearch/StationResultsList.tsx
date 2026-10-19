'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { IconChevronRight, IconMap, IconStar } from '@/components/Icons';
import {
  STATION_PAGE_SIZE, stationAtlasLink,
  type StationMatchedItem, type StationSearchKind, type StationSearchStation, type StationSearchStationsResponse,
} from '@/lib/stationSearch';
import { ruPlural } from '@/lib/stationSearchOptions';
import { systemPageHref } from '@/lib/systemIdentity';

/**
 * Результаты поиска станций списком: строка — станция, по нажатию строка
 * раскрывается и показывает, что на станции совпало с запросом (цены, запас,
 * спрос; модули и корабли с ценой; услуги и инженеры), откуда данные и когда
 * получены, а также ссылки на карточку системы и Атлас.
 */

export const STATION_TAB_TITLES: Record<StationSearchKind, string> = {
  market: 'Товары', outfitting: 'Модули', shipyard: 'Корабли', services: 'Услуги',
};

const SOURCES: Record<string, string> = { 'colonial-helper': 'Colonial Helper', edsm: 'EDSM', spansh: 'Spansh', eddn: 'EDDN' };

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const number = (value: unknown, suffix = '') => finite(value) ? `${value.toLocaleString('ru-RU')}${suffix}` : '—';
const credits = (value: unknown) => number(value, ' CR');
const distance = (value: unknown) => finite(value) ? `${value.toLocaleString('ru-RU', { maximumFractionDigits: value < 100 ? 2 : 1 })} св. л.` : '—';

function observedAt(value: string): Date | null {
  const at = Date.parse(value);
  // EDSM без времени наблюдения пишет 1970-01-01.
  return Number.isFinite(at) && at > Date.UTC(2014, 0, 1) ? new Date(at) : null;
}

export function observedAgo(value: string, now = Date.now()): string {
  const at = observedAt(value);
  if (!at) return 'время неизвестно';
  const minutes = Math.max(0, Math.round((now - at.getTime()) / 60_000));
  if (minutes < 1) return 'только что';
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  const days = Math.round(hours / 24);
  if (days < 31) return `${days} ${ruPlural(days, ['день', 'дня', 'дней'])} назад`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months} мес. назад`;
  const years = Math.round(days / 365);
  return `${years} ${ruPlural(years, ['год', 'года', 'лет'])} назад`;
}

function observedLabel(value: string): string {
  const at = observedAt(value);
  return at ? at.toLocaleString('ru-RU') : 'Время наблюдения неизвестно';
}

const ITEM_FORMS: Record<StationSearchKind, [string, string, string]> = {
  market: ['товар', 'товара', 'товаров'],
  outfitting: ['модуль', 'модуля', 'модулей'],
  shipyard: ['корабль', 'корабля', 'кораблей'],
  services: ['услуга', 'услуги', 'услуг'],
};

function itemPrice(kind: StationSearchKind, item: StationMatchedItem): number | undefined {
  return kind === 'market' ? item.buyPrice : item.price ?? item.buyPrice;
}

/** Что видно в свёрнутой строке. */
function stationSummary(kind: StationSearchKind, station: StationSearchStation, picked: boolean): string {
  const first = station.items[0];
  const count = station.item_count;
  if (kind === 'services') {
    const names = station.items.map((item) => item.display);
    return names.length > 2 ? `${names.slice(0, 2).join(', ')} и ещё ${count - 2}` : names.join(', ');
  }
  if (count === 1 && first) {
    const price = itemPrice(kind, first);
    const parts = [picked ? '' : first.display, finite(price) ? credits(price) : '',
      kind === 'market' && finite(first.stock) ? `запас ${number(first.stock, ' т')}` : ''].filter(Boolean);
    return parts.join(' · ') || first.display;
  }
  const best = finite(station.best_price) ? ` · от ${credits(station.best_price)}` : '';
  return `${count} ${ruPlural(count, ITEM_FORMS[kind])}${best}`;
}

function ItemsTable({ kind, station }: { kind: StationSearchKind; station: StationSearchStation }) {
  if (kind === 'services') {
    return (
      <ul className="station-row-services">
        {station.items.map((item, index) => (
          <li key={`${item.name}-${index}`} title={item.hint || undefined}>{item.display}</li>
        ))}
      </ul>
    );
  }
  const title = kind === 'market' ? 'Товар' : kind === 'outfitting' ? 'Модуль' : 'Корабль';
  return (
    <div className="station-items-scroll">
      <table className={`station-items station-items-${kind}`}>
        <thead>
          <tr>
            <th scope="col">{title}</th>
            {kind === 'market' ? <>
              <th scope="col">Покупка</th><th scope="col">Продажа</th><th scope="col">Запас</th><th scope="col">Спрос</th>
            </> : <th scope="col">Цена</th>}
          </tr>
        </thead>
        <tbody>
          {station.items.map((item, index) => (
            <tr key={`${item.symbol || item.name}-${index}`}>
              <th scope="row">
                <span className="station-items-name">{item.display}</span>
                {item.hint && <span className="station-items-hint">{item.hint}</span>}
              </th>
              {kind === 'market' ? <>
                <td>{credits(item.buyPrice)}</td>
                <td>{credits(item.sellPrice)}</td>
                <td>{number(item.stock, ' т')}</td>
                <td>{number(item.demand, ' т')}</td>
              </> : <td>{credits(itemPrice(kind, item))}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StationRow({ kind, station, index, open, picked, onToggle }: {
  kind: StationSearchKind; station: StationSearchStation; index: number; open: boolean; picked: boolean; onToggle: () => void;
}) {
  const panelId = `station-row-panel-${index}`;
  const atlas = stationAtlasLink(station);
  const more = station.item_count - station.items.length;
  const metadata = station.metadata ?? {};
  return (
    <li className={`station-row${open ? ' open' : ''}${station.stale ? ' stale' : ''}`}>
      <button type="button" className="station-row-head" aria-expanded={open} aria-controls={panelId} onClick={onToggle}>
        <IconChevronRight size={14} className="station-row-chevron" />
        <span className="station-row-name">
          <strong>{station.station_name}</strong>
          <span className="station-row-type">{station.station_type || 'Тип неизвестен'}</span>
        </span>
        <span className="station-row-system">{station.system_name}</span>
        <span className="station-row-distance">{distance(station.distance)}</span>
        <span className="station-row-summary">{stationSummary(kind, station, picked)}</span>
        <span className={`station-row-age${station.stale ? ' stale' : ''}`} title={`${SOURCES[station.source] || station.source} · ${observedLabel(station.observed_at)}`}>
          <span className="station-row-dot" aria-hidden="true" />{observedAgo(station.observed_at)}
        </span>
      </button>
      {open && (
        <div id={panelId} className="station-row-panel" role="region" aria-label={`${station.station_name}: что найдено`}>
          <ItemsTable kind={kind} station={station} />
          {more > 0 && <p className="station-row-more">И ещё {more} {ruPlural(more, ITEM_FORMS[kind])} — уточните запрос, класс или рейтинг.</p>}
          <dl className="station-row-facts">
            <div><dt>Система</dt><dd><Link href={systemPageHref(station.system_name)} title="Всё о системе: стройки, фракции, PowerPlay, станции, авианосцы">{station.system_name}</Link></dd></div>
            <div><dt>Тип станции</dt><dd>{station.station_type || 'Нет данных'}</dd></div>
            {metadata.body_name && <div><dt>Тело</dt><dd>{metadata.body_name}</dd></div>}
            <div><dt>От точки прибытия</dt><dd>{number(metadata.distance_to_arrival, ' св. с.')}</dd></div>
            <div><dt>От опорной системы</dt><dd>{distance(station.distance)}</dd></div>
            {metadata.engineers?.length ? <div><dt>Инженеры</dt><dd>{metadata.engineers.join(', ')}</dd></div> : null}
          </dl>
          <p className="station-report-time">
            {SOURCES[station.source] || station.source} · {observedLabel(station.observed_at)}
            {station.stale && <span className="station-row-stale"> · отчёт старше часа — наличие и цены могли измениться</span>}
          </p>
          <div className="station-row-actions">
            <Link href={systemPageHref(station.system_name)} className="btn">Карточка системы</Link>
            {atlas
              ? <Link href={atlas} target="_blank" rel="noopener noreferrer" className="btn" title="Открыть систему в новой вкладке Атласа"><IconMap size={14} /> Показать систему в Атласе</Link>
              : <button type="button" className="btn" disabled title="В БД нет координат системы">Координаты системы неизвестны</button>}
          </div>
        </div>
      )}
    </li>
  );
}

interface Props {
  data: StationSearchStationsResponse;
  loading: boolean;
  onPage: (page: number) => void;
}

export function StationResultsList({ data, loading, onPage }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  // Новая выдача — всё свёрнуто; единственная станция раскрыта сразу.
  useEffect(() => {
    setExpanded(new Set(data.stations.length === 1 ? [data.stations[0].station_key] : []));
  }, [data]);

  const toggle = (key: string) => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const allOpen = data.stations.length > 0 && data.stations.every((station) => expanded.has(station.station_key));
  const pages = data.total != null ? Math.max(1, Math.ceil(data.total / STATION_PAGE_SIZE)) : null;
  const found = data.total != null
    ? `Найдено ${data.total.toLocaleString('ru-RU')} ${ruPlural(data.total, ['станция', 'станции', 'станций'])}`
    : `На странице ${data.stations.length} ${ruPlural(data.stations.length, ['станция', 'станции', 'станций'])}`;

  return (
    <>
      <div className="station-results-heading">
        <h2>{STATION_TAB_TITLES[data.kind]}: {data.query}</h2>
        <div className="station-results-meta">
          <span className="atlas-muted">
            {found}{pages ? ` · страница ${data.page + 1} из ${pages}` : ` · страница ${data.page + 1}`}
            {data.reference ? ` · от ${data.reference.name}` : ''}
          </span>
          {data.stations.length > 1 && (
            <button type="button" className="station-expand-all" onClick={() =>
              setExpanded(allOpen ? new Set() : new Set(data.stations.map((station) => station.station_key)))}>
              {allOpen ? 'Свернуть все' : 'Развернуть все'}
            </button>
          )}
        </div>
      </div>
      {data.pick && (
        <p className="station-results-exact"><IconStar size={12} /> Точное совпадение с выбранным из списка: «{data.pick.label}».</p>
      )}
      {data.grouping === 'page' && (
        <p className="station-results-exact">База ещё без миграции поиска списком — станции собраны из одной страницы наблюдений, общее число неизвестно.</p>
      )}
      {!data.stations.length && (
        <div className="station-search-empty">
          <h2>Нет подходящих наблюдений в БД</h2>
          <p>Попробуйте другой запрос, больший радиус или отключите фильтр свежести. Отсутствие отчёта не означает, что услуга или товар отсутствуют в игре.</p>
          <Link href="/atlas?tab=market">Для товаров — расширенный поиск в Атласе →</Link>
        </div>
      )}
      {data.stations.length > 0 && (
        <div className="station-list-wrap">
          <div className="station-list-columns" aria-hidden="true">
            <span />
            <span>Станция</span><span>Система</span><span>Расстояние</span><span>Найдено</span><span>Обновлено</span>
          </div>
          <ul className="station-list" aria-label="Найденные станции">
            {data.stations.map((station, index) => (
              <StationRow key={station.station_key} kind={data.kind} station={station} index={index}
                open={expanded.has(station.station_key)} picked={!!data.pick} onToggle={() => toggle(station.station_key)} />
            ))}
          </ul>
        </div>
      )}
      {(data.page > 0 || data.has_more) && (
        <nav className="station-search-pagination" aria-label="Страницы результатов">
          <button type="button" className="btn" disabled={loading || data.page === 0} onClick={() => onPage(data.page - 1)}>← Назад</button>
          <span>Страница {data.page + 1}{pages ? ` из ${pages}` : ''}</span>
          <button type="button" className="btn" disabled={loading || !data.has_more || data.page >= 100} onClick={() => onPage(data.page + 1)}>Далее →</button>
        </nav>
      )}
    </>
  );
}
