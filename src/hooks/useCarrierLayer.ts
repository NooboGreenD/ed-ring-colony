'use client';

/**
 * Слой «Авианосцы» карты галактики: загрузка `GET /api/map/carriers`,
 * переключатель слоя, фильтр (источник, «чьи», класс) и выбранная система.
 *
 * Хук общий для двух страниц, потому что управление слоем живёт в разных
 * местах:
 *   * `/map` («Карта кольца») — панель слоёв самой карты, состояние внутри
 *     `GalaxyMap`;
 *   * `Atlas` — вкладка «Авианосцы»: фильтр переехал туда (10.11.2026),
 *     поэтому состояние поднимается на страницу, а карта получает готовый
 *     объект слоя — как PowerPlay и «Фракции».
 *
 * Носители прыгают не чаще раза в 15–20 минут, а прыжок виден заранее —
 * опроса раз в минуту достаточно. Выключенный слой сеть не тратит.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_CARRIER_FILTER,
  countMapCarriers,
  filterMapCarriers,
  groupCarriersBySystem,
  type CarrierLayerFilter,
  type CarrierSystemGroup,
  type MapCarrier,
  type MapCarriersResponse,
  type MapDirectoryInfo,
  type CarrierLayerStatus,
  type MapPoint,
} from '@/lib/carrierMap';

/** Как часто слой перезапрашивает данные, пока он включён. */
export const CARRIER_REFRESH_MS = 60_000;

export interface CarrierLayer {
  carriers: MapCarrier[];
  /** Счётчики по всем носителям (до фильтра). */
  counts: ReturnType<typeof countMapCarriers>;
  /** Носители после фильтра. */
  visibleCarriers: MapCarrier[];
  /** Сколько носителей после фильтра. */
  visibleCount: number;
  /** Системы после фильтра — то, что на карте. */
  groups: CarrierSystemGroup[];
  filter: CarrierLayerFilter;
  setFilter: (filter: CarrierLayerFilter) => void;
  show: boolean;
  setShow: (show: boolean) => void;
  status: CarrierLayerStatus;
  signedIn: boolean;
  directory: MapDirectoryInfo | null;
  selectedKey: string | null;
  selectedGroup: CarrierSystemGroup | null;
  /**
   * Выбрать систему. Каждый выбор — новый `id`, чтобы карта подвела камеру
   * даже к той же системе, выбранной повторно.
   */
  selectGroup: (group: CarrierSystemGroup | null) => void;
  /** Запрос камеры: `id` растёт на каждый выбор, `position` — координаты системы. */
  focusRequest: { id: number; position: MapPoint } | null;
}

export interface UseCarrierLayerOptions {
  /** Слой показывается сразу (у `/map` — да, в Atlas — вкладка решает). */
  defaultVisible?: boolean;
  /** Можно ли ходить в сеть: внешний слой не должен грузить данные дважды. */
  enabled?: boolean;
}

export function useCarrierLayer(options: UseCarrierLayerOptions = {}): CarrierLayer {
  const enabled = options.enabled !== false;
  const [carriers, setCarriers] = useState<MapCarrier[]>([]);
  const [status, setStatus] = useState<CarrierLayerStatus>('loading');
  const [signedIn, setSignedIn] = useState(false);
  const [directory, setDirectory] = useState<MapDirectoryInfo | null>(null);
  const [show, setShow] = useState(options.defaultVisible !== false);
  const [filter, setFilter] = useState<CarrierLayerFilter>(DEFAULT_CARRIER_FILTER);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [focus, setFocus] = useState<{ id: number; position: MapPoint } | null>(null);
  const focusId = useRef(0);

  useEffect(() => {
    if (!enabled || !show) return;
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch(`/api/map/carriers?t=${Date.now()}`, { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = (await response.json()) as MapCarriersResponse;
        if (cancelled) return;
        setCarriers(Array.isArray(data.carriers) ? data.carriers : []);
        setSignedIn(Boolean(data.viewer?.signedIn));
        setDirectory(data.directory ?? null);
        setStatus('ready');
      } catch {
        // Необязательный слой: последний удачный ответ остаётся на карте.
        if (!cancelled) setStatus('error');
      }
    };

    void load();
    const interval = window.setInterval(load, CARRIER_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [enabled, show]);

  const counts = useMemo(() => countMapCarriers(carriers), [carriers]);
  const visibleCarriers = useMemo(() => filterMapCarriers(carriers, filter), [carriers, filter]);
  const groups = useMemo(() => groupCarriersBySystem(visibleCarriers), [visibleCarriers]);
  const selectedGroup = useMemo(
    () => (show && selectedKey ? groups.find((group) => group.key === selectedKey) ?? null : null),
    [groups, selectedKey, show],
  );

  const selectGroup = useCallback((group: CarrierSystemGroup | null) => {
    setSelectedKey(group?.key ?? null);
    if (group?.position) {
      focusId.current += 1;
      setFocus({ id: focusId.current, position: group.position });
    }
  }, []);

  return {
    carriers,
    counts,
    visibleCarriers,
    visibleCount: visibleCarriers.length,
    groups,
    filter,
    setFilter,
    show,
    setShow,
    status,
    signedIn,
    directory,
    selectedKey,
    selectedGroup,
    selectGroup,
    focusRequest: focus,
  };
}
