/**
 * Чтение признака технических работ для прокси (edge-рантайм).
 *
 * Прокси вызывает это на каждом запросе, поэтому значение кэшируется в модуле
 * на несколько секунд: один лишний запрос к Postgres в пять секунд вместо
 * одного на просмотр страницы.
 *
 * Ошибка чтения трактуется как «техработ нет» (fail-open): заглушка не должна
 * закрыться намертво из-за сетевого сбоя между edge-рантаймом и базой.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { MAINTENANCE_KEY, MAINTENANCE_REFRESH_MS, parseMaintenanceState, type MaintenanceState } from './maintenanceFlag';

let client: SupabaseClient | null = null;
let cache: { at: number; value: MaintenanceState | null } | null = null;

function edgeClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  if (!client) {
    client = createClient(url, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
  return client;
}

/** Признак техработ из кэша (или свежий, если кэш протух). */
export async function readMaintenanceCached(now: number = Date.now()): Promise<MaintenanceState | null> {
  if (cache && now - cache.at < MAINTENANCE_REFRESH_MS) return cache.value;

  const supabase = edgeClient();
  if (!supabase) return cache?.value ?? null;

  try {
    const { data, error } = await supabase
      .from('app_flags')
      .select('value')
      .eq('key', MAINTENANCE_KEY)
      .maybeSingle();
    if (error) throw error;
    const value = parseMaintenanceState((data as { value?: unknown } | null)?.value ?? null, now);
    cache = { at: now, value };
    return value;
  } catch {
    return cache?.value ?? null;
  }
}

/** Сбрасывает кэш — нужно тестам и отладке. */
export function resetMaintenanceCache(): void {
  cache = null;
  client = null;
}
