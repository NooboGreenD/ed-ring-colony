/**
 * Расписания прыжков авианосцев: обращения к базе.
 *
 * Маршруты `/api/carriers/jumps/schedules*` пользуются service_role клиентом,
 * поэтому правило видимости проверяется здесь явно: приватное расписание
 * отдаётся только владельцу, публичное — любому, даже без сессии. RLS в
 * миграции `20261112120000_carrier_jump_schedule.sql` повторяет то же правило
 * для прямых запросов из браузера — две независимые проверки лучше одной.
 *
 * Чистые правила (проверка ввода, календарь, сортировка) живут в
 * `carrierJumpSchedule.ts`; здесь только SQL.
 */

import {
  SCHEDULE_ENTRIES_LIMIT,
  SCHEDULE_LIST_LIMIT,
  compareSchedules,
  entryFromRow,
  nextEntryAt,
  normalizeSchedule,
  normalizeScheduleEntry,
  scheduleFromRow,
  type JumpSchedule,
  type JumpScheduleEntry,
} from './carrierJumpSchedule.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Svc = any;
type Row = Record<string, any>;

export const SCHEDULE_COLUMNS = 'id, owner_id, title, note, visibility, created_at, updated_at';

/**
 * Проверенный прыжок → колонки таблицы.
 *
 * `normalizeScheduleEntry` говорит с интерфейсом на camelCase (`carrierId`,
 * `departureAt`), а таблица — на snake_case. Перевод держим здесь, рядом с
 * колонками: иначе в INSERT уехали бы имена, которых в базе нет.
 */
function entryToRow(value: {
  carrierId: string | null;
  callsign: string | null;
  name: string | null;
  from: string;
  to: string;
  departureAt: string;
  note: string | null;
}): Row {
  return {
    carrier_id: value.carrierId,
    callsign: value.callsign,
    name: value.name,
    from_system: value.from,
    to_system: value.to,
    departure_at: value.departureAt,
    note: value.note,
  };
}
export const ENTRY_COLUMNS = 'id, schedule_id, carrier_id, callsign, name, from_system, to_system, departure_at, note, created_at';

export interface ScheduleStats {
  entryCount: number;
  nextEntryAt: string | null;
}

export const EMPTY_STATS: ScheduleStats = { entryCount: 0, nextEntryAt: null };

/** Ошибка маршрута: код ответа и ключ перевода. */
export type ScheduleFailure = { status: number; key: string };

function asRows(value: unknown): Row[] {
  return Array.isArray(value) ? value as Row[] : [];
}

/**
 * Сводка по расписаниям одним запросом (`carrier_jump_schedule_stats`).
 * Функции может не быть на старой установке — тогда считаем по пустому списку
 * и список всё равно показывается (без счётчиков, а не с ошибкой).
 */
export async function scheduleStats(svc: Svc, ids: readonly string[]): Promise<Map<string, ScheduleStats>> {
  const stats = new Map<string, ScheduleStats>();
  if (!ids.length) return stats;
  const { data, error } = await svc.rpc('carrier_jump_schedule_stats', { p_ids: [...ids] });
  if (error || !Array.isArray(data)) return stats;
  for (const row of data as Row[]) {
    const id = String(row.schedule_id ?? '');
    if (!id) continue;
    stats.set(id, {
      entryCount: Number(row.entry_count ?? 0),
      nextEntryAt: row.next_entry_at ? new Date(String(row.next_entry_at)).toISOString() : null,
    });
  }
  return stats;
}

/** Имена владельцев для публичных расписаний: только командирское имя. */
async function ownerNames(svc: Svc, ids: readonly string[]): Promise<Map<string, string | null>> {
  const names = new Map<string, string | null>();
  if (!ids.length) return names;
  const { data, error } = await svc.from('profiles').select('id, cmdr_name').in('id', [...ids]);
  if (error || !Array.isArray(data)) return names;
  for (const row of data as Row[]) {
    const id = String(row.id ?? '');
    if (id) names.set(id, row.cmdr_name ? String(row.cmdr_name) : null);
  }
  return names;
}

/** Собрать расписания из строк: статистика, имя владельца, порядок. */
async function buildSchedules(
  svc: Svc,
  rows: readonly Row[],
  viewerId: string | null,
): Promise<JumpSchedule[]> {
  if (!rows.length) return [];
  const ids = rows.map((row) => String(row.id));
  const ownerIds = Array.from(new Set(rows.map((row) => (row.owner_id == null ? '' : String(row.owner_id))).filter(Boolean)));
  const [stats, names] = await Promise.all([
    scheduleStats(svc, ids),
    ownerNames(svc, ownerIds),
  ]);
  return rows
    .map((row) => {
      const id = String(row.id);
      const stat = stats.get(id) ?? EMPTY_STATS;
      const ownerId = row.owner_id == null ? '' : String(row.owner_id);
      return scheduleFromRow(row, {
        viewerId,
        entryCount: stat.entryCount,
        nextEntryAt: stat.nextEntryAt,
        ownerName: ownerId ? names.get(ownerId) ?? null : null,
      });
    })
    .sort(compareSchedules);
}

/**
 * Список расписаний зрителя: свои (любой видимости) и все публичные.
 * Два отдельных запроса вместо `or()`: PostgREST-строка `or` ломается на
 * значениях со скобками, а здесь она ещё и склеивала бы два разных условия.
 */
export async function listJumpSchedules(
  svc: Svc,
  viewerId: string | null,
  options: { limit?: number } = {},
): Promise<JumpSchedule[]> {
  const limit = Math.max(1, Math.floor(options.limit ?? SCHEDULE_LIST_LIMIT));
  const own = viewerId
    ? svc.from('carrier_jump_schedules')
      .select(SCHEDULE_COLUMNS)
      .eq('owner_id', viewerId)
      .order('updated_at', { ascending: false })
      .limit(limit)
    : Promise.resolve({ data: [], error: null });
  const publicList = svc.from('carrier_jump_schedules')
    .select(SCHEDULE_COLUMNS)
    .eq('visibility', 'public')
    .order('updated_at', { ascending: false })
    .limit(limit);

  const [mine, shared] = await Promise.all([own, publicList]);
  if (mine.error) throw new Error(mine.error.message);
  if (shared.error) throw new Error(shared.error.message);

  const byId = new Map<string, Row>();
  for (const row of [...asRows(mine.data), ...asRows(shared.data)]) {
    if (row?.id != null && !byId.has(String(row.id))) byId.set(String(row.id), row);
  }
  return (await buildSchedules(svc, Array.from(byId.values()), viewerId)).slice(0, limit);
}

export type LoadedSchedule =
  | { ok: true; schedule: JumpSchedule; entries: JumpScheduleEntry[] }
  | { ok: false; failure: ScheduleFailure };

/**
 * Одно расписание с прыжками. Приватное чужое — 403 (а не 404): человек
 * знает, что расписание существует, и ему честно говорят, что оно закрыто.
 */
export async function loadJumpSchedule(svc: Svc, id: string, viewerId: string | null): Promise<LoadedSchedule> {
  const { data, error } = await svc
    .from('carrier_jump_schedules')
    .select(SCHEDULE_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error) return { ok: false, failure: { status: 500, key: 'api.jumpScheduleFailed' } };
  if (!data) return { ok: false, failure: { status: 404, key: 'api.jumpScheduleNotFound' } };

  const ownerId = data.owner_id == null ? '' : String(data.owner_id);
  const mine = Boolean(viewerId) && ownerId === viewerId;
  if (!mine && data.visibility !== 'public') {
    return { ok: false, failure: { status: 403, key: 'api.jumpScheduleForbidden' } };
  }

  const entries = await svc
    .from('carrier_jump_schedule_entries')
    .select(ENTRY_COLUMNS)
    .eq('schedule_id', id)
    .order('departure_at', { ascending: true })
    .limit(SCHEDULE_ENTRIES_LIMIT);
  if (entries.error) return { ok: false, failure: { status: 500, key: 'api.jumpScheduleFailed' } };

  const list = asRows(entries.data).map(entryFromRow);
  const names = await ownerNames(svc, [ownerId]);
  return {
    ok: true,
    schedule: scheduleFromRow(data as Row, {
      viewerId,
      entryCount: list.length,
      nextEntryAt: nextEntryAt(list),
      ownerName: names.get(ownerId) ?? null,
    }),
    entries: list,
  };
}

/** Создать расписание. Владелец — всегда текущий пилот. */
export async function createJumpSchedule(
  svc: Svc,
  viewerId: string,
  input: { title?: unknown; note?: unknown; visibility?: unknown },
): Promise<JumpSchedule | ScheduleFailure> {
  const normalized = normalizeSchedule(input);
  if (!normalized.ok) return { status: 400, key: 'api.jumpScheduleInvalid' };
  const { data, error } = await svc
    .from('carrier_jump_schedules')
    .insert({ ...normalized.value, owner_id: viewerId })
    .select(SCHEDULE_COLUMNS)
    .single();
  if (error || !data) return { status: 500, key: 'api.jumpScheduleFailed' };
  const names = await ownerNames(svc, [viewerId]);
  return scheduleFromRow(data as Row, { viewerId, ownerName: names.get(viewerId) ?? null });
}

/** Изменить шапку: название, заметку или видимость. Только владелец. */
export async function updateJumpSchedule(
  svc: Svc,
  id: string,
  viewerId: string,
  input: { title?: unknown; note?: unknown; visibility?: unknown },
): Promise<JumpSchedule | ScheduleFailure> {
  const current = await svc
    .from('carrier_jump_schedules')
    .select(SCHEDULE_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (current.error) return { status: 500, key: 'api.jumpScheduleFailed' };
  if (!current.data) return { status: 404, key: 'api.jumpScheduleNotFound' };
  if (String(current.data.owner_id ?? '') !== viewerId) {
    return { status: 403, key: 'api.jumpScheduleForbidden' };
  }

  // Не переданное поле не трогаем: переключатель видимости не должен затирать
  // заметку, а переименование — видимость.
  const patch: Row = { updated_at: new Date().toISOString() };
  const merged = {
    title: input.title !== undefined ? input.title : current.data.title,
    note: input.note !== undefined ? input.note : current.data.note,
    visibility: input.visibility !== undefined ? input.visibility : current.data.visibility,
  };
  const normalized = normalizeSchedule(merged);
  if (!normalized.ok) return { status: 400, key: 'api.jumpScheduleInvalid' };
  if (input.title !== undefined) patch.title = normalized.value.title;
  if (input.note !== undefined) patch.note = normalized.value.note;
  if (input.visibility !== undefined) patch.visibility = normalized.value.visibility;

  const { data, error } = await svc
    .from('carrier_jump_schedules')
    .update(patch)
    .eq('id', id)
    .select(SCHEDULE_COLUMNS)
    .single();
  if (error || !data) return { status: 500, key: 'api.jumpScheduleFailed' };

  const stats = await scheduleStats(svc, [id]);
  const stat = stats.get(id) ?? EMPTY_STATS;
  return scheduleFromRow(data as Row, {
    viewerId,
    entryCount: stat.entryCount,
    nextEntryAt: stat.nextEntryAt,
    ownerName: (await ownerNames(svc, [viewerId])).get(viewerId) ?? null,
  });
}

/** Удалить расписание вместе со строками (`ON DELETE CASCADE`). */
export async function deleteJumpSchedule(svc: Svc, id: string, viewerId: string): Promise<ScheduleFailure | null> {
  const current = await svc
    .from('carrier_jump_schedules')
    .select('id, owner_id')
    .eq('id', id)
    .maybeSingle();
  if (current.error) return { status: 500, key: 'api.jumpScheduleFailed' };
  if (!current.data) return { status: 404, key: 'api.jumpScheduleNotFound' };
  if (String(current.data.owner_id ?? '') !== viewerId) {
    return { status: 403, key: 'api.jumpScheduleForbidden' };
  }
  const { error } = await svc.from('carrier_jump_schedules').delete().eq('id', id);
  if (error) return { status: 500, key: 'api.jumpScheduleFailed' };
  return null;
}

/**
 * Добавить прыжок в расписание. Публичное расписание правит только владелец:
 * «поделиться» — это чтение, а не совместное редактирование.
 */
export async function addScheduleEntry(
  svc: Svc,
  scheduleId: string,
  viewerId: string,
  input: Record<string, unknown>,
): Promise<JumpScheduleEntry | { status: number; key: string; duplicate?: boolean }> {
  const schedule = await svc
    .from('carrier_jump_schedules')
    .select('id, owner_id')
    .eq('id', scheduleId)
    .maybeSingle();
  if (schedule.error) return { status: 500, key: 'api.jumpScheduleFailed' };
  if (!schedule.data) return { status: 404, key: 'api.jumpScheduleNotFound' };
  if (String(schedule.data.owner_id ?? '') !== viewerId) {
    return { status: 403, key: 'api.jumpScheduleForbidden' };
  }

  const normalized = normalizeScheduleEntry(input);
  if (!normalized.ok) return { status: 400, key: 'api.jumpScheduleEntryInvalid' };

  // Повтор (тот же носитель и время) — 409, а не тишина: интерфейс покажет
  // «этот прыжок уже в расписании».
  if (normalized.value.carrierId) {
    const existing = await svc
      .from('carrier_jump_schedule_entries')
      .select('id')
      .eq('schedule_id', scheduleId)
      .eq('carrier_id', normalized.value.carrierId)
      .eq('departure_at', normalized.value.departureAt)
      .limit(1);
    if (!existing.error && asRows(existing.data).length) {
      return { status: 409, key: 'api.jumpScheduleEntryExists', duplicate: true };
    }
  }

  const { data, error } = await svc
    .from('carrier_jump_schedule_entries')
    .insert({ ...entryToRow(normalized.value), schedule_id: scheduleId })
    .select(ENTRY_COLUMNS)
    .single();
  if (error || !data) return { status: 500, key: 'api.jumpScheduleFailed' };
  // Шапка «свежая»: по updated_at список показывает недавно изменённые.
  await svc.from('carrier_jump_schedules').update({ updated_at: new Date().toISOString() }).eq('id', scheduleId);
  return entryFromRow(data as Row);
}

/** Убрать прыжок из расписания. Только владелец. */
export async function deleteScheduleEntry(
  svc: Svc,
  scheduleId: string,
  entryId: string,
  viewerId: string,
): Promise<ScheduleFailure | null> {
  const schedule = await svc
    .from('carrier_jump_schedules')
    .select('id, owner_id')
    .eq('id', scheduleId)
    .maybeSingle();
  if (schedule.error) return { status: 500, key: 'api.jumpScheduleFailed' };
  if (!schedule.data) return { status: 404, key: 'api.jumpScheduleNotFound' };
  if (String(schedule.data.owner_id ?? '') !== viewerId) {
    return { status: 403, key: 'api.jumpScheduleForbidden' };
  }
  const { error } = await svc
    .from('carrier_jump_schedule_entries')
    .delete()
    .eq('id', entryId)
    .eq('schedule_id', scheduleId);
  if (error) return { status: 500, key: 'api.jumpScheduleFailed' };
  await svc.from('carrier_jump_schedules').update({ updated_at: new Date().toISOString() }).eq('id', scheduleId);
  return null;
}

/** Ошибка-результат или готовое значение: одна проверка вместо `instanceof`. */
export function isScheduleFailure(value: unknown): value is ScheduleFailure {
  return Boolean(value) && typeof value === 'object' && 'status' in (value as object) && 'key' in (value as object);
}
