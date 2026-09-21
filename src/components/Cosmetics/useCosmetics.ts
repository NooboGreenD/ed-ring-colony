"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { PilotCosmetics } from "./types";

/**
 * Small client-side cache + batcher for /api/billing/cosmetics.
 * Multiple components asking for different users in the same tick get merged
 * into one request; results are cached for ~30s.
 */
const cache = new Map<string, { data: PilotCosmetics; ts: number }>();
const TTL = 30_000;
let pending = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;
const waiters = new Set<() => void>();
let generation = 0;

function notify() {
  generation++;
  waiters.forEach((w) => w());
}

function flush() {
  timer = null;
  const ids = Array.from(pending);
  pending = new Set();
  if (!ids.length) return;
  fetch("/api/billing/cosmetics", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids }) })
    .then((r) => (r.ok ? r.json() : null))
    .then((json) => {
      const now = Date.now();
      for (const id of ids) {
        const data = json?.cosmetics?.[id];
        cache.set(id, { data: data || { user_id: id, frame: null, badge: null, skin: null, glow: null, title: null, tier: null }, ts: now });
      }
      notify();
    })
    .catch(() => {
      const now = Date.now();
      for (const id of ids) cache.set(id, { data: { user_id: id, frame: null, badge: null, skin: null, glow: null, title: null, tier: null }, ts: now });
      notify();
    });
}

function request(ids: string[]) {
  const now = Date.now();
  let added = false;
  for (const id of ids) {
    const hit = cache.get(id);
    if (hit && now - hit.ts < TTL) continue;
    if (!pending.has(id)) {
      pending.add(id);
      added = true;
    }
  }
  if (added && !timer) timer = setTimeout(flush, 20);
}

/** Invalidate cached cosmetics (call after equip/purchase). */
export function invalidateCosmetics(userId?: string) {
  if (userId) cache.delete(userId);
  else cache.clear();
  notify();
}

export function useCosmetics(userIds: (string | null | undefined)[]): Record<string, PilotCosmetics> {
  const key = useMemo(() => Array.from(new Set(userIds.filter(Boolean) as string[])).sort().join(","), [userIds]);
  const [, setTick] = useState(0);
  const idsRef = useRef<string[]>([]);
  idsRef.current = key ? key.split(",") : [];

  useEffect(() => {
    const w = () => setTick((t) => t + 1);
    waiters.add(w);
    if (idsRef.current.length) request(idsRef.current);
    return () => {
      waiters.delete(w);
    };
  }, [key]);

  return useMemo(() => {
    const out: Record<string, PilotCosmetics> = {};
    for (const id of idsRef.current) {
      const hit = cache.get(id);
      if (hit) out[id] = hit.data;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, generation]);
}

export function useCosmeticsFor(userId?: string | null): PilotCosmetics | null {
  const map = useCosmetics([userId]);
  return userId ? map[userId] || null : null;
}
