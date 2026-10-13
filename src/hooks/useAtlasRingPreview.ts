'use client';

import { useEffect, useState } from 'react';
import { ringBasis3D, ringHeightOffset, type XYZ } from '@/lib/atlasRingGeometry';
import { publishAtlasRingPreview } from '@/lib/atlasRingPreview';
import { LANDMARKS } from '@/lib/ed3dCanon';

interface Coordinates { start: XYZ; center: XYZ }
// Только успешно разрешённые пары. Изменение ползунков не делает новых запросов.
const coordinatesCache = new Map<string, Coordinates>();
const coordinateKey = (start: string, center: string) => JSON.stringify([start.toLowerCase(), center.toLowerCase()]);

export function useAtlasRingPreview(startSystem: string, centerSystem: string, radius: number, height: number, tilt: number, enabled: boolean) {
  const start = startSystem.trim();
  const center = centerSystem.trim() || 'Sagittarius A*';
  const key = coordinateKey(start, center);
  const [resolved, setResolved] = useState<{ key: string; coordinates: Coordinates } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const landmark = (name: string) => LANDMARKS.find(point => point.name.toLowerCase() === name.toLowerCase());
  const knownStart = landmark(start), knownCenter = landmark(center);
  const coordinates = knownStart && knownCenter
    ? { start: knownStart, center: knownCenter }
    : coordinatesCache.get(key) || (resolved?.key === key ? resolved.coordinates : null);

  useEffect(() => {
    if (!enabled || !start || coordinates) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ start_system: start, center_system: center });
        const response = await fetch(`/api/atlas/ring-route/preview?${params}`, { signal: controller.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Не удалось загрузить координаты кольца');
        if (![data.start, data.center].every(point => point && [point.x, point.y, point.z].every(Number.isFinite))) {
          throw new Error('Координаты кольца недоступны');
        }
        if (controller.signal.aborted) return;
        coordinatesCache.set(key, data);
        setResolved({ key, coordinates: data });
        setFailure(null);
      } catch (error) {
        if (!controller.signal.aborted) setFailure({ key, message: error instanceof Error ? error.message : 'Превью недоступно' });
      }
    }, 350);
    return () => { clearTimeout(timer); controller.abort(); };
    // Координаты меняются только при выборе другой пары систем, не от ползунков.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);

  const sx = coordinates?.start.x, sy = coordinates?.start.y, sz = coordinates?.start.z;
  const cx = coordinates?.center.x, cy = coordinates?.center.y, cz = coordinates?.center.z;
  useEffect(() => {
    if (!enabled || sx === undefined || sy === undefined || sz === undefined || cx === undefined || cy === undefined || cz === undefined) {
      publishAtlasRingPreview(null);
      return;
    }
    const ringCenter = { x: cx, y: cy + ringHeightOffset(cy, radius, tilt, height), z: cz };
    publishAtlasRingPreview({
      cx: ringCenter.x, cy: ringCenter.y, cz: ringCenter.z, radius,
      basis: ringBasis3D({ x: sx, y: sy, z: sz }, ringCenter, tilt * Math.PI / 180),
    });
    return () => publishAtlasRingPreview(null);
  }, [enabled, sx, sy, sz, cx, cy, cz, radius, height, tilt]);

  if (!enabled) return '';
  if (!start) return 'Укажите начальную систему для предварительного контура.';
  if (failure?.key === key && !coordinates) return `Предварительный контур: ${failure.message}`;
  return coordinates
    ? 'На карте показан предварительный контур поиска. Изменение параметров не запускает поиск.'
    : 'Загрузка координат для предварительного контура…';
}
