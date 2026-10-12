'use client';

/**
 * Подписка на канал прогресса поисковиков Atlas (см. lib/atlasSearchProgress).
 *
 * `useSyncExternalStore` берём, чтобы карта и панель видели одно и то же
 * состояние и не мигали при каждом пакете точек: React сам решает, когда
 * перерисовать подписчика.
 */

import { useSyncExternalStore } from 'react';
import {
  readAtlasSearchProgress,
  readAtlasSearchResult,
  subscribeAtlasSearchProgress,
  subscribeAtlasSearchResult,
  EMPTY_ATLAS_SEARCH_PROGRESS,
  type AtlasSearchProgress,
} from '@/lib/atlasSearchProgress';

export function useAtlasSearchProgress(): AtlasSearchProgress {
  return useSyncExternalStore(
    (listener) => subscribeAtlasSearchProgress(() => listener()),
    () => readAtlasSearchProgress(),
    () => EMPTY_ATLAS_SEARCH_PROGRESS,
  );
}

/**
 * Закреплённый итог поиска: кольцо/маршрут, найденные точки и опоры, которые
 * остаются на карте после того, как оверлей прогресса погас. `null`, пока
 * ничего не найдено или пользователь убрал результат.
 */
export function useAtlasSearchResult(): AtlasSearchProgress | null {
  return useSyncExternalStore(
    (listener) => subscribeAtlasSearchResult(() => listener()),
    () => readAtlasSearchResult(),
    () => null,
  );
}
