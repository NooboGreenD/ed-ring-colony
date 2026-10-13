import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { catalogIsComplete } from './galaxySystemsDb';
import { readAllRows } from './readAllRows';
import {
  inNearbyVolume,
  mergeNearbySystems,
  nearbyNameKey,
  nearbyPoint,
  type NearbyPoint,
  type NearbyShape,
  type NearbyResult,
  type NearbySource,
  type NearbySourceId,
} from './atlasNearby';

/** Complete source reads, not the capped nearest-neighbour RPCs used by route planning. */
async function localSystems(
  table: 'galaxy_systems' | 'atlas_system_cache',
  center: NearbyPoint,
  radius: number,
  signal: AbortSignal
) {
  const result = await readAllRows<any>((from, to) =>
    supabaseAdmin
      .from(table)
      .select(
        table === 'galaxy_systems'
          ? 'name,id64,x,y,z'
          : 'system_name,id64,x,y,z'
      )
      .gte('x', center.x - radius)
      .lte('x', center.x + radius)
      .gte('y', center.y - radius)
      .lte('y', center.y + radius)
      .gte('z', center.z - radius)
      .lte('z', center.z + radius)
      .order('name_lc')
      .range(from, to)
      .abortSignal(signal)
  );
  if (result.error)
    throw new Error(
      'Не удалось прочитать локальный источник: проверьте доступ к базе данных.'
    );
  return result.data.flatMap((row) => {
    const point = nearbyPoint(row);
    return point ? [point] : [];
  });
}
async function externalJson(
  url: string,
  options: RequestInit,
  deadline: number
): Promise<any> {
  let detail = 'источник не ответил';
  for (let attempt = 0; attempt < 2; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0)
      throw new Error(
        'Истёк лимит времени источника; выдача может быть неполной.'
      );
    try {
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(Math.min(8000, remaining)),
        cache: 'no-store',
      });
      if (response.ok) return await response.json();
      detail = `HTTP ${response.status}`;
      if (response.status !== 429 && response.status < 500) break;
    } catch {
      detail = 'нет подключения или превышено время ожидания';
    }
  }
  throw new Error(`Источник недоступен: ${detail}.`);
}
async function referenceSystem(
  name: string,
  deadline: number
): Promise<{ point: NearbyPoint; source: NearbySourceId } | null> {
  for (const table of ['galaxy_systems', 'atlas_system_cache']) {
    try {
      const { data } = await supabaseAdmin
        .from(table)
        .select(
          table === 'galaxy_systems'
            ? 'name,id64,x,y,z'
            : 'system_name,id64,x,y,z'
        )
        .eq('name_lc', nearbyNameKey(name))
        .abortSignal(
          AbortSignal.timeout(
            Math.max(1, Math.min(8000, deadline - Date.now()))
          )
        )
        .maybeSingle();
      const point = nearbyPoint(data);
      if (point)
        return {
          point,
          source: table === 'galaxy_systems' ? 'catalog' : 'cache',
        };
    } catch {
      /* Try the next independent source. */
    }
  }
  try {
    const data = await externalJson(
      `https://www.edsm.net/api-v1/system?systemName=${encodeURIComponent(name)}&showCoordinates=1`,
      { headers: { Accept: 'application/json' } },
      deadline
    );
    const point = nearbyPoint(data);
    if (point && nearbyNameKey(point.name) === nearbyNameKey(name))
      return { point, source: 'edsm-sphere' };
  } catch {
    /* Exact Spansh lookup is also allowed. Never use a merely similar name. */
  }
  try {
    const data = await externalJson(
      `https://spansh.co.uk/api/search?q=${encodeURIComponent(name)}&limit=20`,
      { headers: { Accept: 'application/json' } },
      deadline
    );
    for (const row of data.results || []) {
      const point = nearbyPoint(row);
      if (point && nearbyNameKey(point.name) === nearbyNameKey(name))
        return { point, source: 'spansh' };
    }
  } catch {
    /* No reliable coordinates. */
  }
  return null;
}

export async function searchNearbySystems(
  name: string,
  shape: NearbyShape,
  radius: number
): Promise<NearbyResult> {
  const resolved = await referenceSystem(name, Date.now() + 20_000);
  if (!resolved)
    throw new Error(
      'Не удалось найти точные координаты системы в каталоге, кэше, EDSM или Spansh. Проверьте имя и доступность источников.'
    );
  const reference = resolved.point;
  const deadline = Date.now() + 35_000;
  const statsRequest = (async () => {
    try {
      const { data } = await supabaseAdmin
        .from('galaxy_systems_meta')
        .select('value')
        .eq('key', 'stats')
        .abortSignal(AbortSignal.timeout(5000))
        .maybeSingle();
      return data?.value ?? null;
    } catch {
      return null;
    }
  })();
  const sources: NearbySource[] = [];
  const batches: Array<{ source: NearbySourceId; systems: NearbyPoint[] }> = [
    { source: resolved.source, systems: [reference] },
  ];
  const load = async (id: NearbySourceId, fn: () => Promise<NearbyPoint[]>) => {
    try {
      const systems = await fn();
      batches.push({ source: id, systems });
      sources.push({
        id,
        status: systems.length ? 'ok' : 'empty',
        count: systems.filter((point) =>
          inNearbyVolume(point, reference, shape, radius)
        ).length,
      });
    } catch (error) {
      sources.push({
        id,
        status: 'unavailable',
        count: 0,
        message: error instanceof Error ? error.message : 'Источник недоступен',
      });
    }
  };
  const coords = {
    x: String(reference.x),
    y: String(reference.y),
    z: String(reference.z),
    showCoordinates: '1',
  };
  const edsm = async (kind: 'sphere' | 'cube') => {
    const params = new URLSearchParams({
      ...coords,
      ...(kind === 'sphere'
        ? {
            radius: String(
              shape === 'cube' ? Math.ceil(Math.sqrt(3) * radius) : radius
            ),
          }
        : { size: String(radius * 2) }),
    });
    const data = await externalJson(
      `https://www.edsm.net/api-v1/${kind}-systems?${params}`,
      { headers: { Accept: 'application/json' } },
      deadline
    );
    if (!Array.isArray(data)) throw new Error('EDSM не передал массив систем.');
    return data.flatMap((row) => {
      const point = nearbyPoint(row);
      return point ? [point] : [];
    });
  };
  const spansh = async () => {
    const systems: NearbyPoint[] = [];
    const seen = new Set<string>();
    try {
      for (let page = 0; ; page++) {
        const data = await externalJson(
          'https://spansh.co.uk/api/systems/search',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            body: JSON.stringify({
              reference_system: reference.name,
              size: 100,
              page,
              filters: {
                distance: {
                  min: '0',
                  max: String(
                    shape === 'cube' ? Math.ceil(Math.sqrt(3) * radius) : radius
                  ),
                },
              },
              sort: [
                { distance: { direction: 'asc' } },
                { name: { direction: 'asc' } },
              ],
            }),
          },
          deadline
        );
        if (!Array.isArray(data.results))
          throw new Error('Spansh не передал страницу систем.');
        const total =
          typeof data.count === 'number'
            ? data.count
            : typeof data.count === 'string'
              ? Number(data.count)
              : NaN;
        if (!data.results.length) {
          if (Number.isFinite(total) && systems.length < total)
            throw new Error(
              'Spansh завершил выдачу раньше заявленного числа систем; данные неполные.'
            );
          break;
        }
        let added = 0;
        for (const row of data.results) {
          const point = nearbyPoint(row);
          if (!point) continue;
          const key = nearbyNameKey(point.name);
          if (seen.has(key)) continue;
          seen.add(key);
          systems.push(point);
          added++;
        }
        if (!added)
          throw new Error(
            'Spansh повторил страницу или не вернул координаты: дальнейшая полнота не подтверждена.'
          );
        if (Number.isFinite(total) && systems.length >= total) break;
      }
      batches.push({ source: 'spansh', systems });
      sources.push({
        id: 'spansh',
        status: systems.length ? 'ok' : 'empty',
        count: systems.filter((point) =>
          inNearbyVolume(point, reference, shape, radius)
        ).length,
      });
    } catch (error) {
      batches.push({ source: 'spansh', systems });
      sources.push({
        id: 'spansh',
        status: systems.length ? 'partial' : 'unavailable',
        count: systems.filter((point) =>
          inNearbyVolume(point, reference, shape, radius)
        ).length,
        message: error instanceof Error ? error.message : 'Spansh недоступен',
      });
    }
  };
  await Promise.all([
    load('catalog', () =>
      localSystems(
        'galaxy_systems',
        reference,
        radius,
        AbortSignal.timeout(35_000)
      )
    ),
    load('cache', () =>
      localSystems(
        'atlas_system_cache',
        reference,
        radius,
        AbortSignal.timeout(35_000)
      )
    ),
    load('edsm-sphere', () => edsm('sphere')),
    load('edsm-cube', () => edsm('cube')),
    spansh(),
  ]);
  // Deterministic coordinate priority, independent of network completion order.
  const priority: NearbySourceId[] = [
    'catalog',
    'edsm-sphere',
    'edsm-cube',
    'spansh',
    'cache',
  ];
  batches.sort(
    (a, b) => priority.indexOf(a.source) - priority.indexOf(b.source)
  );
  const systems = mergeNearbySystems(reference, shape, radius, batches);
  const stats = await statsRequest;
  const catalog = sources.find((source) => source.id === 'catalog');
  if (
    catalog &&
    ['ok', 'empty'].includes(catalog.status) &&
    !catalogIsComplete(stats)
  ) {
    catalog.status = 'partial';
    catalog.message =
      'Локальный каталог Spansh частичный или его полнота не подтверждена.';
  }
  sources.sort((a, b) => priority.indexOf(a.id) - priority.indexOf(b.id));
  const warnings = sources
    .filter((source) => source.message)
    .map((source) => `${source.id}: ${source.message}`);
  if (systems.some((system) => system.coordinate_conflict))
    warnings.push(
      'Некоторые источники расходятся в координатах; использованы координаты первого источника по приоритету.'
    );
  warnings.push(
    'Список объединяет доступные записи источников. EDSM/Spansh могут ограничивать свою выдачу; неизвестные им системы найти нельзя.'
  );
  return {
    reference,
    shape,
    radius,
    systems,
    count: systems.length,
    sources,
    warnings,
  };
}
