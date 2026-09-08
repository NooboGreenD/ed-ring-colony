"use client";

import { useState, useCallback, useMemo } from "react";
import type { AtlasCandidate, AtlasSearchSession, AtlasRoute } from "@/types/atlas";

export function useAtlasData() {
  const [candidates, setCandidates] = useState<AtlasCandidate[]>([]);
  const [sessions, setSessions] = useState<AtlasSearchSession[]>([]);
  const [routes, setRoutes] = useState<AtlasRoute[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchCandidates = useCallback(async (searchId?: string, worldType?: string) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (searchId) params.set('search_id', searchId);
      if (worldType) params.set('world_type', worldType);
      const res = await fetch(`/api/atlas/candidates?${params.toString()}`);
      const json = await res.json();
      setCandidates(json.candidates || []);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchSessions = useCallback(async () => {
    try {
      const res = await fetch('/api/atlas/sessions');
      const json = await res.json();
      setSessions(json.sessions || []);
    } catch {
      // ignore
    }
  }, []);

  const search = useCallback(async (params: {
    reference_system: string;
    cube_size_ly: number;
    world_types: string[];
    require_landable?: boolean;
    min_estimated_value?: number;
    max_distance_to_arrival?: number;
  }) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/atlas/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Search failed');
      setCandidates(json.candidates || []);
      return json;
    } catch (err: any) {
      setError(err.message);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  const buildRoute = useCallback(async (params: {
    from_system: string;
    to_system: string;
    via_candidates: string[];
    engine?: string;
    jump_range?: number;
    name?: string;
  }) => {
    setLoading(true);
    try {
      const res = await fetch('/api/atlas/route', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Route failed');
      return json;
    } catch (err: any) {
      setError(err.message);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  const candidatesByType = useMemo(() => {
    const map = new Map<string, AtlasCandidate[]>();
    for (const c of candidates) {
      const arr = map.get(c.world_type) || [];
      arr.push(c);
      map.set(c.world_type, arr);
    }
    return map;
  }, [candidates]);

  return {
    candidates, sessions, routes, loading, error,
    candidatesByType,
    fetchCandidates, fetchSessions, search, buildRoute,
    setCandidates, // <-- добавлено
  };
}
