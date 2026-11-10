/**
 * Серверная часть личного списка авианосцев (`atlas_carrier_watch`).
 *
 * Одна строка таблицы — один носитель у одного пилота: флаг «в избранном» и
 * комментарий. Имена колонок snake_case, а клиент и правила поиска работают с
 * camelCase (`CarrierWatch`), поэтому перевод строки живёт здесь, а не в
 * каждом маршруте.
 */
import type { CarrierWatch } from './carrierDirectory';

/** Колонки, которые читает интерфейс. */
export const WATCH_COLUMNS = 'id, carrier_id, callsign, name, system_name, favorite, note, updated_at';

/** Строка `atlas_carrier_watch` → запись для клиента. */
export function watchFromRow(row: Record<string, unknown>): CarrierWatch {
  return {
    id: String(row.id ?? ''),
    carrierId: String(row.carrier_id ?? ''),
    callsign: (row.callsign as string | null) ?? null,
    name: (row.name as string | null) ?? null,
    system: (row.system_name as string | null) ?? null,
    favorite: row.favorite !== false,
    note: (row.note as string | null) ?? null,
    updatedAt: (row.updated_at as string | null) ?? null,
  };
}

/** Запись → колонки таблицы (для upsert). */
export function watchToRow(watch: Omit<CarrierWatch, 'id' | 'updatedAt'> & { userId: string }) {
  return {
    user_id: watch.userId,
    carrier_id: watch.carrierId,
    callsign: watch.callsign,
    name: watch.name,
    system_name: watch.system,
    favorite: watch.favorite,
    note: watch.note,
    updated_at: new Date().toISOString(),
  };
}
