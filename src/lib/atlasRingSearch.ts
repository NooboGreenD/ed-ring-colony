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
 *      параллельно). Если ближайшие системы куба не покрывают хорду, сегмент
 *      делится и запрашивается снова — иначе в плотном районе пул сбивается
 *      к середине, а концы закрываются расчётом. Коридор моста шире допуска
 *      отклонения: хорда между смещёнными опорами не должна прятать системы,
 *      которые всё ещё лежат на оси кольца.
 *   4. Мост идёт по связным островам реальных систем. Расчётная точка ставится
 *      только в разрыве и наводится на следующую реальную систему, а не в пустоту
 *      по прямой. Итог проверяется по всем трём требованиям и отдаёт статистику.
 */

// Явные расширения нужны для `node --test`.
import { ringBasis3D, ringPointAtAngle3D, ringHeightOffset, type RingBasis3D } from './atlasRingGeometry.ts';
export { ringBasis3D, ringPointAtAngle3D, type RingBasis3D } from './atlasRingGeometry.ts';
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
/**
 * Максимальная толщина галактического диска (± от плоскости), св.л.
 * При 90° наклоне кольца радиус + высотное смещение не должны выходить за эти пределы.
 */
export const GALACTIC_DISK_HALF_THICKNESS = 6_000;
/** Рекомендуемая средняя толщина диска — 3000 св.л. */
export const GALACTIC_DISK_RECOMMENDED = 3_000;
/** Диапазон высотного смещения центра кольца от галактической плоскости. */
export const MIN_HEIGHT_OFFSET = -5_000;
export const MAX_HEIGHT_OFFSET = 5_000;
/** Наклон плоскости кольца в градусах. */
export const MIN_TILT_DEGREES = -180;
export const MAX_TILT_DEGREES = 180;
/**
 * Коридор моста между опорами. Шире допуска отклонения: когда опоры смещены
 * от окружности, хорда уходит в сторону, и системы на оси кольца оказываются
 * дальше 100 св.л. от прямой, хотя сами в допуске. Допуск 100 для точек
 * кольца проверяется отдельно и коридором не подменяется.
 */
export const ROUTE_CORRIDOR = 150;
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
/**
 * Бюджет сборки. Сбор и прокладка разделены, сумма ниже типичного таймаута
 * прокси (60 с): иначе шлюз рвёт ответ, и клиент видит «Не удалось собрать
 * маршрут кольца» без текста ошибки. Пулы, которые уже собраны, не выбрасываются.
 */
const FINALIZE_COLLECT_BUDGET_MS = 25_000;
const FINALIZE_BRIDGE_BUDGET_MS = 12_000;
/** Короткий таймаут пробы на сборке: зависший запрос не должен съедать всё кольцо. */
const FINALIZE_DB_TIMEOUT_MS = 2_000;
/** Сколько проб каталога можно сделать на всё кольцо, не на каждый сегмент. */
const FINALIZE_QUERY_CAP = 360;
const FINALIZE_CONCURRENCY = 6;

/** Бюджеты внешних запросов на один шаг. */
const EDSM_BUDGET_PER_STEP = 16;
const EDSM_TIMEOUT_MS = 6000;
const SPANSH_BUDGET_PER_STEP = 4;
const SPANSH_TIMEOUT_MS = 5000;

/** Максимум систем, которые берём вокруг одной опорной точки. */
const SECTOR_CACHE_LIMIT = 600;
/**
 * Сколько систем запрашиваем вокруг одной точки сегмента.
 *
 * RPC `galaxy_systems_near` и кэш отдают не больше 2000 ближайших. Больший
 * лимит ничего не добавляет и всё равно собирает системы у центра куба:
 * в плотном районе концы хорды остаются пустыми, и мост их триангулирует,
 * хотя системы там есть. Если ответ упёрся в потолок, сегмент делится вдоль
 * хорды и запрашивается снова — слитый пул тогда покрывает весь отрезок.
 */
const SEGMENT_QUERY_LIMIT = 2000;
/**
 * Сколько проб на один сегмент. На кольце в сотни сегментов 15 проб на отрезок
 * не укладываются в один HTTP-запрос и роняют сборку по таймауту.
 */
const SEGMENT_QUERY_BUDGET = 4;
/** Короче этого (вдоль хорды) делить пробу уже нет смысла: это пара прыжков. */
const SEGMENT_MIN_SPAN = 40;
/** Сколько точек сегмента отдаём клиенту для отрисовки на карте. */
const STEP_FOUND_SAMPLE = 400;
/**
 * Потолок пула одного сегмента. Тысячи систем на отрезок при 300 сегментах
 * раздувают память и обход графа — процесс сборки падает, не отдав маршрут.
 * Вдоль хорды хватает нескольких сотен: лишние в плотном районе всё равно
 * ближе середины, а не на концах.
 */
const BRIDGE_POOL_CAP = 480;

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
  /** Сегменты моста, где пришлось вставить расчётные точки. */
  triangulatedSegments: number;
}

export interface KeySystem {
  name: string;
  x: number;
  y: number;
  z: number;
}

/**
 * 3D-базис наклонённого кольца.
 *  - e_radial  (u): направление от центра к точке «старта» в плоскости кольца;
 *  - e_tangent (v): перпендикулярно u в плоскости кольца (по направлению обхода);
 *  - e_normal  (n): нормаль к плоскости кольца.
 * При tilt=0 кольцо лежит в галактической плоскости (n = (0,1,0)), и базис
 * совпадает со старым 2D-вариантом (ux, uz); при tilt≠0 плоскость наклонена
 * вокруг горизонтальной оси с настраиваемым азимутом.
 */

export interface RingPlan {
  sessionId: string;
  start: RingPoint;
  center: RingPoint;
  /** Устаревшее 2D-поле оставлено для обратной совместимости; для новой логики используйте basis3D. */
  basis: { ux: number; uz: number };
  /** Полный 3D-базис с учётом наклона и высотного смещения. */
  basis3D: RingBasis3D;
  ringRadius: number;
  searchRadius: number;
  /** Смещение центра кольца по оси Y относительно `center`, св.л. */
  heightOffset: number;
  /** Наклон плоскости кольца в градусах (0 = в плоскости галактики, 90 = перпендикулярно, 180 = опрокинуто). */
  tiltDegrees: number;
  tiltAxisDegrees: number;
  /** Эффективный центр кольца в пространстве = center + (0, heightOffset, 0). */
  ringCenter: RingPoint;
  /** Пользовательский допуск отклонения от окружности (св.л); null — значение по умолчанию. */
  deviationLimit: number;
  /** Обязательные (ключевые) системы, которые маршрут обязан пройти. */
  keySystems: KeySystem[];
  sectors: number;
  sectorsDone: number;
  anchors: RingAnchor[];
  stats: RingStats;
  status: 'scanning' | 'ready' | 'completed' | 'failed' | 'refining';
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

/** Результат поиска строительных хабов по опорным точкам (для включения в RingResult). */
export interface RingHubSummary {
  anchorName: string;
  hub: {
    systemName: string | null;
    status: 'found' | 'missing' | 'error';
    distance: number | null;
    note?: string;
  };
}

export interface RingResult {
  sessionId: string;
  start: string;
  center: RingPoint;
  /** Эффективный центр кольца в пространстве (center + (0, heightOffset, 0)). */
  ringCenter: RingPoint;
  /** 3D-базис кольца с учётом наклона. */
  basis3D: RingBasis3D;
  /** Высотное смещение, св.л. */
  heightOffset: number;
  /** Наклон плоскости, градусы. */
  tiltDegrees: number;
  tiltAxisDegrees: number;
  ringRadius: number;
  searchRadius: number;
  deviationLimit: number;
  keySystems: KeySystem[];
  route: RingPoint[];
  anchors: RingPoint[];
  hubs?: RingHubSummary[];
  totals: {
    points: number;
    realPoints: number;
    syntheticPoints: number;
    anchors: number;
    triangulatedAnchors: number;
    discovered: number;
    deviationAvg: number;
    deviationMax: number;
    hubsFound?: number;
    hubsMissing?: number;
  };
  validation?: RingValidation;
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
  triangulatedSegments: 0,
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

/** Точка окружности кольца по углу (устаревший 2D-вариант; для наклонённых колец используйте ringPointAtAngle3D). */
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

/** Точка на кольце для сегмента. */
export function ringTarget(
  center: XYZ,
  basis: RingBasis3D | { ux: number; uz: number },
  ringRadius: number,
  sectorIndex: number,
  sectors: number,
  ringCenter?: XYZ,
): XYZ {
  const angle = (2 * Math.PI * sectorIndex) / sectors;
  if ('nx' in basis && ringCenter) return ringPointAtAngle3D(ringCenter, basis, ringRadius, angle);
  return ringPointAtAngle(center, basis as { ux: number; uz: number }, ringRadius, angle);
}

/** Строит 2D-базис в плоскости XZ от центра к точке старта. */
export function ringBasis(start: { x: number; z: number }, center: { x: number; z: number }): { ux: number; uz: number } {
  const vx = start.x - center.x;
  const vz = start.z - center.z;
  const length = Math.hypot(vx, vz) || 1;
  return { ux: vx / length, uz: vz / length };
}

/**
 * Перпендикулярное отклонение точки от окружности наклонённого кольца.
 *
 * Алгоритм: вектор от `ringCenter` к точке раскладывается на составляющие по
 * базису (u, v, n); отклонение = гипотенуза между (1) отклонением радиуса в
 * плоскости кольца и (2) расстоянием до плоскости кольца.
 */
export function ringDeviation3D(
  point: XYZ,
  ringCenter: XYZ,
  basis: RingBasis3D,
  ringRadius: number,
): number {
  const dx = point.x - ringCenter.x;
  const dy = point.y - ringCenter.y;
  const dz = point.z - ringCenter.z;
  const a = dx * basis.ux + dy * basis.uy + dz * basis.uz; // проекция на u
  const b = dx * basis.vx + dy * basis.vy + dz * basis.vz; // проекция на v
  const c = dx * basis.nx + dy * basis.ny + dz * basis.nz; // проекция на нормаль
  const r = Math.hypot(a, b);
  return Math.hypot(r - ringRadius, c);
}

/**
 * Устаревшая 2D-функция отклонения (для обратной совместимости).
 * Вся новая логика использует ringDeviation3D.
 */
export function ringDeviation(point: XYZ, center: XYZ, ringRadius: number): number {
  const horizontal = Math.hypot(point.x - center.x, point.z - center.z);
  return Math.hypot(horizontal - ringRadius, point.y - center.y);
}

/**
 * Точка окружности наклонённого кольца, отстоящая от `from` ровно на `distance`,
 * ближайшая к углу `angle` (отложенному в плоскости кольца от направления u).
 * Унифицированная 3D-версия; работает и для плоского кольца (tilt=0).
 */
export function ringPointAtDistance(
  ringCenter: XYZ,
  basis: RingBasis3D,
  ringRadius: number,
  from: XYZ,
  angle: number,
  distance: number,
): XYZ | null {
  const dx = from.x - ringCenter.x;
  const dy = from.y - ringCenter.y;
  const dz = from.z - ringCenter.z;
  // Проекция вектора from→ringCenter на базис кольца.
  const a = dx * basis.ux + dy * basis.uy + dz * basis.uz;
  const b = dx * basis.vx + dy * basis.vy + dz * basis.vz;
  const c = dx * basis.nx + dy * basis.ny + dz * basis.nz;
  const m = Math.hypot(a, b);
  if (m < 1e-9 || ringRadius <= 0) return null;
  const fMagSq = a * a + b * b + c * c;
  const k = (ringRadius * ringRadius + fMagSq - distance * distance) / (2 * ringRadius * m);
  if (k < -1 || k > 1) return null;
  const phi = Math.atan2(b, a);
  const delta = Math.acos(k);
  const normalise = (value: number) => Math.atan2(Math.sin(value), Math.cos(value));
  const first = phi + delta;
  const second = phi - delta;
  const theta = Math.abs(normalise(first - angle)) <= Math.abs(normalise(second - angle)) ? first : second;
  return ringPointAtAngle3D(ringCenter, basis, ringRadius, theta);
}

/**
 * Устаревшая 2D-обёртка (для обратной совместимости со старым кодом).
 */
export function ringPointAtDistance2D(
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
async function withTimeout<T>(promise: PromiseLike<T>, ms: number, fallback: T): Promise<T> {
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
  deviation_limit: number | null;
  key_systems: KeySystem[] | null;
  sectors: number;
  sectors_done: number;
  center: XYZ;
  /** Система-центр кольца (переопределение; по умолчанию Sgr A*). */
  center_system: string | null;
  /** Смещение центра по оси Y, св.л. */
  height_offset: number | null;
  /** Наклон плоскости в градусах. */
  tilt_degrees: number | null;
  tilt_axis_degrees?: number | null;
  basis: { ux: number; uz: number };
  anchors: RingAnchor[];
  discovered: number;
  stats: RingStats | null;
  route: unknown;
  status: RingPlan['status'];
}

function rowToPlan(row: SessionRow, start: RingPoint): RingPlan {
  const center: RingPoint = row.center_system
    ? { name: row.center_system, x: Number(row.center.x), y: Number(row.center.y), z: Number(row.center.z), source: 'catalog' }
    : { name: 'Sagittarius A*', x: Number(row.center.x), y: Number(row.center.y), z: Number(row.center.z), source: 'catalog' };
  const heightOffset = Number(row.height_offset ?? 0);
  const tiltDegrees = Number(row.tilt_degrees ?? 0);
  const tiltAxisDegrees = Number(row.tilt_axis_degrees ?? 0);
  const ringCenter = { name: center.name, x: center.x, y: center.y + heightOffset, z: center.z, source: center.source };
  const basis3D = ringBasis3D(start, ringCenter, (tiltDegrees * Math.PI) / 180, (tiltAxisDegrees * Math.PI) / 180);
  return {
    sessionId: row.id,
    start,
    center,
    basis: { ux: Number(row.basis.ux), uz: Number(row.basis.uz) },
    basis3D,
    ringRadius: Number(row.ring_radius),
    searchRadius: Number(row.search_radius),
    heightOffset,
    tiltDegrees,
    tiltAxisDegrees,
    ringCenter,
    deviationLimit: Number(row.deviation_limit) || ANCHOR_DEVIATION_LIMIT,
    keySystems: Array.isArray(row.key_systems) ? row.key_systems : [],
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

/** Итог сессии кольца: маршрут и параметры без повторного поиска. */
export interface RingSessionRoute {
  sessionId: string;
  start: string;
  center: XYZ;
  ringRadius: number;
  searchRadius: number;
  route: RingPoint[];
  anchors: RingAnchor[];
  status: RingPlan['status'];
}

/**
 * Сохранённый маршрут готовой сессии.
 *
 * Отдельно от `loadRingSession`: здесь не нужно разрешать координаты стартовой
 * системы (это сетевой/БД-запрос), а сам маршрут читается прямо из строки
 * сессии — так сохранение кольца в проект не гоняет клиента с телом на 10 000
 * точек и не пересчитывает кольцо заново.
 */
export async function loadRingRoute(sessionId: string): Promise<RingSessionRoute | null> {
  const { data, error } = await supabaseAdmin
    .from('atlas_ring_sessions')
    .select('id,start_system,center,ring_radius,search_radius,route,anchors,status')
    .eq('id', sessionId)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as unknown as SessionRow & { route: unknown };
  const route = Array.isArray(row.route) ? (row.route as RingPoint[]) : [];
  return {
    sessionId: row.id,
    start: row.start_system,
    center: { x: Number(row.center.x), y: Number(row.center.y), z: Number(row.center.z) },
    ringRadius: Number(row.ring_radius),
    searchRadius: Number(row.search_radius),
    route,
    anchors: Array.isArray(row.anchors) ? row.anchors : [],
    status: row.status,
  };
}

/** Создание новой сессии: координаты, базис, число сегментов. */
export async function planRingSession(
  config: {
    startSystem: string;
    ringRadius?: number;
    searchRadius?: number;
    /** Пользовательский допуск отклонения от окружности (св.л). */
    deviationLimit?: number | null;
    /** Имена обязательных (ключевых) систем, через которые пройдёт маршрут. */
    keySystems?: string[] | null;
    /** Переопределение центра кольца (по умолчанию — Sagittarius A*). */
    centerSystem?: string | null;
    /** Высотное смещение центра кольца относительно галактической плоскости (св.л). */
    heightOffset?: number | null;
    /** Наклон плоскости кольца в градусах (0=плоское, 90=перпендикулярно). */
    tiltDegrees?: number | null;
    /** Азимут горизонтальной оси наклона относительно направления к старту (0..360°). */
    tiltAxisDegrees?: number | null;
  },
  userId?: string | null,
): Promise<RingPlan> {
  const startName = String(config.startSystem || '').trim();
  if (!startName) throw new Error('Не указана начальная система кольца');

  const ringRadius = Math.min(MAX_RING_RADIUS, Math.max(MIN_RING_RADIUS, Number(config.ringRadius) || DEFAULT_RING_RADIUS));
  const searchRadius = Math.min(MAX_SEARCH_RADIUS, Math.max(MIN_SEARCH_RADIUS, Number(config.searchRadius) || DEFAULT_SEARCH_RADIUS));
  const deviationLimit = Math.min(ANCHOR_DEVIATION_LIMIT * 4, Math.max(10, Math.round(Number(config.deviationLimit) || ANCHOR_DEVIATION_LIMIT)));

  const centerSystemName = String(config.centerSystem || '').trim();
  const tiltDegrees = Math.min(MAX_TILT_DEGREES, Math.max(MIN_TILT_DEGREES, Number(config.tiltDegrees) || 0));
  const rawAxis = Number(config.tiltAxisDegrees) || 0;
  const tiltAxisDegrees = Number.isFinite(rawAxis) ? ((rawAxis % 360) + 360) % 360 : 0;
  const requestedHeight = Number(config.heightOffset) || 0;
  // Центр системы может быть уже не в галактической плоскости (пользовательский центр);
  // выясним его координаты заранее, чтобы ограничить высоту с учётом этого.
  // Разрешаем центр заранее (он нужен и ниже).
  const sgrA = await resolveRingSystem('Sagittarius A*');
  if (!sgrA) throw new Error('Не удалось получить координаты Sagittarius A*');
  let customCenter: RingPoint | null = null;
  if (centerSystemName && normalizeNameForCompare(centerSystemName) !== 'sagittarius a*') {
    const resolved = await resolveRingSystem(centerSystemName).catch(() => null);
    if (!resolved) throw new Error(`Не удалось получить координаты центра — системы «${centerSystemName}»`);
    customCenter = { ...resolved, source: 'catalog' };
  }
  const baseCenter = customCenter || { ...sgrA, source: 'catalog', name: 'Sagittarius A*' };
  // При наклоне проекция на ось Y растёт. Точки кольца имеют y-координаты:
  // Вертикальный размах при любой оси наклона: ±R·abs(sin(tilt)).
  // Чтобы все точки кольца умещались в ±GALACTIC_DISK_HALF_THICKNESS св.л. от галактической плоскости (y=0),
  // ограничиваем heightOffset. Если кольцо шире диска, располагаем центр
  // максимально близко к плоскости: полностью уместить такое кольцо нельзя.
  const heightOffset = ringHeightOffset(baseCenter.y, ringRadius, tiltDegrees, requestedHeight);
  if (Math.abs(requestedHeight - heightOffset) > 0.5) {
    console.warn(`[ring] высотное смещение ${requestedHeight} св.л ограничено ${heightOffset} (учтён наклон ${tiltDegrees}°, предел диска ±${GALACTIC_DISK_HALF_THICKNESS} св.л)`);
  }

  const start = await resolveRingSystem(startName);
  if (!start) throw new Error(`Не удалось получить координаты системы «${startName}»`);

  // Центр уже выбран выше (sgrA / customCenter).
  const center: RingPoint = { ...baseCenter };

  // Разрешаем координаты ключевых систем (параллельно, но не больше 8 сразу).
  const keySystemNames = Array.from(new Set(
    (Array.isArray(config.keySystems) ? config.keySystems : [])
      .map((name) => String(name || '').trim())
      .filter((name) => name && normalizeNameForCompare(name) !== normalizeNameForCompare(startName)),
  ));
  const keySystems: KeySystem[] = [];
  const keyChunks: string[][] = [];
  for (let i = 0; i < keySystemNames.length; i += 6) keyChunks.push(keySystemNames.slice(i, i + 6));
  for (const chunk of keyChunks) {
    const resolved = await Promise.all(chunk.map((name) => resolveRingSystem(name).catch(() => null)));
    resolved.forEach((point, index) => {
      if (point) keySystems.push({ name: point.name, x: point.x, y: point.y, z: point.z });
      else console.warn(`[ring] ключевая система «${chunk[index]}» не найдена, пропускаем`);
    });
  }

  const ringCenter: RingPoint = {
    ...center,
    y: center.y + heightOffset,
  };
  const basis = ringBasis(start, ringCenter);
  const basis3D = ringBasis3D(start, ringCenter, (tiltDegrees * Math.PI) / 180, (tiltAxisDegrees * Math.PI) / 180);
  const sectors = computeSectorCount(ringRadius);

  const stats: RingStats = { ...EMPTY_STATS, sectors, systemsFound: 0 };
  const { data, error } = await supabaseAdmin
    .from('atlas_ring_sessions')
    .insert({
      created_by: userId || null,
      start_system: start.name,
      ring_radius: ringRadius,
      search_radius: searchRadius,
      deviation_limit: deviationLimit === ANCHOR_DEVIATION_LIMIT ? null : deviationLimit,
      key_systems: keySystems.length > 0 ? keySystems : null,
      center_system: centerSystemName || null,
      height_offset: heightOffset === 0 ? null : heightOffset,
      tilt_degrees: tiltDegrees === 0 ? null : tiltDegrees,
      tilt_axis_degrees: tiltAxisDegrees === 0 ? null : tiltAxisDegrees,
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

  // Кэшируем начальную систему, центр и ключевые системы.
  const toCache: Array<{ name: string; x: number; y: number; z: number; source: string }> = [
    { name: start.name, x: start.x, y: start.y, z: start.z, source: start.source || 'edsm' },
    { name: center.name, x: center.x, y: center.y, z: center.z, source: center.source || 'edsm' },
    ...keySystems.map((ks) => ({ name: ks.name, x: ks.x, y: ks.y, z: ks.z, source: 'start' })),
  ];
  await saveCachedSystems(toCache).catch(() => 0);

  return {
    sessionId: String(data.id),
    start: { ...start, source: 'start' },
    center: { ...center, source: 'catalog' },
    basis,
    basis3D,
    ringRadius,
    searchRadius,
    heightOffset,
    tiltDegrees,
    tiltAxisDegrees,
    ringCenter,
    deviationLimit,
    keySystems,
    sectors,
    sectorsDone: 0,
    anchors: [],
    stats,
    status: 'scanning',
  };
}

function normalizeNameForCompare(name: string): string {
  return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Сброс сессии для повторного прогона (уточнения) с новыми параметрами.
 * Сбрасывает anchors и sectorsDone в 0, но сохраняет центр/базис/стартовую систему.
 * Позволяет изменить допуск отклонения и добавить ключевые системы без
 * создания совершенно новой сессии.
 */
export async function replanRingSession(
  sessionId: string,
  updates: {
    deviationLimit?: number | null;
    additionalKeySystems?: string[] | null;
    searchRadius?: number | null;
  } = {},
): Promise<RingPlan> {
  const session = await loadRingSession(sessionId);
  if (!session) throw new Error('Сессия поиска кольца не найдена');

  // Объединяем ключевые системы: старые + новые (без дубликатов).
  const existingNames = new Set(session.keySystems.map((ks) => normalizeNameForCompare(ks.name)));
  existingNames.add(normalizeNameForCompare(session.start.name));
  const addedKeySystems: KeySystem[] = [];
  const newNames = Array.isArray(updates.additionalKeySystems)
    ? Array.from(new Set(updates.additionalKeySystems.map((name) => String(name || '').trim()).filter(Boolean)))
    : [];
  for (const name of newNames) {
    if (existingNames.has(normalizeNameForCompare(name))) continue;
    const resolved = await resolveRingSystem(name).catch(() => null);
    if (resolved) {
      addedKeySystems.push({ name: resolved.name, x: resolved.x, y: resolved.y, z: resolved.z });
      existingNames.add(normalizeNameForCompare(resolved.name));
    }
  }
  const mergedKeySystems = [...session.keySystems, ...addedKeySystems];

  const newDeviationLimit = updates.deviationLimit != null
    ? Math.min(ANCHOR_DEVIATION_LIMIT * 4, Math.max(10, Math.round(Number(updates.deviationLimit))))
    : session.deviationLimit;

  const newSearchRadius = updates.searchRadius != null
    ? Math.min(MAX_SEARCH_RADIUS, Math.max(MIN_SEARCH_RADIUS, Math.round(Number(updates.searchRadius))))
    : session.searchRadius;

  const stats: RingStats = { ...EMPTY_STATS, sectors: session.sectors, systemsFound: session.stats.systemsFound };

  // Сбрасываем anchors/sectorsDone, оставляем накопленную статистику найденных систем.
  const { error } = await supabaseAdmin
    .from('atlas_ring_sessions')
    .update({
      anchors: [],
      sectors_done: 0,
      route: null,
      stats,
      status: 'scanning',
      deviation_limit: newDeviationLimit === ANCHOR_DEVIATION_LIMIT ? null : newDeviationLimit,
      search_radius: newSearchRadius,
      key_systems: mergedKeySystems.length > 0 ? mergedKeySystems : null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', sessionId);
  if (error) throw new Error(`Не удалось сбросить сессию для повтора: ${error.message}`);

  // Кэшируем новые ключевые системы.
  if (addedKeySystems.length > 0) {
    await saveCachedSystems(
      addedKeySystems.map((ks) => ({ name: ks.name, x: ks.x, y: ks.y, z: ks.z, source: 'start' })),
    ).catch(() => 0);
  }

  return {
    ...session,
    anchors: [],
    sectorsDone: 0,
    keySystems: mergedKeySystems,
    deviationLimit: newDeviationLimit,
    searchRadius: newSearchRadius,
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
  /** Центр кольца в пространстве (с учётом высотного смещения). */
  ringCenter: XYZ;
  /** 3D-базис наклонённого кольца. */
  basis3D: RingBasis3D;
  ringRadius: number;
  searchRadius: number;
  /** Допуск отклонения от окружности (св.л); для уточнения может быть больше/меньше 100. */
  deviationLimit: number;
  /** Предыдущая опора кольца (не старт): от неё считается шаг 480–490. */
  previous: XYZ | null;
  /** Первая опора — только на последнем сегменте, чтобы кольцо замкнулось в пределах 500. */
  closing: XYZ | null;
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
 * окружности не больше deviationLimit и шаг от предыдущей опоры не больше 500.
 * Внутри допустимых — приоритет: отклонение ≤ 50 и шаг 480–490, затем близость
 * шага к 485, затем близость к цели сектора.
 */
export function chooseAnchor(input: {
  target: XYZ;
  ringCenter: XYZ;
  basis3D: RingBasis3D;
  ringRadius: number;
  deviationLimit?: number;
  previous: XYZ | null;
  /** Первая опора кольца: последний сегмент не должен оставить замыкающий шаг больше 500. */
  closing?: XYZ | null;
  candidates: RingPoint[];
  used: Set<string>;
}): AnchorCandidate | null {
  const devLimit = input.deviationLimit ?? ANCHOR_DEVIATION_LIMIT;
  const preferred = Math.min(ANCHOR_DEVIATION_PREFERRED, devLimit);
  let best: AnchorCandidate | null = null;
  for (const system of input.candidates) {
    const key = system.name.toLowerCase();
    if (input.used.has(key)) continue;
    const deviation = ringDeviation3D(system, input.ringCenter, input.basis3D, input.ringRadius);
    if (deviation > devLimit) continue;
    const spacing = input.previous ? distance3(system, input.previous) : null;
    if (spacing !== null && (spacing > ANCHOR_SPACING_LIMIT || spacing < 1)) continue;
    const closingSpacing = input.closing ? distance3(system, input.closing) : null;
    if (closingSpacing !== null && closingSpacing < 1) continue;
    const spacingOk = spacing === null || (spacing >= ANCHOR_SPACING_MIN && spacing <= ANCHOR_SPACING_MAX);
    const tier = (deviation > preferred ? 1 : 0) + (spacingOk ? 0 : 2);
    const spacingPenalty = spacing === null ? 0 : Math.abs(spacing - ANCHOR_SPACING_TARGET) * 1000;
    const closingPenalty = closingSpacing === null ? 0 : Math.abs(closingSpacing - ANCHOR_SPACING_TARGET);
    const score = tier * 1e7 + spacingPenalty + closingPenalty + distance3(system, input.target);
    if (!best || score < best.score) best = { system, deviation, spacing, tier, score };
  }
  return best;
}

/**
 * Расчётная опора: точка на окружности. Если шаг от предыдущей опоры вне
 * 480–490, сдвигаем её по окружности к 485 (запасной предел — 499.95), чтобы
 * промежуток не выпал из диапазона и не перешагнул 500. Замыкание на первую
 * опору учитывается, только если не рвёт шаг от предыдущей.
 */
function triangulatedAnchorPosition(geometry: AnchorGeometry): XYZ {
  const { target, previous, closing, ringCenter, basis3D, ringRadius, angle } = geometry;
  const onTarget = { x: target.x, y: target.y, z: target.z };
  if (!previous) return onTarget;

  const spacing = distance3(previous, onTarget);
  const closingOk = !closing || distance3(onTarget, closing) <= ANCHOR_SPACING_LIMIT;
  if (spacing >= ANCHOR_SPACING_MIN && spacing <= ANCHOR_SPACING_MAX && closingOk) return onTarget;

  // Вне 480–490 (или дальше 500 от первой опоры) ставим точку на окружности
  // с нужным шагом, ближайшую к углу сектора. 499.95, а не ровно 500: иначе
  // округление выталкивает шаг за жёсткий предел. Замыкание не имеет права
  // отодвинуть точку так, что шаг от предыдущей опоры станет больше 500.
  const safe = ANCHOR_SPACING_LIMIT - 0.05;
  const pull = (distance: number) => ringPointAtDistance(ringCenter, basis3D, ringRadius, previous, angle, distance);
  for (const distance of [ANCHOR_SPACING_TARGET, ANCHOR_SPACING_MAX, safe]) {
    const point = pull(distance);
    if (!point || distance3(point, previous) > ANCHOR_SPACING_LIMIT) continue;
    if (closing && distance3(point, closing) > ANCHOR_SPACING_LIMIT) continue;
    return point;
  }
  for (const distance of [ANCHOR_SPACING_TARGET, ANCHOR_SPACING_MAX, safe]) {
    const point = pull(distance);
    if (point && distance3(point, previous) <= ANCHOR_SPACING_LIMIT) return point;
  }
  return onTarget;
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
/**
 * Поиск ближайшей неиспользованной ключевой системы к цели сегмента.
 * Возвращает систему только если она лежит в окне `maxDistance` от цели сегмента
 * и ещё не использована в маршруте — это гарантирует, что ключевые точки
 * расставляются вдоль кольца, а не сбиваются в кучу у первой же опоры.
 */
function findNearestKeySystem(
  keySystems: KeySystem[],
  target: XYZ,
  usedNames: Set<string>,
  maxDistance: number,
): KeySystem | null {
  let best: { system: KeySystem; distance: number } | null = null;
  for (const ks of keySystems) {
    const key = ks.name.toLowerCase();
    if (usedNames.has(key)) continue;
    const d = distance3(ks, target);
    if (d > maxDistance) continue;
    if (!best || d < best.distance) best = { system: ks, distance: d };
  }
  return best ? best.system : null;
}

/** Форсированная опора: ключевая система принудительно становится опорой в этом сегменте. */
function forcedAnchor(
  keySystem: KeySystem,
  target: XYZ,
  ringCenter: XYZ,
  basis3D: RingBasis3D,
  ringRadius: number,
): PickedAnchor {
  const deviation = ringDeviation3D(keySystem, ringCenter, basis3D, ringRadius);
  return {
    anchor: {
      name: keySystem.name,
      x: keySystem.x,
      y: keySystem.y,
      z: keySystem.z,
      source: 'catalog', // Ключевая система — реальная система из каталога/кэша.
      isAnchor: true,
      deviation,
      target,
      found: 0,
      usedRadius: 0,
    },
    systems: [],
    catalogHits: 0,
    cacheHits: 0,
    reused: 0,
  };
}

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
      ringCenter: geometry.ringCenter,
      basis3D: geometry.basis3D,
      ringRadius: geometry.ringRadius,
      deviationLimit: geometry.deviationLimit,
      previous: geometry.previous,
      closing: geometry.closing,
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
      deviation: ringDeviation3D(position, geometry.ringCenter, geometry.basis3D, geometry.ringRadius),
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
    const target = ringTarget(session.center, session.basis3D, session.ringRadius, sector, session.sectors, session.ringCenter);
    beam = target;
    const previousAnchor = anchors.length > 0 ? anchors[anchors.length - 1] : null;

    // Ключевые (обязательные) системы: если есть неиспользованная ключевая система
    // рядом с этим сектором (в пределах удвоенного окна поиска), форсируем её как
    // опору — маршрут обязан пройти через неё.
    const forcedKey = findNearestKeySystem(session.keySystems, target, usedNames, session.searchRadius * 1.5);

    const picked = forcedKey
      ? forcedAnchor(forcedKey, target, session.ringCenter, session.basis3D, session.ringRadius)
      : await pickAnchor(
        {
          target,
          angle: (2 * Math.PI * sector) / session.sectors,
          ringCenter: session.ringCenter,
          basis3D: session.basis3D,
          ringRadius: session.ringRadius,
          searchRadius: session.searchRadius,
          deviationLimit: session.deviationLimit,
          previous: previousAnchor ? { x: previousAnchor.x, y: previousAnchor.y, z: previousAnchor.z } : null,
          closing: sector === session.sectors - 1 && anchors.length > 0
            ? { x: anchors[0].x, y: anchors[0].y, z: anchors[0].z }
            : null,
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
  /**
   * Если задано, расчётная точка, вылезшая из допуска отклонения, подтягивается
   * к оси кольца. Для подхода к старту не используется: старт не на окружности.
   */
  ring: { ringCenter: XYZ; basis3D: RingBasis3D; radius: number; limit: number } | null;
  /** После этого момента разрыв закрывается прямой, без перебора пула. */
  deadline?: number;
}

interface SpatialGrid {
  cell: number;
  buckets: Map<string, RingPoint[]>;
}

function buildSpatialGrid(points: RingPoint[], cell: number): SpatialGrid {
  const buckets = new Map<string, RingPoint[]>();
  for (const point of points) {
    const key = `${Math.floor(point.x / cell)},${Math.floor(point.y / cell)},${Math.floor(point.z / cell)}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(point);
    else buckets.set(key, [point]);
  }
  return { cell, buckets };
}

function queryGrid(grid: SpatialGrid, origin: XYZ, radius: number): RingPoint[] {
  const { cell, buckets } = grid;
  const x0 = Math.floor((origin.x - radius) / cell);
  const x1 = Math.floor((origin.x + radius) / cell);
  const y0 = Math.floor((origin.y - radius) / cell);
  const y1 = Math.floor((origin.y + radius) / cell);
  const z0 = Math.floor((origin.z - radius) / cell);
  const z1 = Math.floor((origin.z + radius) / cell);
  const radiusSquared = radius * radius + 1e-6;
  const found: RingPoint[] = [];
  for (let ix = x0; ix <= x1; ix++) {
    for (let iy = y0; iy <= y1; iy++) {
      for (let iz = z0; iz <= z1; iz++) {
        const bucket = buckets.get(`${ix},${iy},${iz}`);
        if (!bucket) continue;
        for (const point of bucket) {
          const dx = point.x - origin.x;
          const dy = point.y - origin.y;
          const dz = point.z - origin.z;
          if (dx * dx + dy * dy + dz * dz <= radiusSquared) found.push(point);
        }
      }
    }
  }
  return found;
}

/**
 * Если пул раздулся делением проб, оставляем системы равномерно вдоль хорды,
 * а не только самые близкие к середине: иначе концы снова закроются расчётом.
 */
function capPoolAlongSegment(pool: RingPoint[], from: XYZ, to: XYZ, cap: number): RingPoint[] {
  if (pool.length <= cap) return pool;
  const bins = 16;
  const buckets: RingPoint[][] = Array.from({ length: bins }, () => []);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const lengthSquared = dx * dx + dy * dy + dz * dz || 1;
  for (const point of pool) {
    const t = ((point.x - from.x) * dx + (point.y - from.y) * dy + (point.z - from.z) * dz) / lengthSquared;
    const bin = Math.max(0, Math.min(bins - 1, Math.floor(t * bins)));
    buckets[bin].push(point);
  }
  const perBin = Math.ceil(cap / bins);
  const kept: RingPoint[] = [];
  for (const bucket of buckets) {
    bucket.sort((left, right) => distanceToSegment(left, from, to) - distanceToSegment(right, from, to));
    kept.push(...bucket.slice(0, perBin));
  }
  return kept;
}

/**
 * Подтянуть точку к окружности наклонённого кольца, не выходя за допуск отклонения.
 * Проецируем вектор точки от ringCenter на плоскость кольца, масштабируем радиус
 * и компоненту по нормали линейно так, чтобы итоговое отклонение стало ≤ limit.
 */
function clampToDeviation3D(
  point: RingPoint,
  ringCenter: XYZ,
  basis: RingBasis3D,
  ringRadius: number,
  limit: number,
): RingPoint {
  const dx = point.x - ringCenter.x;
  const dy = point.y - ringCenter.y;
  const dz = point.z - ringCenter.z;
  const a = dx * basis.ux + dy * basis.uy + dz * basis.uz;
  const b = dx * basis.vx + dy * basis.vy + dz * basis.vz;
  const c = dx * basis.nx + dy * basis.ny + dz * basis.nz;
  const r = Math.hypot(a, b);
  const deviation = Math.hypot(r - ringRadius, c);
  if (deviation <= limit || deviation < 1e-9) return point;
  const scale = limit / deviation;
  const newR = ringRadius + (r - ringRadius) * scale;
  const newC = c * scale;
  const newA = r > 1e-9 ? (a / r) * newR : newR;
  const newB = r > 1e-9 ? (b / r) * newR : 0;
  return {
    ...point,
    x: ringCenter.x + newA * basis.ux + newB * basis.vx + newC * basis.nx,
    y: ringCenter.y + newA * basis.uy + newB * basis.vy + newC * basis.ny,
    z: ringCenter.z + newA * basis.uz + newB * basis.vz + newC * basis.nz,
  };
}

/** Устаревшая 2D-обёртка (для обратной совместимости). */
function clampToDeviation(point: RingPoint, center: XYZ, ringRadius: number, limit: number): RingPoint {
  const dx = point.x - center.x;
  const dz = point.z - center.z;
  const horizontal = Math.hypot(dx, dz);
  const y = point.y - center.y;
  const dev = Math.hypot(horizontal - ringRadius, y);
  if (dev <= limit || dev < 1e-9) return point;
  const scale = limit / dev;
  const newHorizontal = ringRadius + (horizontal - ringRadius) * scale;
  const nx = horizontal > 1e-9 ? dx / horizontal : 1;
  const nz = horizontal > 1e-9 ? dz / horizontal : 0;
  return {
    ...point,
    x: center.x + nx * (horizontal > 1e-9 ? newHorizontal : ringRadius),
    y: center.y + y * scale,
    z: center.z + nz * (horizontal > 1e-9 ? newHorizontal : 0),
  };
}

/** Добить отрезок расчётными точками по прямой. Нужно, когда бюджет сборки кончился. */
function fillStraight(current: RingPoint, to: XYZ, context: BridgeContext, clamp: boolean): RingPoint[] {
  const points: RingPoint[] = [];
  let cursor: RingPoint = current;
  let guard = 0;
  while (distance3(cursor, to) > context.maxJump && guard++ < 8000) {
    const remaining = distance3(cursor, to);
    const synthetic = syntheticToward(cursor, to, context, clamp);
    if (distance3(synthetic, to) >= remaining - 1e-9) break;
    points.push(synthetic);
    cursor = synthetic;
  }
  return points;
}

function syntheticToward(current: XYZ, aim: XYZ, context: BridgeContext, clamp: boolean): RingPoint {
  const remaining = distance3(current, aim);
  let hop: number;
  if (remaining > 2 * context.syntheticStep) {
    hop = context.syntheticStep;
  } else {
    const parts = Math.max(1, Math.ceil(remaining / context.maxJump));
    hop = remaining / parts;
  }
  hop = Math.min(hop, context.maxJump, remaining);
  const ratio = remaining > 1e-12 ? hop / remaining : 0;
  let synthetic: RingPoint = {
    name: `RING TRIANGULATED ${context.syntheticCounter.next()}`,
    x: current.x + (aim.x - current.x) * ratio,
    y: current.y + (aim.y - current.y) * ratio,
    z: current.z + (aim.z - current.z) * ratio,
    source: 'triangulated',
  };
  if (clamp && context.ring) {
    const clamped = clampToDeviation3D(synthetic, context.ring.ringCenter, context.ring.basis3D, context.ring.radius, context.ring.limit);
    if (distance3(current, clamped) <= context.maxJump + 1e-6) synthetic = clamped;
  }
  return synthetic;
}

function shortcutPath(origin: RingPoint, path: RingPoint[], maxJump: number): RingPoint[] {
  if (path.length <= 1) return path;
  const chain = [origin, ...path];
  const kept: RingPoint[] = [];
  let index = 0;
  while (index < chain.length - 1) {
    let farthest = index + 1;
    for (let next = chain.length - 1; next > index + 1; next--) {
      if (distance3(chain[index], chain[next]) <= maxJump) {
        farthest = next;
        break;
      }
    }
    kept.push(chain[farthest]);
    index = farthest;
  }
  return kept;
}

/**
 * Связный остров реальных систем от `current`. Выход — система острова,
 * ближайшая к цели: так тупик в одном прыжке не перекрывает цепочку, которая
 * доводит дальше. Промежуточные точки острова можно срезать, если прыжок
 * позволяет — колонизировать нужно системы, а не каждый короткий шаг.
 */
function takeIsland(
  current: RingPoint,
  to: XYZ,
  grid: SpatialGrid,
  used: Set<string>,
  seen: Set<string>,
  maxJump: number,
): RingPoint[] {
  const parent = new Map<RingPoint, RingPoint | null>();
  const visited = new Set<string>();
  parent.set(current, null);
  visited.add(current.name.toLowerCase());

  const queue: RingPoint[] = [current];
  let head = 0;
  let best: RingPoint | null = null;
  let bestRemaining = distance3(current, to);

  while (head < queue.length) {
    const node = queue[head++];
    for (const candidate of queryGrid(grid, node, maxJump)) {
      const key = candidate.name.toLowerCase();
      if (visited.has(key) || used.has(key) || seen.has(key)) continue;
      const step = distance3(node, candidate);
      if (step > maxJump || step < 0.001) continue;
      visited.add(key);
      parent.set(candidate, node);
      queue.push(candidate);
      const toGoal = distance3(candidate, to);
      if (toGoal < bestRemaining - 1e-3) {
        best = candidate;
        bestRemaining = toGoal;
      }
    }
  }
  // Остров больше не перебираем: повторный обход тех же тысяч систем на каждом
  // прыжке не укладывает сборку длинного кольца в таймаут запроса.
  for (const key of visited) seen.add(key);
  if (!best) return [];

  const path: RingPoint[] = [];
  let cursor: RingPoint | null = best;
  while (cursor && cursor !== current) {
    path.push(cursor);
    cursor = parent.get(cursor) ?? null;
  }
  path.reverse();
  return shortcutPath(current, path, maxJump);
}

/**
 * Ближайшая реальная система впереди, до которой не дотягивается один прыжок.
 * Расчётный шаг наводится на неё, а не на пустую прямую к цели: иначе система
 * в коридоре, но чуть в стороне от хорды, остаётся за бортом.
 */
function findSteerTarget(
  current: XYZ,
  to: XYZ,
  grid: SpatialGrid,
  used: Set<string>,
  maxJump: number,
  steerReach: number,
  remaining: number,
): RingPoint | null {
  const candidates = queryGrid(grid, current, Math.min(steerReach, Math.max(maxJump, remaining)));
  let best: RingPoint | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    if (used.has(candidate.name.toLowerCase())) continue;
    const gap = distance3(current, candidate);
    if (gap <= maxJump || gap < 0.001) continue;
    const toGoal = distance3(candidate, to);
    if (toGoal >= remaining - 1) continue;
    const hops = Math.ceil(gap / maxJump);
    const score = hops * 1e6 + toGoal;
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Цепочка реальных систем от `from` до `to`. Сами концы в цепочку не входят.
 *
 * Приоритет: реальные системы (каталог, кэш, EDSM, Spansh) важнее расчётных точек.
 * Сначала забираем весь остров систем, достижимых прыжком не длиннее maxJump
 * внутри коридора, и выходим из него там, где ближе к цели. Расчётная точка —
 * только если такого острова нет, и ставится она по направлению к следующей
 * реальной системе, а не в пустоту. Если подходящих систем в коридоре нет,
 * участок триангулируется. Это нормально: галактика не полностью исследована,
 * и позже открытые системы попадут в зону поиска — маршрут можно собрать заново.
 */
function bridgeSegment(
  from: RingPoint,
  to: RingPoint,
  pool: RingPoint[],
  used: Set<string>,
  context: BridgeContext,
  clampDeviation = false,
): RingPoint[] {
  const points: RingPoint[] = [];
  const maxJump = context.maxJump;
  const fromKey = from.name.toLowerCase();
  const toKey = to.name.toLowerCase();
  const eligible: RingPoint[] = [];
  for (const candidate of pool) {
    if (!candidate.name) continue;
    const key = candidate.name.toLowerCase();
    if (key === fromKey || key === toKey || used.has(key)) continue;
    if (distanceToSegment(candidate, from, to) > context.corridor) continue;
    eligible.push(candidate);
  }
  const grid = buildSpatialGrid(
    capPoolAlongSegment(eligible, from, to, BRIDGE_POOL_CAP),
    maxJump,
  );
  const steerReach = Math.max(maxJump * 2, context.corridor + maxJump);
  const seen = new Set<string>([fromKey, toKey]);

  let current: RingPoint = from;
  let guard = 0;
  while (distance3(current, to) > maxJump && guard++ < 12000) {
    if (context.deadline && Date.now() > context.deadline) {
      points.push(...fillStraight(current, to, context, clampDeviation));
      break;
    }
    const remaining = distance3(current, to);
    const island = takeIsland(current, to, grid, used, seen, maxJump);
    if (island.length > 0) {
      for (const step of island) {
        used.add(step.name.toLowerCase());
        points.push({
          name: step.name,
          x: step.x,
          y: step.y,
          z: step.z,
          source: step.source || 'cache',
        });
      }
      current = island[island.length - 1];
      continue;
    }

    const steer = findSteerTarget(current, to, grid, used, maxJump, steerReach, remaining);
    let synthetic = syntheticToward(current, steer ?? to, context, clampDeviation);
    if (distance3(synthetic, to) >= remaining - 1e-6) {
      synthetic = syntheticToward(current, to, context, clampDeviation);
    }
    if (distance3(synthetic, to) >= remaining - 1e-9) break;
    points.push(synthetic);
    current = synthetic;
  }

  // Предохранитель: если поиск зациклился, добрать прямыми точками до цели.
  let emergency = 0;
  while (distance3(current, to) > maxJump && emergency++ < 8000) {
    const remaining = distance3(current, to);
    const synthetic = syntheticToward(current, to, context, clampDeviation);
    if (distance3(synthetic, to) >= remaining - 1e-9) break;
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
    ring: null,
  });
}

interface SegmentProbe {
  x: number;
  y: number;
  z: number;
  half: number;
  /** Доля отрезка, которую закрывает проба: [t0, t1] ⊂ [0, 1]. */
  t0: number;
  t1: number;
}

function childProbes(from: XYZ, to: XYZ, probe: SegmentProbe): SegmentProbe[] {
  const midT = (probe.t0 + probe.t1) / 2;
  const span = distance3(from, to) * (probe.t1 - probe.t0);
  const childHalf = span / 4 + ROUTE_CORRIDOR + 1;
  const make = (t0: number, t1: number): SegmentProbe => {
    const t = (t0 + t1) / 2;
    return {
      x: from.x + (to.x - from.x) * t,
      y: from.y + (to.y - from.y) * t,
      z: from.z + (to.z - from.z) * t,
      half: childHalf,
      t0,
      t1,
    };
  };
  return [make(probe.t0, midT), make(midT, probe.t1)];
}

/**
 * Пул систем для одного сегмента. Сначала одна проба на середину хорды. Если
 * каталог или кэш упёрлись в потолок ближайших систем, проба делится вдоль
 * отрезка: иначе в плотном районе 2000 систем сидят у середины, а концы
 * моста триангулируются при живых системах рядом. Пул режется коридором и
 * (кроме подхода к старту) допуском отклонения от кольца.
 */
async function collectSegmentPool(
  from: XYZ,
  to: XYZ,
  options: {
    catalogReady: boolean;
    deadline: number;
    ringCenter: XYZ;
    basis3D: RingBasis3D;
    ringRadius: number;
    approach: boolean;
    deviationLimit?: number;
    queries?: { count: number };
    queryCap?: number;
    queryTimeoutMs?: number;
  },
): Promise<RingPoint[]> {
  if (Date.now() >= options.deadline) return [];
  if (options.queries && options.queryCap && options.queries.count >= options.queryCap) return [];

  const length = distance3(from, to);
  const timeoutMs = options.queryTimeoutMs ?? DB_TIMEOUT_MS;
  const devLimit = options.deviationLimit ?? ANCHOR_DEVIATION_LIMIT;
  const byName = new Map<string, RingPoint>();
  const accept = (point: XYZ) =>
    distanceToSegment(point, from, to) <= ROUTE_CORRIDOR
    && (options.approach || ringDeviation3D(point, options.ringCenter, options.basis3D, options.ringRadius) <= devLimit);

  const queue: SegmentProbe[] = [{
    x: (from.x + to.x) / 2,
    y: (from.y + to.y) / 2,
    z: (from.z + to.z) / 2,
    half: length / 2 + ROUTE_CORRIDOR + 1,
    t0: 0,
    t1: 1,
  }];
  let queries = 0;

  while (queue.length > 0 && queries < SEGMENT_QUERY_BUDGET && Date.now() < options.deadline) {
    if (options.queries && options.queryCap && options.queries.count >= options.queryCap) break;
    const probe = queue.shift()!;
    queries++;
    if (options.queries) options.queries.count++;

    const catalogRows = options.catalogReady
      ? await withTimeout(
        findSystemsInCube({ x: probe.x, y: probe.y, z: probe.z, half: probe.half, limit: SEGMENT_QUERY_LIMIT })
          .catch(() => [] as Array<{ name: string; x: number; y: number; z: number }>),
        timeoutMs,
        [] as Array<{ name: string; x: number; y: number; z: number }>,
      )
      : [] as Array<{ name: string; x: number; y: number; z: number }>;
    // Кэш нужен, только если каталога нет или он пуст в этой пробе. Второй запрос
    // на каждый из сотен сегментов не успевает уложиться в ответ сборки.
    const wantCache = !options.catalogReady || catalogRows.length === 0;
    const cachedRows = wantCache
      ? await withTimeout(
        listCachedSystemsNear(probe, probe.half, SEGMENT_QUERY_LIMIT).catch(() => [] as CachedSystem[]),
        timeoutMs,
        [] as CachedSystem[],
      )
      : [] as CachedSystem[];

    for (const row of catalogRows) {
      if (!row.name || !accept(row)) continue;
      const key = row.name.toLowerCase();
      if (!byName.has(key)) byName.set(key, { name: row.name, x: row.x, y: row.y, z: row.z, source: 'catalog' });
    }
    for (const row of cachedRows) {
      const key = row.name.toLowerCase();
      if (byName.has(key) || !accept(row)) continue;
      byName.set(key, { name: row.name, x: row.x, y: row.y, z: row.z, source: 'cache' });
    }

    const saturated = options.catalogReady
      ? catalogRows.length >= SEGMENT_QUERY_LIMIT
      : cachedRows.length >= SEGMENT_QUERY_LIMIT;
    const span = length * (probe.t1 - probe.t0);
    if (saturated && span > SEGMENT_MIN_SPAN * 2 && queries < SEGMENT_QUERY_BUDGET) {
      queue.push(...childProbes(from, to, probe));
    }
  }

  return capPoolAlongSegment(Array.from(byName.values()), from, to, BRIDGE_POOL_CAP);
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
  ringCenter: XYZ;
  basis3D: RingBasis3D;
  ringRadius: number;
  start: XYZ;
}): RingValidation {
  const { route, approach, ringCenter, basis3D, ringRadius, start } = input;

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

  const anchorDeviations = anchors.map((anchor) => ringDeviation3D(anchor, ringCenter, basis3D, ringRadius));
  const anchorDeviationMax = anchorDeviations.length ? Math.max(...anchorDeviations) : 0;
  const anchorDeviationAvg = anchorDeviations.length
    ? anchorDeviations.reduce((sum, value) => sum + value, 0) / anchorDeviations.length
    : 0;

  let routeDeviationMax = 0;
  let deviationViolations = 0;
  route.forEach((point, index) => {
    if (approach[index]) return;
    const deviation = ringDeviation3D(point, ringCenter, basis3D, ringRadius);
    routeDeviationMax = Math.max(routeDeviationMax, deviation);
    if (deviation > ANCHOR_DEVIATION_LIMIT + 1e-6) deviationViolations++;
  });

  const startOffset = ringDeviation3D(start, ringCenter, basis3D, ringRadius);
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

/** Подход к старту и возврат: всё до первой опоры и после последней. */
function approachFlags(route: RingPoint[]): boolean[] {
  let first = -1;
  let last = -1;
  route.forEach((point, index) => {
    if (!point.isAnchor) return;
    if (first < 0) first = index;
    last = index;
  });
  if (first < 0) return route.map(() => true);
  return route.map((_, index) => index <= first || index >= last);
}

/**
 * Повтор сборки после обрыва ответа: маршрут уже лежит в сессии, заново
 * обходить каталог не нужно. Иначе повторный запрос снова упирается в таймаут.
 */
async function loadCompletedRing(sessionId: string): Promise<RingResult | null> {
  try {
    const { data, error } = await supabaseAdmin
      .from('atlas_ring_sessions')
      .select('id,start_system,center,center_system,height_offset,tilt_degrees,tilt_axis_degrees,ring_radius,search_radius,deviation_limit,key_systems,route,anchors,stats,status')
      .eq('id', sessionId)
      .maybeSingle();
    if (error || !data || data.status !== 'completed') return null;
    const route = Array.isArray(data.route) ? data.route as RingPoint[] : [];
    if (route.length < 3 || !routeIsClosed(route)) return null;
    const baseY = Number(data.center?.y);
    const heightOffset = Number((data as any).height_offset ?? 0);
    const tiltDegrees = Number((data as any).tilt_degrees ?? 0);
    const tiltAxisDegrees = Number((data as any).tilt_axis_degrees ?? 0);
    const center: RingPoint = {
      name: (data as any).center_system || 'Sagittarius A*',
      x: Number(data.center?.x),
      y: baseY,
      z: Number(data.center?.z),
      source: 'catalog' as const,
    };
    const ringRadius = Number(data.ring_radius);
    const start = route[0];
    const ringCenter: RingPoint = { ...center, y: baseY + heightOffset, name: center.name };
    const basis3D = ringBasis3D(start, ringCenter, (tiltDegrees * Math.PI) / 180, (tiltAxisDegrees * Math.PI) / 180);
    const anchors = Array.isArray(data.anchors) && data.anchors.length
      ? data.anchors as RingPoint[]
      : route.filter((point) => point.isAnchor);
    const keySystems = Array.isArray(data.key_systems) ? (data.key_systems as KeySystem[]) : [];
    const deviationLimit = Number(data.deviation_limit) || ANCHOR_DEVIATION_LIMIT;
    const stats: RingStats = { ...EMPTY_STATS, ...(data.stats || {}) };
    const validation = validateRingRoute({
      route,
      approach: approachFlags(route),
      ringCenter,
      basis3D,
      ringRadius,
      start,
    });
    const syntheticPoints = route.filter((point) => point.source === 'triangulated').length;
    return {
      sessionId,
      start: String(data.start_system || start.name),
      center,
      ringCenter,
      basis3D,
      heightOffset,
      tiltDegrees,
      tiltAxisDegrees,
      ringRadius,
      searchRadius: Number(data.search_radius),
      deviationLimit,
      keySystems,
      route,
      anchors,
      hubs: undefined,
      totals: {
        points: route.length,
        realPoints: route.length - syntheticPoints,
        syntheticPoints,
        anchors: anchors.length,
        triangulatedAnchors: anchors.filter((anchor) => anchor.source === 'triangulated').length,
        discovered: stats.systemsFound,
        deviationAvg: validation.anchorDeviationAvg,
        deviationMax: validation.anchorDeviationMax,
      },
      validation,
      stats,
    };
  } catch (error: any) {
    console.warn('[ring-finalize] не удалось прочитать готовый маршрут:', error?.message || error);
    return null;
  }
}

/** Сессия, у которой пройдены все сегменты, превращается в замкнутый маршрут. */
export async function finalizeRingSession(sessionId: string): Promise<RingResult> {
  const already = await loadCompletedRing(sessionId);
  if (already) return already;

  const session = await loadRingSession(sessionId);
  if (!session) throw new Error('Сессия поиска кольца не найдена');
  if (session.sectorsDone < session.sectors) {
    throw new Error(`Кольцо просканировано не полностью: ${session.sectorsDone} из ${session.sectors} сегментов`);
  }

  const stats: RingStats = { ...session.stats };
  const catalogReady = await isCatalogReady();
  const collectDeadline = Date.now() + FINALIZE_COLLECT_BUDGET_MS;

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
  const poolQueries = { count: 0 };
  const pools = await mapConcurrent(segments, FINALIZE_CONCURRENCY, (index) => collectSegmentPool(
    sequence[index],
    sequence[index + 1],
    {
      catalogReady,
      deadline: collectDeadline,
      ringCenter: session.ringCenter,
      basis3D: session.basis3D,
      ringRadius: session.ringRadius,
      approach: index === 0 || index === lastSegment,
      deviationLimit: session.deviationLimit,
      queries: poolQueries,
      queryCap: FINALIZE_QUERY_CAP,
      queryTimeoutMs: FINALIZE_DB_TIMEOUT_MS,
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
    ring: { ringCenter: session.ringCenter, basis3D: session.basis3D, radius: session.ringRadius, limit: session.deviationLimit || ANCHOR_DEVIATION_LIMIT },
    deadline: Date.now() + FINALIZE_BRIDGE_BUDGET_MS,
  };

  const route: RingPoint[] = [sequence[0]];
  const approach: boolean[] = [true];
  const segmentStats: { index: number; poolSize: number; triangulatedCount: number }[] = [];
  for (let index = 0; index < sequence.length - 1; index++) {
    const from = sequence[index];
    const to = sequence[index + 1];
    const touchesStart = index === 0 || index === lastSegment;
    if (distance3(from, to) <= MAX_JUMP) {
      route.push(to);
      approach.push(touchesStart);
      continue;
    }
    // Пул уже собран — не выбрасываем его из-за бюджета сбора. Если прокладка
    // одного сегмента затянется, мост сам закроет хвост прямой и оставит кольцо замкнутым.
    const pool = poolBySegment.get(index) || [];
    const bridge = bridgeSegment(from, to, pool, used, context, !touchesStart);
    const syntheticInSegment = bridge.filter((point) => point.source === 'triangulated').length;
    segmentStats.push({ index, poolSize: pool.length, triangulatedCount: syntheticInSegment });
    for (const point of bridge) {
      route.push(point);
      approach.push(touchesStart);
    }
    route.push(to);
    approach.push(touchesStart);
  }

  const triangulatedSegments = segmentStats.filter((stat) => stat.triangulatedCount > 0);
  if (triangulatedSegments.length > 0) {
    const worst = [...triangulatedSegments]
      .sort((left, right) => right.triangulatedCount - left.triangulatedCount)
      .slice(0, 6);
    console.warn(
      `[ring-finalize] расчётные точки в ${triangulatedSegments.length} из ${segmentStats.length} сегментов `
      + `(коридор ${ROUTE_CORRIDOR} св.л.; где системы не сомкнулись прыжком, участок триангулирован). `
      + `Худшие: ${worst.map((stat) => `#${stat.index}: пул ${stat.poolSize}, расчётных ${stat.triangulatedCount}`).join('; ')}`,
    );
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
  stats.bridgeCatalogRequests = poolQueries.count;
  stats.triangulatedSegments = triangulatedSegments.length;

  const validation = validateRingRoute({
    route: deduped,
    approach: dedupedApproach,
    ringCenter: session.ringCenter,
    basis3D: session.basis3D,
    ringRadius: session.ringRadius,
    start,
  });

  const deviations = anchors.map((anchor) => ringDeviation3D(anchor, session.ringCenter, session.basis3D, session.ringRadius));
  const deviationAvg = deviations.length > 0 ? deviations.reduce((sum, value) => sum + value, 0) / deviations.length : 0;
  const deviationMax = deviations.length > 0 ? Math.max(...deviations) : 0;

  const result: RingResult = {
    sessionId,
    start: session.start.name,
    center: session.center,
    ringCenter: session.ringCenter,
    basis3D: session.basis3D,
    heightOffset: session.heightOffset,
    tiltDegrees: session.tiltDegrees,
    tiltAxisDegrees: session.tiltAxisDegrees,
    ringRadius: session.ringRadius,
    searchRadius: session.searchRadius,
    deviationLimit: session.deviationLimit,
    keySystems: session.keySystems,
    route: deduped,
    anchors,
    hubs: undefined,
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

  // Сохранение не должно ронять уже собранный маршрут: клиенту важнее ответ,
  // чем запись в сессию. Повторный запрос прочитает её, если запись успела.
  try {
    const write = supabaseAdmin
      .from('atlas_ring_sessions')
      .update({
        route: result.route,
        stats,
        status: 'completed',
        updated_at: new Date().toISOString(),
      })
      .eq('id', sessionId);
    const saved = await withTimeout(
      write as unknown as PromiseLike<{ error: { message: string } | null }>,
      6_000,
      { error: { message: 'таймаут сохранения маршрута' } },
    );
    if (saved?.error) console.warn('[ring] не удалось сохранить маршрут кольца:', saved.error.message);
  } catch (error: any) {
    console.warn('[ring] сохранение маршрута прервано:', error?.message || error);
  }

  if (!routeIsClosed(deduped)) {
    console.warn('[ring-finalize] маршрут не замкнулся:', deduped.length, 'точек');
  }

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
