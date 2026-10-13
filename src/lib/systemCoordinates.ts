import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { readAllRows } from '@/lib/readAllRows';
import {
  coordinateNameKey,
  readSystemCoordinates,
  type SystemCoordinates,
  type CoordinateSource,
} from './systemCoordinateTypes';

const PARALLEL = 4;
/** Keep a whole source-resolution request inside the route's 60-second budget. */
async function jsonRequest(url: string, deadline: number): Promise<any> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
        signal: AbortSignal.timeout(Math.min(3000, remaining)),
      });
      if (response.ok) return await response.json();
      if (response.status === 404) return null;
      if (response.status !== 429 && response.status < 500) break;
    } catch {
      /* One retry, then the next independent source. */
    }
  }
  throw new Error(
    'Источник координат недоступен или превышено время ожидания.'
  );
}
async function parallel<T>(items: T[], work: (item: T) => Promise<void>) {
  for (let offset = 0; offset < items.length; offset += PARALLEL)
    await Promise.all(items.slice(offset, offset + PARALLEL).map(work));
}
export async function resolveSystemCoordinates(names: string[]) {
  const deadline = Date.now() + 50_000;
  const requested = new Map<string, string[]>();
  for (const name of names) {
    const key = coordinateNameKey(name);
    if (!requested.has(key)) requested.set(key, []);
    if (!requested.get(key)!.includes(name)) requested.get(key)!.push(name);
  }
  const found = new Map<
    string,
    { coords: SystemCoordinates; source: CoordinateSource; name: string }
  >();
  const warnings = new Set<string>();
  const accept = (name: unknown, record: unknown, source: CoordinateSource) => {
    if (typeof name !== 'string') return;
    const key = coordinateNameKey(name);
    const coords = readSystemCoordinates(record);
    if (requested.has(key) && !found.has(key) && coords)
      found.set(key, { coords, source, name });
  };
  const unique = Array.from(requested.values()).map((values) =>
    values[0].trim()
  );
  const batches: string[][] = [];
  for (let i = 0; i < unique.length; i += 25)
    batches.push(unique.slice(i, i + 25));
  await parallel(batches, async (batch) => {
    const params = new URLSearchParams({ showCoordinates: '1' });
    for (const name of batch) params.append('systemName[]', name);
    try {
      const data = await jsonRequest(
        'https://www.edsm.net/api-v1/systems?' + params,
        deadline
      );
      if (data === null) return;
      if (!Array.isArray(data))
        throw new Error('EDSM не передал список систем.');
      for (const item of data) accept(item?.name, item, 'edsm');
    } catch {
      warnings.add(
        'EDSM недоступен: для недостающих систем проверяется Spansh.'
      );
    }
  });
  // The imported Spansh catalog is optional; never let it block live fallback.
  const missingKeys = Array.from(requested.keys()).filter(
    (key) => !found.has(key)
  );
  if (missingKeys.length) {
    try {
      const response = await readAllRows<any>((from, to) =>
        supabaseAdmin
          .from('galaxy_systems')
          .select('name,x,y,z')
          .in('name_lc', missingKeys)
          .order('id')
          .range(from, to)
          .abortSignal(
            AbortSignal.timeout(
              Math.max(1, Math.min(3000, deadline - Date.now()))
            )
          )
      );
      if (response.error) throw new Error(response.error.message);
      for (const row of response.data) accept(row.name, row, 'spansh_catalog');
    } catch {
      warnings.add(
        'Локальный каталог Spansh недоступен: используется Spansh API.'
      );
    }
  }
  await parallel(
    Array.from(requested.keys()).filter((key) => !found.has(key)),
    async (key) => {
      const name = requested.get(key)![0].trim();
      try {
        const data = await jsonRequest(
          `https://spansh.co.uk/api/search?q=${encodeURIComponent(name)}&limit=100`,
          deadline
        );
        if (data === null) return;
        if (!Array.isArray(data.results))
          throw new Error('Spansh не передал список систем.');
        // Never take the first autocomplete result, a prefix, or a nearest system.
        const exact = data.results
          .map((entry: any) => entry?.record ?? entry)
          .filter(
            (row: any) =>
              typeof row?.name === 'string' &&
              coordinateNameKey(row.name) === key
          );
        for (const row of exact) {
          accept(row.name, row, 'spansh');
          if (found.has(key)) return;
        }
        // Some search records expose only ID64. Resolve the exact system dump,
        // preserving ID64 strings and rechecking its name before accepting XYZ.
        const ids = new Set<string>();
        for (const row of exact) {
          const id =
            typeof row.id64 === 'string'
              ? row.id64
              : Number.isSafeInteger(row.id64)
                ? String(row.id64)
                : '';
          if (!/^[1-9][0-9]{0,19}$/.test(id) || ids.has(id)) continue;
          ids.add(id);
          const dump = await jsonRequest(
            `https://spansh.co.uk/api/dump/${id}`,
            deadline
          );
          const system = dump?.system;
          if (
            typeof system?.name === 'string' &&
            coordinateNameKey(system.name) === key
          )
            accept(system.name, system, 'spansh');
          if (found.has(key)) return;
        }
      } catch {
        warnings.add(
          'Spansh API недоступен или превышено время поиска; часть систем может остаться без координат.'
        );
      }
    }
  );
  const results: Record<string, SystemCoordinates> = Object.create(null);
  const sources: Record<string, CoordinateSource> = Object.create(null);
  const canonical_names: Record<string, string> = Object.create(null);
  const unresolved: string[] = [];
  for (const [key, variants] of requested) {
    const hit = found.get(key);
    for (const name of variants) {
      if (hit) {
        results[name] = hit.coords;
        sources[name] = hit.source;
        canonical_names[name] = hit.name;
      } else unresolved.push(name);
    }
  }
  return {
    results,
    sources,
    canonical_names,
    total: names.length,
    resolved: Object.keys(results).length,
    unresolved,
    warnings: Array.from(warnings),
  };
}
