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

      // 3. Подтягиваем актуальные статусы из system_progress (свежие данные из RavenColonial)
      let mergedHubs = validHubs;
      let mergedRoute = validRoute;
      try {
        const { data: progressData, error: progressError } = await supabase
          .from('system_progress')
          .select('system_name, progress, updated_at, data');
        
        if (!progressError && Array.isArray(progressData)) {
          const progressMap = new Map<string, { progress: number | null; status: string }>();
          for (const row of progressData) {
            const p = row.progress;
            const status = p == null ? 'planned' : p >= 100 ? 'done' : p > 0 ? 'building' : 'planned';
            progressMap.set(String(row.system_name).toLowerCase(), { progress: p, status });
          }

          // Обновляем хабы — создаём новые объекты, чтобы React увидел изменения
          mergedHubs = validHubs.map((hub) => {
            const fresh = progressMap.get(hub.system_name.toLowerCase());
            if (fresh && fresh.progress != null) {
              return { ...hub, progress: fresh.progress, status: fresh.status as Hub['status'] };
            }
            return hub;
          });

          // Обновляем точки маршрута — создаём новые объекты
          mergedRoute = validRoute.map((point) => {
            const fresh = progressMap.get(point.system_name.toLowerCase());
            if (fresh && fresh.progress != null) {
              return { ...point, progress: fresh.progress, status: fresh.status as RouteSystem['status'] };
            }
            return point;
          });
        }
      } catch (progressErr) {
        console.warn('[GalaxyMap] Failed to load system_progress:', progressErr);
      }

      setHubs(mergedHubs);
      setRoute(mergedRoute);
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
