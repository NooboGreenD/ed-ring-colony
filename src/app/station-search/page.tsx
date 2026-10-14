'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { SystemSearchInput } from '@/components/Atlas/SystemSearchInput';
import { IconSearch, IconMap, IconPackage, IconWrench, IconRocket, IconGear, IconAlert } from '@/components/Icons';
import { SERVICE_OPTIONS, stationAtlasLink, type StationSearchKind, type StationSearchResult } from '@/lib/stationSearch';
import { BUILD_COMMODITIES } from '@/lib/commodities';

const TABS = [
  { id: 'market' as const, title: 'Товары', icon: IconPackage, placeholder: 'Например, Steel или Water' },
  { id: 'outfitting' as const, title: 'Модули', icon: IconWrench, placeholder: 'Например, FSD, гипердвигатель или Frontier-символ' },
  { id: 'shipyard' as const, title: 'Корабли', icon: IconRocket, placeholder: 'Например, Python, Anaconda или Sidewinder' },
  { id: 'services' as const, title: 'Услуги', icon: IconGear, placeholder: 'Услуга или имя инженера, например Felicity Farseer' },
];
interface ResponseData { results: StationSearchResult[]; has_more: boolean; page: number; query: string; kind: StationSearchKind; }
const sources: Record<string, string> = { 'colonial-helper': 'Colonial Helper', edsm: 'EDSM', spansh: 'Spansh', eddn: 'EDDN' };
const number = (value: number | undefined | null, suffix = '') => typeof value === 'number' && Number.isFinite(value) ? `${value.toLocaleString('ru-RU')}${suffix}` : 'Нет данных';
function observed(value: string) { const at = Date.parse(value); return at > 0 ? new Date(at).toLocaleString('ru-RU') : 'Время неизвестно'; }

export default function StationSearchPage() {
  const [form, setForm] = useState({ kind: 'market' as StationSearchKind, q: '', reference: '', radius: '500', min_stock: '1', module_class: '', rating: '', fresh: false, sort: 'distance' });
  const [data, setData] = useState<ResponseData | null>(null);
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const tab = TABS.find((entry) => entry.id === form.kind)!;
  useEffect(() => {
    setReady(true);
    return () => { generation.current++; controller.current?.abort(); };
  }, []);
  const change = (patch: Partial<typeof form>) => {
    generation.current++; controller.current?.abort(); setLoading(false); setData(null); setError('');
    setForm((current) => ({ ...current, ...patch }));
  };
  async function search(page = 0) {
    controller.current?.abort();
    const request = new AbortController(); controller.current = request;
    const current = ++generation.current;
    const params = new URLSearchParams({ kind: form.kind, q: form.q.trim(), radius: form.reference.trim() ? form.radius : '500', min_stock: form.kind === 'market' ? form.min_stock : '1',
      fresh: String(form.fresh), sort: form.sort, page: String(page) });
    if (form.reference.trim()) params.set('reference', form.reference.trim());
    if (form.kind === 'outfitting' && form.module_class) params.set('module_class', form.module_class);
    if (form.kind === 'outfitting' && form.rating) params.set('rating', form.rating);
    setLoading(true); setError('');
    try {
      const response = await fetch(`/api/stations/search?${params}`, { signal: request.signal });
      const result = await response.json();
      if (current !== generation.current) return;
      if (!response.ok) throw new Error(result.error || 'Не удалось выполнить поиск');
      setData(result);
    } catch (caught) {
      if (current !== generation.current || request.signal.aborted) return;
      setData(null); setError(caught instanceof Error ? caught.message : 'Ошибка поиска станций');
    } finally { if (current === generation.current) setLoading(false); }
  }
  return (
    <main className="market-page-wrap station-search-page">
      <div className="station-search-heading">
        <div><div className="station-search-eyebrow">ИНСТРУМЕНТЫ / БАЗА СТАНЦИЙ</div><h1 className="market-title">Поиск по станциям</h1></div>
        <Link href="/atlas" className="btn"><IconMap size={14} /> Открыть Атлас</Link>
      </div>
      <p className="atlas-muted">Товары, оснащение, корабли и услуги по наблюдениям Colonial Helper, EDSM, Spansh и EDDN, сохранённым в БД проекта.</p>
      <div className="station-search-tabs" role="tablist" aria-label="Что искать">
        {TABS.map((entry) => <button key={entry.id} id={`station-tab-${entry.id}`} type="button" role="tab" disabled={!ready} aria-selected={entry.id === form.kind} tabIndex={entry.id === form.kind ? 0 : -1} onKeyDown={(event) => {
          const index = TABS.findIndex((item) => item.id === entry.id);
          const next = event.key === 'ArrowRight' ? (index + 1) % TABS.length : event.key === 'ArrowLeft' ? (index + TABS.length - 1) % TABS.length : event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : -1;
          if (next < 0) return; event.preventDefault();
          change({ kind: TABS[next].id, q: '', module_class: '', rating: '', sort: 'distance' });
          document.getElementById(`station-tab-${TABS[next].id}`)?.focus();
        }} aria-controls="station-search-panel"
          className={`btn${entry.id === form.kind ? ' btn-orange' : ''}`} onClick={() => change({ kind: entry.id, q: '', module_class: '', rating: '', sort: 'distance' })}>
          <entry.icon size={14} /> {entry.title}
        </button>)}
      </div>
      <section id="station-search-panel" role="tabpanel" aria-labelledby={`station-tab-${form.kind}`}>
        <form className="station-search-form" onSubmit={(event) => { event.preventDefault(); void search(); }}>
          <div className="market-field station-query-field">
            <label htmlFor="station-query">{form.kind === 'services' ? 'Услуга / инженер' : tab.title}</label>
            <input id="station-query" className="input" disabled={!ready} required minLength={2} maxLength={120} list={`station-options-${form.kind}`} value={form.q} placeholder={tab.placeholder} onChange={(event) => change({ q: event.target.value })} />
            {form.kind === 'services' && <datalist id="station-options-services">{SERVICE_OPTIONS.map((service) => <option key={service.value} value={service.label} />)}</datalist>}
            {form.kind === 'market' && <datalist id="station-options-market">{BUILD_COMMODITIES.map((name) => <option key={name} value={name} />)}</datalist>}
          </div>
          <SystemSearchInput value={form.reference} onChange={(reference) => change({ reference })} label="Относительно системы (необязательно)" placeholder="Без ограничения — все известные станции" />
          <div className="market-field"><label htmlFor="station-radius">Радиус, св. л.</label><input id="station-radius" className="input" type="number" min={1} max={50000} required disabled={!form.reference.trim()} value={form.radius} onChange={(event) => change({ radius: event.target.value })} /></div>
          {form.kind === 'market' && <div className="market-field"><label htmlFor="station-stock">Минимальный запас, т</label><input id="station-stock" className="input" type="number" min={1} max={1e12} required value={form.min_stock} onChange={(event) => change({ min_stock: event.target.value })} /></div>}
          {form.kind === 'outfitting' && <>
            <div className="market-field"><label htmlFor="station-class">Класс модуля</label><select id="station-class" className="input" value={form.module_class} onChange={(event) => change({ module_class: event.target.value })}><option value="">Любой</option>{Array.from({ length: 9 }, (_, i) => <option key={i} value={i}>{i}</option>)}</select></div>
            <div className="market-field"><label htmlFor="station-rating">Рейтинг</label><select id="station-rating" className="input" value={form.rating} onChange={(event) => change({ rating: event.target.value })}><option value="">Любой</option>{'ABCDEFGHI'.split('').map((rating) => <option key={rating}>{rating}</option>)}</select></div>
          </>}
          <div className="market-field"><label htmlFor="station-sort">Сортировка</label><select id="station-sort" className="input" value={form.sort} onChange={(event) => change({ sort: event.target.value })}>
            <option value="distance">Ближайшие станции</option>{form.kind !== 'services' && <option value="price">Цена покупки</option>}<option value="updated">Свежие наблюдения</option>
          </select></div>
          <div className="station-search-actions"><label className="station-fresh-toggle"><input type="checkbox" checked={form.fresh} onChange={(event) => change({ fresh: event.target.checked })} /> Только данные за последний час</label>
            <button className="btn btn-orange" disabled={!ready || loading} type="submit"><IconSearch size={14} /> {loading ? 'Поиск…' : 'Найти станции'}</button>
          </div>
        </form>
      </section>
      <p className="station-search-notice"><IconAlert size={14} /> Наличие и цены могут измениться. У инженеров и брокеров могут требоваться приглашения, материалы или разрешения. Поиск показывает данные БД, а не гарантирует доступ к услуге.</p>
      <div aria-live="polite" aria-busy={loading}>
        {error && <div className="station-search-error" role="alert">{error}</div>}
        {loading && <p className="atlas-muted">Проверяем сохранённые наблюдения станций…</p>}
        {!data && !error && !loading && <div className="station-search-empty"><IconSearch size={28} /><h2>Найдите нужную станцию</h2><p>Выберите категорию и введите название. Опорная система позволяет найти ближайшие предложения.</p></div>}
        {data && <>
          <div className="station-results-heading"><h2>{TABS.find((entry) => entry.id === data.kind)?.title}: {data.query}</h2><span className="atlas-muted">Страница {data.page + 1} · {data.results.length} предложений</span></div>
          {!data.results.length && <div className="station-search-empty"><h2>Нет подходящих наблюдений в БД</h2><p>Попробуйте другой запрос, больший радиус или отключите фильтр свежести. Отсутствие отчёта не означает, что услуга или товар отсутствуют в игре.</p><Link href="/atlas?tab=market">Для товаров — расширенный поиск в Атласе →</Link></div>}
          <div className="station-results-grid">{data.results.map((row, index) => {
            const mapLink = stationAtlasLink(row);
            return <article className="station-result-card" key={`${row.station_key}-${row.item.symbol || row.item.name}-${index}`}>
              <div className="station-result-top"><span className="station-item-name">{row.item_display || row.item.name}</span><span className={`station-report-badge${row.stale ? ' stale' : ''}`}>{row.stale ? 'Устаревший отчёт' : 'За последний час'}</span></div>
              <h3>{row.station_name}</h3><div className="station-system-name">{row.system_name}</div>
              <dl className="station-result-facts">
                <div><dt>От опорной системы</dt><dd>{number(row.distance, ' св. л.')}</dd></div>
                {data.kind !== 'services' && <div><dt>Цена покупки</dt><dd>{number(data.kind === 'market' ? row.item.buyPrice : row.item.price, ' CR')}</dd></div>}
                {data.kind === 'market' && <><div><dt>Запас</dt><dd>{number(row.item.stock, ' т')}</dd></div><div><dt>Спрос</dt><dd>{number(row.item.demand, ' т')}</dd></div></>}
                <div><dt>От точки прибытия</dt><dd>{number(row.metadata.distance_to_arrival, ' св. с.')}</dd></div><div><dt>Тип станции</dt><dd>{row.station_type || 'Нет данных'}</dd></div>
              </dl>
              {row.metadata.body_name && <p className="atlas-muted">Тело: {row.metadata.body_name}</p>}
              {row.metadata.engineers?.length ? <p className="atlas-muted">Инженеры: {row.metadata.engineers.join(', ')}</p> : null}
              <div className="station-report-time">{sources[row.source] || row.source} · {observed(row.observed_at)}</div>
              <div className="station-result-footer">{mapLink ? <Link href={mapLink} target="_blank" rel="noopener noreferrer" className="btn" title="Открыть систему в новой вкладке Атласа"><IconMap size={14} /> Показать систему в Атласе</Link> : <button type="button" className="btn" disabled title="В БД нет координат системы">Координаты системы неизвестны</button>}</div>
            </article>;
          })}</div>
          {(data.page > 0 || data.has_more) && <nav className="station-search-pagination" aria-label="Страницы результатов"><button className="btn" disabled={loading || data.page === 0} onClick={() => void search(data.page - 1)}>← Назад</button><span>Страница {data.page + 1}</span><button className="btn" disabled={loading || !data.has_more || data.page >= 100} onClick={() => void search(data.page + 1)}>Далее →</button></nav>}
        </>}
      </div>
    </main>
  );
}
