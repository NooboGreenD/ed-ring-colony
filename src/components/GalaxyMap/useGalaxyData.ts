'use client';
import { useState, useEffect, useCallback, useMemo } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { Hub, RouteSystem } from '@/types/hub';

function hasValidCoords(item: any): boolean {
  return item && typeof item.x === 'number' && typeof item.y === 'number' && typeof item.z === 'number';
}

export function useGalaxyData() {
  const [hubs, setHubs] = useState<Hub[]>([]);
  const [route, setRoute] = useState<RouteSystem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      // 1. Загружаем хабы и маршрут (основные данные)
      const [{ data: hubsData, error: hubsError }, { data: routeData, error: routeError }] = await Promise.all([
        supabase.from("hubs").select("id, system_name, name, status, progress, x, y, z").order("id", { ascending: true }),
        supabase.from("route_systems").select("id, system_name, sort_order, x, y, z, status, progress").order("sort_order", { ascending: true }),
      ]);

      if (hubsError) throw hubsError;
      if (routeError) throw routeError;

      // 2. Отдельно подтягиваем статистику доставок (не ломает загрузку при ошибке)
      let deliveryMap = new Map<string, number>();
      try {
        const { data: deliveryAgg, error: deliveryError } = await supabase.rpc('get_route_delivery_stats');
        if (!deliveryError && Array.isArray(deliveryAgg)) {
          for (const d of deliveryAgg) {
            deliveryMap.set(String(d.system_name).toLowerCase(), Number(d.total_delivered) || 0);
          }
        }
      } catch (rpcErr) {
        console.warn('[GalaxyMap] get_route_delivery_stats недоступна:', rpcErr);
      }

      const validHubs = (hubsData as Hub[] || []).filter(hasValidCoords);
      const validRoute = (routeData as RouteSystem[] || []).filter(hasValidCoords).map(r => ({
        ...r,
        total_delivered: deliveryMap.get(r.system_name.toLowerCase()) ?? 0,
      }));

      setHubs(validHubs);
      setRoute(validRoute);
    } catch (err: any) {
      console.error("[GalaxyMap] Data error:", err);
      setError(err.message || "Ошибка загрузки данных галактики");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const routeLine = useMemo(() => {
    if (route.length < 2) return null;
    const points = route.map((r) => [r.x, r.y, r.z]);
    return points;
  }, [route]);

  return { hubs, route, allRoutePoints: route, routeLine, loading, error, refetch: fetchData };
}

// Re-export types for backward compatibility with GalaxyMap.tsx
export type { Hub, RouteSystem as RoutePoint } from '@/types/hub';
