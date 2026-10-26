'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { SystemSearchInput } from '@/components/Atlas/SystemSearchInput';
import { IconSearch, IconMap, IconPackage, IconWrench, IconRocket, IconGear, IconAlert } from '@/components/Icons';
import { StationItemPicker, rememberStationPick, useStationSearchOptions } from '@/components/StationSearch/StationItemPicker';
import { StationResultsList } from '@/components/StationSearch/StationResultsList';
import type { StationSearchKind, StationSearchStationsResponse } from '@/lib/stationSearch';
import { exactStationOption, pickMatchesKind, type StationPickRef, type StationSearchOption } from '@/lib/stationSearchOptions';
import { cleanSystemName } from '@/lib/systemIdentity';

const TABS = [
  { id: 'market' as const, title: 'Товары', icon: IconPackage, placeholder: 'Например, сталь, Steel или вода' },
  { id: 'outfitting' as const, title: 'Модули', icon: IconWrench, placeholder: 'Например, FSD, гипердвигатель или щит' },
  { id: 'shipyard' as const, title: 'Корабли', icon: IconRocket, placeholder: 'Например, Python, Anaconda или Type-9' },
  { id: 'services' as const, title: 'Услуги', icon: IconGear, placeholder: 'Услуга или инженер, например Felicity Farseer' },
];
/** Быстрый выбор радиуса (св. л.) и минимального запаса (т). */
const RADIUS_PRESETS = [50, 100, 250, 500, 1000];
const STOCK_PRESETS = [1, 100, 500, 1000, 5000];

interface FormState {
  kind: StationSearchKind; q: string; pick: StationPickRef | null; reference: string; radius: string; min_stock: string;
  module_class: string; rating: string; fresh: boolean; sort: string; pad: string; carriers: string;
}

export default function StationSearchPage() {
  const [form, setForm] = useState<FormState>({ kind: 'market', q: '', pick: null, reference: '', radius: '500', min_stock: '1', module_class: '', rating: '', fresh: false, sort: 'distance', pad: 'any', carriers: 'include' });
  const [data, setData] = useState<StationSearchStationsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [linkedItem, setLinkedItem] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const tab = TABS.find((entry) => entry.id === form.kind)!;
  const options = useStationSearchOptions(form.kind);

  useEffect(() => {
    setReady(true);
    // Ссылка из карточки системы и других разделов: `?reference=<система>&kind=…&q=…&item=…`.
    const params = new URLSearchParams(window.location.search);
    const reference = cleanSystemName(params.get('reference') ?? '').slice(0, 200);
    const q = (params.get('q') ?? '').slice(0, 200);
    const kind = TABS.find((entry) => entry.id === params.get('kind'))?.id;
    const pad = ['S', 'M', 'L'].includes(params.get('pad') ?? '') ? params.get('pad')! : 'any';
    const carriers = ['exclude', 'only'].includes(params.get('carriers') ?? '') ? params.get('carriers')! : 'include';
    if (reference || q || kind || pad !== 'any' || carriers !== 'include') {
      setForm((current) => ({ ...current, pad, carriers, reference: reference || current.reference, q: q || current.q, kind: kind ?? current.kind }));
    }
    const item = params.get('item');
    if (item && pickMatchesKind(kind ?? 'market', item)) setLinkedItem(item);
    return () => { generation.current++; controller.current?.abort(); };
  }, []);

  // `?item=` из ссылки становится точным выбором, когда список загрузится.
  useEffect(() => {
    if (!linkedItem || options.loading) return;
    const option = options.options.find((entry) => entry.id === linkedItem);
    if (option) setForm((current) => ({ ...current, q: option.label, pick: { id: option.id, label: option.label } }));
    setLinkedItem(null);
  }, [linkedItem, options]);

  const change = (patch: Partial<FormState>) => {
    generation.current++; controller.current?.abort(); setLoading(false); setData(null); setError('');
    setForm((current) => ({ ...current, ...patch }));
  };
  const switchTab = (kind: StationSearchKind) => change({ kind, q: '', pick: null, module_class: '', rating: '', sort: 'distance' });
  const pickOption = (option: StationSearchOption) => change({ q: option.label, pick: { id: option.id, label: option.label } });

  async function search(page = 0) {
    // Название, введённое целиком (на любом языке или символом), — тот же точный выбор.
    let pick = form.pick;
    if (!pick) {
      const exact = exactStationOption(options.options, form.q);
      if (exact) {
        pick = { id: exact.id, label: exact.label };
        rememberStationPick(form.kind, pick);
        setForm((current) => ({ ...current, q: exact.label, pick }));
      }
    }
    controller.current?.abort();
    const request = new AbortController(); controller.current = request;
    const current = ++generation.current;
    const params = new URLSearchParams({ kind: form.kind, q: (pick?.label ?? form.q).trim(), group: 'station',
      radius: form.reference.trim() ? form.radius : '500', min_stock: form.kind === 'market' ? form.min_stock : '1',
      pad: form.pad, carriers: form.carriers, fresh: String(form.fresh), sort: form.sort, page: String(page) });
    if (pick) params.set('item', pick.id);
    if (form.reference.trim()) params.set('reference', form.reference.trim());
    if (form.kind === 'outfitting' && form.module_class) params.set('module_class', form.module_class);
    if (form.kind === 'outfitting' && form.rating) params.set('rating', form.rating);
    setLoading(true); setError('');
    try {
      const response = await fetch(`/api/stations/search?${params}`, { signal: request.signal });
      let result: any;
      try {
        result = await response.json();
      } catch {
        if ([502, 503, 504].includes(response.status)) {
          throw new Error(`Сервер поиска временно не ответил (HTTP ${response.status}). Повторите поиск.`);
        }
        throw new Error(`Сервер поиска вернул некорректный ответ (HTTP ${response.status}). Повторите поиск.`);
      }
      if (current !== generation.current) return;
      if (!response.ok) throw new Error(result.error || 'Не удалось выполнить поиск');
      setData({ ...result, stations: Array.isArray(result.stations) ? result.stations : [] });
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
          switchTab(TABS[next].id);
          document.getElementById(`station-tab-${TABS[next].id}`)?.focus();
        }} aria-controls="station-search-panel"
          className={`btn${entry.id === form.kind ? ' btn-orange' : ''}`} onClick={() => switchTab(entry.id)}>
          <entry.icon size={14} /> {entry.title}
        </button>)}
      </div>
      <section id="station-search-panel" role="tabpanel" aria-labelledby={`station-tab-${form.kind}`}>
        <form className="station-search-form" onSubmit={(event) => { event.preventDefault(); void search(); }}>
          <div className="market-field station-query-field">
            <StationItemPicker
              kind={form.kind}
              id="station-query"
              label={form.kind === 'services' ? 'Услуга / инженер' : tab.title}
              value={form.q}
              pick={form.pick}
              placeholder={tab.placeholder}
              disabled={!ready}
              options={options.options}
              loading={options.loading}
              error={options.error}
              onChange={(q) => change({ q, pick: null })}
              onPick={pickOption}
            />
          </div>
          <SystemSearchInput value={form.reference} onChange={(reference) => change({ reference })} label="Относительно системы (необязательно)" placeholder="Без ограничения — все известные станции" />
          <div className="market-field">
            <label htmlFor="station-radius">Радиус, св. л.</label>
            <input id="station-radius" className="input" type="number" min={1} max={50000} required disabled={!form.reference.trim()} value={form.radius} onChange={(event) => change({ radius: event.target.value })} />
            <div className="atlas-preset-row station-presets" role="group" aria-label="Быстрый выбор радиуса">
              {RADIUS_PRESETS.map((value) => (
                <button key={value} type="button" disabled={!form.reference.trim()} className={`atlas-preset${form.radius === String(value) ? ' active' : ''}`}
                  aria-pressed={form.radius === String(value)} title={`${value} св. л.`} onClick={() => change({ radius: String(value) })}>{value.toLocaleString('ru-RU')}</button>
              ))}
            </div>
          </div>
          {form.kind === 'market' && <div className="market-field">
            <label htmlFor="station-stock">Минимальный запас, т</label>
            <input id="station-stock" className="input" type="number" min={1} max={1e12} required value={form.min_stock} onChange={(event) => change({ min_stock: event.target.value })} />
            <div className="atlas-preset-row station-presets" role="group" aria-label="Быстрый выбор запаса">
              {STOCK_PRESETS.map((value) => (
                <button key={value} type="button" className={`atlas-preset${form.min_stock === String(value) ? ' active' : ''}`}
                  aria-pressed={form.min_stock === String(value)} title={`от ${value} т`} onClick={() => change({ min_stock: String(value) })}>{value.toLocaleString('ru-RU')}</button>
              ))}
            </div>
          </div>}
          {form.kind === 'outfitting' && <>
            <div className="market-field"><label htmlFor="station-class">Класс модуля</label><select id="station-class" className="input" value={form.module_class} onChange={(event) => change({ module_class: event.target.value })}><option value="">Любой</option>{Array.from({ length: 9 }, (_, i) => <option key={i} value={i}>{i}</option>)}</select></div>
            <div className="market-field"><label htmlFor="station-rating">Рейтинг</label><select id="station-rating" className="input" value={form.rating} onChange={(event) => change({ rating: event.target.value })}><option value="">Любой</option>{'ABCDEFGHI'.split('').map((rating) => <option key={rating}>{rating}</option>)}</select></div>
          </>}
          <div className="market-field">
            <label htmlFor="station-pad">Площадка под корабль</label>
            <select id="station-pad" className="input" value={form.pad} onChange={(event) => change({ pad: event.target.value })} aria-describedby="station-pad-help">
              <option value="any">Любая / неизвестно</option>
              <option value="S">S — малый корабль</option>
              <option value="M">M — средний корабль (M или L)</option>
              <option value="L">L — большой корабль</option>
            </select>
            <small id="station-pad-help" className="atlas-muted">При выборе размера станции с неизвестной площадкой исключаются.</small>
          </div>
          <div className="market-field">
            <label htmlFor="station-carriers">Авианосцы</label>
            <select id="station-carriers" className="input" value={form.carriers} onChange={(event) => change({ carriers: event.target.value })}>
              <option value="include">Включать в поиск</option>
              <option value="exclude">Исключить из поиска</option>
              <option value="only">Только авианосцы</option>
            </select>
          </div>
          <div className="market-field"><label htmlFor="station-sort">Сортировка</label><select id="station-sort" className="input" value={form.sort} onChange={(event) => change({ sort: event.target.value })}>
            <option value="distance">Ближайшие станции</option>{form.kind !== 'services' && <option value="price">Цена покупки</option>}<option value="updated">Свежие наблюдения</option>
          </select></div>
          <div className="station-search-actions"><label className="station-fresh-toggle"><input type="checkbox" checked={form.fresh} onChange={(event) => change({ fresh: event.target.checked })} /> Только данные за последний час</label>
            <button className="btn btn-orange" disabled={!ready || loading} type="submit"><IconSearch size={14} /> {loading ? 'Поиск…' : 'Найти станции'}</button>
          </div>
        </form>
      </section>
      <p className="station-search-notice"><IconAlert size={14} /> Наличие и цены могут измениться. У инженеров и брокеров могут требоваться приглашения, материалы или разрешения. Поиск показывает данные БД, а не гарантирует доступ к услуге.</p>
      <div className="station-search-status" aria-live="polite" aria-busy={loading}>
        {error && <div className="station-search-error" role="alert">{error}</div>}
        {loading && <p className="atlas-muted">Проверяем сохранённые наблюдения станций…</p>}
        {data && !loading && <span className="station-sr-only">{data.total != null ? `Найдено станций: ${data.total}` : `Станций на странице: ${data.stations.length}`}</span>}
      </div>
      {!data && !error && !loading && <div className="station-search-empty"><IconSearch size={28} /><h2>Найдите нужную станцию</h2><p>Выберите категорию и начните вводить название — список подскажет точные варианты. Опорная система позволяет найти ближайшие предложения.</p></div>}
      {data && <StationResultsList data={data} loading={loading} onPage={(page) => void search(page)} />}
    </main>
  );
}
