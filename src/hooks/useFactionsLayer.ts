'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BGS_MAX_SELECTED,
  DEFAULT_BGS_FILTER,
  bgsOverview,
  buildBgsMapPoints,
  countBgsAllegiances,
  decodeBgsLayer,
  decodeBgsMeta,
  decodeFactionPresence,
  decodeFactionSearch,
  nextSelectionColor,
  normalizeAllegiance,
  parseBgsFilter,
  parseBgsSelection,
  type BgsAllegiance,
  type BgsFactionPresence,
  type BgsFactionSummary,
  type BgsFilter,
  type BgsLayerData,
  type BgsMapPoint,
  type BgsOverview,
  type BgsSelectedFaction,
  type BgsSystem,
} from '@/lib/bgs';

/**
 * Слой «Фракции» Atlas: загрузка `GET /api/factions/systems` (все населённые
 * системы), выбранные минорные фракции и их системы
 * (`GET /api/factions/presence`), фильтр вкладки, выбранная на карте система.
 * Показ на карте, фильтр и выбранные фракции переживают перезагрузку страницы
 * (localStorage).
 *
 * Набор большой (десятки тысяч систем), поэтому он грузится только когда нужен
 * — открыта вкладка или слой включён на карте — и один раз на вкладку
 * браузера (кэш модуля). Повторный визит браузер подтверждает по ETag (304).
 */

export const FACTIONS_STORAGE_KEY = 'atlas-factions-v1';
/**
 * Пока сервер импортирует дамп EDSM, вкладка спрашивает короткое состояние
 * (`?meta=1`, без систем) — не дольше ~3 часов; когда импорт закончился,
 * набор перезапрашивается целиком.
 */
const REFRESH_RETRY_MS = 15_000;
const REFRESH_RETRY_LIMIT = 720;
/** Системы выбранной фракции считаются свежими столько (потом перезапрос при открытии). */
const PRESENCE_TTL_MS = 5 * 60 * 1000;

export type FactionsLoadStatus = 'idle' | 'loading' | 'ready' | 'empty' | 'error';

export interface FactionsDownloadProgress {
  received: number;
  total: number | null;
}

let moduleCache: BgsLayerData | null = null;
let inFlight: Promise<BgsLayerData> | null = null;
const presenceCache = new Map<number, { data: BgsFactionPresence; at: number }>();
const progressListeners = new Set<(progress: FactionsDownloadProgress | null) => void>();

function emitProgress(progress: FactionsDownloadProgress | null): void {
  for (const listener of progressListeners) listener(progress);
}

/** Для тестов: забыть загруженное. */
export function resetFactionsLayerCache(): void {
  moduleCache = null;
  inFlight = null;
  presenceCache.clear();
}

async function readBody(response: Response): Promise<unknown> {
  const declared = Number(response.headers?.get?.('x-content-bytes'));
  const total = Number.isFinite(declared) && declared > 0 ? declared : null;
  const reader = response.body && typeof response.body.getReader === 'function' ? response.body.getReader() : null;
  if (!reader) return response.json().catch(() => null);
  const chunks: Uint8Array[] = [];
  let received = 0;
  let lastEmit = 0;
  emitProgress({ received: 0, total });
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    const now = Date.now();
    if (now - lastEmit > 80) {
      lastEmit = now;
      emitProgress({ received, total });
    }
  }
  emitProgress({ received, total: total ?? received });
  const merged = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(merged));
  } catch {
    return null;
  }
}

async function errorText(response: Response, fallback: string): Promise<string> {
  const body = await response.json().catch(() => null);
  return body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
    ? (body as { error: string }).error
    : `${fallback} (HTTP ${response.status})`;
}

export function fetchFactionsLayer(force = false): Promise<BgsLayerData> {
  if (!force && moduleCache && moduleCache.status === 'ready' && !moduleCache.meta.refreshing) return Promise.resolve(moduleCache);
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const response = await fetch('/api/factions/systems', force ? { cache: 'no-cache' } : undefined);
    if (!response.ok) throw new Error(await errorText(response, 'Не удалось загрузить системы фракций'));
    const data = decodeBgsLayer(await readBody(response));
    moduleCache = data;
    return data;
  })().finally(() => {
    inFlight = null;
    emitProgress(null);
  });
  return inFlight;
}

/** Короткое состояние слоя: идёт ли импорт и на каком он этапе. */
export async function fetchFactionsMeta(): Promise<BgsLayerData['meta']> {
  const response = await fetch('/api/factions/systems?meta=1', { cache: 'no-store' });
  if (!response.ok) throw new Error(await errorText(response, 'Не удалось узнать состояние импорта'));
  return decodeBgsMeta(await response.json());
}

export async function fetchFactionPresence(ids: number[], force = false): Promise<Map<number, BgsFactionPresence>> {
  const now = Date.now();
  const out = new Map<number, BgsFactionPresence>();
  const missing: number[] = [];
  for (const id of ids) {
    const cached = presenceCache.get(id);
    if (!force && cached && now - cached.at < PRESENCE_TTL_MS) out.set(id, cached.data);
    else missing.push(id);
  }
  if (missing.length > 0) {
    const response = await fetch(`/api/factions/presence?ids=${missing.join(',')}`);
    if (!response.ok) throw new Error(await errorText(response, 'Не удалось загрузить системы фракций'));
    for (const item of decodeFactionPresence(await response.json())) {
      presenceCache.set(item.id, { data: item, at: Date.now() });
      out.set(item.id, item);
    }
  }
  return out;
}

export async function fetchFactionSearch(
  query: string,
  options: { player?: boolean; limit?: number; signal?: AbortSignal } = {},
): Promise<BgsFactionSummary[]> {
  const params = new URLSearchParams({ q: query, limit: String(options.limit ?? 20) });
  if (options.player) params.set('player', '1');
  const response = await fetch(`/api/factions/search?${params.toString()}`, { signal: options.signal });
  if (!response.ok) throw new Error(await errorText(response, 'Поиск фракций недоступен'));
  return decodeFactionSearch(await response.json());
}

interface StoredSettings {
  visible: boolean;
  filter: BgsFilter;
  selection: BgsSelectedFaction[];
  seen: boolean;
}

function readSettings(): StoredSettings | null {
  try {
    if (typeof window === 'undefined') return null;
    const raw = window.localStorage.getItem(FACTIONS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredSettings>;
    return {
      visible: parsed.visible === true,
      filter: parseBgsFilter(parsed.filter),
      selection: parseBgsSelection(parsed.selection),
      seen: parsed.seen === true,
    };
  } catch {
    return null;
  }
}

function writeSettings(settings: StoredSettings): void {
  try {
    if (typeof window !== 'undefined') window.localStorage.setItem(FACTIONS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Приватный режим или переполненное хранилище — настройки просто не запомнятся.
  }
}

export interface FactionsOverviewRequest {
  id: number;
  view: BgsOverview;
}

export type PresenceStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface AtlasFactionsState {
  visible: boolean;
  setVisible: (visible: boolean) => void;
  download: FactionsDownloadProgress | null;
  status: FactionsLoadStatus;
  data: BgsLayerData | null;
  error: string;
  reload: () => void;
  /** Все населённые системы слоя. */
  systems: BgsSystem[];
  allegianceCounts: Record<BgsAllegiance, number>;
  filter: BgsFilter;
  setFilter: (filter: BgsFilter) => void;
  /** Выбранные фракции (до 12). */
  selection: BgsSelectedFaction[];
  presence: ReadonlyMap<number, BgsFactionPresence>;
  presenceStatus: PresenceStatus;
  presenceError: string;
  addFaction: (faction: { id: number; name: string; allegiance?: string | null }) => void;
  removeFaction: (id: number) => void;
  toggleFactionHidden: (id: number) => void;
  /** Оставить на карте только эту фракцию из выбранных. */
  soloFaction: (id: number) => void;
  clearSelection: () => void;
  /** Что сейчас на карте. */
  points: BgsMapPoint[];
  selectedKey: string | null;
  selected: BgsMapPoint | null;
  select: (point: BgsMapPoint | null, options?: { focus?: boolean }) => void;
  /** Показать систему по имени / id64: на слое — открыть карточку, иначе подвести камеру. */
  showSystem: (ref: { id64?: string | null; name: string; x?: number; y?: number; z?: number }) => void;
  focusOverview: (points?: Array<{ x: number; y: number; z: number }>) => void;
  overviewRequest: FactionsOverviewRequest | null;
}

export function useAtlasFactions({ tabActive }: { tabActive: boolean }): AtlasFactionsState {
  const [visible, setVisibleState] = useState(false);
  const [filter, setFilterState] = useState<BgsFilter>(DEFAULT_BGS_FILTER);
  const [selection, setSelection] = useState<BgsSelectedFaction[]>([]);
  const [seen, setSeen] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [status, setStatus] = useState<FactionsLoadStatus>('idle');
  const [data, setData] = useState<BgsLayerData | null>(null);
  const [error, setError] = useState('');
  const [reloadToken, setReloadToken] = useState(0);
  const [download, setDownload] = useState<FactionsDownloadProgress | null>(null);
  const [presence, setPresence] = useState<Map<number, BgsFactionPresence>>(() => new Map());
  const [presenceStatus, setPresenceStatus] = useState<PresenceStatus>('idle');
  const [presenceError, setPresenceError] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const retries = useRef(0);
  // «Перезапросить» обновляет и системы выбранных фракций — один раз, а не на каждый выбор.
  const presenceReloadSeen = useRef(0);

  useEffect(() => {
    progressListeners.add(setDownload);
    return () => {
      progressListeners.delete(setDownload);
    };
  }, []);

  // localStorage — только после монтирования: страница пререндерится на сервере.
  useEffect(() => {
    const stored = readSettings();
    if (stored) {
      setVisibleState(stored.visible);
      setFilterState(stored.filter);
      setSelection(stored.selection);
      setSeen(stored.seen);
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (hydrated) writeSettings({ visible, filter, selection, seen });
  }, [filter, hydrated, seen, selection, visible]);

  // Первое открытие вкладки включает слой: пользователь пришёл посмотреть на фракции.
  useEffect(() => {
    if (!hydrated || !tabActive || seen) return;
    setSeen(true);
    setVisibleState(true);
  }, [hydrated, seen, tabActive]);

  const needed = hydrated && (visible || tabActive);

  useEffect(() => {
    if (!needed) return;
    let cancelled = false;
    let timer: number | undefined;

    // Сервер импортирует дамп фоном: следим за ходом коротким запросом, а когда
    // импорт закончился — забираем новый набор целиком.
    const watch = async () => {
      try {
        const meta = await fetchFactionsMeta();
        if (cancelled) return;
        if (meta.refreshing && retries.current < REFRESH_RETRY_LIMIT) {
          retries.current += 1;
          setData((current) => (current ? { ...current, meta } : current));
          timer = window.setTimeout(() => void watch(), REFRESH_RETRY_MS);
        } else {
          void load(true);
        }
      } catch {
        if (!cancelled) timer = window.setTimeout(() => void watch(), REFRESH_RETRY_MS * 2);
      }
    };

    const load = async (force: boolean) => {
      setStatus((current) => (current === 'ready' || current === 'empty' ? current : 'loading'));
      try {
        const next = await fetchFactionsLayer(force);
        if (cancelled) return;
        setData(next);
        setError('');
        setStatus(next.status);
        if (next.meta.refreshing && retries.current < REFRESH_RETRY_LIMIT) {
          retries.current += 1;
          timer = window.setTimeout(() => void watch(), REFRESH_RETRY_MS);
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Не удалось загрузить системы фракций');
        setStatus((current) => (current === 'ready' ? current : 'error'));
      }
    };

    void load(reloadToken > 0);
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [needed, reloadToken]);

  // Системы выбранных фракций: догружаются только недостающие.
  const selectionIds = useMemo(() => selection.map((item) => item.id), [selection]);
  const selectionKey = selectionIds.join(',');
  useEffect(() => {
    if (!hydrated || selectionIds.length === 0) {
      setPresenceStatus('idle');
      return;
    }
    let cancelled = false;
    setPresenceStatus('loading');
    const force = presenceReloadSeen.current !== reloadToken;
    presenceReloadSeen.current = reloadToken;
    fetchFactionPresence(selectionIds, force)
      .then((loaded) => {
        if (cancelled) return;
        setPresence((current) => {
          const next = new Map(current);
          for (const [id, item] of loaded) next.set(id, item);
          return next;
        });
        setPresenceError('');
        setPresenceStatus('ready');
      })
      .catch((err) => {
        if (cancelled) return;
        setPresenceError(err instanceof Error ? err.message : 'Не удалось загрузить системы фракций');
        setPresenceStatus('error');
      });
    return () => {
      cancelled = true;
    };
    // selectionKey — стабильная форма selectionIds.
  }, [hydrated, selectionKey, reloadToken]);

  const systems = useMemo(() => data?.systems ?? [], [data]);
  const allegianceCounts = useMemo(() => countBgsAllegiances(systems), [systems]);
  const points = useMemo(
    () => buildBgsMapPoints({ systems, filter, selection, presence }),
    [filter, presence, selection, systems],
  );
  const pointIndex = useMemo(() => {
    const index = new Map<string, BgsMapPoint>();
    for (const point of points) index.set(point.key, point);
    return index;
  }, [points]);
  const selected = selectedKey ? pointIndex.get(selectedKey) ?? null : null;

  // Фильтр или новый набор убрали выбранную систему — карточка закрывается.
  useEffect(() => {
    if (selectedKey && !selected && status !== 'loading' && presenceStatus !== 'loading') setSelectedKey(null);
  }, [presenceStatus, selected, selectedKey, status]);

  const setVisible = useCallback((next: boolean) => {
    setVisibleState(next);
    if (!next) setSelectedKey(null);
  }, []);

  const setFilter = useCallback((next: BgsFilter) => setFilterState(next), []);

  const reload = useCallback(() => {
    retries.current = 0;
    setReloadToken((token) => token + 1);
  }, []);

  const addFaction = useCallback((faction: { id: number; name: string; allegiance?: string | null }) => {
    setSelection((current) => {
      if (current.some((item) => item.id === faction.id)) {
        return current.map((item) => (item.id === faction.id ? { ...item, hidden: false } : item));
      }
      if (current.length >= BGS_MAX_SELECTED) return current;
      return [...current, {
        id: faction.id,
        name: faction.name,
        color: nextSelectionColor(current),
        allegiance: normalizeAllegiance(faction.allegiance),
        hidden: false,
      }];
    });
    setVisibleState(true);
  }, []);

  const removeFaction = useCallback((id: number) => {
    setSelection((current) => current.filter((item) => item.id !== id));
  }, []);

  const toggleFactionHidden = useCallback((id: number) => {
    setSelection((current) => current.map((item) => (item.id === id ? { ...item, hidden: !item.hidden } : item)));
  }, []);

  const soloFaction = useCallback((id: number) => {
    setSelection((current) => current.map((item) => ({ ...item, hidden: item.id !== id })));
  }, []);

  const clearSelection = useCallback(() => {
    setSelection([]);
    setSelectedKey(null);
  }, []);

  const select = useCallback((point: BgsMapPoint | null, options: { focus?: boolean } = {}) => {
    setSelectedKey(point ? point.key : null);
    if (point && options.focus) {
      setVisibleState(true);
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('atlas-focus-faction-system', { detail: point }));
      }
    }
  }, []);

  const pointsRef = useRef(points);
  pointsRef.current = points;
  const systemsRef = useRef(systems);
  systemsRef.current = systems;

  const showSystem = useCallback((ref: { id64?: string | null; name: string; x?: number; y?: number; z?: number }) => {
    const key = ref.name.trim().toLowerCase();
    const point = pointsRef.current.find((item) => (ref.id64 && item.id64 === ref.id64) || item.nameLc === key) ?? null;
    if (point) {
      select(point, { focus: true });
      return;
    }
    const system = systemsRef.current.find((item) => (ref.id64 && item.id64 === ref.id64) || item.nameLc === key);
    const target = system ?? (ref.x != null && ref.y != null && ref.z != null ? { name: ref.name, x: ref.x, y: ref.y, z: ref.z } : null);
    if (target && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('atlas-focus-system', { detail: { name: target.name, x: target.x, y: target.y, z: target.z } }));
    }
  }, [select]);

  const [overviewRequest, setOverviewRequest] = useState<FactionsOverviewRequest | null>(null);
  const focusOverview = useCallback((target?: Array<{ x: number; y: number; z: number }>) => {
    const list = target ?? pointsRef.current.filter((point) => !point.background);
    const view = bgsOverview(list);
    if (!view) return;
    setVisibleState(true);
    setOverviewRequest((current) => ({ id: (current?.id ?? 0) + 1, view }));
  }, []);

  return {
    visible,
    setVisible,
    download,
    status,
    data,
    error,
    reload,
    systems,
    allegianceCounts,
    filter,
    setFilter,
    selection,
    presence,
    presenceStatus,
    presenceError,
    addFaction,
    removeFaction,
    toggleFactionHidden,
    soloFaction,
    clearSelection,
    points,
    selectedKey,
    selected,
    select,
    showSystem,
    focusOverview,
    overviewRequest,
  };
}

/** Поиск фракций с задержкой ввода и отменой устаревших запросов. */
export function useFactionSearch(query: string, options: { player?: boolean; enabled?: boolean } = {}) {
  const [results, setResults] = useState<BgsFactionSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const enabled = options.enabled !== false;
  const player = options.player === true;
  const q = query.replace(/\s+/g, ' ').trim();

  useEffect(() => {
    if (!enabled) return;
    // Одна буква — слишком много совпадений; пустой запрос — самые крупные фракции.
    if (q.length === 1) {
      setResults([]);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    const timer = window.setTimeout(() => {
      fetchFactionSearch(q, { player, signal: controller.signal, limit: 20 })
        .then((list) => {
          setResults(list);
          setError('');
        })
        .catch((err) => {
          if (controller.signal.aborted) return;
          setError(err instanceof Error ? err.message : 'Поиск фракций недоступен');
          setResults([]);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, q ? 220 : 0);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [enabled, player, q]);

  return { results, loading, error };
}
