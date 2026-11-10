/**
 * Куда ведут кнопки и что включено на карте по умолчанию.
 *
 * Чистые функции без DOM и React: карта (`GalaxyMap`) только применяет их,
 * а `scripts/tests/map-layer-defaults.test.mjs` проверяет правила напрямую —
 * иначе «какие слои видны при открытии» пришлось бы ловить глазами.
 */

import { readableProgress, statusFromProgress } from './systemProgress.ts';

export type MapStatus = 'planned' | 'building' | 'done';

/** Статус системы: процент из Raven главнее записанного `status`. */
export function mapSystemStatus(item: { status?: unknown; progress?: unknown }): MapStatus {
  // A non-null percentage is the source of truth everywhere Raven data is
  // available. This protects marker color/filtering from legacy rows whose
  // stored status was not updated alongside their progress value.
  if (readableProgress(item.progress) != null) return statusFromProgress(item.progress);
  if (item.status === 'done' || item.status === 'building' || item.status === 'planned') return item.status;
  return 'planned';
}

/**
 * Что из слоёв карты включено при открытии (Atlas, 10.11.2026).
 *
 * Пилот просил почти пустую карту: видны только имена и границы секторов,
 * оранжевый пояс и туманности — остальное включается в панели слоёв.
 * Компактная «Карта кольца» (`/map`) — исключение: там сразу включён маршрут,
 * иначе страница открывалась бы пустой.
 */
export interface MapLayerDefaults {
  /** Маршрут и хабы (а с ними — статусы и хабы кольца). */
  knownSystems: boolean;
  projectRoute: boolean;
  atlasCandidates: boolean;
  pilots: boolean;
  marketResults: boolean;
  noMarketSystems: boolean;
  /** Имена секторов — единственный подписанный слой по умолчанию. */
  regionLabels: boolean;
  regionBoundaries: boolean;
  /** «Оранжевый пояс» — зона кольца. */
  ringZone: boolean;
  nebulae: boolean;
}

export const ATLAS_LAYER_DEFAULTS: MapLayerDefaults = {
  knownSystems: false,
  projectRoute: false,
  atlasCandidates: false,
  pilots: false,
  marketResults: false,
  noMarketSystems: false,
  regionLabels: true,
  regionBoundaries: true,
  ringZone: true,
  nebulae: true,
};

/** «Карта кольца» показывает свой маршрут сразу. */
export const RING_MAP_LAYER_DEFAULTS: MapLayerDefaults = {
  ...ATLAS_LAYER_DEFAULTS,
  knownSystems: true,
  projectRoute: true,
  atlasCandidates: true,
  pilots: true,
  marketResults: true,
  noMarketSystems: true,
};

export function mapLayerDefaults(compactMap: boolean): MapLayerDefaults {
  return compactMap ? RING_MAP_LAYER_DEFAULTS : ATLAS_LAYER_DEFAULTS;
}

/**
 * «Последняя стройка»: **последняя завершённая** система маршрута.
 *
 * Порядок завершения в кольце — это порядок маршрута (`sort_order`): системы
 * строят последовательно, поэтому дальняя завершённая и есть последняя
 * сданная. Дата завершения в данных карты не хранится (`system_progress`
 * знает лишь время последней синхронизации), поэтому сортировать по ней
 * нельзя — иначе кнопка уводила бы к случайной системе.
 *
 * Если завершённых нет — ведём к последней строящейся, затем к концу
 * маршрута: кнопка не должна молчать.
 */
export function lastBuildTarget<T extends { status?: unknown; progress?: unknown; sort_order?: unknown; id?: unknown }>(
  points: readonly T[],
): T | null {
  const byRoute = [...points].sort((left, right) => (
    Number(right.sort_order ?? 0) - Number(left.sort_order ?? 0)
    || Number(right.id ?? 0) - Number(left.id ?? 0)
  ));
  const lastOf = (status: MapStatus) => byRoute.find((point) => mapSystemStatus(point) === status) ?? null;
  return lastOf('done') ?? lastOf('building') ?? byRoute[0] ?? null;
}
