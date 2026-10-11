/**
 * Построение Галактического кольца колонизации — пошагово и с опорой на
 * существующие системы.
 *
 * Что было не так раньше:
 *   • поиск шёл одним длинным запросом и обращался к EDSM в каждом из 360
 *     сегментов; к 3–4-му сегменту соединение с браузером рвалось, и
 *     пользователь видел «network error» без результата;
 *   • приоритет отдавался сети, а не локальному каталогу Spansh, который уже
 *     лежит в БД проекта;
 *   • разрывы закрывались расчётными точками (триангуляцией) даже когда рядом
 *     были реальные системы.
 *
 * Как устроено теперь:
 *   1. Сессия строится шагами (`step`): один HTTP-запрос обрабатывает пачку
 *      сегментов и сразу отдаёт прогресс. Обрыв связи больше не теряет работу —
 *      прогресс лежит в `atlas_ring_sessions` и поиск продолжается с того же
 *      места (в том числе после перезагрузки страницы).
 *   2. Источники по приоритету: каталог Spansh в БД (`galaxy_systems`) →
 *      кэш систем Atlas (`atlas_system_cache`) → EDSM → Spansh API. Внешние
 *      запросы идут только туда, где локальных данных нет, и ограничены
 *      бюджетом на сессию.
 *   3. Опорной точкой сегмента становится ближайшая реальная система; если в
 *      радиусе никого нет, радиус расширяется, и только потом ставится
 *      расчётная точка.
 *   4. Промежутки между опорными точками закрываются цепочкой реальных систем
 *      (жадный проход по каталогу и кэшу в коридоре маршрута). Триангуляция —
 *      последнее средство, когда систем в коридоре нет физически.
 *   5. Всё найденное сохраняется в БД проекта, поэтому повторный поиск в том же
 *      районе идёт без внешних API.
 */

// Явные расширения нужны для `node --test`.
import { supabaseAdmin } from './supabaseAdmin.ts';
import { catalogIsComplete, findSystemByName, findSystemsInCube, getGalaxyStats } from './galaxySystemsDb.ts';
import { boxAround, listCachedSystemsInBox, listCachedSystemsNear, saveCachedSystems, type CachedSystem } from './atlasSystemCache.ts';
import { spanshNearest as spanshNearestApi, spanshSearch, spanshSystemsNear } from './spanshClient.ts';
import { normalizeSystemName } from './galaxySystems.ts';

export const MIN_RING_RADIUS = 100;
export const MAX_RING_RADIUS = 45_000;
export const MAX_SEARCH_RADIUS = 3_000;
export const MAX_JUMP = 14.99;

/** Границы сегментов кольца: слишком мало — рваная форма, слишком много — долго. */
const MIN_SECTORS = 24;
const MAX_SECTORS = 720;

/** Сколько сегментов обрабатывает один шаг (запрос). */
export const DEFAULT_STEP_SECTORS = 24;
const MAX_STEP_SECTORS = 60;

/** Бюджет времени одного шага: шаг обязан уложиться в ответ HTTP. */
const STEP_TIME_BUDGET_MS = 25_000;

/** Бюджеты внешних запросов на один шаг/сессию. */
const EDSM_BUDGET_PER_STEP = 16;
const EDSM_TIMEOUT_MS = 6000;
const EDSM_CONCURRENCY = 4;
const SPANSH_BUDGET_PER_STEP = 4;
const SPANSH_TIMEOUT_MS = 5000;

/** Максимум систем, которые тянем из кэша вокруг одной опорной точки. */
const SECTOR_CACHE_LIMIT = 600;
/** Сколько точек сегмента отдаём клиенту для отрисовки на карте. */
const STEP_FOUND_SAMPLE = 400;
/** Предел строк, которые вычитываем из кэша при сборке маршрута. */
const FINALIZE_POOL_LIMIT = 40_000;
/** Бюджет дополнительных запросов к каталогу на сборке маршрута. */
const FINALIZE_CATALOG_BUDGET = 90;

const EDSM_UA = 'ED-Ring-Colony/1.0 (galactic-ring-route)';

export type RingSource = 'catalog' | 'cache' | 'edsm' | 'spansh' | 'triangulated' | 'start';

export interface RingPoint {
  name: string;
  x: number;
  y: number;
  z: number;
  source?: RingSource;
}

export interface RingAnchor extends RingPoint {
  /** Насколько опорная точка удалена от идеальной точки кольца. */
  deviation: number;
  target: { x: number; y: number; z: number };
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
  beam: { x: number; y: number; z: number } | null;
  stats: RingStats;
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

export function distance3(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/**
 * Число сегментов: шаг между соседними опорными точками примерно равен радиусу
 * поиска, поэтому окна перекрываются и одна система может закрыть два сегмента.
 */
export function computeSectorCount(ringRadius: number, searchRadius: number): number {
  const circumference = 2 * Math.PI * ringRadius;
  const spacing = Math.max(30, searchRadius);
  const raw = Math.ceil(circumference / spacing);
  return Math.max(MIN_SECTORS, Math.min(MAX_SECTORS, raw));
}

/** Точка на кольце для сегмента: базис строится от начальной системы к центру. */
export function ringTarget(
  center: { x: number; y: number; z: number },
  basis: { ux: number; uz: number },
  ringRadius: number,
  sectorIndex: number,
  sectors: number,
): { x: number; y: number; z: number } {
  const angle = (2 * Math.PI * sectorIndex) / sectors;
  return {
    x: center.x + ringRadius * (basis.ux * Math.cos(angle) - basis.uz * Math.sin(angle)),
    y: center.y,
    z: center.z + ringRadius * (basis.uz * Math.cos(angle) + basis.ux * Math.sin(angle)),
  };
}

export function ringBasis(start: { x: number; z: number }, center: { x: number; z: number }): { ux: number; uz: number } {
  const vx = start.x - center.x;
  const vz = start.z - center.z;
  const length = Math.hypot(vx, vz) || 1;
  return { ux: vx / length, uz: vz / length };
}

/** Расстояние от точки до отрезка — коридор маршрута на кольце. */
export function distanceToSegment(
  point: { x: number; y: number; z: number },
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const lengthSquared = dx * dx + dy * dy + dz * dz;
  const t = lengthSquared === 0
    ? 0
    : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy + (point.z - a.z) * dz) / lengthSquared));
  return Math.hypot(point.x - (a.x + dx * t), point.y - (a.y + dy * t), point.z - (a.z + dz * t));
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

/** Координаты одной системы: каталог → кэш Atlas → EDSM → Spansh. */
export async function resolveRingSystem(name: string): Promise<RingPoint | null> {
  const clean = String(name || '').trim().replace(/\s+/g, ' ');
  if (!clean) return null;

  try {
    const row = await findSystemByName(clean);
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
async function edsmSystemsNear(point: { x: number; y: number; z: number }, radius: number): Promise<RingPoint[]> {
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

/**
 * Ближайшая известная Spansh система к координатам (точечный запрос /nearest).
 * Транспорт и таймаут — в общем клиенте Spansh.
 */
async function spanshNearestSystem(point: { x: number; y: number; z: number }): Promise<RingPoint | null> {
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
  center: { x: number; y: number; z: number };
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

  const ringRadius = Math.min(MAX_RING_RADIUS, Math.max(MIN_RING_RADIUS, Number(config.ringRadius) || 23_000));
  const searchRadius = Math.min(MAX_SEARCH_RADIUS, Math.max(50, Number(config.searchRadius) || 500));

  const [start, center] = await Promise.all([
    resolveRingSystem(startName),
    resolveRingSystem('Sagittarius A*'),
  ]);
  if (!start) throw new Error(`Не удалось получить координаты системы «${startName}»`);
  if (!center) throw new Error('Не удалось получить координаты Sagittarius A*');

  const basis = ringBasis(start, center);
  const sectors = computeSectorCount(ringRadius, searchRadius);

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

interface SectorResolution {
  systems: RingPoint[];
  catalogHits: number;
  cacheHits: number;
  edsmRequests: number;
  spanshRequests: number;
  reusedFromNeighbours: number;
}

/**
 * Системы вокруг точки сегмента. Локальные источники — каталог Spansh и кэш
 * Atlas — всегда первые: они бесплатны и мгновенны.
 */
async function resolveSectorSystems(
  target: { x: number; y: number; z: number },
  radius: number,
  options: { catalogReady: boolean; budget: RingBudget; memoryPool: Map<string, RingPoint> },
): Promise<SectorResolution> {
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

  // 2. Каталог Spansh (ночной дамп) — самый полный и быстрый источник.
  if (options.catalogReady) {
    try {
      const rows = await findSystemsInCube({ x: target.x, y: target.y, z: target.z, half: radius * 1.2, limit: 400 });
      for (const row of rows) {
        if (distance3(row, target) <= radius) {
          push({ name: row.name, x: row.x, y: row.y, z: row.z, source: 'catalog' });
          resolution.catalogHits++;
        }
      }
    } catch (error: any) {
      console.warn('[ring] каталог недоступен для сегмента:', error?.message);
    }
  }

  // 3. Кэш Atlas (в том числе наполненный прошлыми поисками).
  if (resolution.systems.length === 0) {
    const cached = await listCachedSystemsNear(target, radius, SECTOR_CACHE_LIMIT).catch(() => [] as CachedSystem[]);
    for (const row of cached) {
      push({ name: row.name, x: row.x, y: row.y, z: row.z, source: 'cache' });
      resolution.cacheHits++;
    }
  }

  // 4. EDSM — только если локальные источники пусты и есть бюджет.
  if (resolution.systems.length === 0 && options.budget.edsm > 0) {
    options.budget.edsm--;
    const systems = await edsmSystemsNear(target, radius);
    resolution.edsmRequests++;
    for (const system of systems) {
      if (distance3(system, target) <= radius) push(system);
    }
  }

  // 5. Spansh API — последний сетевой резерв. Сначала ищем системы в радиусе
  //    от уже известной опорной системы (поиск по расстоянию), и только если
  //    такой опоры нет — спрашиваем ближайшую систему к самим координатам.
  if (resolution.systems.length === 0 && options.budget.spansh > 0) {
    const reference = resolution.systems[0] || options.memoryPool.values().next().value || null;
    if (reference) {
      options.budget.spansh--;
      const near = await spanshSystemsNear({
        referenceSystem: reference.name,
        maxDistance: radius,
        size: Math.min(100, SECTOR_CACHE_LIMIT),
        timeoutMs: SPANSH_TIMEOUT_MS,
      });
      resolution.spanshRequests++;
      for (const system of near) {
        if (distance3(system, target) <= radius) push({ ...system, source: 'spansh' });
      }
    }
  }
  if (resolution.systems.length === 0 && options.budget.spansh > 0) {
    options.budget.spansh--;
    const nearest = await spanshNearestSystem(target);
    resolution.spanshRequests++;
    if (nearest && distance3(nearest, target) <= radius) push(nearest);
  }

  resolution.systems = Array.from(byName.values());
  return resolution;
}

/**
 * Выбор опорной точки сегмента: ближайшая свободная реальная система, при
 * отсутствии — расширение радиуса, и только в самом конце триангуляция.
 */
async function pickAnchor(
  target: { x: number; y: number; z: number },
  radius: number,
  usedNames: Set<string>,
  options: { catalogReady: boolean; budget: RingBudget; memoryPool: Map<string, RingPoint> },
): Promise<{ anchor: RingAnchor; systems: RingPoint[]; catalogHits: number; cacheHits: number; reused: number }> {
  let lastFound = 0;
  let catalogHits = 0;
  let cacheHits = 0;
  let reused = 0;
  const collected = new Map<string, RingPoint>();
  // Расширяем окно: сначала поисковый радиус, затем в 2 и 4 раза (но не больше
  // 2400 св.л., иначе опора уедет слишком далеко от кольца).
  const radii = [radius, Math.min(radius * 2, 1200), Math.min(radius * 4, 2400)]
    .filter((value, index, list) => list.indexOf(value) === index);

  for (const currentRadius of radii) {
    const resolution = await resolveSectorSystems(target, currentRadius, options);
    catalogHits += resolution.catalogHits;
    cacheHits += resolution.cacheHits;
    reused += resolution.reusedFromNeighbours;
    lastFound = resolution.systems.length;
    for (const system of resolution.systems) {
      collected.set(system.name.toLowerCase(), system);
      options.memoryPool.set(system.name.toLowerCase(), system);
    }

    const free = resolution.systems
      .filter((system) => !usedNames.has(system.name.toLowerCase()))
      .sort((left, right) => distance3(left, target) - distance3(right, target));
    if (free.length > 0) {
      const chosen = free[0];
      usedNames.add(chosen.name.toLowerCase());
      return {
        anchor: {
          name: chosen.name,
          x: chosen.x,
          y: chosen.y,
          z: chosen.z,
          source: chosen.source,
          deviation: distance3(chosen, target),
          target,
          found: resolution.systems.length,
          usedRadius: currentRadius,
        },
        systems: Array.from(collected.values()),
        catalogHits,
        cacheHits,
        reused,
      };
    }
    if (resolution.systems.length > 0) {
      // Все найденные системы уже заняты соседними сегментами: дальше расширять
      // смысла нет — это тот случай, когда реальной опоры рядом действительно нет.
      break;
    }
  }

  return {
    anchor: {
      name: `RING TRIANGULATED ${Math.round(target.x)}:${Math.round(target.z)}`,
      x: target.x,
      y: target.y,
      z: target.z,
      source: 'triangulated',
      deviation: 0,
      target,
      found: lastFound,
      usedRadius: radius,
    },
    systems: Array.from(collected.values()),
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
  let beam: { x: number; y: number; z: number } | null = null;

  const catalogReady = await isCatalogReady();
  const budget: RingBudget = { edsm: EDSM_BUDGET_PER_STEP, spansh: SPANSH_BUDGET_PER_STEP };
  const startedAt = Date.now();
  let processedTo = from;

  for (let sector = from; sector < to; sector++) {
    // Шаг не должен превращаться в минуты ожидания: если бюджет времени вышел,
    // возвращаем то, что успели, и клиент просто запросит следующий шаг.
    if (processedTo > from && Date.now() - startedAt > STEP_TIME_BUDGET_MS) break;
    const target = ringTarget(session.center, session.basis, session.ringRadius, sector, session.sectors);
    beam = target;
    const picked = await pickAnchor(
      target,
      session.searchRadius,
      usedNames,
      { catalogReady, budget, memoryPool },
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

  // Найденные системы кладём в кэш проекта: следующий поиск обойдётся без сети.
  const toSave: RingPoint[] = [
    ...memoryPool.values(),
    ...newAnchors.filter((anchor) => anchor.source !== 'triangulated'),
  ];
  const saved = await saveCachedSystems(toSave.map((point) => ({
    name: point.name,
    x: point.x,
    y: point.y,
    z: point.z,
    source: point.source || 'cache',
  }))).catch(() => 0);
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
    const stats = await getGalaxyStats();
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
  corridor: number;
  catalogReady: boolean;
  catalogBudget: number;
  systemsFound: number;
  /** Сквозная нумерация расчётных точек: имена должны быть уникальны. */
  syntheticCounter: { next: () => number };
}

/**
 * Цепочка реальных систем от `from` до `to`. Жадный проход: на каждом шаге
 * берём достижимую систему, которая сильнее всего приближает к цели и не
 * выходит из коридора маршрута. Триангуляция — если такой системы нет.
 */
function bridgeSegment(
  from: RingPoint,
  to: RingPoint,
  pool: RingPoint[],
  used: Set<string>,
  context: BridgeContext,
): RingPoint[] {
  const points: RingPoint[] = [];
  let current = from;
  let guard = 0;
  const corridor = Math.max(context.corridor, context.maxJump);

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
      if (lateral > corridor) continue;
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

    // Расчётная точка: идём по прямой на один максимальный прыжок.
    const ratio = context.maxJump / remaining;
    const synthetic: RingPoint = {
      name: `RING TRIANGULATED ${context.syntheticCounter.next()} `,
      x: current.x + (to.x - current.x) * ratio,
      y: current.y + (to.y - current.y) * ratio,
      z: current.z + (to.z - current.z) * ratio,
      source: 'triangulated',
    };
    synthetic.name = synthetic.name.trim();
    points.push(synthetic);
    current = synthetic;
  }

  return points;
}

/**
 * Бюджет внешних запросов, общий на шаг поиска. Передаётся объектом намеренно:
 * вызовы внутри шага вычитают израсходованное, и лимит реально ограничивает
 * сеть, а не только выглядит как ограничение.
 */
export interface RingBudget {
  edsm: number;
  spansh: number;
}

export interface BridgeOptions {
  maxJump?: number;
  corridor?: number;
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
  options: BridgeOptions = {},
): RingPoint[] {
  let counter = 0;
  return bridgeSegment(from, to, pool, new Set([from.name.toLowerCase()]), {
    maxJump: options.maxJump ?? MAX_JUMP,
    corridor: options.corridor ?? 60,
    catalogReady: false,
    catalogBudget: 0,
    systemsFound: 0,
    syntheticCounter: { next: () => ++counter },
  });
}

/**
 * Кандидаты для моста: системы из кэша/каталога в коридоре вокруг отрезка.
 * Каталог опрашиваем точечно и с бюджетом — только когда кэша не хватает.
 */
async function collectBridgePool(
  from: RingPoint,
  to: RingPoint,
  cached: RingPoint[],
  context: BridgeContext,
): Promise<RingPoint[]> {
  const length = distance3(from, to);
  const corridor = Math.max(context.corridor, context.maxJump) * 2;
  const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2, z: (from.z + to.z) / 2 };
  const reach = length / 2 + corridor;

  let pool = cached.filter((system) => distanceToSegment(system, from, to) <= corridor);

  if (context.catalogReady && context.catalogBudget > 0) {
    // Дополнительно спрашиваем каталог, если в коридоре мало систем: именно это
    // позволяет заменить триангуляцию реальными системами.
    const samples = Math.max(1, Math.min(3, Math.ceil(length / Math.max(context.corridor, 50))));
    const byName = new Map(pool.map((system) => [system.name.toLowerCase(), system]));
    for (let index = 0; index < samples; index++) {
      if (context.catalogBudget <= 0) break;
      const t = samples === 1 ? 0.5 : (index + 0.5) / samples;
      const sample = {
        x: from.x + (to.x - from.x) * t,
        y: from.y + (to.y - from.y) * t,
        z: from.z + (to.z - from.z) * t,
      };
      context.catalogBudget--;
      try {
        const rows = await findSystemsInCube({
          ...sample,
          half: Math.min(Math.max(reach / samples, context.maxJump * 4), 800),
          limit: 400,
        });
        context.systemsFound += rows.length;
        for (const row of rows) {
          if (distanceToSegment(row, from, to) > corridor) continue;
          byName.set(row.name.toLowerCase(), { name: row.name, x: row.x, y: row.y, z: row.z, source: 'catalog' });
        }
      } catch (error: any) {
        console.warn('[ring] каталог не ответил при сборке моста:', error?.message);
        break;
      }
    }
    pool = Array.from(byName.values());
  }

  // Отсекаем далёкие системы: дальний хвост только замедляет перебор.
  return pool.filter((system) => distance3(system, mid) <= reach + context.maxJump * 2);
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

  // Пул реальных систем: всё, что кэш накопил в габаритном боксе кольца. После
  // шага сканирования здесь лежат именно системы, найденные для этого кольца.
  const half = session.ringRadius + session.searchRadius * 4 + Math.max(session.searchRadius * 4, 200);
  const cachedRows = await listCachedSystemsInBox(boxAround(session.center, half), FINALIZE_POOL_LIMIT).catch(() => []);
  const cached: RingPoint[] = cachedRows.map((row) => ({
    name: row.name,
    x: row.x,
    y: row.y,
    z: row.z,
    source: (row.source === 'catalog' ? 'catalog' : 'cache') as RingSource,
  }));

  let syntheticCounter = 0;
  const context: BridgeContext = {
    maxJump: MAX_JUMP,
    corridor: Math.max(session.searchRadius, 30),
    catalogReady,
    catalogBudget: FINALIZE_CATALOG_BUDGET,
    systemsFound: 0,
    syntheticCounter: { next: () => ++syntheticCounter },
  };

  const anchors: RingPoint[] = session.anchors.map((anchor) => ({
    name: anchor.name,
    x: anchor.x,
    y: anchor.y,
    z: anchor.z,
    source: anchor.source,
  }));

  // Замкнутое кольцо: начальная система — первая и последняя точка.
  const sequence: RingPoint[] = [
    { ...session.start, source: 'start' },
    ...anchors,
    { ...session.start, source: 'start' },
  ];

  const used = new Set<string>();
  for (const anchor of anchors) {
    if (anchor.source !== 'triangulated') used.add(anchor.name.toLowerCase());
  }

  const route: RingPoint[] = [sequence[0]];
  for (let index = 0; index < sequence.length - 1; index++) {
    const from = sequence[index];
    const to = sequence[index + 1];
    if (distance3(from, to) <= MAX_JUMP) {
      route.push(to);
      continue;
    }
    const pool = await collectBridgePool(from, to, cached, context);
    const bridge = bridgeSegment(from, to, pool, used, context);
    for (const point of bridge) route.push(point);
    route.push(to);
  }

  // Итоговая статистика: сколько точек реальные, сколько расчётных.
  // Дубли убираем только внутри маршрута: замыкающая точка (старт) должна
  // остаться последней, иначе кольцо перестаёт быть замкнутым.
  const deduped: RingPoint[] = [];
  const seen = new Set<string>();
  const routeKey = (point: RingPoint) =>
    `${point.name.toLowerCase()}|${point.x.toFixed(3)}|${point.y.toFixed(3)}|${point.z.toFixed(3)}`;
  route.forEach((point, index) => {
    const isLast = index === route.length - 1;
    const key = routeKey(point);
    if (!isLast && seen.has(key)) return;
    seen.add(key);
    deduped.push(point);
  });

  const syntheticPoints = deduped.filter((point) => point.source === 'triangulated').length;
  stats.syntheticPoints = syntheticPoints;
  stats.realPoints = deduped.length - syntheticPoints;
  stats.bridgeCatalogRequests = FINALIZE_CATALOG_BUDGET - context.catalogBudget;
  stats.systemsFound = Math.max(stats.systemsFound, context.systemsFound);

  const deviations = session.anchors.map((anchor) => anchor.deviation).filter((value) => Number.isFinite(value));
  const deviationAvg = deviations.length > 0 ? deviations.reduce((sum, value) => sum + value, 0) / deviations.length : 0;
  const deviationMax = deviations.length > 0 ? Math.max(...deviations) : 0;

  // Сохраняем найденное: и в кэш систем, и в саму сессию.
  const toSave = [...cached.filter((system) => system.source !== 'cache'), ...deduped.filter((point) => point.source !== 'triangulated')];
  const saved = await saveCachedSystems(toSave.map((point) => ({
    name: point.name,
    x: point.x,
    y: point.y,
    z: point.z,
    source: point.source || 'cache',
  }))).catch(() => 0);
  stats.systemsSaved += saved;

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
      discovered: cachedRows.length,
      deviationAvg: Math.round(deviationAvg * 10) / 10,
      deviationMax: Math.round(deviationMax * 10) / 10,
    },
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
