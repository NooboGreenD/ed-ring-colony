'use client';

/**
 * Вкладка «Трафик авианосцев» в Atlas.
 *
 * Реестр `fleet_carriers` собирает весь сайт: Colonial Helper присылает
 * `CarrierJump`/`CarrierLocation`/`Docked`, загрузка журналов — историю
 * перелётов. Здесь по нему можно найти **любой** известный носитель
 * галактики: по позывному (тегу), имени, системе или MarketID — и держать
 * под рукой те, что важны лично пилоту.
 *
 * Что делает панель:
 *  * состояние реестра — сколько носителей знает сайт, когда обновляли;
 *  * поиск с задержкой ввода: слова запроса складываются (AND), позывной
 *    ищется и без дефисов («k7qbql» → «K7Q-BQL»);
 *  * «Избранное» — личный список. У пилота с сессией он живёт в
 *    `atlas_carrier_watch` (RLS по `auth.uid()`), у гостя — в localStorage
 *    браузера; чужие записи не видны никому;
 *  * комментарий к носителю — до 500 символов, только для себя;
 *  * управление слоем карты — здесь же (10.11.2026): переключатель слоя,
 *    фильтр источника (сайт / EDDN), «чьи», класс и список систем со
 *    счётчиками. Раньше это жило в панели слоёв карты, отдельно от раздела,
 *    которому принадлежит;
 *  * клик по системе ведёт камеру карты: `atlas-focus-system` уже слушает
 *    `GalaxyMap`, отдельного канала не нужно; строка списка слоя шлёт
 *    `atlas-select-carrier-group` — тем же путём карта открывает карточку.
 *
 * Груза и финансов здесь нет: их не отдаёт `/api/map/carriers` и не хранит
 * реестр — это правило слоя карты, и оно сохранено.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  IconAlert,
  IconCheckCircle,
  IconDownload,
  IconEdit,
  IconMapPin,
  IconNote,
  IconRefresh,
  IconSearch,
  IconStar,
  IconTrash,
  IconX,
} from '@/components/Icons';
import { downloadCsv } from '@/lib/atlas';
import { CarrierLayerControls } from '@/components/GalaxyMap/CarrierLayerControls';
import type { CarrierLayer } from '@/hooks/useCarrierLayer';
import type { CarrierSystemGroup } from '@/lib/carrierMap';
import { CarrierGlyph } from '@/components/GalaxyMap/CarrierGlyph';
import { useI18n } from '@/lib/i18n/I18nContext';
import { toast } from '@/components/ui/Toaster';
import {
  CARRIER_NOTE_MAX,
  CARRIER_QUERY_MIN,
  CARRIER_WATCH_LIMIT,
  carrierLabel,
  localCarrierWatch,
  mergeCarrierWatches,
  normalizeCarrierWatch,
  orderCarrierDirectory,
  readLocalCarrierWatches,
  watchFor,
  writeLocalCarrierWatches,
  type CarrierWatch,
  type CarrierWatchScope,
} from '@/lib/carrierDirectory';

/** Ожидание после последнего нажатия: поиск не должен идти на каждую букву. */
const SEARCH_DEBOUNCE_MS = 350;

type Relation = 'own' | 'squadron' | 'other' | 'unknown';

interface CarrierRow {
  id: string;
  callsign: string | null;
  name: string | null;
  /** Владелец скрыт, если пилот не открыл местоположение — тогда `null`. */
  owner: string | null;
  system: string;
  type?: 'FleetCarrier' | 'SquadronCarrier';
  relation?: Relation;
  decommission?: boolean;
  /** Координаты системы приходят вместе с отметкой — для камеры карты. */
  position?: { x: number; y: number; z: number } | null;
  /** У гостя носитель известен только по снимку из localStorage. */
  watch?: CarrierWatch | null;
  /** Запись есть только в реестре EDDN: владельца и эскадрильи у неё нет. */
  origin?: 'site' | 'eddn';
  /** Пилот был на носителе (или владеет им) — может уточнить имя. */
  canName?: boolean;
}

interface SearchResponse {
  carriers: Array<{
    id: string;
    type: 'FleetCarrier' | 'SquadronCarrier';
    callsign: string | null;
    name: string | null;
    relation: Relation;
    system: string;
    position: { x: number; y: number; z: number } | null;
    decommission: boolean;
    origin?: 'site' | 'eddn';
    canName?: boolean;
  }>;
  total: number;
  truncated: boolean;
  viewer?: { signedIn?: boolean };
}

function formatDate(value: string | null | undefined, locale: string): string {
  if (!value) return '—';
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms).toLocaleString(locale, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** Подпись чьей носитель: строка реестра или гостевая заметка (relation 'unknown'). */
function relationLabel(row: CarrierRow, t: (key: string) => string): string {
  if (row.decommission) return t('acw.decommission');
  if (row.relation === 'own') return t('acw.relationOwn');
  if (row.relation === 'squadron') return t('acw.relationSquadron');
  if (row.relation === 'other') return t('acw.relationOther');
  return t('acw.relationUnknown');
}

function watchToCarrierRow(watch: CarrierWatch): CarrierRow {
  return {
    id: watch.carrierId,
    callsign: watch.callsign,
    name: watch.name,
    system: watch.system ?? '',
    owner: null,
    relation: 'unknown',
    position: null,
    watch,
  };
}

/**
 * Строка списка слоя — событие карты: `GalaxyMap` сбрасывает чужие карточки,
 * выбирает систему и подводит камеру (тот же путь, что клик по значку).
 */
function selectCarrierGroupOnMap(group: CarrierSystemGroup | null): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('atlas-select-carrier-group', { detail: group }));
}

export interface AtlasCarriersPanelProps {
  /** Слой карты: состояние живёт на странице Atlas, фильтр — в этой вкладке. */
  carrierLayer?: CarrierLayer | null;
}

export function AtlasCarriersPanel({ carrierLayer = null }: AtlasCarriersPanelProps = {}) {
  const { t, locale } = useI18n();
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [scope, setScope] = useState<CarrierWatchScope>('all');
  const [status, setStatus] = useState<'loading' | 'error' | 'empty' | 'ready'>('loading');
  const [error, setError] = useState('');
  const [rows, setRows] = useState<CarrierRow[]>([]);
  const [total, setTotal] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [watches, setWatches] = useState<CarrierWatch[]>([]);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  // Уточнение имени: отдельное состояние, чтобы не путать с комментарием.
  const [naming, setNaming] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState('');
  const [saving, setSaving] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => () => { alive.current = false; }, []);

  /* ── личный список: сервер, а у гостя — браузер ── */
  const loadWatches = useCallback(async () => {
    try {
      const response = await fetch('/api/atlas/carriers/watch', { cache: 'no-store' });
      if (response.status === 401) {
        setSignedIn(false);
        setWatches(readLocalCarrierWatches());
        return;
      }
      if (!response.ok) throw new Error(String(response.status));
      const payload = await response.json() as { watches?: CarrierWatch[] };
      const server = payload.watches ?? [];
      // Локальные записи не теряем: они могли появиться до входа.
      const merged = mergeCarrierWatches(server, readLocalCarrierWatches());
      setSignedIn(true);
      setWatches(merged.slice(0, CARRIER_WATCH_LIMIT));
    } catch {
      // Сеть недоступна — работаем как гость, без ошибки на весь раздел.
      setSignedIn(false);
      setWatches(readLocalCarrierWatches());
    }
  }, []);

  useEffect(() => { void loadWatches(); }, [loadWatches]);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const localOnly = signedIn === false;

  const search = useCallback(async () => {
    // У гостя «избранное» целиком живёт в браузере — запрос к серверу не нужен.
    if (scope === 'favorites' && localOnly) {
      const own = watches.filter((watch) => watch.favorite).map(watchToCarrierRow);
      setRows(orderCarrierDirectory(own, watches));
      setTotal(own.length);
      setTruncated(false);
      setStatus(own.length ? 'ready' : 'empty');
      setError('');
      return;
    }
    setStatus((current) => (current === 'ready' ? current : 'loading'));
    setError('');
    try {
      const params = new URLSearchParams();
      if (debounced) params.set('q', debounced);
      params.set('scope', scope);
      const response = await fetch(`/api/atlas/carriers?${params.toString()}`, { cache: 'no-store' });
      const payload = await response.json() as SearchResponse & { error?: string };
      if (!response.ok) throw new Error(payload.error || String(response.status));
      if (!alive.current) return;
      const list: CarrierRow[] = (payload.carriers ?? []).map((carrier) => ({
        id: String(carrier.id),
        callsign: carrier.callsign,
        name: carrier.name,
        owner: (carrier as { owner?: string | null }).owner ?? null,
        system: carrier.system,
        type: carrier.type,
        relation: carrier.relation,
        decommission: carrier.decommission,
        position: carrier.position,
        origin: carrier.origin,
        canName: carrier.canName,
        watch: watchFor(watches, carrier.id),
      }));
      setRows(list);
      setTotal(payload.total ?? list.length);
      setTruncated(Boolean(payload.truncated));
      setUpdatedAt(new Date().toISOString());
      if (payload.viewer?.signedIn != null) setSignedIn((current) => current ?? Boolean(payload.viewer?.signedIn));
      setStatus(list.length ? 'ready' : 'empty');
    } catch (cause) {
      if (!alive.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
      setStatus('error');
    }
  }, [debounced, localOnly, scope, watches]);

  useEffect(() => { void search(); }, [search]);

  const reload = useCallback(() => {
    void loadWatches();
    void search();
  }, [loadWatches, search]);

  /* ── избранное и комментарии ── */

  const persist = useCallback(async (
    carrier: CarrierRow,
    payload: { favorite: boolean; note: string | null },
  ): Promise<boolean> => {
    const normalized = normalizeCarrierWatch({
      carrierId: carrier.id,
      callsign: carrier.callsign,
      name: carrier.name,
      system: carrier.system,
      favorite: payload.favorite,
      note: payload.note,
    });
    if (!normalized.ok) {
      toast(t('acw.saveFailed'), 'error');
      return false;
    }
    // Пустая запись (не в избранном и без заметки) не нужна никому.
    const remove = !normalized.value.favorite && !normalized.value.note;
    const key = carrier.id;
    setSaving(key);
    try {
      if (localOnly) {
        const next = remove
          ? watches.filter((watch) => watch.carrierId !== key)
          : mergeCarrierWatches(
            [localCarrierWatch(normalized.value)],
            watches.filter((watch) => watch.carrierId !== key),
          );
        writeLocalCarrierWatches(next);
        setWatches(next);
        return true;
      }
      const response = remove
        ? await fetch(`/api/atlas/carriers/watch?carrierId=${encodeURIComponent(key)}`, { method: 'DELETE' })
        : await fetch('/api/atlas/carriers/watch', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(normalized.value),
        });
      if (response.status === 401) {
        // Сессия истекла посреди работы: дальше — локально, без потери ввода.
        setSignedIn(false);
        const next = remove
          ? watches.filter((watch) => watch.carrierId !== key)
          : mergeCarrierWatches([localCarrierWatch(normalized.value)], watches.filter((watch) => watch.carrierId !== key));
        writeLocalCarrierWatches(next);
        setWatches(next);
        return true;
      }
      if (!response.ok) throw new Error(String(response.status));
      if (remove) {
        setWatches((current) => current.filter((watch) => watch.carrierId !== key));
      } else {
        const body = await response.json() as { watch?: CarrierWatch };
        const saved = body.watch;
        setWatches((current) => mergeCarrierWatches(
          saved ? [saved] : [localCarrierWatch(normalized.value)],
          current.filter((watch) => watch.carrierId !== key),
        ));
      }
      return true;
    } catch {
      toast(t('acw.saveFailed'), 'error');
      return false;
    } finally {
      if (alive.current) setSaving(null);
    }
  }, [localOnly, t, watches]);

  const toggleFavorite = useCallback(async (carrier: CarrierRow) => {
    const current = watchFor(watches, carrier.id);
    const favorite = !(current?.favorite ?? false);
    const ok = await persist(carrier, { favorite, note: current?.note ?? null });
    if (ok) {
      setRows((list) => list.map((row) => (row.id === carrier.id
        ? { ...row, watch: { ...(current ?? localCarrierWatch({ carrierId: carrier.id, callsign: carrier.callsign, name: carrier.name, system: carrier.system, favorite, note: null })), favorite, note: current?.note ?? null } }
        : row)));
    }
  }, [persist, watches]);

  const saveNote = useCallback(async (carrier: CarrierRow) => {
    const current = watchFor(watches, carrier.id);
    const ok = await persist(carrier, { favorite: current?.favorite ?? false, note: draft.trim() || null });
    if (ok) {
      setEditing(null);
      setDraft('');
      toast(t('acw.commentSaved'), 'success');
    }
  }, [draft, persist, t, watches]);

  /**
   * Уточнить имя носителя. Имя приходит только от людей: EDDN передаёт
   * позывной, а настоящее имя видно лишь владельцу и тем, кто был на борту.
   * Право проверяет сервер (`/api/atlas/carriers/name`), здесь — только ввод.
   */
  const saveName = useCallback(async (carrier: CarrierRow) => {
    const name = nameDraft.replace(/\s+/g, ' ').trim();
    if (!name) return;
    setSaving(carrier.id);
    try {
      const response = await fetch('/api/atlas/carriers/name', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ carrierId: carrier.id, name }),
      });
      const payload = await response.json().catch(() => ({})) as { error?: string; name?: string };
      if (!response.ok) {
        toast(payload.error || t('acw.nameFailed'), 'error');
        return;
      }
      const saved = payload.name ?? name;
      setRows((list) => list.map((row) => (row.id === carrier.id ? { ...row, name: saved } : row)));
      setNaming(null);
      setNameDraft('');
      toast(t('acw.nameSaved'), 'success');
    } catch {
      toast(t('acw.nameFailed'), 'error');
    } finally {
      if (alive.current) setSaving(null);
    }
  }, [alive, nameDraft, t]);

  const removeWatch = useCallback(async (carrier: CarrierRow) => {
    const ok = await persist(carrier, { favorite: false, note: null });
    if (ok) setRows((list) => list.map((row) => (row.id === carrier.id ? { ...row, watch: null } : row)));
  }, [persist]);

  const focusSystem = useCallback((system: string, position?: { x: number; y: number; z: number } | null) => {
    const name = system.trim();
    if (!name) return;
    window.dispatchEvent(new CustomEvent('atlas-focus-system', {
      detail: { name, x: position?.x, y: position?.y, z: position?.z },
    }));
  }, []);

  const exportList = useCallback(() => {
    const header = [t('acw.csvCallsign'), t('acw.csvName'), t('acw.csvSystem'), t('acw.csvRelation'), t('acw.csvNote')];
    const body = rows.map((row) => {
      const watch = row.watch ?? watchFor(watches, row.id);
      return [
        row.callsign ?? '',
        row.name ?? '',
        row.system || '—',
        relationLabel(row, t),
        watch?.note ?? '',
      ];
    });
    downloadCsv(`carriers-${new Date().toISOString().slice(0, 10)}`, [header, ...body]);
  }, [rows, t, watches]);

  const favoriteCount = useMemo(() => watches.filter((watch) => watch.favorite).length, [watches]);
  const noteCount = useMemo(() => watches.filter((watch) => Boolean(watch.note)).length, [watches]);
  const showSearchHint = !debounced && scope === 'all' && status !== 'error' && rows.length > 0;
  const needsMoreLetters = debounced.length > 0 && debounced.length < CARRIER_QUERY_MIN;

  const statusKind = status === 'error' ? 'error' : status === 'loading' ? 'loading' : status === 'empty' ? 'empty' : 'ready';

  let statusBlock;
  if (statusKind === 'loading') {
    statusBlock = (
      <>
        <div className="powerplay-status-title">{t('acw.loading')}</div>
        <div className="powerplay-status-detail">{t('acw.loadingDetail')}</div>
      </>
    );
  } else if (statusKind === 'error') {
    statusBlock = (
      <>
        <div className="powerplay-status-title"><IconAlert size={12} /> {t('acw.loadFailed')}</div>
        <div className="powerplay-status-detail">{error || t('acw.serverNoAnswer')}</div>
        <button type="button" className="atlas-link-btn powerplay-retry" onClick={reload}>{t('acw.retry')}</button>
      </>
    );
  } else if (statusKind === 'empty') {
    statusBlock = (
      <>
        <div className="powerplay-status-title"><IconAlert size={12} /> {scope === 'favorites' ? t('acw.favoritesEmpty') : t('acw.emptyTitle')}</div>
        <div className="powerplay-status-detail">{scope === 'favorites' ? t('acw.favoritesEmptyHint') : t('acw.emptyHint')}</div>
        <div className="powerplay-status-hint">{t('acw.emptySource')}</div>
      </>
    );
  } else {
    statusBlock = (
      <>
        <div className="powerplay-status-title">
          <IconCheckCircle size={12} /> {t('acw.found', { total: total.toLocaleString(locale) })}
        </div>
        <div className="powerplay-status-detail">
          {t('acw.watchStats', { favorites: favoriteCount, notes: noteCount })}
          {updatedAt ? ` · ${t('acw.updated', { date: formatDate(updatedAt, locale) })}` : ''}
        </div>
        {truncated && <div className="powerplay-status-hint">{t('acw.truncated', { shown: rows.length })}</div>}
      </>
    );
  }

  return (
    <div className="atlas-section powerplay-panel acw-panel" data-carrier-watch-panel="">
      <div className="atlas-section-head">
        <h4><CarrierGlyph size={14} color="currentColor" /> {t('acw.title')}</h4>
        <div className="atlas-section-actions">
          <button type="button" className="atlas-icon-btn" title={t('acw.exportTitle')} onClick={exportList} disabled={rows.length === 0}>
            <IconDownload size={12} />
          </button>
          <button type="button" className="atlas-icon-btn" title={t('acw.reloadTitle')} onClick={reload}>
            <IconRefresh size={12} />
          </button>
        </div>
      </div>

      {carrierLayer && (
        <div className="acw-layer" data-carrier-layer-controls="">
          <div className="acw-layer-title">{t('acw.layerTitle')}</div>
          <p className="acw-hint dim">{t('acw.layerHint')}</p>
          <CarrierLayerControls
            show={carrierLayer.show}
            onShowChange={carrierLayer.setShow}
            filter={carrierLayer.filter}
            onFilterChange={carrierLayer.setFilter}
            counts={carrierLayer.counts}
            visibleCount={carrierLayer.visibleCount}
            groups={carrierLayer.groups}
            selectedKey={carrierLayer.selectedKey}
            onSelectGroup={selectCarrierGroupOnMap}
            status={carrierLayer.status}
            signedIn={carrierLayer.signedIn}
            directory={carrierLayer.directory}
          />
        </div>
      )}

      <div className={`powerplay-state-card ${statusKind}`} data-carrier-watch-status={statusKind} role="status" aria-live="polite">
        {statusBlock}
      </div>

      <div className="atlas-inline-search">
        <IconSearch size={12} />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('acw.searchPlaceholder')}
          aria-label={t('acw.searchAria')}
        />
        {query && (
          <button type="button" onClick={() => setQuery('')} aria-label={t('acw.clearSearchAria')}>
            <IconX size={11} />
          </button>
        )}
      </div>

      <div className="acw-scope" role="group" aria-label={t('acw.scopeAria')}>
        <button
          type="button"
          className={`acw-scope-btn${scope === 'all' ? ' active' : ''}`}
          aria-pressed={scope === 'all'}
          onClick={() => setScope('all')}
        >
          {t('acw.scopeAll')}
        </button>
        <button
          type="button"
          className={`acw-scope-btn${scope === 'favorites' ? ' active' : ''}`}
          aria-pressed={scope === 'favorites'}
          onClick={() => setScope('favorites')}
        >
          <IconStar size={11} /> {t('acw.scopeFavorites', { count: favoriteCount })}
        </button>
      </div>

      <p className="acw-hint">
        {signedIn === false ? t('acw.guestHint') : t('acw.personalHint')}
      </p>

      {(needsMoreLetters || showSearchHint) && (
        <p className="acw-hint dim">{needsMoreLetters ? t('acw.minChars', { count: CARRIER_QUERY_MIN }) : t('acw.searchHint')}</p>
      )}

      <ul className="bgs-results acw-results" aria-label={t('acw.resultsAria')} data-carrier-watch-results="">
        {status === 'loading' && rows.length === 0 && <li className="powerplay-empty">{t('acw.searching')}</li>}
        {status !== 'loading' && rows.length === 0 && (
          <li className="powerplay-empty">
            {scope === 'favorites' ? t('acw.favoritesEmpty') : debounced ? t('acw.notFound', { query: debounced }) : t('acw.startHint')}
          </li>
        )}
        {rows.map((row) => {
          const watch = row.watch ?? watchFor(watches, row.id);
          const favorite = Boolean(watch?.favorite);
          const label = carrierLabel(row);
          const isEditing = editing === row.id;
          return (
            <li key={row.id} data-carrier-watch-row={row.id}>
              <div className="acw-row">
                <button
                  type="button"
                  className="acw-row-main"
                  onClick={() => focusSystem(row.system, row.position)}
                  title={!row.system ? t('acw.noSystem') : row.position ? t('acw.focusTitle', { system: row.system }) : t('acw.noCoords')}
                  disabled={!row.position}
                >
                  <span className="acw-row-label">{label}</span>
                  <span className="acw-row-meta">
                    <span className="acw-chip">{relationLabel(row, t)}</span>
                    {row.origin === 'eddn' && <span className="acw-chip dim" title={t('acw.nameHint')}>{t('acw.originEddn')}</span>}
                    {row.system ? <span className="acw-system"><IconMapPin size={10} /> {row.system}</span> : <span className="acw-system dim">{t('acw.noSystem')}</span>}
                    {watch?.note && <span className="acw-note-badge" title={watch.note}><IconNote size={10} /> {t('acw.hasNote')}</span>}
                  </span>
                </button>
                <span className="acw-row-actions">
                  <button
                    type="button"
                    className={`atlas-icon-btn acw-star${favorite ? ' active' : ''}`}
                    aria-pressed={favorite}
                    title={favorite ? t('acw.favoriteRemove') : t('acw.favoriteAdd')}
                    aria-label={favorite ? t('acw.favoriteRemove') : t('acw.favoriteAdd')}
                    onClick={() => void toggleFavorite(row)}
                    disabled={saving === row.id}
                  >
                    <IconStar size={12} />
                  </button>
                  {row.canName && (
                    <button
                      type="button"
                      className={`atlas-icon-btn${naming === row.id ? ' active' : ''}`}
                      title={t('acw.nameEdit')}
                      aria-label={t('acw.nameEdit')}
                      onClick={() => {
                        setNaming(naming === row.id ? null : row.id);
                        setNameDraft(row.name ?? '');
                      }}
                    >
                      <IconEdit size={12} />
                    </button>
                  )}
                  <button
                    type="button"
                    className={`atlas-icon-btn${isEditing ? ' active' : ''}`}
                    title={t('acw.comment')}
                    aria-label={t('acw.comment')}
                    onClick={() => {
                      setEditing(isEditing ? null : row.id);
                      setDraft(watch?.note ?? '');
                    }}
                  >
                    <IconNote size={12} />
                  </button>
                  {watch && (
                    <button
                      type="button"
                      className="atlas-icon-btn"
                      title={t('acw.remove')}
                      aria-label={t('acw.remove')}
                      onClick={() => void removeWatch(row)}
                      disabled={saving === row.id}
                    >
                      <IconTrash size={12} />
                    </button>
                  )}
                </span>
              </div>
              {naming === row.id && (
                <div className="acw-editor acw-name-editor">
                  <input
                    type="text"
                    value={nameDraft}
                    maxLength={80}
                    placeholder={t('acw.namePlaceholder')}
                    aria-label={t('acw.namePlaceholder')}
                    onChange={(event) => setNameDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void saveName(row);
                      if (event.key === 'Escape') { setNaming(null); setNameDraft(''); }
                    }}
                  />
                  <div className="acw-editor-foot">
                    <span className="acw-counter">{t('acw.nameHint')}</span>
                    <button type="button" className="atlas-link-btn" onClick={() => { setNaming(null); setNameDraft(''); }}>
                      {t('acw.commentCancel')}
                    </button>
                    <button type="button" className="acw-save" onClick={() => void saveName(row)} disabled={saving === row.id || !nameDraft.trim()}>
                      {t('acw.nameSave')}
                    </button>
                  </div>
                </div>
              )}
              {isEditing && (
                <div className="acw-editor">
                  <textarea
                    value={draft}
                    maxLength={CARRIER_NOTE_MAX}
                    rows={3}
                    placeholder={t('acw.commentPlaceholder')}
                    aria-label={t('acw.commentPlaceholder')}
                    onChange={(event) => setDraft(event.target.value)}
                  />
                  <div className="acw-editor-foot">
                    <span className="acw-counter">{draft.length}/{CARRIER_NOTE_MAX}</span>
                    <button type="button" className="atlas-link-btn" onClick={() => { setEditing(null); setDraft(''); }}>
                      {t('acw.commentCancel')}
                    </button>
                    <button type="button" className="acw-save" onClick={() => void saveNote(row)} disabled={saving === row.id}>
                      {t('acw.commentSave')}
                    </button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <p className="acw-footnote">
        {t('acw.footnote', { max: CARRIER_NOTE_MAX })}
      </p>
    </div>
  );
}

export default AtlasCarriersPanel;
