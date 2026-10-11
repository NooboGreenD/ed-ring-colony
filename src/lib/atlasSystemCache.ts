/**
 * Кэш систем и тел для поисковиков Atlas (таблицы atlas_system_cache /
 * atlas_body_cache, миграция 20261011000000).
 *
 * Идея: любой удачный внешний запрос (каталог Spansh, EDSM, Spansh API) один
 * раз сохраняется в БД проекта. Следующий поиск в том же районе берёт данные
 * оттуда и не тратит ни лимиты внешних API, ни время пользователя.
 *
 * Все функции деградируют мягко: без миграции (или при недоступной БД) они
 * возвращают пустой результат и пишут предупреждение в лог — поисковик просто
 * идёт по внешним источникам, как раньше.
 */

// Явные расширения нужны для `node --test` (см. galaxySystemsDb.ts).
import { supabaseAdmin } from './supabaseAdmin.ts';
import { normalizeSystemName } from './galaxySystems.ts';

export interface CachedSystem {
  name: string;
  x: number;
  y: number;
  z: number;
  id64?: string | null;
  source?: string;
}

export interface Box {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

export interface CachedBody {
  bodyName: string;
  systemName: string;
  x: number;
  y: number;
  z: number;
  worldType: string;
  bodyType?: string | null;
  subtype?: string | null;
  distanceFromRef?: number | null;
  distanceToArrival?: number | null;
  estimatedValue?: number | null;
  isTerraformable?: boolean | null;
  isMainStar?: boolean | null;
  hasAtmosphere?: boolean | null;
  gravity?: number | null;
  temperature?: number | null;
  atmosphere?: string | null;
  metadata?: Record<string, unknown>;
  source?: string;
}

/** Размер страницы: PostgREST по умолчанию отдаёт не больше 1000 строк. */
const PAGE_SIZE = 1000;
/** Сколько страниц максимум вычитываем за один вызов. */
const MAX_PAGES = 40;

// Таблица может отсутствовать (миграция ещё не применена). Чтобы не долбить
// БД одинаковыми ошибками на каждый сегмент поиска, помним это на пять минут.
const MISSING_TABLE_TTL_MS = 5 * 60_000;
let systemsUnavailableUntil = 0;
let bodiesUnavailableUntil = 0;

function isMissingRelation(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  if (error.code === '42P01' || error.code === 'PGRST205' || error.code === 'PGRST202') return true;
  return /does not exist|not find the table|schema cache/i.test(error.message || '');
}

export function boxAround(point: { x: number; y: number; z: number }, radius: number): Box {
  return {
    minX: point.x - radius,
    maxX: point.x + radius,
    minY: point.y - radius,
    maxY: point.y + radius,
    minZ: point.z - radius,
    maxZ: point.z + radius,
  };
}

export async function listCachedSystemsInBox(box: Box, limit = 20_000): Promise<CachedSystem[]> {
  if (Date.now() < systemsUnavailableUntil) return [];
  const rows: CachedSystem[] = [];
  try {
    for (let page = 0; page < MAX_PAGES && rows.length < limit; page++) {
      const from = page * PAGE_SIZE;
      const to = Math.min(from + PAGE_SIZE, limit) - 1;
      const { data, error } = await supabaseAdmin
        .from('atlas_system_cache')
        .select('system_name,x,y,z,id64,source')
        .gte('x', box.minX).lte('x', box.maxX)
        .gte('y', box.minY).lte('y', box.maxY)
        .gte('z', box.minZ).lte('z', box.maxZ)
        .order('system_name', { ascending: true })
        .range(from, to);
      if (error) {
        if (isMissingRelation(error)) {
          systemsUnavailableUntil = Date.now() + MISSING_TABLE_TTL_MS;
          console.warn('[atlas cache] atlas_system_cache недоступна:', error.message);
          return [];
        }
        console.warn('[atlas cache] не удалось прочитать кэш систем:', error.message);
        break;
      }
      const batch = (data || []) as Array<{ system_name: string; x: number; y: number; z: number; id64: string | null; source: string | null }>;
      for (const row of batch) {
        const x = Number(row.x);
        const y = Number(row.y);
        const z = Number(row.z);
        if (!row.system_name || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
        rows.push({ name: row.system_name, x, y, z, id64: row.id64, source: row.source || 'cache' });
      }
      if (batch.length < PAGE_SIZE) break;
    }
  } catch (error: any) {
    console.warn('[atlas cache] чтение кэша систем прервано:', error?.message || error);
  }
  return rows;
}

export async function listCachedSystemsNear(
  point: { x: number; y: number; z: number },
  radius: number,
  limit = 800,
): Promise<CachedSystem[]> {
  const rows = await listCachedSystemsInBox(boxAround(point, radius), Math.max(limit, PAGE_SIZE));
  const radiusSquared = radius * radius;
  return rows
    .map((row) => ({
      row,
      distanceSquared: (row.x - point.x) ** 2 + (row.y - point.y) ** 2 + (row.z - point.z) ** 2,
    }))
    .filter((entry) => entry.distanceSquared <= radiusSquared)
    .sort((left, right) => left.distanceSquared - right.distanceSquared)
    .slice(0, limit)
    .map((entry) => entry.row);
}

/**
 * Сохранение найденных систем. Обновляем только «свежесть» и источник, чтобы
 * эталонными координатами оставались первые попавшие в кэш.
 */
export async function saveCachedSystems(systems: CachedSystem[]): Promise<number> {
  if (Date.now() < systemsUnavailableUntil || systems.length === 0) return 0;
  const now = new Date().toISOString();
  const byName = new Map<string, CachedSystem>();
  for (const system of systems) {
    const name = String(system.name || '').trim().replace(/\s+/g, ' ');
    if (!name) continue;
    if (!Number.isFinite(system.x) || !Number.isFinite(system.y) || !Number.isFinite(system.z)) continue;
    byName.set(name.toLowerCase(), { ...system, name });
  }
  const rows = Array.from(byName.values()).map((system) => ({
    system_name: system.name,
    name_lc: normalizeSystemName(system.name),
    x: system.x,
    y: system.y,
    z: system.z,
    id64: system.id64 ? String(system.id64) : null,
    source: system.source || 'edsm',
    last_seen_at: now,
  }));
  let saved = 0;
  for (let index = 0; index < rows.length; index += 500) {
    const chunk = rows.slice(index, index + 500);
    const { error } = await supabaseAdmin
      .from('atlas_system_cache')
      .upsert(chunk, { onConflict: 'system_name' });
    if (error) {
      if (isMissingRelation(error)) {
        systemsUnavailableUntil = Date.now() + MISSING_TABLE_TTL_MS;
        console.warn('[atlas cache] atlas_system_cache недоступна, кэш не сохраняется:', error.message);
        return saved;
      }
      console.warn('[atlas cache] не удалось сохранить системы:', error.message);
      continue;
    }
    saved += chunk.length;
  }
  return saved;
}

export async function listCachedBodiesInBox(box: Box, worldTypes: string[], limit = 5_000): Promise<CachedBody[]> {
  if (Date.now() < bodiesUnavailableUntil) return [];
  const result: CachedBody[] = [];
  try {
    for (let page = 0; page < MAX_PAGES && result.length < limit; page++) {
      const from = page * PAGE_SIZE;
      const to = Math.min(from + PAGE_SIZE, limit) - 1;
      let query = supabaseAdmin
        .from('atlas_body_cache')
        .select('body_name,system_name,x,y,z,world_type,body_type,subtype,distance_from_ref,distance_to_arrival,estimated_value,is_terraformable,is_main_star,has_atmosphere,gravity,temperature,atmosphere,metadata,source')
        .gte('x', box.minX).lte('x', box.maxX)
        .gte('y', box.minY).lte('y', box.maxY)
        .gte('z', box.minZ).lte('z', box.maxZ)
        .order('body_name', { ascending: true })
        .range(from, to);
      if (worldTypes.length > 0) query = query.in('world_type', worldTypes);
      const { data, error } = await query;
      if (error) {
        if (isMissingRelation(error)) {
          bodiesUnavailableUntil = Date.now() + MISSING_TABLE_TTL_MS;
          console.warn('[atlas cache] atlas_body_cache недоступна:', error.message);
          return [];
        }
        console.warn('[atlas cache] не удалось прочитать кэш тел:', error.message);
        break;
      }
      const batch = (data || []) as any[];
      for (const row of batch) {
        const x = Number(row.x);
        const y = Number(row.y);
        const z = Number(row.z);
        if (!row.body_name || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
        result.push({
          bodyName: String(row.body_name),
          systemName: String(row.system_name || ''),
          x, y, z,
          worldType: String(row.world_type || ''),
          bodyType: row.body_type ?? null,
          subtype: row.subtype ?? null,
          distanceFromRef: row.distance_from_ref ?? null,
          distanceToArrival: row.distance_to_arrival ?? null,
          estimatedValue: row.estimated_value ?? null,
          isTerraformable: row.is_terraformable ?? null,
          isMainStar: row.is_main_star ?? null,
          hasAtmosphere: row.has_atmosphere ?? null,
          gravity: row.gravity ?? null,
          temperature: row.temperature ?? null,
          atmosphere: row.atmosphere ?? null,
          metadata: row.metadata && typeof row.metadata === 'object' ? row.metadata : {},
          source: row.source || 'cache',
        });
      }
      if (batch.length < PAGE_SIZE) break;
    }
  } catch (error: any) {
    console.warn('[atlas cache] чтение кэша тел прервано:', error?.message || error);
  }
  return result;
}

export async function saveCachedBodies(bodies: CachedBody[]): Promise<number> {
  if (Date.now() < bodiesUnavailableUntil || bodies.length === 0) return 0;
  const now = new Date().toISOString();
  const byName = new Map<string, CachedBody>();
  for (const body of bodies) {
    const bodyName = String(body.bodyName || '').trim();
    if (!bodyName || !body.worldType) continue;
    if (!Number.isFinite(body.x) || !Number.isFinite(body.y) || !Number.isFinite(body.z)) continue;
    byName.set(bodyName.toLowerCase(), body);
  }
  const rows = Array.from(byName.values()).map((body) => ({
    body_name: body.bodyName,
    system_name: body.systemName,
    system_lc: normalizeSystemName(body.systemName),
    x: body.x, y: body.y, z: body.z,
    world_type: body.worldType,
    body_type: body.bodyType ?? null,
    subtype: body.subtype ?? null,
    distance_from_ref: body.distanceFromRef ?? null,
    distance_to_arrival: body.distanceToArrival ?? null,
    estimated_value: body.estimatedValue ?? null,
    is_terraformable: body.isTerraformable ?? null,
    is_main_star: body.isMainStar ?? null,
    has_atmosphere: body.hasAtmosphere ?? null,
    gravity: body.gravity ?? null,
    temperature: body.temperature ?? null,
    atmosphere: body.atmosphere ?? null,
    metadata: body.metadata || {},
    source: body.source || 'spansh',
    last_seen_at: now,
  }));
  let saved = 0;
  for (let index = 0; index < rows.length; index += 500) {
    const chunk = rows.slice(index, index + 500);
    const { error } = await supabaseAdmin
      .from('atlas_body_cache')
      .upsert(chunk, { onConflict: 'body_name' });
    if (error) {
      if (isMissingRelation(error)) {
        bodiesUnavailableUntil = Date.now() + MISSING_TABLE_TTL_MS;
        console.warn('[atlas cache] atlas_body_cache недоступна, кэш не сохраняется:', error.message);
        return saved;
      }
      console.warn('[atlas cache] не удалось сохранить тела:', error.message);
      continue;
    }
    saved += chunk.length;
  }
  return saved;
}
