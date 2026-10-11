/**
 * Поиск миров Atlas — серверная часть.
 *
 * Что изменилось по сравнению с прежним «одним большим» обработчиком:
 *   1. Источники по приоритету: каталог Spansh в БД → кэш тел `atlas_body_cache`
 *      → EDSM (звёзды) → Spansh API (планеты). Повторный поиск в том же районе
 *      отвечает из кэша проекта, без внешних запросов.
 *   2. Прогресс пишется в `atlas_searches.progress`: клиент видит этап, процент и
 *      последние найденные точки, поэтому процесс рисуется прямо на 3D-карте.
 *   3. Системы планет определяются по локальному каталогу (самое длинное
 *      совпадение имени), а не эвристикой «отрежь последнее слово» — из-за неё
 *      часть найденных миров не находила координат.
 *   4. Всё найденное (тела и координаты) сохраняется в БД проекта.
 */

// Явные расширения нужны для `node --test`.
import { supabaseAdmin } from './supabaseAdmin.ts';
import { findSystemByName, findSystemsByNames, findStarCandidates, rowWorldType, systemById64 } from './galaxySystemsDb.ts';

import { boxAround, listCachedBodiesInBox, saveCachedBodies, saveCachedSystems } from './atlasSystemCache.ts';
import { spanshBodiesSearch, mapSpanshSubtypeToWorldType, isTerraformable } from './spanshClient.ts';
import { normalizeSystemName } from './galaxySystems.ts';
import type { AtlasSearchParams, WorldType } from '@/types/atlas';

const DB_STAR_WORLD_TYPES: WorldType[] = [
  'neutron_star', 'black_hole', 'white_dwarf', 'wolf_rayet',
  'herbig_ae_be', 't_tauri', 'carbon_star', 'supergiant', 'giant',
];

const STAR_WORLD_TYPES: WorldType[] = [...DB_STAR_WORLD_TYPES, 'proto_star'];
const PLANET_WORLD_TYPES: WorldType[] = ['earth_like', 'water_world', 'ammonia'];
const ROCKY_WORLD_TYPES: WorldType[] = ['rocky_atmosphere', 'rocky_bio'];

const SPANSH_PLANET_SUBTYPES: Record<string, WorldType> = {
  'Earth-like world': 'earth_like',
  'Water world': 'water_world',
  'Ammonia world': 'ammonia',
  'Water giant': 'water_world',
};

const EDSM_STAR_TYPE_MAP: Record<string, WorldType[]> = {
  N: ['neutron_star'], H: ['black_hole'], D: ['white_dwarf'],
  W: ['wolf_rayet'], WN: ['wolf_rayet'], WC: ['wolf_rayet'], WO: ['wolf_rayet'],
  C: ['carbon_star'], 'C-N': ['carbon_star'], 'C-J': ['carbon_star'], 'C-H': ['carbon_star'], 'C-Hd': ['carbon_star'],
  S: ['supergiant'], A_BlueWhiteSuperGiant: ['supergiant'], F_WhiteSuperGiant: ['supergiant'], G_WhiteSuperGiant: ['supergiant'],
  K_OrangeGiant: ['giant'], M_RedGiant: ['giant'],
};

function mapEdsmStarType(type: string): WorldType | null {
  for (const [prefix, types] of Object.entries(EDSM_STAR_TYPE_MAP)) {
    if (type.startsWith(prefix) || type.includes(prefix)) return types[0];
  }
  return null;
}

export interface WorldSearchPoint {
  name: string;
  x: number;
  y: number;
  z: number;
  world_type: string;
  body_name?: string;
}

export interface WorldSearchProgress {
  stage: 'coords' | 'catalog' | 'cache' | 'edsm' | 'spansh' | 'save' | 'completed' | 'failed';
  percent: number;
  message: string;
  found: number;
  /** Последние найденные точки: клиент рисует их на карте по ходу поиска. */
  batch: WorldSearchPoint[];
  stats?: Record<string, number>;
}

export interface WorldSearchCandidate {
  search_id: string;
  system_name: string;
  x: number;
  y: number;
  z: number;
  world_type: WorldType;
  body_name: string;
  distance_from_ref: number;
  distance_to_arrival: number;
  estimated_value: number;
  is_main_star: boolean;
  metadata: Record<string, unknown>;
}

const dist3 = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) =>
  Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);

/** Обновление живого прогресса сессии (его читает клиент при опросе). */
export async function writeSearchProgress(sessionId: string, progress: WorldSearchProgress): Promise<void> {
  try {
    await supabaseAdmin
      .from('atlas_searches')
      .update({ progress, status: progress.stage === 'completed' ? 'completed' : progress.stage === 'failed' ? 'failed' : 'running' })
      .eq('id', sessionId);
  } catch (error: any) {
    console.warn('[atlas search] не удалось записать прогресс:', error?.message);
  }
}

/**
 * Определение системы для тела Spansh: сначала id64, затем самое длинное
 * совпадение имени в локальном каталоге, и только потом эвристика EDSM.
 */
export interface BodySystemLink {
  systemName: string;
  x: number;
  y: number;
  z: number;
  source: string;
}

export async function resolveBodySystems(
  bodies: Array<{
    name: string;
    system_name?: string | null;
    systemName?: string | null;
    system_id64?: string | number | null;
    systemId64?: string | number | null;
  }>,
): Promise<Map<string, BodySystemLink>> {
  const resolved = new Map<string, BodySystemLink>();
  const linkByName = new Map<string, string>();
  const candidates = new Set<string>();

  const remember = (bodyName: string, systemName: string) => {
    const clean = String(systemName || '').trim().replace(/\s+/g, ' ');
    if (!bodyName || !clean) return;
    linkByName.set(bodyName, clean);
    candidates.add(clean);
  };

  for (const body of bodies) {
    const name = String(body?.name || '').trim();
    if (!name) continue;

    // 1. Самое точное: Spansh сам сказал, к какой системе относится тело.
    const explicit = body.system_name || body.systemName;
    if (explicit) {
      remember(name, String(explicit));
      continue;
    }

    // 2. id64 системы — точное совпадение в каталоге проекта.
    const systemId = body.system_id64 ?? body.systemId64;
    if (systemId) {
      try {
        const row = await systemById64(String(systemId));
        if (row) {
          resolved.set(name, { systemName: row.name, x: row.x, y: row.y, z: row.z, source: 'catalog' });
          continue;
        }
      } catch {
        // Каталог недоступен — пробуем по имени.
      }
    }

    // 3. Имя системы — префикс имени тела. Проверяем до трёх вариантов от самого
    //    длинного: «Eol Prou RS-T d3-94 2 a» → …d3-94 2 → …d3-94.
    const tokens = name.split(/\s+/);
    const prefixes: string[] = [];
    for (let take = tokens.length - 1; take >= 1 && prefixes.length < 3; take--) {
      prefixes.push(tokens.slice(0, take).join(' '));
    }
    remember(name, prefixes[prefixes.length - 1] || name);
    for (const prefix of prefixes) candidates.add(prefix);
  }

  if (candidates.size > 0) {
    let rowsByKey = new Map<string, { name: string; x: number; y: number; z: number }>();
    try {
      rowsByKey = await findSystemsByNames(Array.from(candidates));
    } catch (error: any) {
      console.warn('[atlas search] каталог систем недоступен для тел:', error?.message);
    }
    const unresolvedNames = new Set<string>();
    for (const [bodyName, systemName] of linkByName) {
      const row = rowsByKey.get(normalizeSystemName(systemName));
      if (row) {
        resolved.set(bodyName, { systemName: row.name, x: row.x, y: row.y, z: row.z, source: 'catalog' });
      } else {
        unresolvedNames.add(systemName);
      }
    }
    // Имена, которых нет в каталоге, разрешаем общим путём (кэш → EDSM).
    if (unresolvedNames.size > 0) {
      const coords = await resolveCoordinates(Array.from(unresolvedNames));
      for (const [bodyName, systemName] of linkByName) {
        if (resolved.has(bodyName)) continue;
        const found = coords.get(normalizeSystemName(systemName));
        if (found) resolved.set(bodyName, { systemName, x: found.x, y: found.y, z: found.z, source: found.source });
      }
    }
  }

  return resolved;
}

/**
 * Координаты систем по именам: каталог → кэш Atlas → EDSM.
 * Кэш появился именно для того, чтобы повторные поиски не дёргали EDSM.
 */
export async function resolveCoordinates(names: string[]): Promise<Map<string, { x: number; y: number; z: number; source: string }>> {
  const result = new Map<string, { x: number; y: number; z: number; source: string }>();
  const unique = Array.from(new Set(names.map((name) => name.trim()).filter(Boolean)));
  if (unique.length === 0) return result;

  try {
    const rows = await findSystemsByNames(unique);
    for (const [key, row] of rows) result.set(key, { x: row.x, y: row.y, z: row.z, source: 'catalog' });
  } catch (error: any) {
    console.warn('[atlas search] каталог координат недоступен:', error?.message);
  }

  const missing = unique.filter((name) => !result.has(normalizeSystemName(name)));
  if (missing.length > 0) {
    for (let index = 0; index < missing.length; index += 200) {
      const chunk = missing.slice(index, index + 200);
      try {
        const { data } = await supabaseAdmin
          .from('atlas_system_cache')
          .select('system_name,name_lc,x,y,z')
          .in('name_lc', chunk.map(normalizeSystemName));
        for (const row of (data || []) as Array<{ system_name: string; name_lc: string; x: number; y: number; z: number }>) {
          result.set(row.name_lc, { x: Number(row.x), y: Number(row.y), z: Number(row.z), source: 'cache' });
        }
      } catch (error: any) {
        console.warn('[atlas search] кэш систем недоступен:', error?.message);
      }
    }
  }

  const stillMissing = unique.filter((name) => !result.has(normalizeSystemName(name)));
  if (stillMissing.length > 0) {
    const fromEdsm = await resolveEdsmCoordinates(stillMissing);
    for (const [name, coords] of Object.entries(fromEdsm)) {
      result.set(normalizeSystemName(name), { ...coords, source: 'edsm' });
    }
    await saveCachedSystems(
      Object.entries(fromEdsm).map(([name, coords]) => ({
        name,
        x: coords.x,
        y: coords.y,
        z: coords.z,
        source: 'edsm',
      })),
    ).catch(() => 0);
  }

  return result;
}

async function resolveEdsmCoordinates(names: string[]): Promise<Record<string, { x: number; y: number; z: number }>> {
  const results: Record<string, { x: number; y: number; z: number }> = {};
  const BATCH = 25;
  for (let index = 0; index < names.length; index += BATCH) {
    const batch = names.slice(index, index + BATCH);
    const params = new URLSearchParams();
    params.append('showCoordinates', '1');
    for (const name of batch) params.append('systemName[]', name);
    try {
      const res = await fetch('https://www.edsm.net/api-v1/systems?' + params.toString(), {
        headers: { Accept: 'application/json' },
        next: { revalidate: 86400 },
      });
      const data = await res.json();
      for (const item of data || []) {
        if (item?.name && item.coords) results[item.name] = { x: item.coords.x, y: item.coords.y, z: item.coords.z };
      }
    } catch (error: any) {
      console.error('[atlas search] EDSM batch error:', error?.message);
    }
  }
  return results;
}

async function edsmSphereSystems(
  refSystem: string,
  radius: number,
): Promise<Array<{ name: string; x: number; y: number; z: number; primaryStar?: { type?: string } }>> {
  const params = new URLSearchParams();
  params.append('systemName', refSystem);
  params.append('radius', String(Math.min(radius, 100)));
  params.append('showCoordinates', '1');
  params.append('showPrimaryStar', '1');
  try {
    const res = await fetch('https://www.edsm.net/api-v1/sphere-systems?' + params.toString(), {
      headers: { Accept: 'application/json' },
      next: { revalidate: 86400 },
    });
    const data = await res.json();
    return (data || []).filter((system: any) => system?.name && system.coords).map((system: any) => ({
      name: system.name, x: system.coords.x, y: system.coords.y, z: system.coords.z, primaryStar: system.primaryStar,
    }));
  } catch (error: any) {
    console.error('[atlas search] EDSM sphere error:', error?.message);
    return [];
  }
}

/** Сколько планетных типов запрашиваем у Spansh одним запросом. */
function planetTypesInWorldTypes(worldTypes: WorldType[]): WorldType[] {
  return PLANET_WORLD_TYPES.filter((type) => worldTypes.includes(type));
}

export interface WorldSearchContext {
  sessionId: string;
  params: AtlasSearchParams;
  refCoords: { x: number; y: number; z: number };
  refName: string;
  catalogReady: boolean;
}

/**
 * Полный поиск миров для сессии. Пишет прогресс по ходу работы и сохраняет
 * всех найденных кандидатов пачками, чтобы карта оживала сразу.
 */
export async function runWorldSearch(context: WorldSearchContext): Promise<{ candidates: number; stats: Record<string, number> }> {
  const { sessionId, params, refCoords, catalogReady } = context;
  const halfCube = params.cube_size_ly / 2;
  const worldTypes = params.world_types as WorldType[];
  const starTypes = worldTypes.filter((type) => STAR_WORLD_TYPES.includes(type));
  const dbStarTypes = starTypes.filter((type) => DB_STAR_WORLD_TYPES.includes(type));
  const onlineStarTypes = starTypes.filter((type) => !DB_STAR_WORLD_TYPES.includes(type));
  const planetTypes = planetTypesInWorldTypes(worldTypes);
  const rockyTypes = ROCKY_WORLD_TYPES.filter((type) => worldTypes.includes(type));
  const wantsTerraformable = worldTypes.includes('terraformable');

  const candidates: WorldSearchCandidate[] = [];
  const seen = new Set<string>();
  const batch: WorldSearchPoint[] = [];
  const stats = { catalogStars: 0, cachedBodies: 0, edsmStars: 0, spanshBodies: 0, systemsSaved: 0 };

  const pushCandidate = (candidate: Omit<WorldSearchCandidate, 'search_id'>) => {
    const key = `${normalizeSystemName(candidate.system_name)}|${candidate.world_type}|${candidate.body_name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    candidates.push({ ...candidate, search_id: sessionId });
    if (batch.length < 400) {
      batch.push({
        name: candidate.system_name,
        x: candidate.x,
        y: candidate.y,
        z: candidate.z,
        world_type: candidate.world_type,
        body_name: candidate.body_name,
      });
    }
    return true;
  };

  const flush = async (progress: Partial<WorldSearchProgress> & { stage: WorldSearchProgress['stage']; percent: number; message: string }) => {
    await writeSearchProgress(sessionId, {
      stage: progress.stage,
      percent: progress.percent,
      message: progress.message,
      found: candidates.length,
      batch: batch.splice(0, batch.length),
      stats: {
        'Из каталога (звёзды)': stats.catalogStars,
        'Из кэша тел': stats.cachedBodies,
        'Из EDSM': stats.edsmStars,
        'Из Spansh': stats.spanshBodies,
      },
    });
  };

  await flush({ stage: 'coords', percent: 5, message: 'Координаты опорной системы определены' });

  /* ── 1. Звёзды из локального каталога Spansh ── */
  let dbStarUsed = false;
  if (dbStarTypes.length > 0 && catalogReady) {
    try {
      const rows = await findStarCandidates({ x: refCoords.x, y: refCoords.y, z: refCoords.z, half: halfCube, worldTypes: dbStarTypes });
      dbStarUsed = true;
      for (const row of rows) {
        const distance = dist3(row, refCoords);
        if (distance > halfCube) continue;
        // Классификация звезды — общая с автодополнением и подсказками карты:
        // одна и та же система не должна попадать в разные категории.
        const cls = rowWorldType(row, dbStarTypes);
        if (!cls) continue;
        if (pushCandidate({
          system_name: row.name,
          x: row.x, y: row.y, z: row.z,
          world_type: cls as WorldType,
          body_name: row.name,
          distance_from_ref: distance,
          distance_to_arrival: 0,
          estimated_value: 0,
          is_main_star: true,
          metadata: { mainStar: row.main_star, star_type: row.star_type, id64: row.id64, needs_permit: row.needs_permit },
        })) stats.catalogStars++;
      }
    } catch (error: any) {
      console.warn('[atlas search] каталог звёзд недоступен:', error?.message);
      dbStarUsed = false;
    }
  }

  await flush({
    stage: 'catalog',
    percent: 25,
    message: dbStarUsed
      ? `Каталог Spansh: звёзд найдено ${stats.catalogStars}`
      : 'Каталог Spansh недоступен — звёзды ищем в EDSM',
  });

  /* ── 2. Звёзды из EDSM (только если каталог не покрыл запрос) ── */
  const edsmStarTypes = dbStarUsed ? onlineStarTypes : starTypes;
  if (edsmStarTypes.length > 0) {
    const systems = await edsmSphereSystems(context.refName, halfCube);
    for (const system of systems) {
      const distance = dist3(system, refCoords);
      if (distance > halfCube) continue;
      const worldType = mapEdsmStarType(system.primaryStar?.type || '');
      if (!worldType || !edsmStarTypes.includes(worldType)) continue;
      if (pushCandidate({
        system_name: system.name,
        x: system.x, y: system.y, z: system.z,
        world_type: worldType,
        body_name: system.name,
        distance_from_ref: distance,
        distance_to_arrival: 0,
        estimated_value: 0,
        is_main_star: true,
        metadata: { primaryStarType: system.primaryStar?.type, source: 'edsm' },
      })) stats.edsmStars++;
    }
    await saveCachedSystems(systems.map((system) => ({
      name: system.name, x: system.x, y: system.y, z: system.z, source: 'edsm',
    }))).then((saved) => { stats.systemsSaved += saved; }).catch(() => 0);
  }

  await flush({
    stage: 'edsm',
    percent: 40,
    message: `EDSM: звёзд найдено ${stats.edsmStars}`,
  });

  /* ── 3. Тела из кэша проекта (повторный поиск не идёт в сеть) ── */
  const cachedWorldTypes = [...planetTypes, ...(wantsTerraformable ? ['terraformable'] : []), ...rockyTypes];
  if (cachedWorldTypes.length > 0) {
    const cachedBodies = await listCachedBodiesInBox(boxAround(refCoords, halfCube), cachedWorldTypes, 6000).catch(() => []);
    for (const body of cachedBodies) {
      const distance = dist3(body, refCoords);
      if (distance > halfCube) continue;
      const worldType = body.worldType as WorldType;
      if (!cachedWorldTypes.includes(worldType)) continue;
      const kept = pushCandidate({
        system_name: body.systemName,
        x: body.x, y: body.y, z: body.z,
        world_type: worldType,
        body_name: body.bodyName,
        distance_from_ref: distance,
        distance_to_arrival: Number(body.distanceToArrival) || 0,
        estimated_value: Number(body.estimatedValue) || 0,
        is_main_star: false,
        metadata: { ...(body.metadata || {}), source: body.source || 'cache', subtype: body.subtype, atmosphere: body.atmosphere, gravity: body.gravity, temperature: body.temperature },
      });
      if (kept) stats.cachedBodies++;
    }
  }

  await flush({
    stage: 'cache',
    percent: 55,
    message: `Кэш проекта: тел найдено ${stats.cachedBodies}`,
  });

  /* ── 4. Spansh: планеты и «землеподобные» категории ── */
  const spanshFiltersBase: Record<string, unknown> = {};
  if (params.require_landable) spanshFiltersBase.is_landable = { value: true };
  if (params.min_estimated_value && params.min_estimated_value > 0) {
    spanshFiltersBase.estimated_scan_value = { value: { comparison: '>=', value: params.min_estimated_value } };
  }
  if (params.max_distance_to_arrival && params.max_distance_to_arrival > 0) {
    spanshFiltersBase.distance_to_arrival = { value: { comparison: '<=', value: params.max_distance_to_arrival } };
  }

  const bodyBatches: Array<{ filters: Record<string, unknown>; targetTypes: WorldType[] }> = [];
  if (planetTypes.length > 0) {
    const subtypes = Object.entries(SPANSH_PLANET_SUBTYPES)
      .filter(([, worldType]) => planetTypes.includes(worldType))
      .map(([subtype]) => subtype);
    if (subtypes.length > 0) bodyBatches.push({ filters: { ...spanshFiltersBase, subtype: { value: subtypes } }, targetTypes: planetTypes });
  }
  if (wantsTerraformable) {
    bodyBatches.push({ filters: { ...spanshFiltersBase, is_terraformable: { value: true } }, targetTypes: ['terraformable'] });
  }
  if (rockyTypes.length > 0) {
    bodyBatches.push({
      filters: {
        ...spanshFiltersBase,
        type: { value: 'Planet' },
        subtype: { value: ['Rocky body', 'Rocky ice world'] },
      },
      targetTypes: rockyTypes,
    });
  }

  const bodiesToCache: Parameters<typeof saveCachedBodies>[0] = [];

  for (const batchSpec of bodyBatches) {
    try {
      const result = await spanshBodiesSearch({
        referenceSystem: context.refName,
        filters: batchSpec.filters,
        sort: [{ distance: { direction: 'asc' } }],
        size: 2000,
      });
      // Запись поиска Spansh оборачивает тело в `record` — разворачиваем, чтобы
      // дальше работать с полями тела напрямую.
      const bodies = (result.results || []).map((entry: any) => (entry?.record ?? entry) as Record<string, any>);
      const systemMap = await resolveBodySystems(bodies.map((body: Record<string, any>) => ({
        name: String(body.name || ''),
        system_name: (body.system_name ?? body.systemName ?? null) as string | null,
        system_id64: (body.system_id64 ?? body.systemId64 ?? null) as string | number | null,
      })));

      for (const body of bodies) {
        const bodyName = String(body.name || '');
        if (!bodyName) continue;
        const distanceToArrival = Number(body.distance_to_arrival) || 0;
        const estimatedValue = Number(body.estimated_scan_value || body.estimated_mapping_value) || 0;

        // Фильтры Spansh проверяем и на нашей стороне: неизвестное поле он
        // молча игнорирует, а пользователь ждёт именно то, что выбрал.
        if (params.require_landable && body.is_landable === false) continue;
        if ((params.max_distance_to_arrival || 0) > 0 && distanceToArrival > (params.max_distance_to_arrival || 0)) continue;
        if ((params.min_estimated_value || 0) > 0 && estimatedValue < (params.min_estimated_value || 0)) continue;

        const direct = systemMap.get(bodyName);
        if (!direct) continue;
        const coords = direct;
        const distance = dist3(coords, refCoords);
        if (distance > halfCube) continue;

        let worldType: WorldType | null = null;
        if (batchSpec.targetTypes.includes('terraformable') && isTerraformable(body as any)) worldType = 'terraformable';
        if (!worldType) {
          const mapped = mapSpanshSubtypeToWorldType(body.subtype || '') as WorldType | null;
          if (mapped && batchSpec.targetTypes.includes(mapped)) worldType = mapped;
        }
        if (!worldType && batchSpec.targetTypes.includes('rocky_atmosphere')
          && body.atmosphere && body.atmosphere !== 'No atmosphere') {
          worldType = 'rocky_atmosphere';
        }
        if (!worldType && batchSpec.targetTypes.includes('rocky_bio')
          && (body.landmarks || []).some((landmark: string) => landmark.includes('Biological'))) {
          worldType = 'rocky_bio';
        }
        if (!worldType) worldType = batchSpec.targetTypes[0];

        const kept = pushCandidate({
          system_name: coords.systemName,
          x: coords.x, y: coords.y, z: coords.z,
          world_type: worldType,
          body_name: bodyName,
          distance_from_ref: distance,
          distance_to_arrival: distanceToArrival,
          estimated_value: estimatedValue,
          is_main_star: Boolean(body.is_main_star),
          metadata: {
            subtype: body.subtype, type: body.type, gravity: body.gravity,
            temperature: body.temperature, atmosphere: body.atmosphere,
            volcanism: body.volcanism, materials: body.materials, rings: body.rings,
            landmarks: body.landmarks, source: 'spansh',
          },
        });
        if (kept) stats.spanshBodies++;

        bodiesToCache.push({
          bodyName,
          systemName: coords.systemName,
          x: coords.x, y: coords.y, z: coords.z,
          worldType,
          bodyType: body.type ?? null,
          subtype: body.subtype ?? null,
          distanceFromRef: distance,
          distanceToArrival,
          estimatedValue,
          isTerraformable: Boolean(body.is_terraformable),
          isMainStar: Boolean(body.is_main_star),
          hasAtmosphere: Boolean(body.atmosphere && body.atmosphere !== 'No atmosphere'),
          gravity: Number(body.gravity) || null,
          temperature: Number(body.temperature) || null,
          atmosphere: body.atmosphere ?? null,
          metadata: { landmarks: body.landmarks, rings: body.rings },
          source: 'spansh',
        });
      }

      await flush({
        stage: 'spansh',
        percent: Math.min(85, 60 + Math.round((bodyBatches.indexOf(batchSpec) + 1) / bodyBatches.length * 25)),
        message: `Spansh: тел найдено ${stats.spanshBodies}`,
      });
    } catch (error: any) {
      console.error(`[atlas search] Spansh не ответил (${batchSpec.targetTypes.join(', ')}):`, error?.message);
    }
  }

  /* ── 5. Сохранение результатов ── */
  await flush({ stage: 'save', percent: 90, message: 'Сохранение результатов и кэша' });

  if (bodiesToCache.length > 0) {
    const savedBodies = await saveCachedBodies(bodiesToCache).catch(() => 0);
    stats.systemsSaved += savedBodies;
  }
  await saveCachedSystems(
    candidates
      .filter((candidate) => candidate.is_main_star)
      .map((candidate) => ({ name: candidate.system_name, x: candidate.x, y: candidate.y, z: candidate.z, source: 'edsm' })),
  ).catch(() => 0);

  if (candidates.length > 0) {
    const rows = candidates.map((candidate) => ({
      search_id: candidate.search_id,
      system_name: candidate.system_name,
      x: candidate.x, y: candidate.y, z: candidate.z,
      world_type: candidate.world_type,
      body_name: candidate.body_name,
      distance_from_ref: candidate.distance_from_ref,
      distance_to_arrival: candidate.distance_to_arrival,
      estimated_value: candidate.estimated_value,
      is_main_star: candidate.is_main_star,
      metadata: candidate.metadata,
    }));
    const BATCH = 400;
    for (let index = 0; index < rows.length; index += BATCH) {
      const { error } = await supabaseAdmin.from('atlas_candidates').insert(rows.slice(index, index + BATCH));
      if (error) console.error('[atlas search] вставка кандидатов не удалась:', error.message);
    }
  }

  await writeSearchProgress(sessionId, {
    stage: 'completed',
    percent: 100,
    message: `Готово: найдено ${candidates.length.toLocaleString('ru-RU')} объектов`,
    found: candidates.length,
    batch: [],
    stats: {
      'Из каталога (звёзды)': stats.catalogStars,
      'Из кэша тел': stats.cachedBodies,
      'Из EDSM': stats.edsmStars,
      'Из Spansh': stats.spanshBodies,
      'Сохранено в кэш': stats.systemsSaved,
    },
  });

  return { candidates: candidates.length, stats };
}

/** Координаты опорной системы поиска: каталог → кэш → Spansh → EDSM. */
export async function resolveReferenceSystem(name: string): Promise<{ x: number; y: number; z: number; source: string } | null> {
  try {
    const local = await findSystemByName(name);
    if (local) return { x: local.x, y: local.y, z: local.z, source: 'catalog' };
  } catch (error: any) {
    console.warn('[atlas search] локальный поиск системы не удался:', error?.message);
  }
  try {
    const row = await supabaseAdmin
      .from('atlas_system_cache')
      .select('x,y,z')
      .eq('name_lc', normalizeSystemName(name))
      .maybeSingle();
    if (row.data && Number.isFinite(Number(row.data.x))) {
      return { x: Number(row.data.x), y: Number(row.data.y), z: Number(row.data.z), source: 'cache' };
    }
  } catch {
    // Кэша может не быть — продолжаем.
  }
  try {
    const { spanshSearch } = await import('./spanshClient.ts');
    const nearest = await spanshSearch({ q: name, limit: 1 });
    const record = nearest?.results?.[0]?.record;
    if (record && Number.isFinite(Number(record.x))) {
      return { x: Number(record.x), y: Number(record.y), z: Number(record.z), source: 'spansh' };
    }
  } catch (error: any) {
    console.warn('[atlas search] Spansh не подтвердил систему:', error?.message);
  }
  try {
    const params = new URLSearchParams();
    params.append('systemName', name);
    params.append('showCoordinates', '1');
    const res = await fetch('https://www.edsm.net/api-v1/system?' + params.toString(), {
      headers: { Accept: 'application/json' },
      next: { revalidate: 86400 },
    });
    const data = await res.json();
    if (data?.coords) return { x: data.coords.x, y: data.coords.y, z: data.coords.z, source: 'edsm' };
  } catch (error: any) {
    console.warn('[atlas search] EDSM не ответил по системе:', error?.message);
  }
  return null;
}
