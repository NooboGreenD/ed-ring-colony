'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { AtlasCandidate, AtlasFavorite, AtlasSearchSession, WorldType } from '@/types/atlas';
import { favoriteKey, normalizeSystemKey } from '@/lib/atlas';

/**
 * Общее состояние раздела Atlas: избранное и история поисков.
 *
 * До этого каждая панель (`AtlasFavorites`, `AtlasSearchHistory`) поднимала
 * собственный экземпляр `useAtlasHistory`. Из-за этого:
 *  - `/api/atlas/sessions` и `/api/atlas/favorites` запрашивались дважды;
 *  - избранное, добавленное из списка кандидатов, не появлялось в блоке
 *    «Избранное» до перезагрузки страницы (это были разные состояния);
 *  - гость получал «Ошибка добавления» вместо локального избранного.
 *
 * Провайдер один раз грузит данные, держит их в одном месте и умеет работать
 * без аккаунта: серверные записи дополняются локальными (localStorage).
 */

const LOCAL_FAVORITES_KEY = 'atlas:favorites-local';
const LOCAL_SEARCHES_KEY = 'atlas:local-searches';

interface FavoriteInput {
  system_name: string;
  x: number;
  y: number;
  z: number;
  world_type: WorldType | string;
  body_name?: string | null;
  note?: string;
}

interface AtlasContextValue {
  sessions: AtlasSearchSession[];
  sessionsLoading: boolean;
  sessionsNeedAuth: boolean;
  refreshSessions: () => Promise<void>;
  localSessions: AtlasSearchSession[];
  recordSearch: (input: { id: string; reference_system: string; cube_size_ly?: number; world_types?: string[]; status?: AtlasSearchSession['status'] }) => void;
  removeSession: (id: string) => void;
  favorites: AtlasFavorite[];
  favoritesLoading: boolean;
  favoritesNeedAuth: boolean;
  favoriteKeys: Set<string>;
  isFavorite: (systemName: string, worldType: string) => boolean;
  addFavorite: (candidate: AtlasCandidate | FavoriteInput) => Promise<boolean>;
  removeFavorite: (id: string) => Promise<boolean>;
  refreshFavorites: () => Promise<void>;
}

const AtlasContext = createContext<AtlasContextValue | null>(null);

function readLocalFavorites(): AtlasFavorite[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(LOCAL_FAVORITES_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeLocalFavorites(rows: AtlasFavorite[]): void {
  try {
    window.localStorage.setItem(LOCAL_FAVORITES_KEY, JSON.stringify(rows.slice(0, 500)));
  } catch {
    // Приватный режим: избранное останется только в памяти вкладки.
  }
}

function readLocalSearches(): AtlasSearchSession[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(LOCAL_SEARCHES_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeLocalSearches(rows: AtlasSearchSession[]): void {
  try {
    window.localStorage.setItem(LOCAL_SEARCHES_KEY, JSON.stringify(rows.slice(0, 30)));
  } catch {
    // ignore
  }
}

export function AtlasProvider({ children }: { children: React.ReactNode }) {
  const [serverFavorites, setServerFavorites] = useState<AtlasFavorite[]>([]);
  const [localFavorites, setLocalFavorites] = useState<AtlasFavorite[]>([]);
  const [favoritesLoading, setFavoritesLoading] = useState(false);
  const [favoritesNeedAuth, setFavoritesNeedAuth] = useState(false);
  const [serverSessions, setServerSessions] = useState<AtlasSearchSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsNeedAuth, setSessionsNeedAuth] = useState(false);
  const [localSessions, setLocalSessions] = useState<AtlasSearchSession[]>([]);

  useEffect(() => {
    setLocalFavorites(readLocalFavorites());
    setLocalSessions(readLocalSearches());
  }, []);

  const refreshFavorites = useCallback(async () => {
    setFavoritesLoading(true);
    try {
      const res = await fetch('/api/atlas/favorites');
      if (res.status === 401) {
        // Гость: серверное избранное недоступно, работаем локальным списком.
        setFavoritesNeedAuth(true);
        setServerFavorites([]);
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Не удалось загрузить избранное');
      setFavoritesNeedAuth(false);
      setServerFavorites(Array.isArray(data.favorites) ? data.favorites : []);
    } catch {
      setFavoritesNeedAuth(true);
    } finally {
      setFavoritesLoading(false);
    }
  }, []);

  const refreshSessions = useCallback(async () => {
    setSessionsLoading(true);
    try {
      const res = await fetch('/api/atlas/sessions');
      if (res.status === 401) {
        setSessionsNeedAuth(true);
        setServerSessions([]);
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Не удалось загрузить историю');
      setSessionsNeedAuth(false);
      setServerSessions(Array.isArray(data.sessions) ? data.sessions : []);
    } catch {
      setSessionsNeedAuth(true);
    } finally {
      setSessionsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshFavorites();
    void refreshSessions();
  }, [refreshFavorites, refreshSessions]);

  const favorites = useMemo(() => {
    const merged: AtlasFavorite[] = [...serverFavorites];
    const seen = new Set(merged.map((row) => `${favoriteKey(row.system_name, row.world_type)}|${row.id}`));
    const seenKeys = new Set(merged.map((row) => favoriteKey(row.system_name, row.world_type)));
    for (const row of localFavorites) {
      const key = favoriteKey(row.system_name, row.world_type);
      if (seen.has(`${key}|${row.id}`) || seenKeys.has(key)) continue;
      merged.push(row);
      seenKeys.add(key);
    }
    return merged;
  }, [localFavorites, serverFavorites]);

  const favoriteKeys = useMemo(
    () => new Set(favorites.map((row) => favoriteKey(row.system_name, row.world_type))),
    [favorites],
  );

  const isFavorite = useCallback(
    (systemName: string, worldType: string) => favoriteKeys.has(favoriteKey(systemName, worldType)),
    [favoriteKeys],
  );

  const addFavorite = useCallback(async (input: AtlasCandidate | FavoriteInput) => {
    const row: FavoriteInput = {
      system_name: input.system_name,
      x: input.x,
      y: input.y,
      z: input.z,
      world_type: input.world_type,
      body_name: input.body_name,
      note: 'note' in input ? input.note : undefined,
    };
    const key = favoriteKey(row.system_name, row.world_type);
    if (serverFavorites.some((item) => favoriteKey(item.system_name, item.world_type) === key)
      || localFavorites.some((item) => favoriteKey(item.system_name, item.world_type) === key)) {
      return true;
    }

    try {
      const res = await fetch('/api/atlas/favorites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(row),
      });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        if (data?.favorite) setServerFavorites((current) => [data.favorite as AtlasFavorite, ...current]);
        else void refreshFavorites();
        return true;
      }
      if (res.status !== 401) {
        const data = await res.json().catch(() => ({}));
        if (res.status !== 400 && res.status !== 403) throw new Error(data.error || 'Ошибка добавления');
      }
    } catch {
      // Сервер недоступен — сохраняем локально, чтобы кнопка не «теряла» клик.
    }

    const localRow: AtlasFavorite = {
      id: `local:${crypto.randomUUID()}`,
      user_id: 'local',
      system_name: row.system_name,
      x: row.x,
      y: row.y,
      z: row.z,
      world_type: row.world_type as WorldType,
      body_name: row.body_name || undefined,
      note: row.note,
      created_at: new Date().toISOString(),
    };
    setLocalFavorites((current) => {
      const next = [localRow, ...current];
      writeLocalFavorites(next);
      return next;
    });
    return true;
  }, [localFavorites, refreshFavorites, serverFavorites]);

  const removeFavorite = useCallback(async (id: string) => {
    if (id.startsWith('local:')) {
      setLocalFavorites((current) => {
        const next = current.filter((item) => item.id !== id);
        writeLocalFavorites(next);
        return next;
      });
      return true;
    }
    try {
      const res = await fetch(`/api/atlas/favorites?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (res.ok) {
        setServerFavorites((current) => current.filter((item) => item.id !== id));
        return true;
      }
    } catch {
      // Ниже убираем запись оптимистично, чтобы UI не завис на удалении.
    }
    setServerFavorites((current) => current.filter((item) => item.id !== id));
    return false;
  }, []);

  const recordSearch = useCallback((input: { id: string; reference_system: string; cube_size_ly?: number; world_types?: string[]; status?: AtlasSearchSession['status'] }) => {
    const session: AtlasSearchSession = {
      id: input.id,
      reference_system: input.reference_system,
      cube_size_ly: input.cube_size_ly ?? 0,
      world_types: input.world_types ?? [],
      status: input.status ?? 'pending',
      created_at: new Date().toISOString(),
    };
    setLocalSessions((current) => {
      const next = [session, ...current.filter((item) => item.id !== session.id)].slice(0, 30);
      writeLocalSearches(next);
      return next;
    });
  }, []);

  const removeSession = useCallback((id: string) => {
    setLocalSessions((current) => {
      const next = current.filter((item) => item.id !== id);
      writeLocalSearches(next);
      return next;
    });
  }, []);

  const sessions = useMemo(() => {
    const merged = [...serverSessions];
    const ids = new Set(merged.map((row) => row.id));
    for (const row of localSessions) {
      if (ids.has(row.id)) continue;
      merged.push(row);
      ids.add(row.id);
    }
    return merged.slice(0, 50);
  }, [localSessions, serverSessions]);

  const value = useMemo<AtlasContextValue>(() => ({
    sessions,
    sessionsLoading,
    sessionsNeedAuth,
    refreshSessions,
    localSessions,
    recordSearch,
    removeSession,
    favorites,
    favoritesLoading,
    favoritesNeedAuth,
    favoriteKeys,
    isFavorite,
    addFavorite,
    removeFavorite,
    refreshFavorites,
  }), [
    sessions, sessionsLoading, sessionsNeedAuth, refreshSessions, localSessions, recordSearch, removeSession,
    favorites, favoritesLoading, favoritesNeedAuth, favoriteKeys, isFavorite, addFavorite, removeFavorite, refreshFavorites,
  ]);

  return <AtlasContext.Provider value={value}>{children}</AtlasContext.Provider>;
}

export function useAtlas(): AtlasContextValue {
  const context = useContext(AtlasContext);
  if (!context) {
    throw new Error('useAtlas должен вызываться внутри <AtlasProvider>');
  }
  return context;
}

export { normalizeSystemKey };
