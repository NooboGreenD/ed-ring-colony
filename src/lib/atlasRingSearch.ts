/**
 * Построение Галактического кольца колонизации — пошагово и с опорой на
 * существующие системы.
 *
 * Требования к результату (проверяются в `validateRingRoute`, видны в ответе):
 *   • расстояние между соседними системами маршрута — не больше 14,99 св.л.;
 *   • опорные точки кольца — через 480–490 св.л. (жёсткий предел 500 св.л.);
 *   • отклонение опорной точки от окружности кольца — до 50 св.л. (допуск 100).
 *     Отклонение — перпендикулярное расстояние до окружности, а не расстояние
 *     до расчётной точки сегмента: вдоль кольца опора сдвигается свободно,
 *     важно лишь то, насколько она ушла от «оси» кольца.
 *
 * Почему поиск раньше падал по таймауту (504) и не стартовал при больших радиусах:
 *   • кэш систем листался постранично (до 40 последовательных запросов на сегмент),
 *     и чем больше радиус поиска, тем дольше шёл шаг;
 *   • сетевые запросы EDSM/Spansh шли последовательно внутри сегмента, а бюджет
 *     времени проверялся только между сегментами — первый сегмент мог висеть минутами;
 *   • коридор моста между опорами был равен радиусу поиска (до 3000 св.л.), пул
 *     систем разрастался до десятков тысяч, а финализация перебирала его на каждом шаге.
 *
 * Как устроено теперь:
 *   1. Шаг сегментов ограничен по времени: все внешние и БД-вызовы имеют таймаут,
 *      а сетевые источники не трогаем, если каталог проекта полон.
 *   2. Число сегментов — от окружности и шага 490 св.л.; опора выбирается среди
 *      реальных систем с отклонением ≤ 100 и шагом 480–490 от предыдущей опоры.
 *      Если подходящих систем нет — расчётная опора на окружности нужного шага.
 *   3. Финализация: пул систем берётся по каждому сегменту отдельно (пачками,
 *      параллельно), коридор фиксирован допуском отклонения, а не радиусом поиска.
 *   4. Итоговый маршрут проверяется по всем трём требованиям и отдаёт статистику.
 */

// Явные расширения нужны для `node --test`.
import { supabaseAdmin } from './supabaseAdmin.ts';
import { catalogIsComplete, findSystemByName, findSystemsInCube, getGalaxyStats } from './galaxySystemsDb.ts';
import { listCachedSystemsNear, saveCachedSystems, type CachedSystem } from './atlasSystemCache.ts';
import { spanshNearest as spanshNearestApi, spanshSearch, spanshSystemsNear } from './spanshClient.ts';
import { normalizeSystemName } from './galaxySystems.ts';

export const MIN_RING_RADIUS = 100;
export const MAX_RING_RADIUS = 45_000;
export const DEFAULT_RING_RADIUS = 23_000;
export const MIN_SEARCH_RADIUS = 50;
export const MAX_SEARCH_RADIUS = 3_000;
export const DEFAULT_SEARCH_RADIUS = 500;

/** Максимальный прыжок между соседними системами маршрута, св.л. */
export const MAX_JUMP = 14.99;
/** Шаг опорных точек: планируем 480–490, жёсткий предел 500 св.л. */
export const ANCHOR_SPACING_MIN = 480;
export const ANCHOR_SPACING_TARGET = 485;
export const ANCHOR_SPACING_MAX = 490;
export const ANCHOR_SPACING_LIMIT = 500;
/** Отклонение от окружности кольца: предпочтительно до 50, допуск до 100 св.л. */
export const ANCHOR_DEVIATION_PREFERRED = 50;
export const ANCHOR_DEVIATION_LIMIT = 100;
/** Коридор моста между опорами совпадает с допуском отклонения от кольца. */
export const ROUTE_CORRIDOR = ANCHOR_DEVIATION_LIMIT;
/** Шаг расчётной точки чуть короче прыжка: запас на округление координат. */
const SYNTHETIC_STEP = MAX_JUMP - 0.005;

/** Число сегментов: окружность / предельный шаг опор. */
const MIN_SECTORS = 3;
const MAX_SECTORS = 720;

/** Сколько сегментов обрабатывает один шаг (запрос). */
export const DEFAULT_STEP_SECTORS = 24;
const MAX_STEP_SECTORS = 60;

/**
 * Бюджет времени одного шага. Шаг обязан уложиться в ответ HTTP с запасом:
 * все вызовы внутри проверяют дедлайн, а не только переход между сегментами.
 */
const STEP_TIME_BUDGET_MS = 20_000;
/** Таймаут одного обращения к БД: зависший запрос не должен держать шаг. */
const DB_TIMEOUT_MS = 8_000;
/** Бюджет времени сборки маршрута (ниже таймаута роута в 120 с). */
const FINALIZE_TIME_BUDGET_MS = 60_000;
const FINALIZE_CONCURRENCY = 6;

/** Бюджеты внешних запросов на один шаг. */
const EDSM_BUDGET_PER_STEP = 16;
const EDSM_TIMEOUT_MS = 6000;
const SPANSH_BUDGET_PER_STEP = 4;
const SPANSH_TIMEOUT_MS = 5000;

/** Максимум систем, которые берём вокруг одной опорной точки. */
const SECTOR_CACHE_LIMIT = 600;
/** Пул систем одного сегмента маршрута (ближайшие к середине отрезка). */
const SEGMENT_POOL_LIMIT = 2000;
/** Сколько точек сегмента отдаём клиенту для отрисовки на карте. */
const STEP_FOUND_SAMPLE = 400;

const EDSM_UA = 'ED-Ring-Colony/1.0 (galactic-ring-route)';

export type RingSource = 'catalog' | 'cache' | 'edsm' | 'spansh' | 'triangulated' | 'start';

export interface XYZ {
  x: number;
  y: number;
  z: number;
}

export interface RingPoint extends XYZ {
  name: string;
  source?: RingSource;
  /** Опорная точка кольца (а не промежуточная система моста). */
  isAnchor?: boolean;
}

export interface RingAnchor extends RingPoint {
  /** Перпендикулярное отклонение от окружности кольца, св.л. */
  deviation: number;
  target: XYZ;
  /** Сколько реальных систем нашлось в окне сегмента. */
  found: number;
  /** Радиус, на котором нашлась опора (может быть больше запрошенного). */
  usedRadius: number;
}

export interface RingStats {
  sectors: number;
  sectorsDone: number;
  realAnchors: number;
  triangulatedAnchors: number;
  systemsFound: number;
  systemsSaved: number;
  catalogHits: number;
  cacheHits: number;
  edsmRequests: number;
  spanshRequests: number;
  reusedFromNeighbours: number;
  syntheticPoints: number;
  realPoints: number;
  bridgeCatalogRequests: number;
}

export interface RingPlan {
  sessionId: string;
  start: RingPoint;
  center: RingPoint;
  basis: { ux: number; uz: number };
  ringRadius: number;
  searchRadius: number;
  sectors: number;
  sectorsDone: number;
  anchors: RingAnchor[];
  stats: RingStats;
  status: 'scanning' | 'ready' | 'completed' | 'failed';
}

export interface RingStepResult {
  sessionId: string;
  sectorsDone: number;
  sectors: number;
  done: boolean;
  processed: number;
  /** Новые опорные точки: карта рисует их сразу. */
  anchors: RingAnchor[];
  /** Найденные по ходу системы (выборка для карты). */
  found: RingPoint[];
  /** Точка текущего сканирования. */
  beam: XYZ | null;
  stats: RingStats;
}

/** Результат проверки маршрута относительно требований к кольцу. */
export interface RingValidation {
  maxJump: number;
  jumpViolations: number;
  anchorSpacingMin: number;
  anchorSpacingMax: number;
  anchorSpacingAvg: number;
  /** Опоры дальше жёсткого предела 500 св.л. — нарушение. */
  anchorSpacingViolations: number;
  /** Опоры вне целевого диапазона 480–490 св.л. — допустимо, но учитываем. */
  anchorSpacingOutside: number;
  anchorDeviationMax: number;
  anchorDeviationAvg: number;
  /** Точки маршрута вдоль кольца (без подхода к старту) — максимальное отклонение. */
  routeDeviationMax: number;
  deviationViolations: number;
  /** На сколько старт вне окружности кольца: подход к нему выходит за допуск. */
  startOffset: number;
  withinSpec: boolean;
}

export interface RingResult {
  sessionId: string;
  start: string;
  center: RingPoint;
  ringRadius: number;
  searchRadius: number;
  route: RingPoint[];
  anchors: RingPoint[];
  totals: {
    points: number;
    realPoints: number;
    syntheticPoints: number;
    anchors: number;
    triangulatedAnchors: number;
    discovered: number;
    deviationAvg: number;
    deviationMax: number;
  };
  validation: RingValidation;
  stats: RingStats;
}

const EMPTY_STATS: RingStats = {
  sectors: 0,
  sectorsDone: 0,
  realAnchors: 0,
  triangulatedAnchors: 0,
  systemsFound: 0,
  systemsSaved: 0,
  catalogHits: 0,
  cacheHits: 0,
  edsmRequests: 0,
  spanshRequests: 0,
  reusedFromNeighbours: 0,
  syntheticPoints: 0,
  realPoints: 0,
  bridgeCatalogRequests: 0,
};

export function distance3(a: XYZ, b: XYZ): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/**
 * Число сегментов. Шаг между соседними опорами не больше 490 св.л.: при
 * таком числе сегментов дуга между опорами попадает в диапазон 480–490 для
 * любого кольца, кроме очень маленьких (там опор мало по определению).
 */
export function computeSectorCount(ringRadius: number): number {
  const circumference = 2 * Math.PI * ringRadius;
  // Допустимые числа сегментов: шаг (дуга) не больше 490 — это нижняя граница
  // числа сегментов. Если среди них есть такие, что шаг попадает в 480–490,
  // берём ближайший к 485. Для малых колец такого числа может не быть: тогда
  // остаётся минимум, гарантирующий предел 490 (меньший шаг — не нарушение).
  const low = Math.ceil(circumference / ANCHOR_SPACING_MAX);
  const high = Math.floor(circumference / ANCHOR_SPACING_MIN);
  let count = low;
  if (low <= high) {
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let candidate = low; candidate <= high; candidate++) {
      const distance = Math.abs(circumference / candidate - ANCHOR_SPACING_TARGET);
      if (distance < bestDistance) {
        bestDistance = distance;
        count = candidate;
      }
    }
  }
  return Math.max(MIN_SECTORS, Math.min(MAX_SECTORS, count));
}

/** Точка окружности кольца по углу (базис: направление на старт от центра). */
export function ringPointAtAngle(
  center: XYZ,
  basis: { ux: number; uz: number },
  ringRadius: number,
  angle: number,
): XYZ {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    x: center.x + ringRadius * (basis.ux * cos - basis.uz * sin),
    y: center.y,
    z: center.z + ringRadius * (basis.uz * cos + basis.ux * sin),
  };
}

/** Точка на кольце для сегмента: базис строится от начальной системы к центру. */
export function ringTarget(
  center: XYZ,
  basis: { ux: number; uz: number },
  ringRadius: number,
  sectorIndex: number,
  sectors: number,
): XYZ {
  return ringPointAtAngle(center, basis, ringRadius, (2 * Math.PI * sectorIndex) / sectors);
}

export function ringBasis(start: { x: number; z: number }, center: { x: number; z: number }): { ux: number; uz: number } {
  const vx = start.x - center.x;
  const vz = start.z - center.z;
  const length = Math.hypot(vx, vz) || 1;
  return { ux: vx / length, uz: vz / length };
}

/**
 * Перпендикулярное отклонение точки от окружности кольца: горизонтальное
 * расстояние до центра минус радиус, объединённое с отступом по высоте.
 */
export function ringDeviation(point: XYZ, center: XYZ, ringRadius: number): number {
  const horizontal = Math.hypot(point.x - center.x, point.z - center.z);
  return Math.hypot(horizontal - ringRadius, point.y - center.y);
}

/**
 * Точка окружности, отстоящая от `from` ровно на `distance`, ближайшая к углу
 * `angle`. Нужна расчётной опоре, чтобы шаг от предыдущей опоры остался в норме,
 * даже если предыдущая реальная опора ушла от окружности. null — если такой точки нет.
 */
export function ringPointAtDistance(
  center: XYZ,
  basis: { ux: number; uz: number },
  ringRadius: number,
  from: XYZ,
  angle: number,
  distance: number,
): XYZ | null {
  const dx = from.x - center.x;
  const dz = from.z - center.z;
  const h = from.y - center.y;
  // Проекции на базис окружности: e1 = (ux, uz), e2 = (-uz, ux).
  const a = dx * basis.ux + dz * basis.uz;
  const b = -dx * basis.uz + dz * basis.ux;
  const m = Math.hypot(a, b);
  if (m < 1e-9 || ringRadius <= 0) return null;
  const k = (ringRadius * ringRadius + m * m + h * h - distance * distance) / (2 * ringRadius * m);
  if (k < -1 || k > 1) return null;
  const phi = Math.atan2(b, a);
  const delta = Math.acos(k);
  const normalise = (value: number) => Math.atan2(Math.sin(value), Math.cos(value));
  const first = phi + delta;
  const second = phi - delta;
  const theta = Math.abs(normalise(first - angle)) <= Math.abs(normalise(second - angle)) ? first : second;
  return ringPointAtAngle(center, basis, ringRadius, theta);
}

/** Расстояние от точки до отрезка — коридор маршрута на кольце. */
export function distanceToSegment(point: XYZ, a: XYZ, b: XYZ): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const lengthSquared = dx * dx + dy * dy + dz * dz;
  const t = lengthSquared === 0
    ? 0
    : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy + (point.z - a.z) * dz) / lengthSquared));
  return Math.hypot(point.x - (a.x + dx * t), point.y - (a.y + dy * t), point.z - (a.z + dz * t));
}

/** Не даём одному зависшему вызову держать шаг: по таймауту отдаём запасное значение. */
async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

/** Параллельная обработка с ограничением числа одновременных задач. */
async function mapConcurrent<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return out;
}

/* ─────────────────────────── Внешние источники ─────────────────────────── */

async function jsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

async function fetchWithTimeout(url: string, timeoutMs: number, init: RequestInit = {}): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Координаты одной системы: каталог → кэш Atlas → Spansh → EDSM. */
export async function resolveRingSystem(name: string): Promise<RingPoint | null> {
  const clean = String(name || '').trim().replace(/\s+/g, ' ');
  if (!clean) return null;

  try {
    const row = await withTimeout(findSystemByName(clean), DB_TIMEOUT_MS, null);
    if (row) return { name: row.name, x: row.x, y: row.y, z: row.z, source: 'catalog' };
  } catch (error: any) {
    console.warn('[ring] каталожный поиск системы не удался:', error?.message);
  }

  try {
    const { data } = await supabaseAdmin
      .from('atlas_system_cache')
      .select('system_name,x,y,z,source')
      .eq('name_lc', normalizeSystemName(clean))
      .maybeSingle();
    if (data && Number.isFinite(Number(data.x))) {
      return { name: data.system_name, x: Number(data.x), y: Number(data.y), z: Number(data.z), source: 'cache' };
    }
  } catch {
    // Таблицы может не быть — идём дальше к внешним источникам.
  }

  try {
    const search = await spanshSearch({ q: clean, limit: 1 });
    const record = search?.results?.[0]?.record;
    if (record && Number.isFinite(Number(record.x))) {
      return { name: record.name || clean, x: Number(record.x), y: Number(record.y), z: Number(record.z), source: 'spansh' };
    }
  } catch (error: any) {
    console.warn('[ring] Spansh не подтвердил систему:', error?.message);
  }

  const response = await fetchWithTimeout(
    `https://www.edsm.net/api-v1/system?systemName=${encodeURIComponent(clean)}&showCoordinates=1`,
    EDSM_TIMEOUT_MS,
    { headers: { Accept: 'application/json', 'User-Agent': EDSM_UA } },
  );
  if (response?.ok) {
    const data = await jsonResponse(response) as { coords?: { x: number; y: number; z: number } } | null;
    if (data?.coords && Number.isFinite(Number(data.coords.x))) {
      return { name: clean, x: Number(data.coords.x), y: Number(data.coords.y), z: Number(data.coords.z), source: 'edsm' };
    }
  }

  return null;
}

/** Системы вокруг точки по EDSM (последний сетевой резерв). */
async function edsmSystemsNear(point: XYZ, radius: number): Promise<RingPoint[]> {
  const size = Math.min(Math.max(radius * 2, 40), 200);
  const url = new URL('https://www.edsm.net/api-v1/cube-systems');
  url.searchParams.set('x', String(point.x));
  url.searchParams.set('y', String(point.y));
  url.searchParams.set('z', String(point.z));
  url.searchParams.set('size', String(size));
  url.searchParams.set('showCoordinates', '1');
  const response = await fetchWithTimeout(url.toString(), EDSM_TIMEOUT_MS, {
    headers: { Accept: 'application/json', 'User-Agent': EDSM_UA },
  });
  if (!response?.ok) return [];
  const data = await jsonResponse(response);
  if (!Array.isArray(data)) return [];
  return data.flatMap((row: any): RingPoint[] => {
    const coords = row?.coords;
    if (!row?.name || !coords) return [];
    const x = Number(coords.x);
    const y = Number(coords.y);
    const z = Number(coords.z);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return [];
    return [{ name: String(row.name), x, y, z, source: 'edsm' }];
  });
}

/** Ближайшая известная Spansh система к координатам (точечный запрос /nearest). */
async function spanshNearestSystem(point: XYZ): Promise<RingPoint | null> {
  try {
    const system = await spanshNearestApi(point);
    const x = Number(system?.x);
    const y = Number(system?.y);
    const z = Number(system?.z);
    if (!system?.name || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
    return { name: system.name, x, y, z, source: 'spansh' };
  } catch {
    return null;
  }
}

/* ─────────────────────────── Сессии ─────────────────────────── */

interface SessionRow {
  id: string;
  start_system: string;
  ring_radius: number;
  search_radius: number;
  sectors: number;
  sectors_done: number;
  center: XYZ;
  basis: { ux: number; uz: number };
  anchors: RingAnchor[];
  discovered: number;
  stats: RingStats | null;
  route: unknown;
  status: RingPlan['status'];
}

function rowToPlan(row: SessionRow, start: RingPoint): RingPlan {
  return {
    sessionId: row.id,
    start,
    center: { name: 'Sagittarius A*', x: Number(row.center.x), y: Number(row.center.y), z: Number(row.center.z), source: 'catalog' },
    basis: { ux: Number(row.basis.ux), uz: Number(row.basis.uz) },
    ringRadius: Number(row.ring_radius),
    searchRadius: Number(row.search_radius),
    sectors: Number(row.sectors),
    sectorsDone: Number(row.sectors_done),
    anchors: Array.isArray(row.anchors) ? row.anchors : [],
    stats: { ...EMPTY_STATS, ...(row.stats || {}) },
    status: row.status,
  };
}

export async function loadRingSession(sessionId: string): Promise<RingPlan | null> {
  const { data, error } = await supabaseAdmin
    .from('atlas_ring_sessions')
    .select('*')
    .eq('id', sessionId)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as SessionRow;
  const start = await resolveRingSystem(row.start_system);
  if (!start) return null;
  return rowToPlan(row, { ...start, source: 'start' });
}

/** Создание новой сессии: координаты, базис, число сегментов. */
export async function planRingSession(
  config: { startSystem: string; ringRadius?: number; searchRadius?: number },
  userId?: string | null,
): Promise<RingPlan> {
  const startName = String(config.startSystem || '').trim();
  if (!startName) throw new Error('Не указана начальная система кольца');

  const ringRadius = Math.min(MAX_RING_RADIUS, Math.max(MIN_RING_RADIUS, Number(config.ringRadius) || DEFAULT_RING_RADIUS));
  const searchRadius = Math.min(MAX_SEARCH_RADIUS, Math.max(MIN_SEARCH_RADIUS, Number(config.searchRadius) || DEFAULT_SEARCH_RADIUS));

  const [start, center] = await Promise.all([
    resolveRingSystem(startName),
    resolveRingSystem('Sagittarius A*'),
  ]);
  if (!start) throw new Error(`Не удалось получить координаты системы «${startName}»`);
  if (!center) throw new Error('Не удалось получить координаты Sagittarius A*');

  const basis = ringBasis(start, center);
  const sectors = computeSectorCount(ringRadius);

  const stats: RingStats = { ...EMPTY_STATS, sectors, systemsFound: 0 };
  const { data, error } = await supabaseAdmin
    .from('atlas_ring_sessions')
    .insert({
      created_by: userId || null,
      start_system: start.name,
      ring_radius: ringRadius,
      search_radius: searchRadius,
      sectors,
      sectors_done: 0,
      center: { x: center.x, y: center.y, z: center.z },
      basis,
      anchors: [],
      discovered: 0,
      stats,
      status: 'scanning',
    })
    .select('id')
    .single();
  if (error || !data) {
    throw new Error(`Не удалось создать сессию поиска кольца: ${error?.message || 'нет ответа БД'}`);
  }

  // Кэшируем начальную систему и центр — пригодятся и другим поисковикам.
  await saveCachedSystems([
    { name: start.name, x: start.x, y: start.y, z: start.z, source: start.source || 'edsm' },
    { name: center.name, x: center.x, y: center.y, z: center.z, source: center.source || 'edsm' },
  ]).catch(() => 0);

  return {
    sessionId: String(data.id),
    start: { ...start, source: 'start' },
    center: { ...center, source: 'catalog' },
    basis,
    ringRadius,
    searchRadius,
    sectors,
    sectorsDone: 0,
    anchors: [],
    stats,
    status: 'scanning',
  };
}

/* ─────────────────────────── Обработка шага ─────────────────────────── */

interface PickOptions {
  catalogReady: boolean;
  budget: RingBudget;
  memoryPool: Map<string, RingPoint>;
  /** Время, после которого сетевые источники больше не вызываются. */
  deadline: number;
}

interface SectorResolution {
  systems: RingPoint[];
  catalogHits: number;
  cacheHits: number;
  edsmRequests: number;
  spanshRequests: number;
  reusedFromNeighbours: number;
}

/**
 * Системы вокруг точки сегмента. Порядок: уже найденные в этом шаге → каталог
 * проекта → кэш Atlas → сеть. Сеть трогаем только если каталог не полон и
 * локальные источники пусты: полный каталог уже содержит всё, что знает Spansh.
 */
async function resolveSectorSystems(target: XYZ, radius: number, options: PickOptions): Promise<SectorResolution> {
  const resolution: SectorResolution = {
    systems: [],
    catalogHits: 0,
    cacheHits: 0,
    edsmRequests: 0,
    spanshRequests: 0,
    reusedFromNeighbours: 0,
  };
  const byName = new Map<string, RingPoint>();

  const push = (system: RingPoint) => {
    if (!system.name) return;
    const key = system.name.toLowerCase();
    if (!byName.has(key)) byName.set(key, system);
  };

  // 1. Системы, уже найденные в соседних сегментах этого же шага.
  for (const system of options.memoryPool.values()) {
    if (distance3(system, target) <= radius) {
      push(system);
      resolution.reusedFromNeighbours++;
    }
  }

  // 2. Каталог Spansh в БД проекта — самый полный и быстрый источник.
  if (options.catalogReady && Date.now() < options.deadline) {
    const rows = await withTimeout(
      findSystemsInCube({ x: target.x, y: target.y, z: target.z, half: radius, limit: SECTOR_CACHE_LIMIT })
        .catch((error: any) => {
          console.warn('[ring] каталог недоступен для сегмента:', error?.message);
          return [] as Array<{ name: string; x: number; y: number; z: number }>;
        }),
      DB_TIMEOUT_MS,
      [] as Array<{ name: string; x: number; y: number; z: number }>,
    );
    for (const row of rows) {
      if (distance3(row, target) <= radius) {
        push({ name: row.name, x: row.x, y: row.y, z: row.z, source: 'catalog' });
        resolution.catalogHits++;
      }
    }
  }

  // 3. Кэш Atlas (ближайшие через индекс куба) — если каталог ничего не дал.
  if (byName.size === 0 && Date.now() < options.deadline) {
    const cached = await withTimeout(
      listCachedSystemsNear(target, radius, SECTOR_CACHE_LIMIT).catch(() => [] as CachedSystem[]),
      DB_TIMEOUT_MS,
      [] as CachedSystem[],
    );
    for (const row of cached) {
      push({ name: row.name, x: row.x, y: row.y, z: row.z, source: 'cache' });
      resolution.cacheHits++;
    }
  }

  const networkAllowed = !options.catalogReady && byName.size === 0 && Date.now() < options.deadline;

  // 4. EDSM — только без полного каталога и при пустых локальных источниках.
  if (networkAllowed && options.budget.edsm > 0) {
    options.budget.edsm--;
    const systems = await edsmSystemsNear(target, radius);
    resolution.edsmRequests++;
    for (const system of systems) {
      if (distance3(system, target) <= radius) push(system);
    }
  }

  // 5. Spansh API — последний сетевой резерв, в пределах дедлайна шага.
  if (networkAllowed && byName.size === 0 && options.budget.spansh > 0 && Date.now() < options.deadline) {
    const reference = options.memoryPool.values().next().value || null;
    if (reference) {
      options.budget.spansh--;
      const near = await withTimeout(
        spanshSystemsNear({
          referenceSystem: reference.name,
          maxDistance: radius,
          size: Math.min(100, SECTOR_CACHE_LIMIT),
          timeoutMs: SPANSH_TIMEOUT_MS,
        }).catch(() => [] as Awaited<ReturnType<typeof spanshSystemsNear>>),
        SPANSH_TIMEOUT_MS + 1000,
        [] as Awaited<ReturnType<typeof spanshSystemsNear>>,
      );
      resolution.spanshRequests++;
      for (const system of near) {
        if (distance3(system, target) <= radius) push({ ...system, source: 'spansh' });
      }
    }
  }
  if (networkAllowed && byName.size === 0 && options.budget.spansh > 0 && Date.now() < options.deadline) {
    options.budget.spansh--;
    const nearest = await withTimeout(spanshNearestSystem(target), SPANSH_TIMEOUT_MS + 1000, null);
    resolution.spanshRequests++;
    if (nearest && distance3(nearest, target) <= radius) push(nearest);
  }

  resolution.systems = Array.from(byName.values());
  return resolution;
}

/** Геометрия сегмента, нужная для выбора опоры. */
interface AnchorGeometry {
  target: XYZ;
  /** Угол сегмента на окружности (нужен расчётной опоре). */
  angle: number;
  center: XYZ;
  basis: { ux: number; uz: number };
  ringRadius: number;
  searchRadius: number;
  /** Предыдущая опора кольца (не старт): от неё считается шаг 480–490. */
  previous: XYZ | null;
  usedNames: Set<string>;
}

export interface AnchorCandidate {
  system: RingPoint;
  deviation: number;
  spacing: number | null;
  /** 0 — лучший вариант (отклонение ≤ 50 и шаг 480–490); выше — хуже. */
  tier: number;
  score: number;
}

/**
 * Выбор опоры среди реальных систем сегмента. Жёсткие отсечки: отклонение от
 * окружности не больше 100 и шаг от предыдущей опоры не больше 500. Внутри
 * допустимых — приоритет: отклонение ≤ 50 и шаг 480–490, затем близость к цели.
 */
export function chooseAnchor(input: {
  target: XYZ;
  center: XYZ;
  ringRadius: number;
  previous: XYZ | null;
  candidates: RingPoint[];
  used: Set<string>;
}): AnchorCandidate | null {
  let best: AnchorCandidate | null = null;
  for (const system of input.candidates) {
    const key = system.name.toLowerCase();
    if (input.used.has(key)) continue;
    const deviation = ringDeviation(system, input.center, input.ringRadius);
    if (deviation > ANCHOR_DEVIATION_LIMIT) continue;
    const spacing = input.previous ? distance3(system, input.previous) : null;
    if (spacing !== null && (spacing > ANCHOR_SPACING_LIMIT || spacing < 1)) continue;
    const spacingOk = spacing === null || (spacing >= ANCHOR_SPACING_MIN && spacing <= ANCHOR_SPACING_MAX);
    const tier = (deviation > ANCHOR_DEVIATION_PREFERRED ? 1 : 0) + (spacingOk ? 0 : 2);
    // Внутри класса — шаг ближе к 485 св.л., затем близость к цели сегмента.
    const spacingPenalty = spacing === null ? 0 : Math.abs(spacing - ANCHOR_SPACING_TARGET) * 1000;
    const score = tier * 1e7 + spacingPenalty + distance3(system, input.target);
    if (!best || score < best.score) best = { system, deviation, spacing, tier, score };
  }
  return best;
}

/** Расчётная опора: точка на окружности; если шаг от предыдущей опоры вне 480–490 — корректируем. */
function triangulatedAnchorPosition(geometry: AnchorGeometry): XYZ {
  const { target, previous } = geometry;
  if (previous) {
    const spacing = distance3(previous, target);
    if (spacing < ANCHOR_SPACING_MIN || spacing > ANCHOR_SPACING_MAX) {
      const onCircle = ringPointAtDistance(
        geometry.center,
        geometry.basis,
        geometry.ringRadius,
        previous,
        geometry.angle,
        ANCHOR_SPACING_TARGET,
      );
      if (onCircle) return onCircle;
    }
  }
  return { x: target.x, y: target.y, z: target.z };
}

interface PickedAnchor {
  anchor: RingAnchor;
  systems: RingPoint[];
  catalogHits: number;
  cacheHits: number;
  reused: number;
}

/**
 * Выбор опорной точки сегмента. Окно поиска расширяется (×2, ×4), но только
 * пока не найдена опора лучшего класса; при неудаче — расчётная опора.
 */
async function pickAnchor(geometry: AnchorGeometry, options: PickOptions): Promise<PickedAnchor> {
  const base = geometry.searchRadius;
  const radii = [...new Set([base, Math.max(base, Math.min(base * 2, 1200)), Math.max(base, Math.min(base * 4, 2400))])];

  let catalogHits = 0;
  let cacheHits = 0;
  let reused = 0;
  let lastFound = 0;
  let usedRadius = base;
  let best: { choice: AnchorCandidate; found: number; radius: number } | null = null;
  const collected = new Map<string, RingPoint>();

  for (const currentRadius of radii) {
    const resolution = await resolveSectorSystems(geometry.target, currentRadius, options);
    catalogHits += resolution.catalogHits;
    cacheHits += resolution.cacheHits;
    reused += resolution.reusedFromNeighbours;
    lastFound = resolution.systems.length;
    for (const system of resolution.systems) {
      collected.set(system.name.toLowerCase(), system);
      options.memoryPool.set(system.name.toLowerCase(), system);
    }

    const choice = chooseAnchor({
      target: geometry.target,
      center: geometry.center,
      ringRadius: geometry.ringRadius,
      previous: geometry.previous,
      candidates: resolution.systems,
      used: geometry.usedNames,
    });
    if (choice && (!best || choice.score < best.choice.score)) {
      best = { choice, found: resolution.systems.length, radius: currentRadius };
    }
    if (best && best.choice.tier === 0) break;
    if (Date.now() > options.deadline) break;
  }

  const systems = Array.from(collected.values());
  if (best) {
    const { system, deviation } = best.choice;
    geometry.usedNames.add(system.name.toLowerCase());
    usedRadius = best.radius;
    return {
      anchor: {
        name: system.name,
        x: system.x,
        y: system.y,
        z: system.z,
        source: system.source,
        isAnchor: true,
        deviation,
        target: geometry.target,
        found: best.found,
        usedRadius,
      },
      systems,
      catalogHits,
      cacheHits,
      reused,
    };
  }

  const position = triangulatedAnchorPosition(geometry);
  return {
    anchor: {
      name: `RING TRIANGULATED ${Math.round(position.x)}:${Math.round(position.z)}`,
      x: position.x,
      y: position.y,
      z: position.z,
      source: 'triangulated',
      isAnchor: true,
      deviation: ringDeviation(position, geometry.center, geometry.ringRadius),
      target: geometry.target,
      found: lastFound,
      usedRadius,
    },
    systems,
    catalogHits,
    cacheHits,
    reused,
  };
}

/** Обработка следующей пачки сегментов. */
export async function stepRingSession(
  sessionId: string,
  maxSectors: number = DEFAULT_STEP_SECTORS,
): Promise<RingStepResult> {
  const session = await loadRingSession(sessionId);
  if (!session) throw new Error('Сессия поиска кольца не найдена');

  const limit = Math.max(1, Math.min(MAX_STEP_SECTORS, Number(maxSectors) || DEFAULT_STEP_SECTORS));
  const from = session.sectorsDone;
  const to = Math.min(session.sectors, from + limit);
  const anchors = [...session.anchors];
  const stats: RingStats = { ...session.stats, sectors: session.sectors };
  const usedNames = new Set(
    anchors.filter((anchor) => anchor.source !== 'triangulated').map((anchor) => anchor.name.toLowerCase()),
  );
  const memoryPool = new Map<string, RingPoint>();
  const foundSample: RingPoint[] = [];
  const newAnchors: RingAnchor[] = [];
  let beam: XYZ | null = null;

  const catalogReady = await isCatalogReady();
  const budget: RingBudget = { edsm: EDSM_BUDGET_PER_STEP, spansh: SPANSH_BUDGET_PER_STEP };
  const startedAt = Date.now();
  const deadline = startedAt + STEP_TIME_BUDGET_MS;
  let processedTo = from;

  for (let sector = from; sector < to; sector++) {
    // Шаг не должен превращаться в минуты ожидания: при выходе из бюджета времени
    // возвращаем то, что успели; клиент запросит следующий шаг.
    if (processedTo > from && Date.now() > deadline) break;
    const target = ringTarget(session.center, session.basis, session.ringRadius, sector, session.sectors);
    beam = target;
    const previousAnchor = anchors.length > 0 ? anchors[anchors.length - 1] : null;
    const picked = await pickAnchor(
      {
        target,
        angle: (2 * Math.PI * sector) / session.sectors,
        center: session.center,
        basis: session.basis,
        ringRadius: session.ringRadius,
        searchRadius: session.searchRadius,
        previous: previousAnchor ? { x: previousAnchor.x, y: previousAnchor.y, z: previousAnchor.z } : null,
        usedNames,
      },
      { catalogReady, budget, memoryPool, deadline },
    );
    stats.catalogHits += picked.catalogHits;
    stats.cacheHits += picked.cacheHits;
    stats.reusedFromNeighbours += picked.reused;
    for (const system of picked.systems) {
      if (foundSample.length < STEP_FOUND_SAMPLE) foundSample.push(system);
    }
    anchors.push(picked.anchor);
    newAnchors.push(picked.anchor);
    if (picked.anchor.source === 'triangulated') stats.triangulatedAnchors++;
    else stats.realAnchors++;
    processedTo = sector + 1;
  }

  const reached = Math.max(from, processedTo);
  stats.sectorsDone = reached;
  stats.edsmRequests += EDSM_BUDGET_PER_STEP - budget.edsm;
  stats.spanshRequests += SPANSH_BUDGET_PER_STEP - budget.spansh;
  stats.systemsFound += memoryPool.size;

  // В кэш сохраняем только то, что пришло из сети: каталог и кэш уже содержат
  // свои системы, а повторная запись тысяч строк за шаг не нужна.
  const toSave = Array.from(memoryPool.values()).filter((point) => point.source === 'edsm' || point.source === 'spansh');
  const saved = await withTimeout(
    saveCachedSystems(toSave.map((point) => ({
      name: point.name,
      x: point.x,
      y: point.y,
      z: point.z,
      source: point.source || 'cache',
    }))).catch(() => 0),
    DB_TIMEOUT_MS,
    0,
  );
  stats.systemsSaved += saved;

  const done = reached >= session.sectors;
  const { error } = await supabaseAdmin
    .from('atlas_ring_sessions')
    .update({
      anchors,
      sectors_done: reached,
      discovered: session.anchors.length === 0 ? memoryPool.size : stats.systemsFound,
      stats,
      status: done ? 'ready' : 'scanning',
      updated_at: new Date().toISOString(),
    })
    .eq('id', sessionId);
  if (error) throw new Error(`Не удалось сохранить прогресс сегментов: ${error.message}`);

  return {
    sessionId,
    sectorsDone: reached,
    sectors: session.sectors,
    done,
    processed: reached - from,
    anchors: newAnchors,
    found: foundSample,
    beam,
    stats,
  };
}

let catalogReadyCache: { at: number; value: boolean } | null = null;

async function isCatalogReady(): Promise<boolean> {
  if (catalogReadyCache && Date.now() - catalogReadyCache.at < 5 * 60_000) return catalogReadyCache.value;
  let value = false;
  try {
    const stats = await withTimeout(getGalaxyStats(), DB_TIMEOUT_MS, null);
    value = catalogIsComplete(stats);
  } catch {
    value = false;
  }
  catalogReadyCache = { at: Date.now(), value };
  return value;
}

/** Сброс кэша признака «каталог полон» (после импорта дампа). */
export function invalidateRingCatalogCache(): void {
  catalogReadyCache = null;
}

/* ─────────────────────────── Сборка маршрута ─────────────────────────── */

interface BridgeContext {
  maxJump: number;
  /** Допуск отклонения от прямой между опорами (св.л.). */
  corridor: number;
  /** Шаг расчётной точки (≤ maxJump). */
  syntheticStep: number;
  /** Сквозная нумерация расчётных точек: имена должны быть уникальны. */
  syntheticCounter: { next: () => number };
}

/**
 * Цепочка реальных систем от `from` до `to`. Жадный проход: на каждом шаге
 * берём достижимую систему, которая сильнее всего приближает к цели и не
 * выходит из коридора маршрута. Расчётная точка — только если такой нет.
 */
function bridgeSegment(
  from: RingPoint,
  to: RingPoint,
  pool: RingPoint[],
  used: Set<string>,
  context: BridgeContext,
): RingPoint[] {
  const points: RingPoint[] = [];
  let current: RingPoint = from;
  let guard = 0;

  while (distance3(current, to) > context.maxJump && guard++ < 4000) {
    const remaining = distance3(current, to);
    let best: RingPoint | null = null;
    let bestRemaining = remaining;
    let bestLateral = Number.POSITIVE_INFINITY;

    for (const candidate of pool) {
      const key = candidate.name.toLowerCase();
      if (used.has(key)) continue;
      const step = distance3(current, candidate);
      if (step > context.maxJump || step < 0.001) continue;
      const toGoal = distance3(candidate, to);
      if (toGoal >= remaining - 0.5) continue;
      const lateral = distanceToSegment(candidate, from, to);
      if (lateral > context.corridor) continue;
      if (toGoal < bestRemaining - 0.5 || (toGoal <= bestRemaining + 0.5 && lateral < bestLateral)) {
        best = candidate;
        bestRemaining = toGoal;
        bestLateral = lateral;
      }
    }

    if (best) {
      used.add(best.name.toLowerCase());
      points.push({ name: best.name, x: best.x, y: best.y, z: best.z, source: best.source || 'cache' });
      current = best;
      continue;
    }

    // Расчётная точка. Остаток между `syntheticStep` и `2·syntheticStep` делим
    // пополам, чтобы последний прыжок не получился крошечным.
    const hop = remaining > 2 * context.syntheticStep ? context.syntheticStep : remaining / 2;
    const ratio = hop / remaining;
    const synthetic: RingPoint = {
      name: `RING TRIANGULATED ${context.syntheticCounter.next()}`,
      x: current.x + (to.x - current.x) * ratio,
      y: current.y + (to.y - current.y) * ratio,
      z: current.z + (to.z - current.z) * ratio,
      source: 'triangulated',
    };
    points.push(synthetic);
    current = synthetic;
  }

  return points;
}

/**
 * Прокладка между двумя опорными точками с опорой на существующие системы.
 *
 * Экспортируется ради тестов: именно здесь решается, останется ли на кольце
 * расчётная точка. При наличии систем в коридоре функция обязана провести
 * цепочку по ним и не выдумывать координаты.
 */
export function bridgeWithSystems(
  from: RingPoint,
  to: RingPoint,
  pool: RingPoint[],
  options: { maxJump?: number; corridor?: number; syntheticStep?: number } = {},
): RingPoint[] {
  let counter = 0;
  const maxJump = options.maxJump ?? MAX_JUMP;
  return bridgeSegment(from, to, pool, new Set([from.name.toLowerCase()]), {
    maxJump,
    corridor: options.corridor ?? ROUTE_CORRIDOR,
    syntheticStep: options.syntheticStep ?? Math.min(maxJump, SYNTHETIC_STEP),
    syntheticCounter: { next: () => ++counter },
  });
}

/**
 * Пул систем для одного сегмента: каталог (ближайшие к середине отрезка) и
 * кэш. Пул ограничен коридором и допуском отклонения, поэтому его размер не
 * зависит от радиуса поиска.
 */
async function collectSegmentPool(
  from: XYZ,
  to: XYZ,
  options: { catalogReady: boolean; deadline: number; center: XYZ; ringRadius: number; approach: boolean },
): Promise<RingPoint[]> {
  const length = distance3(from, to);
  const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2, z: (from.z + to.z) / 2 };
  const half = length / 2 + ROUTE_CORRIDOR + 1;
  const byName = new Map<string, RingPoint>();

  if (options.catalogReady && Date.now() < options.deadline) {
    const rows = await withTimeout(
      findSystemsInCube({ ...mid, half, limit: SEGMENT_POOL_LIMIT }).catch(() => [] as Array<{ name: string; x: number; y: number; z: number }>),
      DB_TIMEOUT_MS,
      [] as Array<{ name: string; x: number; y: number; z: number }>,
    );
    for (const row of rows) byName.set(row.name.toLowerCase(), { name: row.name, x: row.x, y: row.y, z: row.z, source: 'catalog' });
  }

  const cached = await withTimeout(
    listCachedSystemsNear(mid, half, SEGMENT_POOL_LIMIT).catch(() => [] as CachedSystem[]),
    DB_TIMEOUT_MS,
    [] as CachedSystem[],
  );
  for (const row of cached) {
    const key = row.name.toLowerCase();
    if (!byName.has(key)) byName.set(key, { name: row.name, x: row.x, y: row.y, z: row.z, source: 'cache' });
  }

  // Участок подхода от старта лежит вне окружности (старт может быть сдвинут),
  // поэтому там отклонение от кольца не ограничиваем — только коридор отрезка.
  return Array.from(byName.values()).filter((point) =>
    distanceToSegment(point, from, to) <= ROUTE_CORRIDOR
    && (options.approach || ringDeviation(point, options.center, options.ringRadius) <= ANCHOR_DEVIATION_LIMIT));
}

/**
 * Проверка итогового маршрута по трём требованиям кольца. `approach` помечает
 * точки подхода от старта и возврата к нему: старт не обязан лежать на
 * окружности, поэтому эти участки не проверяются на отклонение, но
 * прыжки проверяются везде.
 */
export function validateRingRoute(input: {
  route: RingPoint[];
  approach: boolean[];
  center: XYZ;
  ringRadius: number;
  start: XYZ;
}): RingValidation {
  const { route, approach, center, ringRadius, start } = input;

  let maxJump = 0;
  let jumpViolations = 0;
  for (let index = 1; index < route.length; index++) {
    const jump = distance3(route[index - 1], route[index]);
    maxJump = Math.max(maxJump, jump);
    if (jump > MAX_JUMP + 1e-6) jumpViolations++;
  }

  const anchors = route.filter((point) => point.isAnchor);
  const spacings: number[] = [];
  for (let index = 1; index < anchors.length; index++) {
    spacings.push(distance3(anchors[index - 1], anchors[index]));
  }
  const spacingMin = spacings.length ? Math.min(...spacings) : 0;
  const spacingMax = spacings.length ? Math.max(...spacings) : 0;
  const spacingAvg = spacings.length ? spacings.reduce((sum, value) => sum + value, 0) / spacings.length : 0;
  const spacingViolations = spacings.filter((value) => value > ANCHOR_SPACING_LIMIT + 1e-6).length;
  const spacingOutside = spacings.filter((value) => value < ANCHOR_SPACING_MIN || value > ANCHOR_SPACING_MAX).length;

  const anchorDeviations = anchors.map((anchor) => ringDeviation(anchor, center, ringRadius));
  const anchorDeviationMax = anchorDeviations.length ? Math.max(...anchorDeviations) : 0;
  const anchorDeviationAvg = anchorDeviations.length
    ? anchorDeviations.reduce((sum, value) => sum + value, 0) / anchorDeviations.length
    : 0;

  let routeDeviationMax = 0;
  let deviationViolations = 0;
  route.forEach((point, index) => {
    if (approach[index]) return;
    const deviation = ringDeviation(point, center, ringRadius);
    routeDeviationMax = Math.max(routeDeviationMax, deviation);
    if (deviation > ANCHOR_DEVIATION_LIMIT + 1e-6) deviationViolations++;
  });

  const startOffset = ringDeviation(start, center, ringRadius);
  const withinSpec = jumpViolations === 0
    && spacingViolations === 0
    && anchorDeviationMax <= ANCHOR_DEVIATION_LIMIT + 1e-6
    && deviationViolations === 0;

  const round1 = (value: number) => Math.round(value * 10) / 10;
  return {
    maxJump: Math.round(maxJump * 1000) / 1000,
    jumpViolations,
    anchorSpacingMin: round1(spacingMin),
    anchorSpacingMax: round1(spacingMax),
    anchorSpacingAvg: round1(spacingAvg),
    anchorSpacingViolations: spacingViolations,
    anchorSpacingOutside: spacingOutside,
    anchorDeviationMax: round1(anchorDeviationMax),
    anchorDeviationAvg: round1(anchorDeviationAvg),
    routeDeviationMax: round1(routeDeviationMax),
    deviationViolations,
    startOffset: round1(startOffset),
    withinSpec,
  };
}

/** Сессия, у которой пройдены все сегменты, превращается в замкнутый маршрут. */
export async function finalizeRingSession(sessionId: string): Promise<RingResult> {
  const session = await loadRingSession(sessionId);
  if (!session) throw new Error('Сессия поиска кольца не найдена');
  if (session.sectorsDone < session.sectors) {
    throw new Error(`Кольцо просканировано не полностью: ${session.sectorsDone} из ${session.sectors} сегментов`);
  }

  const stats: RingStats = { ...session.stats };
  const catalogReady = await isCatalogReady();
  const deadline = Date.now() + FINALIZE_TIME_BUDGET_MS;

  const anchors: RingPoint[] = session.anchors.map((anchor) => ({
    name: anchor.name,
    x: anchor.x,
    y: anchor.y,
    z: anchor.z,
    source: anchor.source,
    isAnchor: true,
  }));
  const start: RingPoint = { ...session.start, source: 'start' };

  // Замкнутое кольцо: начальная система — первая и последняя точка.
  const sequence: RingPoint[] = [start, ...anchors, start];

  // Опоры и сам старт в мост не встраиваем: старт уже стоит в начале и в конце.
  const used = new Set<string>([start.name.toLowerCase()]);
  for (const anchor of anchors) {
    if (anchor.source !== 'triangulated') used.add(anchor.name.toLowerCase());
  }

  // Пулы считаем заранее и параллельно: сборка моста последовательна (общий `used`).
  const lastSegment = sequence.length - 2;
  const segments: number[] = [];
  for (let index = 0; index < sequence.length - 1; index++) {
    if (distance3(sequence[index], sequence[index + 1]) > MAX_JUMP) segments.push(index);
  }
  const pools = await mapConcurrent(segments, FINALIZE_CONCURRENCY, (index) => collectSegmentPool(
    sequence[index],
    sequence[index + 1],
    {
      catalogReady,
      deadline,
      center: session.center,
      ringRadius: session.ringRadius,
      approach: index === 0 || index === lastSegment,
    },
  ));
  const poolBySegment = new Map<number, RingPoint[]>();
  segments.forEach((index, position) => poolBySegment.set(index, pools[position]));

  let syntheticCounter = 0;
  const context: BridgeContext = {
    maxJump: MAX_JUMP,
    corridor: ROUTE_CORRIDOR,
    syntheticStep: SYNTHETIC_STEP,
    syntheticCounter: { next: () => ++syntheticCounter },
  };

  const route: RingPoint[] = [sequence[0]];
  const approach: boolean[] = [true];
  for (let index = 0; index < sequence.length - 1; index++) {
    const from = sequence[index];
    const to = sequence[index + 1];
    const touchesStart = index === 0 || index === lastSegment;
    if (distance3(from, to) <= MAX_JUMP) {
      route.push(to);
      approach.push(touchesStart);
      continue;
    }
    const bridge = bridgeSegment(from, to, poolBySegment.get(index) || [], used, context);
    for (const point of bridge) {
      route.push(point);
      approach.push(touchesStart);
    }
    route.push(to);
    approach.push(touchesStart);
  }

  // Убираем только идущие подряд совпадающие точки: они не меняют прыжков.
  const deduped: RingPoint[] = [];
  const dedupedApproach: boolean[] = [];
  route.forEach((point, index) => {
    const previous = deduped[deduped.length - 1];
    if (previous && distance3(previous, point) < 1e-9 && previous.name === point.name) return;
    deduped.push(point);
    dedupedApproach.push(approach[index]);
  });

  const syntheticPoints = deduped.filter((point) => point.source === 'triangulated').length;
  stats.syntheticPoints = syntheticPoints;
  stats.realPoints = deduped.length - syntheticPoints;
  stats.bridgeCatalogRequests = segments.length;

  const validation = validateRingRoute({
    route: deduped,
    approach: dedupedApproach,
    center: session.center,
    ringRadius: session.ringRadius,
    start,
  });

  const deviations = anchors.map((anchor) => ringDeviation(anchor, session.center, session.ringRadius));
  const deviationAvg = deviations.length > 0 ? deviations.reduce((sum, value) => sum + value, 0) / deviations.length : 0;
  const deviationMax = deviations.length > 0 ? Math.max(...deviations) : 0;

  const result: RingResult = {
    sessionId,
    start: session.start.name,
    center: session.center,
    ringRadius: session.ringRadius,
    searchRadius: session.searchRadius,
    route: deduped,
    anchors,
    totals: {
      points: deduped.length,
      realPoints: stats.realPoints,
      syntheticPoints,
      anchors: anchors.length,
      triangulatedAnchors: anchors.filter((anchor) => anchor.source === 'triangulated').length,
      discovered: stats.systemsFound,
      deviationAvg: Math.round(deviationAvg * 10) / 10,
      deviationMax: Math.round(deviationMax * 10) / 10,
    },
    validation,
    stats,
  };

  const { error } = await supabaseAdmin
    .from('atlas_ring_sessions')
    .update({
      route: result.route,
      stats,
      status: 'completed',
      updated_at: new Date().toISOString(),
    })
    .eq('id', sessionId);
  if (error) console.warn('[ring] не удалось сохранить маршрут кольца:', error.message);

  return result;
}

/** Сколько сегментов осталось пройти у сессии. */
export function remainingSectors(plan: RingPlan): number {
  return Math.max(0, plan.sectors - plan.sectorsDone);
}

export async function findRingSessionByStart(startSystem: string) {
  const { data } = await supabaseAdmin
    .from('atlas_ring_sessions')
    .select('id,start_system,ring_radius,search_radius,sectors,sectors_done,status,created_at')
    .ilike('start_system', startSystem)
    .neq('status', 'failed')
    .order('created_at', { ascending: false })
    .limit(5);
  return data || [];
}

/** Пригодится в тестах: проверка, что сессия действительно замкнута. */
export function routeIsClosed(route: RingPoint[]): boolean {
  if (route.length < 2) return false;
  const first = route[0];
  const last = route[route.length - 1];
  return distance3(first, last) < 0.001;
}

/** Бюджет внешних запросов, общий на шаг поиска. */
export interface RingBudget {
  edsm: number;
  spansh: number;
}
