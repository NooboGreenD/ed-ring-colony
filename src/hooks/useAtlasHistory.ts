"use client";

import { useState, useCallback } from 'react';
import type { AtlasSearchSession, AtlasFavorite } from '@/types/atlas';

export function useAtlasHistory() {
  const [sessions, setSessions] = useState<AtlasSearchSession[]>([]);
  const [favorites, setFavorites] = useState<AtlasFavorite[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchSessions = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/atlas/sessions');
      const json = await res.json();
      setSessions(json.sessions || []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchFavorites = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/atlas/favorites');
      const json = await res.json();
      setFavorites(json.favorites || []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, []);

  const addFavorite = useCallback(async (candidate: any, note?: string) => {
    const res = await fetch('/api/atlas/favorites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_name: candidate.system_name,
        x: candidate.x, y: candidate.y, z: candidate.z,
        world_type: candidate.world_type,
        body_name: candidate.body_name,
        note,
      }),
    });
    if (res.ok) fetchFavorites();
    return res.ok;
  }, [fetchFavorites]);

  const removeFavorite = useCallback(async (id: string) => {
    const res = await fetch(`/api/atlas/favorites?id=${id}`, { method: 'DELETE' });
    if (res.ok) setFavorites(prev => prev.filter(f => f.id !== id));
    return res.ok;
  }, []);

  return { sessions, favorites, loading, fetchSessions, fetchFavorites, addFavorite, removeFavorite };
}
