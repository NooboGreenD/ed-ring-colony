import { createServiceClient } from '@/lib/supabaseServer';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const MIN_JUMP = 1;
const MAX_JUMP = 14.99;
const MIN_RING_RADIUS = 100;
const MAX_RING_RADIUS = 45_000;
const MAX_SEARCH_RADIUS = 3_000;
// 360 sectors keeps the angular gap small while halving external requests;
// interpolation fills every gap and stays below the 30,000-point limit even at
// the maximum 45,000 ly ring radius.
const SECTORS = 360;
const EDSM_UA = 'ED-Ring-Colony/1.0 (galactic-ring-route)';

type Point = { name: string; x: number; y: number; z: number; source?: string };

function distance(a: Point, b: Point) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

async function json(res: Response): Promise<any | null> {
  const text = await res.text();
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

async function edsmCoords(name: string): Promise<Point | null> {
  const res = await fetch(`https://www.edsm.net/api-v1/system?systemName=${encodeURIComponent(name)}&showCoordinates=1`, { headers: { Accept: 'application/json', 'User-Agent': EDSM_UA } });
  const data = await json(res);
  const c = data?.coords;
  return c && Number.isFinite(Number(c.x)) && Number.isFinite(Number(c.y)) && Number.isFinite(Number(c.z))
    ? { name, x: Number(c.x), y: Number(c.y), z: Number(c.z), source: 'edsm' } : null;
}

async function systemsNear(point: Point, radius: number): Promise<Point[]> {
  // A slow/rate-limited EDSM tile must not abort the whole ring. Missing
  // sectors are deliberately returned as empty and become triangulated
  // anchors later in the same pass.
  try {
    // EDSM accepts coordinate-based cube queries and returns real named systems.
    // Keep the requested radius bounded; the final distance filter removes cube corners.
    const size = Math.min(radius * 2, 6000);
    const url = new URL('https://www.edsm.net/api-v1/cube-systems');
    url.searchParams.set('x', String(point.x));
    url.searchParams.set('y', String(point.y));
    url.searchParams.set('z', String(point.z));
    url.searchParams.set('size', String(size));
    url.searchParams.set('showCoordinates', '1');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    let res: Response;
    try {
      res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': EDSM_UA }, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
    const data = await json(res);
    if (!Array.isArray(data)) return [];
    return data.flatMap((row: any) => {
      const c = row?.coords;
      if (!row?.name || !c) return [];
      const candidate = { name: String(row.name), x: Number(c.x), y: Number(c.y), z: Number(c.z), source: 'edsm' };
      return [candidate].filter((item) => Number.isFinite(item.x) && Number.isFinite(item.y) && Number.isFinite(item.z) && distance(item, point) <= radius);
    });
  } catch (error) {
    console.warn('[Atlas ring] EDSM sector skipped:', error instanceof Error ? error.message : error);
    return [];
  }
}

function ringBasis(start: Point, center: Point) {
  const vx = start.x - center.x;
  const vz = start.z - center.z;
  const len = Math.hypot(vx, vz) || 1;
  return { ux: vx / len, uz: vz / len };
}

function interpolate(from: Point, to: Point, out: Point[], label: string) {
  const hops = Math.max(1, Math.ceil(distance(from, to) / MAX_JUMP));
  for (let i = 1; i < hops; i++) {
    const t = i / hops;
    out.push({
      name: `${label} ${i}`,
      x: from.x + (to.x - from.x) * t,
      y: from.y + (to.y - from.y) * t,
      z: from.z + (to.z - from.z) * t,
      source: 'triangulated',
    });
  }
  out.push(to);
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type RingProgress = { stage: string; percent: number; message: string; sector?: number; sectors?: number; found?: number; cached?: boolean; deviation?: number };

async function buildRing(body: any, report: (progress: RingProgress) => void) {
  const startName = typeof body.start_system === 'string' ? body.start_system.trim() : '';
  const ringRadius = Math.min(MAX_RING_RADIUS, Math.max(MIN_RING_RADIUS, Number(body.ring_radius) || 23_000));
  const searchRadius = Math.min(MAX_SEARCH_RADIUS, Math.max(50, Number(body.search_radius) || 500));
  if (!startName) throw new Error('start_system is required');

  report({ stage: 'coordinates', percent: 2, message: 'Получение координат начальной системы и Sagittarius A*' });
  const start = await edsmCoords(startName);
  const center = await edsmCoords('Sagittarius A*');
  if (!start || !center) throw new Error('Не удалось получить координаты начальной точки или Sagittarius A*');

  const basis = ringBasis(start, center);
  const svc = createServiceClient();
  report({ stage: 'cache', percent: 5, message: 'Загрузка сохранённых систем из кэша' });
    const { data: cachedRows } = await svc
      .from('atlas_ring_system_cache')
      .select('system_name,x,y,z,source')
      .limit(100_000);
    const cachedSystems: Point[] = (cachedRows || []).filter((row: any) => Number.isFinite(Number(row.x)) && Number.isFinite(Number(row.y)) && Number.isFinite(Number(row.z))).map((row: any) => ({ name: row.system_name, x: Number(row.x), y: Number(row.y), z: Number(row.z), source: row.source || 'cache' }));
    const discovered = new Map<string, Point>();
    const anchors: Point[] = [];
    const targets: Point[] = [];
    const usedAnchorNames = new Set<string>();
    const scanLog: { sector: number; found: number; selected: string | null }[] = [];

    for (let sector = 0; sector < SECTORS; sector++) {
      const angle = (2 * Math.PI * sector) / SECTORS;
      const target: Point = {
        name: `ring-target-${sector + 1}`,
        x: center.x + ringRadius * (basis.ux * Math.cos(angle) - basis.uz * Math.sin(angle)),
        y: center.y,
        z: center.z + ringRadius * (basis.uz * Math.cos(angle) + basis.ux * Math.sin(angle)),
      };
      targets.push(target);
      const cachedNearby = cachedSystems.filter((system) => distance(system, target) <= searchRadius);
      // Cached coordinates make repeat searches cheap. Ask EDSM only for a
      // sector that has not been discovered before and throttle each request.
      const usingCache = cachedNearby.length > 0;
      if (!usingCache) await pause(140);
      const nearby = usingCache ? cachedNearby : await systemsNear(target, searchRadius);
      const selectedDeviation = nearby.length ? distance(nearby[0], target) : searchRadius;
      for (const system of nearby) discovered.set(system.name.toLowerCase(), system);
      // Prefer a real system, but never drop a sector: a target point is the
      // last-resort triangulation anchor when no unused known system exists.
      const selected = nearby
        .sort((a, b) => distance(a, target) - distance(b, target))
        .find((system) => !usedAnchorNames.has(system.name.toLowerCase())) || null;
      const anchor = selected || { ...target, name: `TRIANGULATED RING ${sector + 1}`, source: 'triangulated' };
      anchors.push(anchor);
      if (selected) usedAnchorNames.add(selected.name.toLowerCase());
      scanLog.push({ sector: sector + 1, found: nearby.length, selected: selected?.name || null });
      report({
        stage: 'scan',
        percent: 8 + Math.round(((sector + 1) / SECTORS) * 78),
        message: `Перебор сегмента ${sector + 1} из ${SECTORS}`,
        sector: sector + 1,
        sectors: SECTORS,
        found: nearby.length,
        cached: usingCache,
        deviation: selected ? distance(selected, target) : selectedDeviation,
      });
    }

    report({ stage: 'verify', percent: 86, message: 'Повторная проверка: поиск более подходящих известных систем' });
    // A second pass prevents a sector from keeping a worse anchor merely
    // because that system was returned while scanning another sector.
    const verificationNames = new Set<string>([start.name.toLowerCase()]);
    for (let index = 0; index < anchors.length; index++) {
      const target = targets[index];
      const current = anchors[index];
      const better = Array.from(discovered.values())
        .filter((system) => !verificationNames.has(system.name.toLowerCase()) && distance(system, target) <= searchRadius)
        .sort((a, b) => distance(a, target) - distance(b, target))[0];
      if (better && (current.source === 'triangulated' || distance(better, target) + 0.01 < distance(current, target))) {
        anchors[index] = better;
      }
      if (anchors[index].source !== 'triangulated') verificationNames.add(anchors[index].name.toLowerCase());
      if ((index + 1) % 60 === 0) report({ stage: 'verify', percent: 86 + Math.round(((index + 1) / anchors.length) * 3), message: `Проверка сегмента ${index + 1} из ${anchors.length}`, sector: index + 1, sectors: anchors.length });
    }

    report({ stage: 'route', percent: 90, message: 'Построение полного замкнутого кольца с шагом не более 14,99 св.л.' });
    // Ensure the requested start system is the first and last point.
    discovered.set(start.name.toLowerCase(), start);
    const routeAnchors = [start, ...anchors, start];
    const route: Point[] = [];
    for (let index = 0; index < routeAnchors.length - 1; index++) {
      interpolate(routeAnchors[index], routeAnchors[index + 1], route, `RING TRIANGULATED ${index + 1}`);
    }

    const cacheRows = Array.from(discovered.values()).map((point) => ({
      system_name: point.name,
      x: point.x, y: point.y, z: point.z,
      source: point.source || 'edsm',
      raw_data: { ring_radius: ringRadius, search_radius: searchRadius },
      last_seen_at: new Date().toISOString(),
    }));
    for (let index = 0; index < cacheRows.length; index += 500) {
      const { error } = await svc.from('atlas_ring_system_cache').upsert(cacheRows.slice(index, index + 500), { onConflict: 'system_name' });
      if (error) throw new Error(`Кэш кольцевого маршрута: ${error.message}`);
    }

    report({ stage: 'save', percent: 96, message: `Сохранение ${discovered.size} реальных систем в кэш` });
    return {
      start: start.name,
      center: { name: center.name, x: center.x, y: center.y, z: center.z },
      ring_radius: ringRadius,
      search_radius: searchRadius,
      min_jump: MIN_JUMP,
      max_jump: MAX_JUMP,
      route,
      anchors: routeAnchors,
      discovered_count: discovered.size,
      synthetic_count: route.filter((point) => point.source === 'triangulated').length,
      sectors: scanLog,
    };
}

export async function POST(req: Request) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify({ event, data })}\n`));
      (async () => {
        try {
          const body = await req.json();
          send('progress', { stage: 'start', percent: 0, message: 'Запуск поиска кольцевого маршрута' });
          const result = await buildRing(body, (progress) => send('progress', progress));
          send('result', result);
        } catch (error) {
          send('error', { message: error instanceof Error ? error.message : 'Ring route search failed' });
        } finally {
          send('done', {});
          controller.close();
        }
      })();
    },
  });
  return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' } });
}
