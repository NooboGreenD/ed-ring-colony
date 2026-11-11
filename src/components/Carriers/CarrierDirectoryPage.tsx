'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  IconChevronLeft,
  IconChevronRight,
  IconCopy,
  IconRefresh,
  IconRoute,
  IconSearch,
  IconStar,
  IconX,
} from '@/components/Icons';
import { toast } from '@/components/ui/Toaster';
import { useI18n } from '@/lib/i18n/I18nContext';
import {
  CARRIER_CATALOG_DEFAULT_STATE,
  CARRIER_CATALOG_PAGE_SIZE,
  catalogApiHref,
  catalogJumpFilter,
  catalogOrigin,
  catalogPageCount,
  catalogPageRange,
  catalogPageWindow,
  catalogQueryString,
  catalogScope,
  catalogSort,
  normalizeCatalogSearch,
  parseCatalogState,
  type CarrierCatalogJump,
  type CarrierCatalogOrigin,
  type CarrierCatalogRow,
  type CarrierCatalogScope,
  type CarrierCatalogSort,
  type CarrierCatalogState,
} from '@/lib/carrierCatalog';
import {
  localCarrierWatch,
  mergeCarrierWatches,
  normalizeCarrierWatch,
  readLocalCarrierWatches,
  watchFor,
  writeLocalCarrierWatches,
  type CarrierWatch,
} from '@/lib/carrierDirectory';
import { carrierCardHref } from '@/lib/carrierCard';
import { systemPageHref } from '@/lib/systemIdentity';

/** Список меняется медленнее прыжков, но и он не вечен: обновляем раз в 2 минуты. */
const REFRESH_MS = 120_000;
/** Пауза после последнего символа в поиске: запрос на каждую букву — лишний. */
const SEARCH_DELAY_MS = 250;

interface DirectoryFeed {
  carriers?: CarrierCatalogRow[];
  total?: number;
  page?: number;
  pageSize?: number;
  pages?: number;
  viewer?: { signedIn?: boolean };
  generatedAt?: string;
  error?: string;
}

const SORT_OPTIONS: CarrierCatalogSort[] = ['recent', 'name', 'system'];
const SORT_LABEL: Record<CarrierCatalogSort, string> = {
  recent: 'cl.sortRecent',
  name: 'cl.sortName',
  system: 'cl.sortSystem',
};

const ORIGIN_OPTIONS: CarrierCatalogOrigin[] = ['all', 'site', 'eddn'];
const ORIGIN_LABEL: Record<CarrierCatalogOrigin, string> = {
  all: 'cl.originAll',
  site: 'cl.originSite',
  eddn: 'cl.originEddn',
};

const SCOPE_OPTIONS: CarrierCatalogScope[] = ['all', 'mine'];
const SCOPE_LABEL: Record<CarrierCatalogScope, string> = {
  all: 'cl.scopeAll',
  mine: 'cl.scopeMine',
};

const JUMP_OPTIONS: CarrierCatalogJump[] = ['all', 'planned'];
const JUMP_LABEL: Record<CarrierCatalogJump, string> = {
  all: 'cl.jumpAll',
  planned: 'cl.jumpPlanned',
};

/** «14.11, 18:20» — без секунд: в списке важна минута, а не точность прибора. */
function stamp(value: string | null, locale: string): string {
  if (!value) return '';
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toLocaleString(locale, {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** «3 часа назад» — по-настоящему локализовано, без своих словарей на каждый срок. */
function relativeLabel(value: string | null, locale: string, now: number): string {
  if (!value) return '';
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return '';
  const diff = Math.round((ms - now) / 60_000);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (Math.abs(diff) < 60) return format.format(diff, 'minute');
  if (Math.abs(diff) < 60 * 36) return format.format(Math.round(diff / 60), 'hour');
  return format.format(Math.round(diff / (60 * 24)), 'day');
}

/** Сегментированный фильтр: одна строка, три-четыре варианта, видно выбранный. */
function Segment<T extends string>({
  label,
  value,
  options,
  labels,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly T[];
  labels: Record<T, string>;
  onChange: (next: T) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="cl-seg" role="group" aria-label={label}>
      <span className="cl-seg-label">{label}</span>
      {options.map((option) => (
        <button
          key={option}
          type="button"
          className={`cl-seg-btn${option === value ? ' active' : ''}`}
          aria-pressed={option === value}
          onClick={() => onChange(option)}
        >
          {t(labels[option])}
        </button>
      ))}
    </div>
  );
}

/**
 * Каталог авианосцев: все известные носители одной таблицей.
 *
 * Состояние таблицы (поиск, фильтры, порядок, страница) живёт в адресе: ссылкой
 * делятся, а после перезагрузки открывается то же самое. Данные собирает
 * сервер — `carrier_catalog_page` объединяет учёт сайта и реестр EDDN, поэтому
 * страница не склеивает две выборки у себя и не теряет строки между ними.
 *
 * Интерфейс намеренно повторяет `/carriers/jumps` (те же классы `.cj-*`), чтобы
 * два экрана про авианосцы читались как один раздел. Своё у страницы только
 * то, чего у прыжков нет: сегментированные фильтры, пейджер и копирование
 * Carrier ID.
 */
export function CarrierDirectoryPage() {
  const { t, locale } = useI18n();
  const [state, setState] = useState<CarrierCatalogState>(CARRIER_CATALOG_DEFAULT_STATE);
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState<CarrierCatalogRow[]>([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [pageSize, setPageSize] = useState(CARRIER_CATALOG_PAGE_SIZE);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading');
  /** Таблица уже на экране, но данные перечитываются: не мигаем, а притухаем. */
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [watches, setWatches] = useState<CarrierWatch[]>([]);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  /** Адрес прочитан: до этого ни запрос, ни запись адреса не имеют смысла. */
  const [ready, setReady] = useState(false);
  const alive = useRef(true);
  /** Номер последнего запроса: ответ на отменённый фильтр не должен перебивать новый. */
  const requestSeq = useRef(0);
  const searchInput = useRef<HTMLInputElement | null>(null);

  useEffect(() => () => { alive.current = false; }, []);

  /* ── адрес страницы → состояние ── */
  useEffect(() => {
    const initial = parseCatalogState(window.location.search);
    setState(initial);
    setSearch(initial.q);
    setReady(true);
  }, []);

  /* ── состояние → адрес (без перезагрузки и без новой записи в истории) ── */
  useEffect(() => {
    if (!ready || typeof window === 'undefined') return;
    const query = catalogQueryString(state);
    const url = `${window.location.pathname}${query ? `?${query}` : ''}`;
    window.history.replaceState(null, '', url);
  }, [ready, state]);

  /* ── ввод в поиске: пауза, потом состояние ── */
  useEffect(() => {
    const clean = normalizeCatalogSearch(search);
    if (clean === state.q) return;
    const timer = setTimeout(() => {
      setState((current) => ({ ...current, q: clean, page: 1 }));
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [search, state.q]);

  const update = useCallback((patch: Partial<CarrierCatalogState>) => {
    setState((current) => ({ ...current, ...patch, page: patch.page ?? 1 }));
  }, []);

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    if (alive.current) setRefreshing(true);
    try {
      const response = await fetch(catalogApiHref(state), { cache: 'no-store' });
      const payload = await response.json() as DirectoryFeed;
      if (!response.ok) throw new Error(payload.error || String(response.status));
      if (!alive.current || seq !== requestSeq.current) return;
      const nextRows = Array.isArray(payload.carriers) ? payload.carriers : [];
      const nextTotal = Number(payload.total ?? nextRows.length);
      const nextPages = Number(payload.pages ?? catalogPageCount(nextTotal, CARRIER_CATALOG_PAGE_SIZE));
      setRows(nextRows);
      setTotal(Number.isFinite(nextTotal) ? nextTotal : nextRows.length);
      setPages(Number.isFinite(nextPages) && nextPages > 0 ? nextPages : 1);
      if (Number(payload.pageSize) > 0) setPageSize(Number(payload.pageSize));
      setUpdatedAt(payload.generatedAt ?? new Date().toISOString());
      setNow(Date.now());
      if (payload.viewer?.signedIn != null) setSignedIn((current) => current ?? Boolean(payload.viewer?.signedIn));
      setError('');
      setStatus('ready');
      // Сервер мог отдать другую страницу: из адреса легко прийти на «999».
      const actual = Number(payload.page);
      if (Number.isFinite(actual) && actual >= 1 && actual !== state.page) {
        setState((current) => ({ ...current, page: actual }));
      }
    } catch (cause) {
      if (!alive.current || seq !== requestSeq.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
      setStatus('error');
    } finally {
      if (alive.current && seq === requestSeq.current) setRefreshing(false);
    }
  }, [state]);

  useEffect(() => {
    if (!ready) return;
    setStatus((current) => (current === 'ready' ? current : 'loading'));
    void load();
  }, [load, ready]);

  useEffect(() => {
    if (!ready) return;
    const timer = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') void load();
    }, REFRESH_MS);
    const ticker = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      clearInterval(timer);
      clearInterval(ticker);
    };
  }, [load, ready]);

  /* ── личный список: сервер, у гостя — браузер ── */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch('/api/atlas/carriers/watch', { cache: 'no-store' });
        if (response.status === 401) {
          if (!cancelled) {
            setSignedIn(false);
            setWatches(readLocalCarrierWatches());
          }
          return;
        }
        if (!response.ok) throw new Error(String(response.status));
        const payload = await response.json() as { watches?: CarrierWatch[] };
        if (cancelled) return;
        setSignedIn(true);
        setWatches(mergeCarrierWatches(payload.watches ?? [], readLocalCarrierWatches()));
      } catch {
        if (cancelled) return;
        setSignedIn(false);
        setWatches(readLocalCarrierWatches());
      }
    })();
    return () => { cancelled = true; };
  }, []);

  /** Избранное: вошедшему — на сервер, гостю — в браузер. Заметку и подписку не трогаем. */
  const toggleFavorite = useCallback(async (row: CarrierCatalogRow) => {
    const current = watchFor(watches, row.id);
    const nextFavorite = current?.favorite !== true;
    const normalized = normalizeCarrierWatch({
      carrierId: row.id,
      callsign: row.callsign,
      name: row.name,
      system: row.system,
      favorite: nextFavorite,
      note: current?.note ?? null,
    });
    if (!normalized.ok) {
      toast(t('cl.saveFailed'), 'error');
      return;
    }
    const value = normalized.value;
    const remove = !value.favorite && !value.note && !current?.jumpSystem && !current?.jumpDepartureAt;
    const local = localCarrierWatch({
      ...value,
      jumpSystem: current?.jumpSystem ?? null,
      jumpDepartureAt: current?.jumpDepartureAt ?? null,
      jumpSeenAt: current?.jumpSeenAt ?? null,
    });
    const without = watches.filter((watch) => watch.carrierId !== row.id);
    const applyLocal = () => {
      const next = remove ? without : mergeCarrierWatches([local], without);
      writeLocalCarrierWatches(next);
      setWatches(next);
    };

    setSaving(row.id);
    try {
      if (signedIn === false) {
        applyLocal();
        toast(nextFavorite ? t('cl.favorited') : t('cl.favorite'), 'success');
        return;
      }
      const response = remove
        ? await fetch(`/api/atlas/carriers/watch?carrierId=${encodeURIComponent(row.id)}`, { method: 'DELETE' })
        : await fetch('/api/atlas/carriers/watch', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            carrierId: row.id,
            callsign: value.callsign,
            name: value.name,
            system: value.system,
            favorite: value.favorite,
            note: value.note,
          }),
        });
      if (response.status === 401) {
        setSignedIn(false);
        applyLocal();
        return;
      }
      if (!response.ok) throw new Error(String(response.status));
      if (remove) {
        setWatches(without);
      } else {
        const body = await response.json().catch(() => ({})) as { watch?: CarrierWatch };
        setWatches(mergeCarrierWatches([body.watch ?? local], without));
      }
      toast(nextFavorite ? t('cl.favorited') : t('cl.favorite'), 'success');
    } catch {
      toast(t('cl.saveFailed'), 'error');
    } finally {
      if (alive.current) setSaving(null);
    }
  }, [signedIn, t, watches]);

  /** Carrier ID — кнопкой: пилот приносит его в игру или в чат, а не перепечатывает. */
  const copyId = useCallback(async (id: string) => {
    try {
      await navigator.clipboard?.writeText(id);
      toast(t('cl.copied'), 'success');
    } catch {
      toast(t('cl.copyId'), 'error');
    }
  }, [t]);

  /** «/» — поиск, как в почте: руки не уходят с клавиатуры. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      const tag = (event.target as HTMLElement | null)?.tagName ?? '';
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) return;
      event.preventDefault();
      searchInput.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const window_ = useMemo(() => catalogPageWindow(state.page, pages), [pages, state.page]);
  const range = useMemo(() => catalogPageRange(state.page, pageSize, total), [pageSize, state.page, total]);
  const filtered = state.q !== '' || state.origin !== 'all' || state.scope !== 'all' || state.jump !== 'all';
  const favorites = useMemo(() => new Set(watches.filter((watch) => watch.favorite).map((watch) => watch.carrierId)), [watches]);
  const updated = updatedAt ? stamp(updatedAt, locale) : '';

  return (
    <div className="cl-page">
      <div className="cl-head">
        <div className="cl-actions">
          <Link className="cl-cta" href="/carriers/jumps">
            <IconRoute size={15} />
            <span className="cl-cta-text">
              <b>{t('cl.toJumps')}</b>
              <span>{t('cl.toJumpsHint')}</span>
            </span>
            <IconChevronRight size={14} />
          </Link>
        </div>
      </div>

      <div className="cj-toolbar">
        <div className="cj-search cl-search">
          <IconSearch size={14} />
          <input
            ref={searchInput}
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t('cl.searchPlaceholder')}
            aria-label={t('cl.searchAria')}
            autoComplete="off"
            spellCheck={false}
          />
          {search ? (
            <button
              type="button"
              className="cj-icon-btn"
              onClick={() => { setSearch(''); searchInput.current?.focus(); }}
              aria-label={t('cl.clearSearch')}
              title={t('cl.clearSearch')}
            >
              <IconX size={14} />
            </button>
          ) : null}
        </div>
        <label className="cl-sort">
          <span>{t('cl.sortLabel')}</span>
          <select value={state.sort} onChange={(event) => update({ sort: catalogSort(event.target.value) })}>
            {SORT_OPTIONS.map((option) => <option key={option} value={option}>{t(SORT_LABEL[option])}</option>)}
          </select>
        </label>
        <button
          type="button"
          className="cj-btn"
          onClick={() => { setStatus('loading'); void load(); }}
          disabled={status === 'loading' || refreshing}
          title={t('cl.refreshTitle')}
        >
          <IconRefresh size={14} />
          {t('cl.refresh')}
        </button>
        {filtered ? (
          <button
            type="button"
            className="cj-btn"
            onClick={() => { setSearch(''); setState({ ...CARRIER_CATALOG_DEFAULT_STATE }); }}
          >
            {t('cl.reset')}
          </button>
        ) : null}
      </div>

      <div className="cl-filters">
        <Segment
          label={t('cl.filterOrigin')}
          value={state.origin}
          options={ORIGIN_OPTIONS}
          labels={ORIGIN_LABEL}
          onChange={(next) => update({ origin: catalogOrigin(next) })}
        />
        <Segment
          label={t('cl.filterJump')}
          value={state.jump}
          options={JUMP_OPTIONS}
          labels={JUMP_LABEL}
          onChange={(next) => update({ jump: catalogJumpFilter(next) })}
        />
        {signedIn === false ? null : (
          <Segment
            label={t('cl.filterScope')}
            value={state.scope}
            options={SCOPE_OPTIONS}
            labels={SCOPE_LABEL}
            onChange={(next) => update({ scope: catalogScope(next) })}
          />
        )}
      </div>

      <p className="cj-meta">
        <span>{t('cl.found', { total })}</span>
        {total ? <span>{t('cl.range', { from: range.from, to: range.to, total })}</span> : null}
        {total ? <span>{t('cl.pageOf', { page: state.page, pages })}</span> : null}
        {updated ? <span>{t('cj.updated', { date: updated })}</span> : null}
        <span className="cj-dim">{signedIn === false ? t('cl.guestHint') : t('cl.personalHint')}</span>
      </p>

      {status === 'error' ? (
        <div className="cj-state-block" role="alert">
          <b>{t('cl.loadFailed')}</b>
          <span>{error}</span>
          <button type="button" className="cj-btn" onClick={() => { setStatus('loading'); void load(); }}>{t('cl.retry')}</button>
        </div>
      ) : null}

      {status === 'loading' ? (
        <div className="cj-state-block">
          <b>{t('cl.loading')}</b>
          <span>{t('cl.loadingDetail')}</span>
          <div className="cl-skeleton" aria-hidden="true">
            {[0, 1, 2, 3, 4].map((row) => <span key={row} className="cl-skel" />)}
          </div>
        </div>
      ) : null}

      {status === 'ready' && rows.length === 0 ? (
        <div className="cj-state-block">
          <b>{t('cl.emptyTitle')}</b>
          <span>{t('cl.emptyHint')}</span>
          {filtered ? (
            <button
              type="button"
              className="cj-btn"
              onClick={() => { setSearch(''); setState({ ...CARRIER_CATALOG_DEFAULT_STATE }); }}
            >
              {t('cl.emptyReset')}
            </button>
          ) : null}
        </div>
      ) : null}

      {status === 'ready' && rows.length ? (
        <div className={`cj-scroll${refreshing ? ' cl-refreshing' : ''}`} aria-busy={refreshing}>
          <table className="cj-table cl-table" aria-label={t('cl.title')}>
            <thead>
              <tr>
                <th scope="col">{t('cl.colCarrier')}</th>
                <th scope="col">{t('cl.colSystem')}</th>
                <th scope="col">{t('cl.colJump')}</th>
                <th scope="col" className="cj-num">{t('cl.colServices')}</th>
                <th scope="col">{t('cl.colSeen')}</th>
                <th scope="col">{t('cl.colSource')}</th>
                <th scope="col">{t('cl.colWatch')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const favorite = favorites.has(row.id);
                // `carrierCardHref` отсекает не-цифры, а id уже проверен выше;
                // запасной адрес — тот же самый, без лишней ветки в разметке.
                const href = carrierCardHref(row.id) ?? `/carriers/${row.id}`;
                const relative = relativeLabel(row.seenAt, locale, now);
                return (
                  <tr key={row.id} className={row.decommission ? 'cl-off' : undefined}>
                    <td data-label={t('cl.colCarrier')}>
                      <Link className="cj-carrier-link" href={href} title={t('cl.openCard')}>
                        <span className="cj-callsign">{row.callsign || t('cl.noCallsign')}</span>
                        <span className="cj-name">{row.name || t('cl.noName')}</span>
                      </Link>
                      <span className="cl-tags">
                        {row.relation === 'own' ? <span className="cl-tag own">{t('cl.relationOwn')}</span> : null}
                        {row.relation === 'squadron' ? <span className="cl-tag squadron">{t('cl.relationSquadron')}</span> : null}
                        {row.decommission ? <span className="cj-chip">{t('cl.decommission')}</span> : null}
                        <button
                          type="button"
                          className="cl-copy"
                          onClick={() => void copyId(row.id)}
                          title={t('cl.copyId')}
                          aria-label={t('cl.copyId')}
                        >
                          <IconCopy size={11} />
                          <span>{row.id}</span>
                        </button>
                      </span>
                    </td>
                    <td data-label={t('cl.colSystem')}>
                      {row.system ? (
                        <Link className="cj-system cj-target" href={systemPageHref(row.system)} title={t('cl.openSystem', { system: row.system })}>
                          {row.system}
                        </Link>
                      ) : <span className="cj-dim">{t('cl.unknownSystem')}</span>}
                      {row.body ? <span className="cj-relative">{row.body}</span> : null}
                    </td>
                    <td data-label={t('cl.colJump')}>
                      {row.jump ? (
                        <>
                          <Link
                            className="cj-system cj-target"
                            href={systemPageHref(row.jump.system)}
                            title={t('cl.openSystem', { system: row.jump.system })}
                          >
                            {row.jump.system}
                          </Link>
                          <span className={`cj-pill ${row.jump.state}`}>
                            {row.jump.state === 'jumping' ? t('cl.stateJumping') : t('cl.stateScheduled')}
                          </span>
                          {row.jump.departureAt ? (
                            <span className="cj-relative">{stamp(row.jump.departureAt, locale)}</span>
                          ) : null}
                        </>
                      ) : <span className="cj-dim">{t('cl.jumpNone')}</span>}
                    </td>
                    <td data-label={t('cl.colServices')} className="cj-num">
                      {row.services.total
                        ? t('cl.servicesCount', { active: row.services.active, total: row.services.total })
                        : <span className="cj-dim">{t('cl.servicesNone')}</span>}
                    </td>
                    <td data-label={t('cl.colSeen')}>
                      <span className="cj-time">{stamp(row.seenAt, locale) || t('cl.servicesNone')}</span>
                      {relative ? <span className="cj-relative">{relative}</span> : null}
                      {row.sightings && row.sightings > 1 ? (
                        <span className="cj-relative">{t('cl.sightings', { count: row.sightings })}</span>
                      ) : null}
                    </td>
                    <td data-label={t('cl.colSource')}>
                      <span className={`cl-source ${row.origin}`}>
                        {row.origin === 'eddn' ? t('cl.originEddn') : t('cl.originSite')}
                      </span>
                    </td>
                    <td data-label={t('cl.colWatch')}>
                      <button
                        type="button"
                        className={`cj-sub${favorite ? ' on' : ''}`}
                        onClick={() => void toggleFavorite(row)}
                        disabled={saving === row.id}
                        aria-pressed={favorite}
                        title={t('cl.favoriteTitle')}
                      >
                        <IconStar size={13} />
                        {favorite ? t('cl.favorited') : t('cl.favorite')}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {status === 'ready' && pages > 1 ? (
        <nav className="cl-pager" aria-label={t('cl.pageOf', { page: state.page, pages })}>
          <button
            type="button"
            className="cl-page-btn wide"
            onClick={() => update({ page: Math.max(1, state.page - 1) })}
            disabled={state.page <= 1}
          >
            <IconChevronLeft size={13} />
            {t('cl.prev')}
          </button>
          {window_.map((number, index) => (number === 0 ? (
            <span key={`gap-${index}`} className="cl-gap" aria-hidden="true">…</span>
          ) : (
            <button
              key={number}
              type="button"
              className={`cl-page-btn${number === state.page ? ' active' : ''}`}
              aria-current={number === state.page ? 'page' : undefined}
              aria-label={t('cl.pageAria', { page: number })}
              onClick={() => update({ page: number })}
            >
              {number}
            </button>
          )))}
          <button
            type="button"
            className="cl-page-btn wide"
            onClick={() => update({ page: Math.min(pages, state.page + 1) })}
            disabled={state.page >= pages}
          >
            {t('cl.next')}
            <IconChevronRight size={13} />
          </button>
        </nav>
      ) : null}

      <p className="cj-footnote">{t('cl.footnote')}</p>
    </div>
  );
}
