/**
 * Серверная часть реестра авианосцев (`carrier_directory`).
 *
 * Здесь только обращения к БД; правила разбора EDDN и журналов —
 * в `carrierRegistry.ts`. Запись идёт через SQL-функции миграции
 * `20261108120000_carrier_directory.sql`: они же следят, чтобы EDDN не мог
 * записать имя, а уточнить имя мог лишь владелец или побывавший на носителе.
 */

import {
  carrierNamesFromJournal,
  carrierVisitsFromJournal,
  eddnCarrierRow,
  registryEntryFromRow,
  type CarrierRegistryEntry,
  type CarrierRegistryRow,
} from './carrierRegistry';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Svc = any;

const IN_CHUNK = 100;
export const REGISTRY_COLUMNS = 'carrier_id, callsign, name, carrier_type, system_name, system_address, body_name, x, y, z, services, updated_at, last_seen_at, sightings, source';
/** Строки реестра старше этого срока в поиске не показываем: носитель мог улететь. */
export const REGISTRY_STALE_MS = 90 * 24 * 60 * 60 * 1000;

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

async function safeRows(query: any): Promise<Record<string, any>[]> {
  try {
    const { data, error } = await query;
    if (error) return [];
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/** Защита от PostgREST-шаблонов: `%` и `_` в запросе — литералы. */
function likePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/**
 * Сообщение EDDN → реестр. Возвращает `true`, если строку записали.
 *
 * Имя здесь не участвует по построению: `carrier_directory_apply` его не
 * трогает, а `eddnCarrierRow` его и не извлекает.
 */
export async function applyEddnCarrierMessage(svc: Svc, message: unknown): Promise<boolean> {
  const row = eddnCarrierRow(message);
  if (!row) return false;
  const { data, error } = await svc.rpc('carrier_directory_apply', { p_rows: [row] });
  if (error) throw new Error(`Carrier directory: ${error.message}`);
  return Number(data?.applied ?? 0) > 0;
}

/** Пачка строк (например, из будущего дозагрузчика) — тем же путём, что EDDN. */
export async function applyCarrierRegistryRows(svc: Svc, rows: CarrierRegistryRow[]): Promise<number> {
  if (!rows.length) return 0;
  let applied = 0;
  for (const chunk of chunks(rows, 500)) {
    const { data, error } = await svc.rpc('carrier_directory_apply', { p_rows: chunk });
    if (error) throw new Error(`Carrier directory: ${error.message}`);
    applied += Number(data?.applied ?? 0);
  }
  return applied;
}

/**
 * Наблюдения пилота: визиты и имена.
 *
 * Визит — это право уточнить имя позже (`carrier_directory_set_name`).
 * Имя из журнала пишем сразу: если пилот был на носителе, его игра показала
 * настоящее имя, а не позывной.
 */
export async function applyCarrierSightings(
  svc: Svc,
  userId: string | null,
  events: unknown,
): Promise<{ visits: number; names: number }> {
  if (!userId) return { visits: 0, names: 0 };
  const visits = carrierVisitsFromJournal(events);
  let applied = 0;
  if (visits.length) {
    const { data, error } = await svc.rpc('carrier_visits_record', { p_user: userId, p_rows: visits });
    if (error) throw new Error(`Carrier visits: ${error.message}`);
    applied = Number(data?.applied ?? 0);
  }

  let named = 0;
  for (const entry of carrierNamesFromJournal(events)) {
    const { data, error } = await svc.rpc('carrier_directory_set_name', {
      p_carrier_id: Number(entry.carrier_id),
      p_name: entry.name,
      p_user: userId,
    });
    if (error) continue; // имя — не повод валить загрузку журнала
    if (data?.ok) named += 1;
  }
  return { visits: applied, names: named };
}

/** Поиск по реестру: позывной, имя, система и MarketID. */
export async function searchCarrierRegistry(
  svc: Svc,
  tokens: string[],
  limit: number,
  options: { ids?: string[]; nowMs?: number } = {},
): Promise<{ rows: CarrierRegistryEntry[]; total: number; truncated: boolean }> {
  const nowMs = options.nowMs ?? Date.now();
  const fresh = new Date(nowMs - REGISTRY_STALE_MS).toISOString();
  const scanned = new Map<string, Record<string, any>>();
  const absorb = (rows: Record<string, any>[]) => {
    for (const row of rows) {
      if (row?.carrier_id == null) continue;
      scanned.set(String(row.carrier_id), row);
    }
  };

  if (options.ids) {
    for (const chunk of chunks(options.ids, IN_CHUNK)) {
      absorb(await safeRows(svc.from('carrier_directory').select(REGISTRY_COLUMNS).in('carrier_id', chunk)));
    }
  } else {
    const primary = [...tokens].sort((left, right) => right.length - left.length)[0] ?? '';
    if (!primary) {
      absorb(await safeRows(svc.from('carrier_directory').select(REGISTRY_COLUMNS)
        .gte('updated_at', fresh).order('updated_at', { ascending: false }).limit(limit * 3)));
    } else {
      const pattern = likePattern(primary);
      const lookups = [
        svc.from('carrier_directory').select(REGISTRY_COLUMNS).ilike('callsign', pattern).gte('updated_at', fresh).limit(limit * 3),
        svc.from('carrier_directory').select(REGISTRY_COLUMNS).ilike('name', pattern).gte('updated_at', fresh).limit(limit * 3),
        svc.from('carrier_directory').select(REGISTRY_COLUMNS).ilike('system_name', pattern).gte('updated_at', fresh).limit(limit * 3),
      ];
      // Позывной пишут с дефисом, а ищут слитно: «k7qbql» → «K7Q-BQL».
      const compact = primary.replace(/[^a-z0-9]/g, '');
      if (compact.length >= 3) {
        const loose = `%${compact.split('').map((char) => char).join('%')}%`;
        lookups.push(svc.from('carrier_directory').select(REGISTRY_COLUMNS)
          .ilike('callsign', loose).gte('updated_at', fresh).limit(limit * 3));
      }
      if (/^\d+$/.test(primary)) {
        lookups.push(svc.from('carrier_directory').select(REGISTRY_COLUMNS).eq('carrier_id', primary).limit(1));
      }
      for (const rows of await Promise.all(lookups.map((lookup) => safeRows(lookup)))) absorb(rows);
    }
  }

  const entries = [...scanned.values()]
    .filter((row) => Date.parse(String(row.updated_at ?? '')) >= nowMs - REGISTRY_STALE_MS)
    .map((row) => registryEntryFromRow(row));
  return { rows: entries.slice(0, limit), total: entries.length, truncated: entries.length > limit };
}

/** Строки реестра по конкретным MarketID (для слияния с учётом сайта). */
export async function carrierRegistryByIds(svc: Svc, ids: readonly string[]): Promise<Map<string, CarrierRegistryEntry>> {
  const out = new Map<string, CarrierRegistryEntry>();
  if (!ids.length) return out;
  for (const chunk of chunks([...new Set(ids)], IN_CHUNK)) {
    const rows = await safeRows(svc.from('carrier_directory').select(REGISTRY_COLUMNS).in('carrier_id', chunk));
    for (const row of rows) out.set(String(row.carrier_id), registryEntryFromRow(row));
  }
  return out;
}

/**
 * Кто из этих носителей может уточнить имя: владелец (учёт сайта) или
 * побывавший на борту. Нужно интерфейсу, чтобы не показывать поле всем.
 */
export async function carriersViewerCanName(svc: Svc, userId: string | null, ids: readonly string[]): Promise<Set<string>> {
  const allowed = new Set<string>();
  if (!userId || !ids.length) return allowed;
  for (const chunk of chunks([...new Set(ids)], IN_CHUNK)) {
    const visited = await safeRows(svc.from('carrier_visits').select('carrier_id').eq('user_id', userId).in('carrier_id', chunk));
    for (const row of visited) allowed.add(String(row.carrier_id));
    const owned = await safeRows(svc.from('fleet_carriers').select('carrier_id').eq('owner_id', userId).in('carrier_id', chunk));
    for (const row of owned) allowed.add(String(row.carrier_id));
  }
  return allowed;
}

/** Уточнить имя. Право проверяет SQL-функция, маршрут лишь передаёт пилота. */
export async function setCarrierName(
  svc: Svc,
  userId: string,
  carrierId: string,
  name: string,
): Promise<{ ok: boolean; error?: string }> {
  const { data, error } = await svc.rpc('carrier_directory_set_name', {
    p_carrier_id: Number(carrierId),
    p_name: name,
    p_user: userId,
  });
  if (error) return { ok: false, error: error.message };
  return data?.ok ? { ok: true } : { ok: false, error: String(data?.error ?? 'unknown') };
}
