/** Pure shared validation: missing coordinates must never turn into (0,0,0). */
export interface SystemCoordinates {
  x: number;
  y: number;
  z: number;
}
export type CoordinateSource = 'edsm' | 'spansh_catalog' | 'spansh';
export const coordinateNameKey = (name: string) =>
  name.trim().replace(/\s+/g, ' ').toLowerCase();
export function readSystemCoordinates(
  value: unknown
): SystemCoordinates | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, any>;
  const coords = row.coords ?? row;
  const values = [coords.x, coords.y, coords.z];
  if (
    values.some(
      (axis) =>
        (typeof axis !== 'number' && typeof axis !== 'string') ||
        String(axis).trim() === '' ||
        !Number.isFinite(Number(axis))
    )
  )
    return null;
  return { x: Number(coords.x), y: Number(coords.y), z: Number(coords.z) };
}
