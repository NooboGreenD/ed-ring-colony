import { LRUCache } from "lru-cache";

const rateLimitCache = new LRUCache<string, number>({
  max: 500,
  ttl: 60_000,
});

export function checkRateLimit(ip: string, max = 5): boolean {
  const current = rateLimitCache.get(ip) || 0;
  if (current >= max) return false;
  rateLimitCache.set(ip, current + 1);
  return true;
}

// Higher limit for internal sync endpoints
export function checkSyncRateLimit(ip: string, max = 300): boolean {
  const current = rateLimitCache.get(ip) || 0;
  if (current >= max) return false;
  rateLimitCache.set(ip, current + 1);
  return true;
}
