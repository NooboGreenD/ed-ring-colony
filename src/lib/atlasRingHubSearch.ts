/**
 * Поиск кандидатов на строительные хабы в радиусе 14.99 св.л от опорных точек кольца.
 *
 * Хаб — система, в которой есть каменистое тело (Rocky body / High metal content world /
 * Rocky ice world / Metal-rich body) с возможностью посадки (isLandable = true).
 * Такая система подходит для закладки форпоста и снабжения сегмента кольца.
 *
 * Источники по приоритету:
 *   1. Кэш тел Atlas (`atlas_body_cache`) — быстрей всего, растёт с каждым поиском.
 *   2. Каталог тел в БД проекта (`system_scans`) — Colonial Helper уже отсканировал.
 *   3. Spansh `/bodies/search` — сетевой поиск по радиусу от опорной системы.
 *   4. EDSM `/bodies` (только для ближайшей системы опоры) — резерв.
 *
 * Хаб считается кандидатом, если он ≤ MAX_JUMP (14.99 св.л) от опорной точки.
 * Ближайший к опоре приоритетен.
 */

import { supabaseAdmin } from './supabaseAdmin.ts';
import {
  findSystemsInCube,
  getGalaxyStats,
  catalogIsComplete,
} from './galaxySystemsDb.ts';
import {
  listCachedSystemsNear,
  listCachedBodiesInBox,
  saveCachedBodies,
  saveCachedSystems,
  type CachedSystem,
  type CachedBody,
  boxAround,
} from './atlasSystemCache.ts';
import { spanshBodiesSearch } from './spanshClient.ts';
import { normalizeSystemName } from './galaxySystems.ts';
import { MAX_JUMP } from './atlasRingSearch.ts';

export const HUB_SEARCH_RADIUS = MAX_JUMP; // 14.99 св.л.

/** Таймауты и бюджеты. */
const DB_TIMEOUT_MS = 4_000;
const SPANSH_TIMEOUT_MS = 6_000;
const EDSM_TIMEOUT_MS = 5_000;
const SPANSH_BUDGET_PER_BATCH = 3;
/** Батч параллельно обрабатываемых опорных точек. */
const HUB_CONCURRENCY = 6;
/** Максимум тел/систем, которые просим у источника за раз. */
const BODIES_QUERY_LIMIT = 80;

const UA = 'ED-Ring-Colony/1.0 (hub-search)';

/** Типы тел, которые подходят под «каменное тело с посадкой». */
const LANDABLE_ROCKY_SUBTYPES = new Set([
  'Rocky body',
  'High metal content world',
  'Rocky ice world',
  'Metal-rich body',
  'Icy body', // при наличии посадки тоже можно использовать как ледяной хаб
]);

export interface HubCandidate {
  /** Имя системы-кандидата (пусто, если хаб не найден). */
  systemName: string | null;
  /** Координаты системы-кандидата (или null если не найден). */
  x: number | null;
  y: number | null;
  z: number | null;
  /** Расстояние от опорной точки до хаба, св.л. */
  distance: number | null;
  /** Имя подходящего тела (для справки). */
  bodyName: string | null;
  /** Тип тела. */
  bodySubtype: string | null;
  /** Статус хаба: 'found' | 'missing' | 'error'. */
  status: 'found' | 'missing' | 'error';
  /** Примечание: что пошло не так при 'missing' или 'error'. */
  note?: string;
  /** Источник данных: 'cache' | 'db' | 'spansh' | 'edsm'. */
  source?: string;
}

export interface AnchorHubResult {
  /** Имя опорной точки (системы или триангулированной). */
  anchorName: string;
  anchorX: number;
  anchorY: number;
  anchorZ: number;
  hub: HubCandidate;
}

interface NearbySystem {
  name: string;
  x: number;
  y: number;
  z: number;
  distance: number;
  source: string;
}

const dist3 = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** Кэш признака «каталог полон» на 5 минут (как в atlasRingSearch). */
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

async function withTimeout<T>(promise: PromiseLike<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); });
  try { return await Promise.race([promise, timeout]); }
  catch { return fallback; }
  finally { if (timer) clearTimeout(timer); }
}

/** Параллельная обработка с ограничением одновременных задач. */
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

/**
 * Шаг 1: ищем ближайшие известные системы в радиусе 14.99 св.л от опоры.
 * Порядок: кэш Atlas → каталог Spansh в БД проекта.
 */
async function nearbySystemsFromDb(anchor: { x: number; y: number; z: number }): Promise<NearbySystem[]> {
  const radius = HUB_SEARCH_RADIUS;
  const found: NearbySystem[] = [];
  const seen = new Set<string>();

  const cached = await withTimeout(
    listCachedSystemsNear(anchor, radius, 200).catch(() => [] as CachedSystem[]),
    DB_TIMEOUT_MS, [] as CachedSystem[],
  );
  for (const row of cached) {
    const d = dist3(row, anchor);
    if (d > radius) continue;
    const key = normalizeSystemName(row.name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    found.push({ name: row.name, x: row.x, y: row.y, z: row.z, distance: d, source: 'cache' });
  }

  const catalogReady = await isCatalogReady();
  if (catalogReady) {
    const rows = await withTimeout(
      findSystemsInCube({ x: anchor.x, y: anchor.y, z: anchor.z, half: radius + 1, limit: 300 })
        .catch(() => [] as Array<{ name: string; x: number; y: number; z: number }>),
      DB_TIMEOUT_MS, [] as Array<{ name: string; x: number; y: number; z: number }>,
    );
    for (const row of rows) {
      const d = dist3(row, anchor);
      if (d > radius) continue;
      const key = normalizeSystemName(row.name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      found.push({ name: row.name, x: row.x, y: row.y, z: row.z, distance: d, source: 'catalog' });
    }
  }

  found.sort((a, b) => a.distance - b.distance);
  return found;
}

/**
 * Шаг 1b: кэш тел — смотрим сразу в радиусе опоры, не запрашивая списка систем.
 */
async function bodiesFromCache(anchor: { x: number; y: number; z: number }): Promise<{ systemName: string; bodyName: string; subtype: string; distance: number; x: number; y: number; z: number; source: string }[]> {
  const radius = HUB_SEARCH_RADIUS;
  const bodies = await withTimeout(
    listCachedBodiesInBox(boxAround(anchor, radius), [], BODIES_QUERY_LIMIT).catch(() => [] as CachedBody[]),
    DB_TIMEOUT_MS, [] as CachedBody[],
  );
  const result: { systemName: string; bodyName: string; subtype: string; distance: number; x: number; y: number; z: number; source: string }[] = [];
  for (const body of bodies) {
    if (!body.systemName) continue;
    // Фильтруем каменистые пригодные для посадки.
    if (body.hasAtmosphere !== false && body.subtype && !LANDABLE_ROCKY_SUBTYPES.has(body.subtype)) continue;
    // Признак посадки: у кэша это isTerraformable != null проверять не нужно,
    // а is_landable хранится в metadata у части записей. Смотрим по is_landable в metadata.
    const meta = body.metadata as Record<string, unknown> | null;
    if (meta && typeof meta.is_landable === 'boolean' && !meta.is_landable) continue;
    const d = dist3(body, anchor);
    if (d > radius) continue;
    result.push({
      systemName: body.systemName,
      bodyName: body.bodyName,
      subtype: body.subtype || '',
      distance: d,
      x: body.x, y: body.y, z: body.z,
      source: 'cache',
    });
  }
  result.sort((a, b) => a.distance - b.distance);
  return result;
}

/**
 * Шаг 2: запрашиваем тела в БД system_scans для ближайших систем и ищем
 * каменистое тело с is_landable = true.
 */
async function checkSystemsInDbScan(systemNames: string[]): Promise<Map<string, { bodyName: string; subtype: string }>> {
  const result = new Map<string, { bodyName: string; subtype: string }>();
  if (systemNames.length === 0) return result;
  try {
    const names = systemNames.slice(0, 30);
    const { data, error } = await supabaseAdmin
      .from('system_scans')
      .select('system_name,body_name,sub_type,is_landable,body_type')
      .in('system_name', names);
    if (error || !Array.isArray(data)) return result;
    for (const row of data as any[]) {
      const key = normalizeSystemName(String(row.system_name || ''));
      if (!key || result.has(key)) continue;
      const subtype = String(row.sub_type || '');
      const isLandable = row.is_landable === true;
      const isPlanet = String(row.body_type || '').toLowerCase() === 'planet';
      if (!isPlanet || !isLandable || !LANDABLE_ROCKY_SUBTYPES.has(subtype)) continue;
      result.set(key, { bodyName: String(row.body_name || ''), subtype });
    }
  } catch {
    // Не критично — идём к Spansh.
  }
  return result;
}

/**
 * Шаг 3: Spansh bodies search в радиусе от опоры. Фильтруем rocky body с isLandable.
 */
async function searchSpanshBodies(anchor: NearbySystem | { name: string; x: number; y: number; z: number }): Promise<{ systemName: string; bodyName: string; subtype: string; distance: number; x: number; y: number; z: number } | null> {
  try {
    const referenceName = 'name' in anchor ? anchor.name : null;
    if (!referenceName) return null;
    const result = await withTimeout(
      spanshBodiesSearch({
        referenceSystem: referenceName,
        filters: {
          distance: { min: '0', max: String(HUB_SEARCH_RADIUS) },
          sub_type: {
            value: ['Rocky body', 'High metal content world', 'Metal-rich body', 'Rocky ice world'],
          },
          is_landable: { value: true },
        },
        sort: [{ distance: { direction: 'asc' } }],
        size: 10,
        page: 0,
      }),
      SPANSH_TIMEOUT_MS, null,
    );
    if (!result || !Array.isArray((result as any).results)) return null;
    const entries = (result as any).results as any[];
    for (const entry of entries) {
      const record = entry?.record || entry;
      const sysName = String(record?.system || record?.name || record?.system_name || '');
      const bodyName = String(record?.name || '');
      const subtype = String(record?.sub_type || record?.subtype || '');
      if (!sysName || !LANDABLE_ROCKY_SUBTYPES.has(subtype)) continue;
      const coords = record?.coords || record;
      const x = Number(coords.x);
      const y = Number(coords.y);
      const z = Number(coords.z);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
      const d = dist3({ x, y, z }, anchor);
      if (d > HUB_SEARCH_RADIUS) continue;
      return { systemName: sysName, bodyName, subtype, distance: d, x, y, z };
    }
  } catch {
    // Игнорируем сбой сети: резерв — EDSM.
  }
  return null;
}

/**
 * Шаг 4: EDSM bodies для ближайшей системы (точечный запрос, не перегружаем).
 */
async function fetchEdsmBodies(systemName: string): Promise<{ bodyName: string; subtype: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EDSM_TIMEOUT_MS);
  try {
    const res = await fetch(
      `https://www.edsm.net/api-system-v1/bodies?systemName=${encodeURIComponent(systemName)}`,
      { signal: controller.signal, headers: { 'User-Agent': UA, Accept: 'application/json' } },
    );
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    const bodies = Array.isArray(data?.bodies) ? data.bodies : [];
    let best: { bodyName: string; subtype: string; dta: number } | null = null;
    for (const body of bodies) {
      if (body?.isLandable !== true) continue;
      const subtype = String(body?.subType || '');
      if (!LANDABLE_ROCKY_SUBTYPES.has(subtype)) continue;
      const dta = Number(body?.distanceToArrival) || 0;
      if (!best || dta < best.dta) {
        best = { bodyName: String(body.name || ''), subtype, dta };
      }
    }
    return best ? { bodyName: best.bodyName, subtype: best.subtype } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Поиск хаба у одной опорной точки. */
async function findHubForAnchor(anchor: { name: string; x: number; y: number; z: number }, spanshBudget: { count: number }): Promise<AnchorHubResult> {
  const missing = (note?: string): AnchorHubResult => ({
    anchorName: anchor.name,
    anchorX: anchor.x, anchorY: anchor.y, anchorZ: anchor.z,
    hub: { systemName: null, x: null, y: null, z: null, distance: null, bodyName: null, bodySubtype: null, status: 'missing', note, source: undefined },
  });

  // 1. Быстрый путь: кэш тел — вдруг в этом районе уже искали.
  const cachedBodies = await bodiesFromCache(anchor);
  if (cachedBodies.length > 0) {
    const best = cachedBodies[0];
    return {
      anchorName: anchor.name, anchorX: anchor.x, anchorY: anchor.y, anchorZ: anchor.z,
      hub: {
        systemName: best.systemName, x: best.x, y: best.y, z: best.z,
        distance: Math.round(best.distance * 100) / 100,
        bodyName: best.bodyName, bodySubtype: best.subtype,
        status: 'found', source: 'cache',
      },
    };
  }

  // 2. Соседние системы из каталога/кэша — проверяем их сканы в БД.
  const nearby = await nearbySystemsFromDb(anchor);
  if (nearby.length > 0) {
    const dbScans = await checkSystemsInDbScan(nearby.map((s) => s.name));
    for (const system of nearby) {
      const key = normalizeSystemName(system.name);
      if (dbScans.has(key)) {
        const body = dbScans.get(key)!;
        return {
          anchorName: anchor.name, anchorX: anchor.x, anchorY: anchor.y, anchorZ: anchor.z,
          hub: {
            systemName: system.name, x: system.x, y: system.y, z: system.z,
            distance: Math.round(system.distance * 100) / 100,
            bodyName: body.bodyName, bodySubtype: body.subtype,
            status: 'found', source: system.source === 'catalog' ? 'db' : 'cache',
          },
        };
      }
    }

    // 3. Spansh: бюджет на пакет.
    if (spanshBudget.count > 0) {
      spanshBudget.count--;
      const spanshHit = await searchSpanshBodies(nearby[0]);
      if (spanshHit) {
        return {
          anchorName: anchor.name, anchorX: anchor.x, anchorY: anchor.y, anchorZ: anchor.z,
          hub: {
            systemName: spanshHit.systemName, x: spanshHit.x, y: spanshHit.y, z: spanshHit.z,
            distance: Math.round(spanshHit.distance * 100) / 100,
            bodyName: spanshHit.bodyName, bodySubtype: spanshHit.subtype,
            status: 'found', source: 'spansh',
          },
        };
      }
    }

    // 4. EDSM (точечно для ближайшей системы — не сжигаем лимиты).
    const edsmHit = await fetchEdsmBodies(nearby[0].name);
    if (edsmHit) {
      return {
        anchorName: anchor.name, anchorX: anchor.x, anchorY: anchor.y, anchorZ: anchor.z,
        hub: {
          systemName: nearby[0].name, x: nearby[0].x, y: nearby[0].y, z: nearby[0].z,
          distance: Math.round(nearby[0].distance * 100) / 100,
          bodyName: edsmHit.bodyName, bodySubtype: edsmHit.subtype,
          status: 'found', source: 'edsm',
        },
      };
    }
  }

  // Ни в одном источнике не нашли подходящей системы/тела.
  const note = nearby.length === 0
    ? 'Нет известных систем в радиусе 14.99 св.л'
    : `Из ${nearby.length} ближайших систем ни в одной нет каменистого тела с посадкой`;
  return missing(note);
}

/**
 * Поиск хабов для массива опорных точек.
 *
 * @param anchors список опор (x, y, z, name)
 * @param options.concurrency сколько опор обрабатывать параллельно
 * @param options.spanshBudget общий лимит запросов к Spansh API
 */
export async function findHubsForAnchors(
  anchors: Array<{ name: string; x: number; y: number; z: number }>,
  options: { spanshBudget?: number; concurrency?: number; onProgress?: (done: number, total: number, latest: AnchorHubResult) => void } = {},
): Promise<AnchorHubResult[]> {
  const spanshBudget = { count: options.spanshBudget ?? 10 };
  const results: AnchorHubResult[] = new Array(anchors.length);
  const limit = Math.max(1, Math.min(HUB_CONCURRENCY, options.concurrency ?? HUB_CONCURRENCY));

  let next = 0;
  let done = 0;
  const workers = Array.from({ length: Math.min(limit, anchors.length) }, async () => {
    while (next < anchors.length) {
      const index = next++;
      // Spansh не перегружаем: если бюджет исчерпан, делаем паузу, но не падаем —
      // оставшиеся опоры обрабатываем без сетевого поиска.
      try {
        results[index] = await findHubForAnchor(anchors[index], spanshBudget);
      } catch (error) {
        results[index] = {
          anchorName: anchors[index].name,
          anchorX: anchors[index].x, anchorY: anchors[index].y, anchorZ: anchors[index].z,
          hub: { systemName: null, x: null, y: null, z: null, distance: null, bodyName: null, bodySubtype: null, status: 'error', note: error instanceof Error ? error.message : 'ошибка поиска' },
        };
      }
      done++;
      options.onProgress?.(done, anchors.length, results[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Сброс кэша готовности каталога (после импорта дампа). */
export function invalidateHubCatalogCache(): void {
  catalogReadyCache = null;
}
