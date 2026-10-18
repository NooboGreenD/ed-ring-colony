/** Shared nearby-system contract and exact volume filtering (no network). */
import { systemKey } from './systemIdentity.ts';

export type NearbyShape = 'sphere' | 'cube';
export type NearbySourceId =
  | 'catalog'
  | 'cache'
  | 'edsm-sphere'
  | 'edsm-cube'
  | 'spansh';
export interface NearbyPoint {
  name: string;
  x: number;
  y: number;
  z: number;
  id64?: string;
}
export interface NearbySystem extends NearbyPoint {
  distance: number;
  sources: NearbySourceId[];
  aliases: string[];
  coordinate_conflict: boolean;
}
export interface NearbySource {
  id: NearbySourceId;
  status: 'ok' | 'empty' | 'partial' | 'unavailable';
  count: number;
  message?: string;
}
export interface NearbyResult {
  reference: NearbyPoint;
  shape: NearbyShape;
  radius: number;
  systems: NearbySystem[];
  count: number;
  sources: NearbySource[];
  warnings: string[];
}
/** Ключ системы — общий для всего проекта (`systemIdentity.ts`). */
export const nearbyNameKey = (name: string): string => systemKey(name);
export function nearbyPoint(value: unknown): NearbyPoint | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, any>;
  const row = input.record ?? input;
  const coords = row.coords ?? row;
  const name = String(row.name ?? row.system_name ?? '')
    .trim()
    .replace(/\s+/g, ' ');
  if (
    !name ||
    [coords.x, coords.y, coords.z].some(
      (value) => value == null || !Number.isFinite(Number(value))
    )
  )
    return null;
  const id = row.id64;
  // Large ID64 values must not be recovered from already-rounded JSON numbers.
  const id64 =
    typeof id === 'string' && /^[1-9][0-9]{0,19}$/.test(id)
      ? id
      : Number.isSafeInteger(id) && id > 0
        ? String(id)
        : undefined;
  return {
    name,
    x: Number(coords.x),
    y: Number(coords.y),
    z: Number(coords.z),
    ...(id64 ? { id64 } : {}),
  };
}
export function nearbyDistance(a: NearbyPoint, b: NearbyPoint) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
export function inNearbyVolume(
  point: NearbyPoint,
  center: NearbyPoint,
  shape: NearbyShape,
  radius: number
) {
  const distance =
    shape === 'sphere'
      ? nearbyDistance(point, center)
      : Math.max(
          Math.abs(point.x - center.x),
          Math.abs(point.y - center.y),
          Math.abs(point.z - center.z)
        );
  return distance <= radius + 1e-8;
}
export function mergeNearbySystems(
  center: NearbyPoint,
  shape: NearbyShape,
  radius: number,
  batches: Array<{ source: NearbySourceId; systems: NearbyPoint[] }>
) {
  const names = new Map<string, NearbySystem>();
  const ids = new Map<string, NearbySystem>();
  for (const batch of batches)
    for (const point of batch.systems) {
      const key = nearbyNameKey(point.name);
      const existing =
        names.get(key) ?? (point.id64 ? ids.get(point.id64) : undefined);
      if (existing) {
        if (!existing.sources.includes(batch.source))
          existing.sources.push(batch.source);
        if (
          point.name !== existing.name &&
          !existing.aliases.includes(point.name)
        )
          existing.aliases.push(point.name);
        if (nearbyDistance(existing, point) > 1e-5)
          existing.coordinate_conflict = true;
        names.set(key, existing);
        if (!existing.id64 && point.id64) {
          existing.id64 = point.id64;
          ids.set(point.id64, existing);
        }
        continue;
      }
      const system: NearbySystem = {
        ...point,
        distance: nearbyDistance(point, center),
        sources: [batch.source],
        aliases: [],
        coordinate_conflict: false,
      };
      names.set(key, system);
      if (point.id64) ids.set(point.id64, system);
    }
  // First-priority coordinates are authoritative for geometry as well as display.
  return Array.from(new Set(names.values()))
    .filter((point) => inNearbyVolume(point, center, shape, radius))
    .sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name));
}
