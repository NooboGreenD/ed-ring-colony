'use client';

/** Effective (source + admin overlays) catalogue, shared by all shipyard views. */
import { useEffect, useState } from 'react';
import type { OutfittingData } from './types';

const URL = '/api/outfitting/catalog';
const REVISION_KEY = 'edrc-outfitting-revision';
const TTL = 30_000;
let cache: OutfittingData | null = null;
let cachedAt = 0;
let generation = 0;
let pending: Promise<OutfittingData> | null = null;
const listeners = new Set<(data: OutfittingData) => void>();

function publish(data: OutfittingData) {
  cache = data;
  cachedAt = Date.now();
  listeners.forEach((listener) => listener(data));
}

/** Admin saves refresh this tab immediately and notify other open site tabs. */
export function publishOutfittingData(data: OutfittingData): void {
  generation += 1;
  pending = null;
  publish(data);
  try { window.localStorage.setItem(REVISION_KEY, `${data.catalogRevision ?? 0}:${Date.now()}`); }
  catch { /* Storage restrictions must not prevent a successful save. */ }
}

export function loadOutfittingData(force = false): Promise<OutfittingData> {
  if (!force && cache && Date.now() - cachedAt < TTL) return Promise.resolve(cache);
  if (pending) return pending;
  const ticket = generation;
  const request = fetch(URL, { cache: 'no-store' })
    .then(async (response) => {
      if (!response.ok) throw new Error(`Справочник верфи недоступен (${response.status})`);
      const data = await response.json() as OutfittingData;
      if (!data.ships || !data.modules || !data.groups) throw new Error('Некорректный справочник верфи');
      // A slow read started BEFORE an admin save must not overwrite that save.
      if (ticket === generation) publish(data);
      return ticket !== generation && cache ? cache : data;
    })
    .finally(() => { if (pending === request) pending = null; });
  pending = request;
  return request;
}

export function useOutfittingData(): { data: OutfittingData | null; error: string } {
  const [data, setData] = useState<OutfittingData | null>(cache);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    const onData = (loaded: OutfittingData) => {
      if (!cancelled) { setData(loaded); setError(''); }
    };
    listeners.add(onData);
    const refresh = (force = false) => {
      loadOutfittingData(force).then(onData).catch((reason: unknown) => {
        // Keep the last known catalogue on a transient background DB outage.
        if (!cancelled && !cache) setError(reason instanceof Error ? reason.message : 'Не удалось загрузить справочник');
      });
    };
    const onFocus = () => refresh();
    const onVisibility = () => { if (document.visibilityState === 'visible') refresh(); };
    const onStorage = (event: StorageEvent) => {
      if (event.key === REVISION_KEY) { cachedAt = 0; refresh(true); }
    };
    refresh();
    window.addEventListener('focus', onFocus);
    window.addEventListener('storage', onStorage);
    document.addEventListener('visibilitychange', onVisibility);
    const timer = window.setInterval(onVisibility, TTL);
    return () => {
      cancelled = true;
      listeners.delete(onData);
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('storage', onStorage);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  return { data, error };
}
