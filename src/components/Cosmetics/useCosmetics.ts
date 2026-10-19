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
const revisions = new Map<string, number>();
const inflight = new Map<string, number>();
const retryAfter = new Map<string, number>();

function notify() {
  generation++;
  waiters.forEach((w) => w());
}

function flush() {
  timer = null;
  const ids = Array.from(pending);
  pending = new Set();
  if (!ids.length) return;
  const versions = new Map(ids.map(id => [id, revisions.get(id) || 0]));
  ids.forEach(id => inflight.set(id, versions.get(id)!));
  fetch("/api/billing/cosmetics", { method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids }) })
    .then(async r => {
      if (!r.ok) throw new Error('Cosmetics unavailable');
      const json = await r.json();
      for (const id of ids) {
        // An equip may have completed while this request was in flight.
        if ((revisions.get(id) || 0) !== versions.get(id)) continue;
        const data = json?.cosmetics?.[id];
        if (!data) { retryAfter.set(id, Date.now() + 5000); continue; }
        cache.set(id, { data, ts: Date.now() });
        retryAfter.delete(id);
      }
    })
    .catch(() => {
      // A network failure is not a successful "no skin equipped" response.
      for (const id of ids) if ((revisions.get(id) || 0) === versions.get(id)) retryAfter.set(id, Date.now() + 5000);
    })
    .finally(() => {
      for (const id of ids) if (inflight.get(id) === versions.get(id)) inflight.delete(id);
      notify();
    });
}

function request(ids: string[]) {
  const now = Date.now();
  let added = false;
  for (const id of ids) {
    const hit = cache.get(id);
    if (hit && now - hit.ts < TTL) continue;
    if ((retryAfter.get(id) || 0) > now) continue;
    if (inflight.get(id) === (revisions.get(id) || 0)) continue;
    if (!pending.has(id)) {
      pending.add(id);
      added = true;
    }
  }
  if (added && !timer) timer = setTimeout(flush, 20);
}

/** Invalidate cached cosmetics (call after equip/purchase). */
export function invalidateCosmetics(userId?: string) {
  const ids = userId ? [userId] : [...new Set([...cache.keys(), ...pending, ...inflight.keys()])];
  for (const id of ids) {
    revisions.set(id, (revisions.get(id) || 0) + 1);
    const hit = cache.get(id);
    if (hit) hit.ts = 0; // Keep the current theme until a successful response.
    retryAfter.delete(id);
  }
  notify();
}

export function useCosmetics(userIds: (string | null | undefined)[]): Record<string, PilotCosmetics> {
  const key = useMemo(() => Array.from(new Set(userIds.filter(Boolean) as string[])).sort().join(","), [userIds]);
  const [, setTick] = useState(0);
  const idsRef = useRef<string[]>([]);
  idsRef.current = key ? key.split(",") : [];

  useEffect(() => {
    const w = () => { request(idsRef.current); setTick((t) => t + 1); };
    waiters.add(w);
    if (idsRef.current.length) request(idsRef.current);
    const refresh = setInterval(() => request(idsRef.current), 5000);
    return () => {
      clearInterval(refresh);
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
