'use client';

import { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import { SystemSearchInput } from '@/components/Atlas/SystemSearchInput';
import { toast } from '@/components/ui/Toaster';
import { useI18n } from '@/lib/i18n/I18nContext';
import { BUILD_COMMODITIES, resolveCommodity } from '@/lib/commodities';
import { downloadCsv } from '@/lib/atlas';
import { IconAlert, IconDownload, IconSearch, IconX } from '@/components/Icons';

interface MarketPrice {
  system_name: string;
  station_name: string;
  commodity_name: string;
  sell_price: number;
  buy_price: number;
  stock: number;
  demand: number;
  reported_at: string;
  stale?: boolean;
  source?: string;
}

type SortKey = 'sell' | 'buy' | 'stock' | 'system';

export default function MarketPage() {
  const { t, locale } = useI18n();
  const [commodity, setCommodity] = useState('');
  const [system, setSystem] = useState('');
  const [prices, setPrices] = useState<MarketPrice[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<SortKey>('sell');

  const search = useCallback(async (rawCommodity = commodity) => {
    const query = resolveCommodity(rawCommodity);
    if (!query) {
      setError(t('amk.enterCommodity'));
      return;
    }
    setCommodity(query);
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ commodity: query, ...(system.trim() ? { system: system.trim() } : {}) });
      const res = await fetch(`/api/market/search?${params.toString()}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t('amk.fetchFailed', { status: res.status }));
      setPrices(Array.isArray(data.prices) ? data.prices : []);
      setSearched(true);
    } catch (err: any) {
      setPrices([]);
      setSearched(true);
      setError(err.message || t('amk.searchError'));
      toast(err.message || t('amk.searchError'), 'error');
    } finally {
      setLoading(false);
    }
  }, [commodity, system, t]);

  const visible = useMemo(() => {
    const query = filter.trim().toLowerCase();
    const rows = prices.filter((row) => {
      if (!query) return true;
      return row.system_name.toLowerCase().includes(query)
        || row.station_name.toLowerCase().includes(query)
        || row.commodity_name.toLowerCase().includes(query);
    });
    return [...rows].sort((a, b) => {
      if (sort === 'buy') return (a.buy_price || 0) - (b.buy_price || 0);
      if (sort === 'stock') return (b.stock || 0) - (a.stock || 0);
      if (sort === 'system') return a.system_name.localeCompare(b.system_name);
      return (b.sell_price || 0) - (a.sell_price || 0);
    });
  }, [filter, prices, sort]);

  const exportCsv = () => {
    if (visible.length === 0) return;
    downloadCsv(`market-${commodity}-${system || 'all'}`, [
      [t('amk.csvSystem'), t('amk.csvStation'), t('amk.csvCommodity'), t('amk.csvBuy'), t('amk.csvSell'), t('amk.csvStock'), t('amk.csvDemand'), t('amk.csvUpdated')],
      ...visible.map((row) => [
        row.system_name, row.station_name, row.commodity_name,
        row.buy_price ?? '', row.sell_price ?? '', row.stock ?? '', row.demand ?? '',
        row.reported_at ? new Date(row.reported_at).toLocaleString(locale) : '',
      ]),
    ]);
  };

  return (
    <div className="market-page-wrap">
      <nav className="atlas-nav-links" aria-label={t('amk.navAria')}>
        <Link href="/atlas">← Atlas</Link>
        <span className="sep">//</span>
        <span className="current">{t('amk.current')}</span>
      </nav>

      <h2 className="market-title">{t('amk.title')}</h2>
      <p className="atlas-muted">
        {t('amk.intro')}
      </p>

      <form
        className="market-search-row"
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <div className="market-field">
          <label htmlFor="market-commodity">{t('amk.commodity')}</label>
          <input
            id="market-commodity"
            className="input"
            list="market-commodities"
            placeholder={t('amk.commodityPlaceholder')}
            value={commodity}
            onChange={(event) => setCommodity(event.target.value)}
          />
          <datalist id="market-commodities">
            {BUILD_COMMODITIES.map((item) => <option key={item} value={item} />)}
          </datalist>
        </div>

        <SystemSearchInput
          label={t('amk.systemOptional')}
          value={system}
          onChange={setSystem}
          onSubmit={() => { void search(); }}
          placeholder={t('amk.allSystems')}
          compact
        />

        <div className="market-search-actions">
          <button type="submit" className="btn btn-orange" disabled={loading}>
            {loading ? t('amk.searching') : t('amk.find')}
          </button>
          {(commodity || system) && (
            <button
              type="button"
              className="btn"
              onClick={() => {
                setCommodity('');
                setSystem('');
                setPrices([]);
                setError(null);
                setSearched(false);
              }}
            >
              {t('amk.reset')}
            </button>
          )}
        </div>
      </form>

      {error && (
        <p className="atlas-inline-error" role="alert">
          <IconAlert size={12} /> {error}
        </p>
      )}

      {prices.length > 0 && (
        <>
          <div className="market-toolbar">
            <div className="atlas-inline-search">
              <IconSearch size={12} />
              <input
                type="search"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder={t('amk.filterPlaceholder')}
                aria-label={t('amk.filterAria')}
              />
              {filter && (
                <button type="button" onClick={() => setFilter('')} aria-label={t('amk.clearFilter')}>
                  <IconX size={11} />
                </button>
              )}
            </div>
            <select value={sort} onChange={(event) => setSort(event.target.value as SortKey)} aria-label={t('amk.sortAria')}>
              <option value="sell">{t('amk.sortSell')}</option>
              <option value="buy">{t('amk.sortBuy')}</option>
              <option value="stock">{t('amk.sortStock')}</option>
              <option value="system">{t('amk.sortSystem')}</option>
            </select>
            <button type="button" className="btn" onClick={exportCsv} title={t('amk.exportCsv')}>
              <IconDownload size={12} /> CSV
            </button>
          </div>

          <p className="atlas-list-counter">{t('amk.rows', { visible: visible.length, total: prices.length })}</p>

          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>{t('amk.csvSystem')}</th><th>{t('amk.csvStation')}</th><th>{t('amk.csvCommodity')}</th>
                  <th>{t('amk.colBuy')}</th><th>{t('amk.colSell')}</th><th>{t('amk.csvStock')}</th><th>{t('amk.csvDemand')}</th><th>{t('amk.csvUpdated')}</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row, index) => (
                  <tr key={`${row.system_name}-${row.station_name}-${row.commodity_name}-${index}`}>
                    <td>{row.system_name}</td>
                    <td>{row.station_name}</td>
                    <td>{row.commodity_name}</td>
                    <td className="num">{row.buy_price?.toLocaleString(locale) ?? '—'}</td>
                    <td className="num green">{row.sell_price?.toLocaleString(locale) ?? '—'}</td>
                    <td className="num">{row.stock?.toLocaleString(locale) ?? '—'}</td>
                    <td className="num">{row.demand?.toLocaleString(locale) ?? '—'}</td>
                    <td className="muted">
                      {Date.parse(row.reported_at) > 0 ? new Date(row.reported_at).toLocaleString(locale) : t('amk.timeUnknown')}
                      {row.source ? ` · ${row.source}` : ''}{row.stale ? t('amk.stale') : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {visible.length === 0 && <p className="atlas-muted">{t('amk.noRows')}</p>}
        </>
      )}

      {!loading && searched && prices.length === 0 && !error && (
        <p className="atlas-muted">
          {t('amk.notFound')}
        </p>
      )}

      {!searched && !loading && (
        <p className="atlas-muted">
          {t('amk.introPrompt')}
        </p>
      )}
    </div>
  );
}
