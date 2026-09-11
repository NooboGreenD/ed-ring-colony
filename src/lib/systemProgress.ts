import type { RavenSystemV2 } from '@/lib/ravenColonial';

/**
 * A map system can be entered with different capitalization or accidental
 * repeated whitespace in the route, RavenColonial and a journal.  Keep the
 * comparison key independent from the label shown to a pilot.
 */
export function systemNameKey(value: unknown): string {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

export function readableProgress(value: unknown): number | null {
  const number = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : NaN;

  if (!Number.isFinite(number)) return null;
  return Math.min(100, Math.max(0, number));
}

export function statusFromProgress(progress: unknown): 'planned' | 'building' | 'done' {
  const value = readableProgress(progress);
  if (value == null || value <= 0) return 'planned';
  if (value >= 100) return 'done';
  return 'building';
}

export interface ProgressCacheRow {
  system_name: string;
  progress: unknown;
  updated_at?: string | null;
}

interface ProgressMapValue {
  progress: number | null;
  updated_at?: string | null;
}

function timestamp(value: string | null | undefined): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

/**
 * `system_progress.system_name` historically was case-sensitive even though
 * the rest of the application treats star-system names as case-insensitive.
 * If legacy rows differ only by case, use the most recently synchronized one,
 * rather than whichever row PostgREST happened to return last.
 */
export function latestProgressBySystem(rows: ProgressCacheRow[] | null | undefined): Map<string, ProgressMapValue> {
  const result = new Map<string, ProgressMapValue>();

  for (const row of rows ?? []) {
    const key = systemNameKey(row.system_name);
    if (!key) continue;

    const candidate: ProgressMapValue = {
      progress: readableProgress(row.progress),
      updated_at: row.updated_at ?? null,
    };
    const current = result.get(key);

    if (
      !current
      || timestamp(candidate.updated_at) > timestamp(current.updated_at)
      || (
        timestamp(candidate.updated_at) === timestamp(current.updated_at)
        && candidate.progress != null
        && current.progress == null
      )
    ) {
      result.set(key, candidate);
    }
  }

  return result;
}

/** Merge the current Raven cache into map records without treating `0` as absent. */
export function mergeProgressIntoMap<T extends { system_name: string; progress?: unknown; status?: unknown }>(
  systems: T[] | null | undefined,
  cachedRows: ProgressCacheRow[] | null | undefined,
): Array<T & { progress: number; status: 'planned' | 'building' | 'done' }> {
  const progressByName = latestProgressBySystem(cachedRows);

  return (systems ?? []).map((system) => {
    const cached = progressByName.get(systemNameKey(system.system_name));
    const progress = cached?.progress ?? readableProgress(system.progress) ?? 0;

    return {
      ...system,
      progress,
      status: statusFromProgress(progress),
    };
  });
}

export interface RavenProgressPersistenceResult {
  cached: boolean;
  cacheSystemName: string | null;
  updatedRouteSystems: number;
  updatedHubs: number;
  warnings: string[];
}

type ServiceClient = {
  from(table: string): any;
};

function ravenCacheData(data: RavenSystemV2) {
  return {
    siteName: data.siteName,
    architectName: data.architectName,
    projects: data.projects,
    resources: data.resources,
    totalRequired: data.totalRequired,
    totalProvided: data.totalProvided,
    totalRemaining: data.totalRemaining,
  };
}

/**
 * Persist a successful Raven read in every cache consumed by the galaxy map.
 *
 * The old code updated different subsets of `system_progress`,
 * `route_systems`, and `hubs` depending on which sync endpoint was used.
 * That allowed an old 0% cache row to overwrite a newer route value on the
 * map.  All Raven entry points now share this one write path.
 */
export async function persistRavenSystemProgress(
  supabase: ServiceClient,
  requestedSystemName: string,
  data: RavenSystemV2,
): Promise<RavenProgressPersistenceResult> {
  const requestedName = String(requestedSystemName ?? '').trim();
  const ravenName = String(data.systemName ?? '').trim();
  const candidateKeys = new Set(
    [requestedName, ravenName]
      .map(systemNameKey)
      .filter(Boolean),
  );

  const result: RavenProgressPersistenceResult = {
    cached: false,
    cacheSystemName: null,
    updatedRouteSystems: 0,
    updatedHubs: 0,
    warnings: [],
  };

  if (candidateKeys.size === 0) {
    result.warnings.push('System name is empty; Raven result was not cached.');
    return result;
  }

  // A result with neither a calculable percentage nor projects is normally a
  // Raven/network miss. Never erase a useful map cache with that empty shape.
  if (readableProgress(data.progress) == null && data.projects.length === 0) {
    result.warnings.push('Raven returned no projects or progress; existing map cache was kept.');
    return result;
  }

  try {
    const [routeResponse, hubsResponse] = await Promise.all([
      supabase.from('route_systems').select('id, system_name'),
      supabase.from('hubs').select('id, system_name'),
    ]);

    if (routeResponse.error) result.warnings.push(`Could not find route-system cache rows: ${routeResponse.error.message}`);
    if (hubsResponse.error) result.warnings.push(`Could not find hub cache rows: ${hubsResponse.error.message}`);

    const matchingRoutes = (routeResponse.data ?? []).filter((row: { system_name: string }) =>
      candidateKeys.has(systemNameKey(row.system_name)),
    );
    const matchingHubs = (hubsResponse.data ?? []).filter((row: { system_name: string }) =>
      candidateKeys.has(systemNameKey(row.system_name)),
    );

    // Prefer the spelling stored by the map itself. This prevents a Raven
    // capitalization variant from creating a second, stale-able cache key.
    const cacheSystemName = matchingRoutes[0]?.system_name
      ?? matchingHubs[0]?.system_name
      ?? (ravenName || requestedName);
    const progress = readableProgress(data.progress);
    const now = new Date().toISOString();

    const cacheResponse = await supabase
      .from('system_progress')
      .upsert({
        system_name: cacheSystemName,
        progress,
        updated_at: now,
        data: ravenCacheData(data),
      });

    if (cacheResponse.error) {
      result.warnings.push(`Could not update system progress cache: ${cacheResponse.error.message}`);
    } else {
      result.cached = true;
      result.cacheSystemName = cacheSystemName;
    }

    // A system with projects but no cargo denominator is still useful in the
    // detail cache, but it has no factual numeric status to write to the map.
    if (progress == null) return result;

    const update = { progress, status: statusFromProgress(progress) };
    const routeIds = matchingRoutes.map((row: { id: number | string }) => row.id);
    const hubIds = matchingHubs.map((row: { id: number | string }) => row.id);

    if (routeIds.length > 0) {
      const response = await supabase.from('route_systems').update(update).in('id', routeIds);
      if (response.error) result.warnings.push(`Could not update route map progress: ${response.error.message}`);
      else result.updatedRouteSystems = routeIds.length;
    }

    if (hubIds.length > 0) {
      const response = await supabase.from('hubs').update(update).in('id', hubIds);
      if (response.error) result.warnings.push(`Could not update hub map progress: ${response.error.message}`);
      else result.updatedHubs = hubIds.length;
    }
  } catch (error) {
    // Raven data was already successfully obtained by the caller. Cache
    // persistence is intentionally best-effort and must never make a system
    // page or a manual sync report that live read as failed.
    result.warnings.push(
      `Could not persist map progress: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return result;
}
