/**
 * Серверная часть личного списка авианосцев (`atlas_carrier_watch`).
 *
 * Одна строка таблицы — один носитель у одного пилота: флаг «в избранном»,
 * комментарий и, если пилот подписался на прыжок, снимок плана
 * (`jump_*`, миграция `20261110190000_carrier_watch_jump.sql`). Имена колонок
 * snake_case, а клиент и правила поиска работают с camelCase (`CarrierWatch`),
 * поэтому перевод строки живёт здесь, а не в каждом маршруте.
 */
import type { CarrierWatch } from './carrierDirectory';

/** Колонки, которые читает интерфейс. */
export const WATCH_COLUMNS = 'id, carrier_id, callsign, name, system_name, favorite, note, updated_at, jump_system_name, jump_departure_at, jump_seen_at';
/**
 * Колонки до миграции подписок на прыжок: старая установка не должна ломать
 * избранное Атласа — маршрут при ошибке выбора повторяет запрос без `jump_*`.
 */
export const WATCH_COLUMNS_BASE = 'id, carrier_id, callsign, name, system_name, favorite, note, updated_at';

/** Время из строки базы — ISO: PostgREST отдаёт строку, драйвер теста может `Date`. */
function asIso(value: unknown): string | null {
  if (value == null || value === '') return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

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
    updatedAt: asIso(row.updated_at),
    jumpSystem: (row.jump_system_name as string | null) ?? null,
    jumpDepartureAt: asIso(row.jump_departure_at),
    jumpSeenAt: asIso(row.jump_seen_at),
  };
}

/**
 * Запись → колонки таблицы (для upsert).
 *
 * Снимок прыжка попадает в запрос **только** когда он передан: обычное
 * избранное Атласа не должно затирать подписку на прыжок пустыми полями
 * (PostgREST обновляет лишь те колонки, которые есть в теле).
 */
export function watchToRow(watch: Omit<CarrierWatch, 'id' | 'updatedAt'> & { userId: string }) {
  const row: Record<string, unknown> = {
    user_id: watch.userId,
    carrier_id: watch.carrierId,
    callsign: watch.callsign,
    name: watch.name,
    system_name: watch.system,
    favorite: watch.favorite,
    note: watch.note,
    updated_at: new Date().toISOString(),
  };
  if (watch.jumpSystem !== undefined) row.jump_system_name = watch.jumpSystem;
  if (watch.jumpDepartureAt !== undefined) row.jump_departure_at = watch.jumpDepartureAt;
  if (watch.jumpSeenAt !== undefined) row.jump_seen_at = watch.jumpSeenAt;
  return row;
}
