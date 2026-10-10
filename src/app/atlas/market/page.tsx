'use client';

import { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import { SystemSearchInput } from '@/components/Atlas/SystemSearchInput';
import { toast } from '@/components/ui/Toaster';
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
}

type SortKey = 'sell' | 'buy' | 'stock' | 'system';

export default function MarketPage() {
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
      setError('Укажите товар — например, Steel');
      return;
    }
    setCommodity(query);
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ commodity: query, ...(system.trim() ? { system: system.trim() } : {}) });
      const res = await fetch(`/api/market/search?${params.toString()}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Не удалось получить цены (HTTP ${res.status})`);
      setPrices(Array.isArray(data.prices) ? data.prices : []);
      setSearched(true);
    } catch (err: any) {
      setPrices([]);
      setSearched(true);
      setError(err.message || 'Ошибка поиска цен');
      toast(err.message || 'Ошибка поиска цен', 'error');
    } finally {
      setLoading(false);
    }
  }, [commodity, system]);

  const visible = useMemo(() => {
    const query = filter.trim().toLowerCase();
    const rows = prices.filter((row) => {
      if (!query) return true;
      return row.system_name.toLowerCase().includes(query)
        || row.station_name.toLowerCase().includes(query)
        || row.commodity_name.toLowerCase().includes(query);
    });
    return [...rows].sort((a, b) => {
      if (sort === 'buy') return (b.buy_price || 0) - (a.buy_price || 0);
      if (sort === 'stock') return (b.stock || 0) - (a.stock || 0);
      if (sort === 'system') return a.system_name.localeCompare(b.system_name);
      return (b.sell_price || 0) - (a.sell_price || 0);
    });
  }, [filter, prices, sort]);

  const exportCsv = () => {
    if (visible.length === 0) return;
    downloadCsv(`market-${commodity}-${system || 'all'}`, [
      ['Система', 'Станция', 'Товар', 'Покупка, CR', 'Продажа, CR', 'Запас', 'Спрос', 'Обновлено'],
      ...visible.map((row) => [
        row.system_name, row.station_name, row.commodity_name,
        row.buy_price ?? '', row.sell_price ?? '', row.stock ?? '', row.demand ?? '',
        row.reported_at ? new Date(row.reported_at).toLocaleString('ru-RU') : '',
      ]),
    ]);
  };

  return (
    <div className="market-page-wrap">
      <nav className="atlas-nav-links" aria-label="Навигация Atlas">
        <Link href="/atlas">← Atlas</Link>
        <span className="sep">//</span>
        <span className="current">РЫНОК РЕСУРСОВ</span>
      </nav>

      <h2 className="market-title">Рынок ресурсов</h2>
      <p className="atlas-muted">
        Отчёт EDDN по товарам для строительства: цены, запас и спрос по станциям. Для поиска конкретного
        товара на маршруте используйте вкладку «Рынок» в Atlas.
      </p>

      <form
        className="market-search-row"
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <div className="market-field">
          <label htmlFor="market-commodity">Товар</label>
          <input
            id="market-commodity"
            className="input"
            list="market-commodities"
            placeholder="Например, Steel"
            value={commodity}
            onChange={(event) => setCommodity(event.target.value)}
          />
          <datalist id="market-commodities">
            {BUILD_COMMODITIES.map((item) => <option key={item} value={item} />)}
          </datalist>
        </div>

        <SystemSearchInput
          label="Система (необязательно)"
          value={system}
          onChange={setSystem}
          onSubmit={() => { void search(); }}
          placeholder="Все системы"
          compact
        />

        <div className="market-search-actions">
          <button type="submit" className="btn btn-orange" disabled={loading}>
            {loading ? 'Поиск…' : 'Найти'}
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
              Сбросить
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
                placeholder="Фильтр: система или станция"
                aria-label="Фильтр цен"
              />
              {filter && (
                <button type="button" onClick={() => setFilter('')} aria-label="Очистить фильтр">
                  <IconX size={11} />
                </button>
              )}
            </div>
            <select value={sort} onChange={(event) => setSort(event.target.value as SortKey)} aria-label="Сортировка цен">
              <option value="sell">Выгодная продажа</option>
              <option value="buy">Выгодная покупка</option>
              <option value="stock">Больше запаса</option>
              <option value="system">По системе</option>
            </select>
            <button type="button" className="btn" onClick={exportCsv} title="Экспорт в CSV">
              <IconDownload size={12} /> CSV
            </button>
          </div>

          <p className="atlas-list-counter">Строк: {visible.length} из {prices.length}</p>

          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Система</th><th>Станция</th><th>Товар</th>
                  <th>Покупка</th><th>Продажа</th><th>Запас</th><th>Спрос</th><th>Обновлено</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row, index) => (
                  <tr key={`${row.system_name}-${row.station_name}-${row.commodity_name}-${index}`}>
                    <td>{row.system_name}</td>
                    <td>{row.station_name}</td>
                    <td>{row.commodity_name}</td>
                    <td className="num">{row.buy_price?.toLocaleString('ru-RU') ?? '—'}</td>
                    <td className="num green">{row.sell_price?.toLocaleString('ru-RU') ?? '—'}</td>
                    <td className="num">{row.stock?.toLocaleString('ru-RU') ?? '—'}</td>
                    <td className="num">{row.demand?.toLocaleString('ru-RU') ?? '—'}</td>
                    <td className="muted">
                      {row.reported_at ? new Date(row.reported_at).toLocaleDateString('ru-RU') : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {visible.length === 0 && <p className="atlas-muted">По фильтру строк нет.</p>}
        </>
      )}

      {!loading && searched && prices.length === 0 && !error && (
        <p className="atlas-muted">
          Цены не найдены. Попробуйте другой товар, снимите фильтр по системе или проверьте чуть позже —
          отчётность EDDN приходит с задержкой.
        </p>
      )}

      {!searched && !loading && (
        <p className="atlas-muted">
          Введите товар и нажмите «Найти». Поле системы необязательно: без него поиск идёт по всей галактике.
        </p>
      )}
    </div>
  );
}
