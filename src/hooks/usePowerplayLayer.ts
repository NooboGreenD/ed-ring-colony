'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_POWERPLAY_FILTER,
  countPowerplay,
  decodePowerplayLayer,
  filterPowerplaySystems,
  parsePowerplayFilter,
  powerplayOverview,
  type PowerplayCounts,
  type PowerplayOverview,
  type PowerplayFilter,
  type PowerplayLayerData,
  type PowerplaySystem,
} from '@/lib/powerplay';

/**
 * Слой «PowerPlay» Atlas: загрузка `GET /api/powerplay/systems`, фильтр
 * вкладки, выбранная система и настройки, которые переживают перезагрузку
 * страницы (показ на карте и фильтр — в localStorage).
 *
 * Набор большой (~50 тысяч систем), поэтому он грузится только когда нужен —
 * открыта вкладка или слой включён на карте — и один раз на вкладку браузера
 * (кэш модуля). Повторный визит браузер подтверждает по ETag (304).
 */

export const POWERPLAY_STORAGE_KEY = 'atlas-powerplay-v1';
/** Пока сервер импортирует дамп, пустой ответ перезапрашивается. */
const EMPTY_RETRY_MS = 20_000;
const EMPTY_RETRY_LIMIT = 30;

export type PowerplayLoadStatus = 'idle' | 'loading' | 'ready' | 'empty' | 'error';

let moduleCache: PowerplayLayerData | null = null;
let inFlight: Promise<PowerplayLayerData> | null = null;

/** Для тестов: забыть загруженный набор. */
export function resetPowerplayLayerCache(): void {
  moduleCache = null;
  inFlight = null;
}

export function fetchPowerplayLayer(force = false): Promise<PowerplayLayerData> {
  if (!force && moduleCache && moduleCache.status === 'ready') return Promise.resolve(moduleCache);
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const response = await fetch('/api/powerplay/systems', force ? { cache: 'no-cache' } : undefined);
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const message = body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : `HTTP ${response.status}`;
      throw new Error(message);
    }
    const data = decodePowerplayLayer(body);
    moduleCache = data;
    return data;
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

interface StoredSettings {
  visible: boolean;
  filter: PowerplayFilter;
  /** Вкладку уже открывали: первый визит сам включает слой на карте. */
  seen: boolean;
}

function readSettings(): StoredSettings | null {
  try {
    if (typeof window === 'undefined') return null;
    const raw = window.localStorage.getItem(POWERPLAY_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredSettings>;
    return { visible: parsed.visible === true, filter: parsePowerplayFilter(parsed.filter), seen: parsed.seen === true };
  } catch {
    return null;
  }
}

function writeSettings(settings: StoredSettings): void {
  try {
    if (typeof window !== 'undefined') window.localStorage.setItem(POWERPLAY_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Приватный режим или переполненное хранилище — настройки просто не запомнятся.
  }
}

export interface AtlasPowerplayState {
  /** Слой виден на карте. */
  visible: boolean;
  setVisible: (visible: boolean) => void;
  filter: PowerplayFilter;
  setFilter: (filter: PowerplayFilter) => void;
  status: PowerplayLoadStatus;
  data: PowerplayLayerData | null;
  error: string;
  reload: () => void;
  /** Все системы набора. */
  systems: PowerplaySystem[];
  /** После фильтра вкладки — то, что на карте. */
  visibleSystems: PowerplaySystem[];
  counts: PowerplayCounts;
  selectedId: string | null;
  selected: PowerplaySystem | null;
  /** Выбрать систему; `focus` — подвести к ней камеру карты. */
  select: (system: PowerplaySystem | null, options?: { focus?: boolean }) => void;
  /** Показать на карте набор целиком (по умолчанию — то, что под фильтром). */
  focusOverview: (systems?: PowerplaySystem[]) => void;
  /**
   * Последний запрос «показать целиком» для карты. Это состояние, а не событие:
   * карта грузится лениво и при первом открытии вкладки ещё не подписана.
   */
  overviewRequest: PowerplayOverviewRequest | null;
}

export interface PowerplayOverviewRequest {
  id: number;
  view: PowerplayOverview;
}

export function useAtlasPowerplay({ tabActive }: { tabActive: boolean }): AtlasPowerplayState {
  const [visible, setVisibleState] = useState(false);
  const [filter, setFilterState] = useState<PowerplayFilter>(DEFAULT_POWERPLAY_FILTER);
  const [seen, setSeen] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [status, setStatus] = useState<PowerplayLoadStatus>('idle');
  const [data, setData] = useState<PowerplayLayerData | null>(null);
  const [error, setError] = useState('');
  const [reloadToken, setReloadToken] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const retries = useRef(0);

  // localStorage — только после монтирования: страница пререндерится на сервере.
  useEffect(() => {
    const stored = readSettings();
    if (stored) {
      setVisibleState(stored.visible);
      setFilterState(stored.filter);
      setSeen(stored.seen);
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (hydrated) writeSettings({ visible, filter, seen });
  }, [filter, hydrated, seen, visible]);

  // Первое открытие вкладки включает слой: пользователь пришёл посмотреть на державы.
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

    const load = async (force: boolean) => {
      setStatus((current) => (current === 'ready' || current === 'empty' ? current : 'loading'));
      try {
        const next = await fetchPowerplayLayer(force);
        if (cancelled) return;
        setData(next);
        setError('');
        setStatus(next.status);
        // Сервер импортирует дамп фоном — вернёмся за результатом.
        if (next.status === 'empty' && next.meta.refreshing && retries.current < EMPTY_RETRY_LIMIT) {
          retries.current += 1;
          timer = window.setTimeout(() => void load(true), EMPTY_RETRY_MS);
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Не удалось загрузить системы PowerPlay');
        setStatus((current) => (current === 'ready' ? current : 'error'));
      }
    };

    void load(reloadToken > 0);
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [needed, reloadToken]);

  const systems = useMemo(() => data?.systems ?? [], [data]);
  const visibleSystems = useMemo(() => filterPowerplaySystems(systems, filter), [systems, filter]);
  const counts = useMemo(() => countPowerplay(systems, data?.powers ?? []), [data, systems]);
  const visibleIndex = useMemo(() => {
    const index = new Map<string, PowerplaySystem>();
    for (const system of visibleSystems) index.set(system.id64 || system.nameLc, system);
    return index;
  }, [visibleSystems]);
  const selected = selectedId ? visibleIndex.get(selectedId) ?? null : null;

  // Фильтр или новый набор убрали выбранную систему — карточка закрывается.
  useEffect(() => {
    if (selectedId && !selected && status !== 'loading') setSelectedId(null);
  }, [selected, selectedId, status]);

  const setVisible = useCallback((next: boolean) => {
    setVisibleState(next);
    if (!next) setSelectedId(null);
  }, []);

  const setFilter = useCallback((next: PowerplayFilter) => setFilterState(next), []);

  const reload = useCallback(() => {
    retries.current = 0;
    setReloadToken((token) => token + 1);
  }, []);

  const select = useCallback((system: PowerplaySystem | null, options: { focus?: boolean } = {}) => {
    setSelectedId(system ? system.id64 || system.nameLc : null);
    if (system && options.focus) {
      // Выбор из списка вкладки показывает слой, даже если его выключили.
      setVisibleState(true);
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('atlas-focus-powerplay', { detail: system }));
      }
    }
  }, []);

  const visibleRef = useRef(visibleSystems);
  visibleRef.current = visibleSystems;
  const [overviewRequest, setOverviewRequest] = useState<PowerplayOverviewRequest | null>(null);
  const focusOverview = useCallback((target?: PowerplaySystem[]) => {
    const view = powerplayOverview(target ?? visibleRef.current);
    if (!view) return;
    setVisibleState(true);
    setOverviewRequest((current) => ({ id: (current?.id ?? 0) + 1, view }));
  }, []);

  return {
    visible,
    setVisible,
    filter,
    setFilter,
    status,
    data,
    error,
    reload,
    systems,
    visibleSystems,
    counts,
    selectedId,
    selected,
    select,
    focusOverview,
    overviewRequest,
  };
}
