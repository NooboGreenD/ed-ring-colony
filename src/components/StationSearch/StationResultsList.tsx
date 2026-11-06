'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { IconChevronRight, IconMap, IconStar } from '@/components/Icons';
import {
  STATION_PAGE_SIZE, stationAtlasLink,
  type StationMatchedItem, type StationSearchKind, type StationSearchStation, type StationSearchStationsResponse,
} from '@/lib/stationSearch';
import { systemPageHref } from '@/lib/systemIdentity';
import { useI18n } from '@/lib/i18n/I18nContext';

/**
 * Результаты поиска станций списком: строка — станция, по нажатию строка
 * раскрывается и показывает, что на станции совпало с запросом (цены, запас,
 * спрос; модули и корабли с ценой; услуги и инженеры), откуда данные и когда
 * получены, а также ссылки на карточку системы и Атлас.
 */

type TFunc = (key: string, params?: Record<string, string | number>) => string;

export const STATION_TAB_TITLES: Record<StationSearchKind, string> = {
  market: 'stn.tab.market', outfitting: 'stn.tab.outfitting', shipyard: 'stn.tab.shipyard', services: 'stn.tab.services',
};

const SOURCES: Record<string, string> = { 'colonial-helper': 'Colonial Helper', edsm: 'EDSM', spansh: 'Spansh', eddn: 'EDDN' };

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const num = (locale: string, value: unknown) => (finite(value) ? value.toLocaleString(locale) : '—');
const credits = (locale: string, value: unknown) => (finite(value) ? `${value.toLocaleString(locale)} CR` : '—');
const tons = (t: TFunc, locale: string, value: unknown) => (finite(value) ? t('stn.tons', { count: value.toLocaleString(locale) }) : '—');
const lightSeconds = (t: TFunc, locale: string, value: unknown) => (finite(value) ? t('stn.lightSeconds', { count: value.toLocaleString(locale) }) : '—');
const distance = (t: TFunc, locale: string, value: unknown) => (finite(value)
  ? t('stn.lightYears', { count: value.toLocaleString(locale, { maximumFractionDigits: value < 100 ? 2 : 1 }) })
  : '—');

function observedAt(value: string): Date | null {
  const at = Date.parse(value);
  // EDSM без времени наблюдения пишет 1970-01-01.
  return Number.isFinite(at) && at > Date.UTC(2014, 0, 1) ? new Date(at) : null;
}

export function observedAgo(t: TFunc, value: string, now = Date.now()): string {
  const at = observedAt(value);
  if (!at) return t('stn.timeUnknown');
  const minutes = Math.max(0, Math.round((now - at.getTime()) / 60_000));
  if (minutes < 1) return t('stn.justNow');
  if (minutes < 60) return t('stn.minutesAgo', { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t('stn.hoursAgo', { count: hours });
  const days = Math.round(hours / 24);
  if (days < 31) return t('stn.daysAgo', { count: days });
  const months = Math.round(days / 30);
  if (months < 12) return t('stn.monthsAgo', { count: months });
  const years = Math.round(days / 365);
  return t('stn.yearsAgo', { count: years });
}

function observedLabel(t: TFunc, locale: string, value: string): string {
  const at = observedAt(value);
  return at ? at.toLocaleString(locale) : t('stn.observedUnknown');
}

function itemPrice(kind: StationSearchKind, item: StationMatchedItem): number | undefined {
  return kind === 'market' ? item.buyPrice : item.price ?? item.buyPrice;
}

/** Что видно в свёрнутой строке. */
function stationSummary(t: TFunc, locale: string, kind: StationSearchKind, station: StationSearchStation, picked: boolean): string {
  const first = station.items[0];
  const count = station.item_count;
  if (kind === 'services') {
    const names = station.items.map((item) => item.display);
    return names.length > 2
      ? t('stn.servicesMore', { first: names.slice(0, 2).join(', '), count: count - 2 })
      : names.join(', ');
  }
  if (count === 1 && first) {
    const price = itemPrice(kind, first);
    const parts = [picked ? '' : first.display, finite(price) ? credits(locale, price) : '',
      kind === 'market' && finite(first.stock) ? t('stn.stockTons', { count: first.stock.toLocaleString(locale) }) : ''].filter(Boolean);
    return parts.join(' · ') || first.display;
  }
  const best = finite(station.best_price) ? ` · ${t('stn.fromPrice', { price: credits(locale, station.best_price) })}` : '';
  return `${t('stn.rowItems', { count: count.toLocaleString(locale) })}${best}`;
}

function ItemsTable({ kind, station }: { kind: StationSearchKind; station: StationSearchStation }) {
  const { t, locale } = useI18n();
  if (kind === 'services') {
    return (
      <ul className="station-row-services">
        {station.items.map((item, index) => (
          <li key={`${item.name}-${index}`} title={item.hint || undefined}>{item.display}</li>
        ))}
      </ul>
    );
  }
  const title = t(kind === 'market' ? 'stn.colMarket' : kind === 'outfitting' ? 'stn.colOutfitting' : 'stn.colShipyard');
  return (
    <div className="station-items-scroll">
      <table className={`station-items station-items-${kind}`}>
        <thead>
          <tr>
            <th scope="col">{title}</th>
            {kind === 'market' ? <>
              <th scope="col">{t('stn.colBuy')}</th><th scope="col">{t('stn.colSell')}</th><th scope="col">{t('stn.colStock')}</th><th scope="col">{t('stn.colDemand')}</th>
            </> : <th scope="col">{t('stn.colPrice')}</th>}
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
                <td>{credits(locale, item.buyPrice)}</td>
                <td>{credits(locale, item.sellPrice)}</td>
                <td>{tons(t, locale, item.stock)}</td>
                <td>{tons(t, locale, item.demand)}</td>
              </> : <td>{credits(locale, itemPrice(kind, item))}</td>}
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
  const { t, locale } = useI18n();
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
          <span className="station-row-type">{station.station_type || t('stn.typeUnknown')}</span>
        </span>
        <span className="station-row-system">{station.system_name}</span>
        <span className="station-row-distance">{distance(t, locale, station.distance)}</span>
        <span className="station-row-summary">{stationSummary(t, locale, kind, station, picked)}</span>
        <span className={`station-row-age${station.stale ? ' stale' : ''}`} title={`${SOURCES[station.source] || station.source} · ${observedLabel(t, locale, station.observed_at)}`}>
          <span className="station-row-dot" aria-hidden="true" />{observedAgo(t, station.observed_at)}
        </span>
      </button>
      {open && (
        <div id={panelId} className="station-row-panel" role="region" aria-label={t('stn.rowPanelAria', { name: station.station_name })}>
          <ItemsTable kind={kind} station={station} />
          {more > 0 && <p className="station-row-more">{t('stn.moreItems', { count: more.toLocaleString(locale) })}</p>}
          <dl className="station-row-facts">
            <div><dt>{t('stn.dtSystem')}</dt><dd><Link href={systemPageHref(station.system_name)} title={t('stn.systemLinkTitle')}>{station.system_name}</Link></dd></div>
            <div><dt>{t('stn.dtStationType')}</dt><dd>{station.station_type || t('stn.noData')}</dd></div>
            {metadata.body_name && <div><dt>{t('stn.dtBody')}</dt><dd>{metadata.body_name}</dd></div>}
            <div><dt>{t('stn.dtArrival')}</dt><dd>{lightSeconds(t, locale, metadata.distance_to_arrival)}</dd></div>
            <div><dt>{t('stn.dtReference')}</dt><dd>{distance(t, locale, station.distance)}</dd></div>
            {metadata.engineers?.length ? <div><dt>{t('stn.dtEngineers')}</dt><dd>{metadata.engineers.join(', ')}</dd></div> : null}
          </dl>
          <p className="station-report-time">
            {SOURCES[station.source] || station.source} · {observedLabel(t, locale, station.observed_at)}
            {station.stale && <span className="station-row-stale">{t('stn.staleNote')}</span>}
          </p>
          <div className="station-row-actions">
            <Link href={systemPageHref(station.system_name)} className="btn">{t('stn.systemCard')}</Link>
            {atlas
              ? <Link href={atlas} target="_blank" rel="noopener noreferrer" className="btn" title={t('stn.atlasOpenTitle')}><IconMap size={14} /> {t('stn.atlasOpen')}</Link>
              : <button type="button" className="btn" disabled title={t('stn.noCoordsTitle')}>{t('stn.noCoords')}</button>}
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
  const { t, locale } = useI18n();
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
    ? t('stn.found', { count: data.total.toLocaleString(locale) })
    : t('stn.onPage', { count: data.stations.length.toLocaleString(locale) });

  return (
    <>
      <div className="station-results-heading">
        <h2>{t(STATION_TAB_TITLES[data.kind])}: {data.query}</h2>
        <div className="station-results-meta">
          <span className="atlas-muted">
            {found}{pages ? t('stn.pageOf', { page: data.page + 1, pages }) : t('stn.pageOnly', { page: data.page + 1 })}
            {data.reference ? t('stn.fromReference', { name: data.reference.name }) : ''}
          </span>
          {data.stations.length > 1 && (
            <button type="button" className="station-expand-all" onClick={() =>
              setExpanded(allOpen ? new Set() : new Set(data.stations.map((station) => station.station_key)))}>
              {allOpen ? t('stn.collapseAll') : t('stn.expandAll')}
            </button>
          )}
        </div>
      </div>
      {data.pick && (
        <p className="station-results-exact"><IconStar size={12} /> {t('stn.pickExact', { label: data.pick.label })}</p>
      )}
      {data.grouping === 'page' && (
        <p className="station-results-exact">{t('stn.pageGrouping')}</p>
      )}
      {!data.stations.length && (
        <div className="station-search-empty">
          <h2>{t('stn.emptyTitle')}</h2>
          <p>{t('stn.emptyBody')}</p>
          <Link href="/atlas?tab=market">{t('stn.emptyLink')}</Link>
        </div>
      )}
      {data.stations.length > 0 && (
        <div className="station-list-wrap">
          <div className="station-list-columns" aria-hidden="true">
            <span />
            <span>{t('stn.colStation')}</span><span>{t('stn.colSystem')}</span><span>{t('stn.colDistance')}</span><span>{t('stn.colFound')}</span><span>{t('stn.colUpdated')}</span>
          </div>
          <ul className="station-list" aria-label={t('stn.listAria')}>
            {data.stations.map((station, index) => (
              <StationRow key={station.station_key} kind={data.kind} station={station} index={index}
                open={expanded.has(station.station_key)} picked={!!data.pick} onToggle={() => toggle(station.station_key)} />
            ))}
          </ul>
        </div>
      )}
      {(data.page > 0 || data.has_more) && (
        <nav className="station-search-pagination" aria-label={t('stn.paginationAria')}>
          <button type="button" className="btn" disabled={loading || data.page === 0} onClick={() => onPage(data.page - 1)}>{t('stn.prev')}</button>
          <span>{t('stn.pageLabel', { page: data.page + 1 })}{pages ? t('stn.pageLabelOf', { pages }) : ''}</span>
          <button type="button" className="btn" disabled={loading || !data.has_more || data.page >= 100} onClick={() => onPage(data.page + 1)}>{t('stn.next')}</button>
        </nav>
      )}
    </>
  );
}
