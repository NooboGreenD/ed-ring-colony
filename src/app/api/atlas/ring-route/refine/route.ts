import { NextResponse } from 'next/server';
import { catalogIsComplete, findSystemsInCube, getGalaxyStats } from '@/lib/galaxySystemsDb';
import { listCachedSystemsNear, saveCachedSystems } from '@/lib/atlasSystemCache';

/**
 * Уточнение уже построенного кольца: расчётные точки заменяются реальными
 * системами, если такая система есть в коридоре и не ломает прыжки.
 *
 * Источники по приоритету: кэш Atlas → каталог Spansh → EDSM (с бюджетом).
 * Раньше здесь на каждую точку ходил EDSM, и уточнение длинного кольца
 * растягивалось на десятки минут и обрывалось по таймауту.
 */

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const MAX_JUMP = 14.99;
/** Допуск отклонения от окружности кольца (св.л.): совпадает с atlasRingSearch. */
const ANCHOR_DEVIATION_LIMIT = 100;
const DEFAULT_REFINE_RADIUS = 30;
const MAX_EDSM_REQUESTS = 30;
/** Бюджет времени уточнения: длинное кольцо нельзя считать минутами. */
const REFINE_TIME_BUDGET_MS = 45_000;
const EDSM_TIMEOUT_MS = 6000;
const UA = 'ED-Ring-Colony/1.0 (ring-refinement)';

type Point = { name: string; x: number; y: number; z: number; source?: string; isAnchor?: boolean };

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

type RingBasis3D = {
  ux: number; uy: number; uz: number;
  vx: number; vy: number; vz: number;
  nx: number; ny: number; nz: number;
};

/** 3D-отклонение точки от наклонённой окружности кольца. */
const deviationFrom3D = (point: Point, ringCenter: Point, basis: RingBasis3D, ringRadius: number) => {
  const dx = point.x - ringCenter.x;
  const dy = point.y - ringCenter.y;
  const dz = point.z - ringCenter.z;
  const a = dx * basis.ux + dy * basis.uy + dz * basis.uz;
  const b = dx * basis.vx + dy * basis.vy + dz * basis.vz;
  const c = dx * basis.nx + dy * basis.ny + dz * basis.nz;
  const r = Math.hypot(a, b);
  return Math.hypot(r - ringRadius, c);
};

/** Устаревшее 2D-отклонение — для совместимости со старыми кольцами. */
const deviationFrom2D = (point: Point, center: Point, ringRadius: number) =>
  Math.hypot(Math.hypot(point.x - center.x, point.z - center.z) - ringRadius, point.y - center.y);

async function edsmNear(point: Point, radius: number): Promise<Point[]> {
  const url = new URL('https://www.edsm.net/api-v1/cube-systems');
  url.searchParams.set('x', String(point.x));
  url.searchParams.set('y', String(point.y));
  url.searchParams.set('z', String(point.z));
  url.searchParams.set('size', String(Math.min(Math.max(radius * 2, 40), 200)));
  url.searchParams.set('showCoordinates', '1');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EDSM_TIMEOUT_MS);
  try {
    const response = await fetch(url.toString(), {
      headers: { Accept: 'application/json', 'User-Agent': UA },
      signal: controller.signal,
    });
    if (!response.ok) return [];
    const data = await response.json().catch(() => null);
    if (!Array.isArray(data)) return [];
    return data.flatMap((row: any): Point[] => {
      const coords = row?.coords;
      if (!row?.name || !coords) return [];
      const x = Number(coords.x);
      const y = Number(coords.y);
      const z = Number(coords.z);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return [];
      return [{ name: String(row.name), x, y, z, source: 'edsm' }];
    });
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const input: Point[] = Array.isArray(body?.route) ? body.route : [];
    const center = body?.center as Point | undefined;
    const ringRadius = Number(body?.ring_radius) || 23_000;
    const refineRadius = Math.min(120, Math.max(10, Number(body?.refine_radius) || DEFAULT_REFINE_RADIUS));
    const deviationLimit = Math.min(400, Math.max(10, Number(body?.deviation_limit) || ANCHOR_DEVIATION_LIMIT));
    // Флаг «уточнять опоры» — при повторном прогоне можно заменить триангулированные опоры.
    const refineAnchors = body?.refine_anchors === true;
    // Дополнительные системы, которые маршрут должен пройти (ключевые) — уже в маршруте?
    const extraKeySystems: Point[] = Array.isArray(body?.key_systems) ? body.key_systems : [];
    // 3D-геометрия наклонённого кольца (basis3D + ringCenter). Если переданы — используем 3D-отклонение.
    const basis3D = body?.basis3d as RingBasis3D | undefined;
    const ringCenterIn = body?.ring_center as Point | undefined;
    const has3D = Boolean(basis3D && ringCenterIn
      && Number.isFinite(basis3D.ux) && Number.isFinite(basis3D.vx) && Number.isFinite(basis3D.nx)
      && ringCenterIn && Number.isFinite(ringCenterIn.x));
    const deviationFn = has3D
      ? (p: Point) => deviationFrom3D(p, ringCenterIn!, basis3D!, ringRadius)
      : (p: Point) => deviationFrom2D(p, center!, ringRadius);
    const geomCenter = has3D ? ringCenterIn! : center!;
    if (input.length < 3 || !center) {
      return NextResponse.json({ error: 'Недостаточно данных для уточнения маршрута' }, { status: 400 });
    }

    let catalogReady = false;
    try {
      catalogReady = catalogIsComplete(await getGalaxyStats());
    } catch {
      catalogReady = false;
    }

    const result = input.map((point) => ({ ...point }));
    const used = new Set(
      result
        .filter((point) => point.source !== 'triangulated' && !point.name.startsWith('RING TRIANGULATED'))
        .map((point) => point.name.toLowerCase()),
    );
    // Ключевые системы из запроса тоже считаем «занятыми».
    for (const ks of extraKeySystems) {
      if (ks?.name) used.add(String(ks.name).toLowerCase());
    }
    const discovered = new Map<string, Point>();
    let replacements = 0;
    let anchorReplacements = 0;
    let edsmRequests = 0;
    let cacheHits = 0;
    let catalogHits = 0;

    const startedAt = Date.now();
    for (let index = 1; index < result.length - 1; index++) {
      if (index > 1 && Date.now() - startedAt > REFINE_TIME_BUDGET_MS) {
        console.warn('[ring-refine] бюджет времени исчерпан, уточнено не всё кольцо');
        break;
      }
      const current = result[index];
      const previous = result[index - 1];
      const next = result[index + 1];
      // Опорные точки обычно не трогаем, но при refine_anchors=true триангулированные
      // опоры пытаемся заменить на ближайшую реальную систему (в пределах отклонения).
      if (current.isAnchor) {
        if (!refineAnchors) continue;
        const isTriangulatedAnchor = current.source === 'triangulated' || current.name.startsWith('RING TRIANGULATED');
        if (!isTriangulatedAnchor) continue;
        // Ищем систему с подходящим отклонением — не трогая соседние прыжки.
        const candidates: Point[] = [];
        const cached = await listCachedSystemsNear(current, refineRadius * 2, 200).catch(() => []);
        for (const row of cached) candidates.push({ name: row.name, x: row.x, y: row.y, z: row.z, source: 'cache' });
        if (candidates.length === 0 && catalogReady) {
          try {
            const rows = await findSystemsInCube({ x: current.x, y: current.y, z: current.z, half: refineRadius * 2, limit: 200 });
            for (const row of rows) {
              if (dist(row, current) > refineRadius * 2) continue;
              candidates.push({ name: row.name, x: row.x, y: row.y, z: row.z, source: 'catalog' });
            }
          } catch {/* ignore */}
        }
        for (const c of candidates) discovered.set(c.name.toLowerCase(), c);
        const replacement = candidates
          .filter((c) => !used.has(c.name.toLowerCase())
            && dist(c, previous) <= 14.99
            && dist(c, next) <= 14.99
            && deviationFn(c) <= deviationLimit)
          .sort((a, b) => deviationFn(a) - deviationFn(b))[0];
        if (replacement) {
          used.delete(current.name.toLowerCase());
          used.add(replacement.name.toLowerCase());
          result[index] = { ...replacement, isAnchor: true };
          replacements++;
          anchorReplacements++;
        }
        continue;
      }
      const currentError = deviationFn(current);
      const isSynthetic = current.source === 'triangulated' || current.name.startsWith('RING TRIANGULATED');

      const candidates: Point[] = [];
      const cached = await listCachedSystemsNear(current, refineRadius, 200).catch(() => []);
      for (const row of cached) {
        candidates.push({ name: row.name, x: row.x, y: row.y, z: row.z, source: 'cache' });
        cacheHits++;
      }
      if (candidates.length === 0 && catalogReady) {
        try {
          const rows = await findSystemsInCube({ x: current.x, y: current.y, z: current.z, half: refineRadius, limit: 200 });
          for (const row of rows) {
            if (dist(row, current) > refineRadius) continue;
            candidates.push({ name: row.name, x: row.x, y: row.y, z: row.z, source: 'catalog' });
            catalogHits++;
          }
        } catch (error: any) {
          console.warn('[ring-refine] каталог недоступен:', error?.message);
        }
      }
      if (candidates.length === 0 && edsmRequests < MAX_EDSM_REQUESTS) {
        edsmRequests++;
        candidates.push(...(await edsmNear(current, refineRadius)));
      }

      for (const candidate of candidates) discovered.set(candidate.name.toLowerCase(), candidate);

      const better = candidates
        .filter((item) => !used.has(item.name.toLowerCase())
          && dist(item, previous) <= MAX_JUMP
          && dist(item, next) <= MAX_JUMP
          && deviationFn(item) <= deviationLimit)
        .sort((left, right) => deviationFn(left) - deviationFn(right))[0];

      const candidateError = better ? deviationFn(better) : Number.POSITIVE_INFINITY;
      const improves = Boolean(better)
        && (isSynthetic || candidateError + 0.01 < currentError);
      if (better && improves) {
        used.delete(current.name.toLowerCase());
        used.add(better.name.toLowerCase());
        result[index] = better;
        replacements++;
      }
    }

    const saved = await saveCachedSystems(
      Array.from(discovered.values()).map((point) => ({
        name: point.name,
        x: point.x,
        y: point.y,
        z: point.z,
        source: point.source || 'edsm',
      })),
    ).catch(() => 0);

    const synthetic = result.filter((point) => point.source === 'triangulated' || point.name.startsWith('RING TRIANGULATED')).length;

    return NextResponse.json({
      route: result,
      replacements,
      anchor_replacements: anchorReplacements,
      scanned: result.length - 2,
      discovered: discovered.size,
      refine_radius: refineRadius,
      deviation_limit: deviationLimit,
      max_jump: MAX_JUMP,
      synthetic_points: synthetic,
      real_points: result.length - synthetic,
      sources: { cache: cacheHits, catalog: catalogHits, edsm: edsmRequests, saved },
    });
  } catch (error: any) {
    console.error('[ring-refine] ошибка:', error);
    return NextResponse.json({ error: error?.message || 'Ошибка уточнения маршрута' }, { status: 500 });
  }
}
