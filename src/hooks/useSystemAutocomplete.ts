'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { normalizeSystemKey } from '@/lib/atlas';

/**
 * Подсказки систем для всех «поисковиков» Atlas.
 *
 * Источники идут по приоритету:
 *   1. локальный каталог Spansh (`/api/galaxy/systems/search`) — мгновенно;
 *   2. EDSM (`/api/edsm/search`) — только если каталог пуст.
 *
 * Ответы кэшируются в памяти модуля (LRU на 120 запросов), поэтому повторный
 * ввод «Sol» не бьёт по сети заново. Все запросы отменяются через
 * AbortController, а ответы устаревших запросов игнорируются — раньше быстрый
 * набор текста мог перезаписать список более старым результатом.
 */

export interface SystemSuggestion {
  name: string;
  x?: number;
  y?: number;
  z?: number;
  /** id64 каталога приходит строкой (Supabase numeric/bigint), EDSM — числом. */
  id64?: string | null;
  distance_from_sols?: number | null;
  distance_from_sgra?: number | null;
  main_star?: string | null;
  star_type?: string | null;
  needs_permit?: boolean;
  source: 'catalog' | 'edsm';
}

const CACHE_LIMIT = 120;
const suggestionCache = new Map<string, SystemSuggestion[]>();

function readCache(key: string): SystemSuggestion[] | null {
  const hit = suggestionCache.get(key);
  if (!hit) return null;
  // Обновляем порядок: часто используемые запросы живут дольше.
  suggestionCache.delete(key);
  suggestionCache.set(key, hit);
  return hit;
}

function writeCache(key: string, value: SystemSuggestion[]): void {
  suggestionCache.delete(key);
  suggestionCache.set(key, value);
  while (suggestionCache.size > CACHE_LIMIT) {
    const oldest = suggestionCache.keys().next().value;
    if (oldest == null) break;
    suggestionCache.delete(oldest);
  }
}

async function fetchCatalog(query: string, limit: number, signal: AbortSignal): Promise<SystemSuggestion[]> {
  const res = await fetch(`/api/galaxy/systems/search?q=${encodeURIComponent(query)}&limit=${limit}`, { signal });
  if (!res.ok) return [];
  const data = await res.json().catch(() => ({}));
  const rows = Array.isArray(data?.results) ? data.results : [];
  return rows.map((row: Record<string, unknown>) => ({
    name: String(row.name ?? ''),
    x: typeof row.x === 'number' ? row.x : undefined,
    y: typeof row.y === 'number' ? row.y : undefined,
    z: typeof row.z === 'number' ? row.z : undefined,
    id64: row.id64 != null && String(row.id64).trim() !== '' ? String(row.id64) : null,
    distance_from_sols: typeof row.distance_from_sols === 'number' ? row.distance_from_sols : null,
    distance_from_sgra: typeof row.distance_from_sgra === 'number' ? row.distance_from_sgra : null,
    main_star: typeof row.main_star === 'string' ? row.main_star : null,
    star_type: typeof row.star_type === 'string' ? row.star_type : null,
    needs_permit: row.needs_permit === true,
    source: 'catalog' as const,
  })).filter((row: SystemSuggestion) => row.name);
}

async function fetchEdsm(query: string, limit: number, signal: AbortSignal): Promise<SystemSuggestion[]> {
  const res = await fetch(`/api/edsm/search?q=${encodeURIComponent(query)}`, { signal });
  if (!res.ok) return [];
  const data = await res.json().catch(() => ({}));
  const rows = Array.isArray(data?.systems) ? data.systems : [];
  return rows.slice(0, limit).map((row: Record<string, any>) => ({
    name: String(row.name ?? ''),
    x: typeof row.coords?.x === 'number' ? row.coords.x : undefined,
    y: typeof row.coords?.y === 'number' ? row.coords.y : undefined,
    z: typeof row.coords?.z === 'number' ? row.coords.z : undefined,
    id64: row.id != null && String(row.id).trim() !== '' ? String(row.id) : null,
    distance_from_sols: typeof row.distance === 'number' ? row.distance : null,
    distance_from_sgra: null,
    main_star: null,
    star_type: null,
    needs_permit: row.requirePermit === true,
    source: 'edsm' as const,
  })).filter((row: SystemSuggestion) => row.name);
}

export interface UseSystemAutocompleteResult {
  suggestions: SystemSuggestion[];
  loading: boolean;
  error: string | null;
  /** Откуда пришли подсказки — показываем в подписи выпадающего списка. */
  source: 'catalog' | 'edsm' | null;
  /** Сеть отключена/каталог недоступен: поиск всё равно работает по вводу. */
  degraded: boolean;
}

export function useSystemAutocomplete(query: string, options: { limit?: number; enabled?: boolean } = {}): UseSystemAutocompleteResult {
  const { limit = 8, enabled = true } = options;
  const [suggestions, setSuggestions] = useState<SystemSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<'catalog' | 'edsm' | null>(null);
  const requestIdRef = useRef(0);
  const trimmedQuery = query.trim().replace(/\s+/g, ' ');
  // Кэш и порог длины считаем по нормализованному ключу, а в API отправляем
  // исходное написание: каталоги различают «Sol» и «sol».
  const normalizedQuery = normalizeSystemKey(query);

  useEffect(() => {
    if (!enabled || normalizedQuery.length < 2) {
      setSuggestions([]);
      setLoading(false);
      setError(null);
      setSource(null);
      return;
    }

    const cached = readCache(normalizedQuery);
    if (cached) {
      setSuggestions(cached);
      setSource(cached[0]?.source ?? null);
      setError(null);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);

    const timer = window.setTimeout(async () => {
      try {
        let rows = await fetchCatalog(trimmedQuery, limit, controller.signal);
        let from: 'catalog' | 'edsm' = 'catalog';
        if (rows.length === 0 && !controller.signal.aborted) {
          rows = await fetchEdsm(trimmedQuery, limit, controller.signal);
          from = 'edsm';
        }
        if (controller.signal.aborted || requestId !== requestIdRef.current) return;
        writeCache(normalizedQuery, rows);
        setSuggestions(rows);
        setSource(rows.length > 0 ? from : null);
        setError(null);
      } catch (err) {
        if (controller.signal.aborted || requestId !== requestIdRef.current) return;
        // Ни каталог, ни EDSM не ответили: не мешаем вводить имя вручную.
        const message = err instanceof Error && err.name !== 'AbortError' ? err.message : 'Подсказки недоступны';
        setSuggestions([]);
        setSource(null);
        setError(message);
      } finally {
        if (requestId === requestIdRef.current) setLoading(false);
      }
    }, 200);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [normalizedQuery, trimmedQuery, limit, enabled]);

  return { suggestions, loading, error, source, degraded: !!error };
}

const RECENT_STORAGE_KEY = 'atlas:recent-systems';
const RECENT_LIMIT = 8;

/** Последние выбранные системы — общая история для всех полей Atlas. */
export function useRecentSystems() {
  const [recent, setRecent] = useState<string[]>([]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(RECENT_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) {
        setRecent(parsed.filter((name): name is string => typeof name === 'string').slice(0, RECENT_LIMIT));
      }
    } catch {
      setRecent([]);
    }
  }, []);

  const rememberSystem = useCallback((name: string) => {
    const clean = name.trim();
    if (!clean) return;
    setRecent((current) => {
      const next = [clean, ...current.filter((item) => normalizeSystemKey(item) !== normalizeSystemKey(clean))].slice(0, RECENT_LIMIT);
      try {
        window.localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Приватный режим — история просто не сохранится.
      }
      return next;
    });
  }, []);

  const forgetRecent = useCallback(() => {
    setRecent([]);
    try {
      window.localStorage.removeItem(RECENT_STORAGE_KEY);
    } catch {
      // ignore
    }
  }, []);

  return { recent, rememberSystem, forgetRecent };
}
