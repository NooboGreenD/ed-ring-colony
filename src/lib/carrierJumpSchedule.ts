/**
 * Расписания прыжков авианосцев — вкладка «Расписание» на `/carriers/jumps`.
 *
 * Заказ прыжка живёт минуты: носитель ушёл — строка исчезла. Планы же
 * составляют на дни вперёд, и ведёт их человек: «в четверг наш Drake идёт из
 * Sol в Lave», «в субботу заберём груз в Alioth». Поэтому рядом с живой
 * таблицей есть расписание — собственные записи пилота.
 *
 * Здесь только чистые правила, без React и без БД: проверка того, что вводят
 * в форму, перевод строк базы в объекты для интерфейса, календарная сетка
 * месяца и группировка прыжков по дням. Ими пользуются и страница, и маршруты,
 * и тесты (`scripts/tests/carrier-jump-schedule.test.mjs`), поэтому расхождению
 * между «что сохранили» и «что показали» взяться негде.
 *
 * Видимость — два значения: `private` (по умолчанию, только владелец) и
 * `public` (по ссылке, читать может кто угодно, даже без входа). Правит
 * расписание всегда только владелец.
 */

import type { JumpBoardRow } from './carrierJumps.ts';

/** Длина названия и заметки — те же пределы, что в CHECK-ах миграции. */
export const SCHEDULE_TITLE_MAX = 80;
export const SCHEDULE_NOTE_MAX = 500;
export const ENTRY_NOTE_MAX = 500;
/** Сколько расписаний отдаёт список и сколько строк — одно расписание. */
export const SCHEDULE_LIST_LIMIT = 50;
export const SCHEDULE_ENTRIES_LIMIT = 500;
/** Дальше этого срока план — уже не план, а опечатка в годе. */
export const ENTRY_MAX_AHEAD_MS = 366 * 24 * 60 * 60 * 1000;
/** И настолько в прошлом строка уже бессмысленна. */
export const ENTRY_MAX_AGO_MS = 366 * 24 * 60 * 60 * 1000;

export type JumpScheduleVisibility = 'private' | 'public';

export const JUMP_SCHEDULE_VISIBILITIES: readonly JumpScheduleVisibility[] = ['private', 'public'];

/** Расписание в том виде, в каком его видит интерфейс. */
export interface JumpSchedule {
  id: string;
  title: string;
  note: string | null;
  visibility: JumpScheduleVisibility;
  /** Владелец смотрит на своё расписание: править можно только тогда. */
  mine: boolean;
  /** Имя владельца для публичных подборок; у своего — тоже (для списка). */
  ownerName: string | null;
  entryCount: number;
  /** Ближайший прыжок: по нему список сортируется и показывает «когда». */
  nextEntryAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** Один прыжок в расписании. */
export interface JumpScheduleEntry {
  id: string;
  scheduleId: string;
  /** MarketID носителя; у ручного плана может не быть. */
  carrierId: string | null;
  callsign: string | null;
  name: string | null;
  from: string;
  to: string;
  departureAt: string;
  note: string | null;
  createdAt?: string | null;
}

export type ScheduleNormalized =
  | { ok: true; value: { title: string; note: string | null; visibility: JumpScheduleVisibility } }
  | { ok: false; error: string };

export type EntryNormalized =
  | {
    ok: true;
    value: {
      carrierId: string | null;
      callsign: string | null;
      name: string | null;
      from: string;
      to: string;
      departureAt: string;
      note: string | null;
    };
  }
  | { ok: false; error: string };

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function timeMs(value: unknown): number {
  if (value == null || value === '') return NaN;
  return Date.parse(String(value));
}

/** Время из строки базы — ISO: PostgREST отдаёт строку, драйвер теста может `Date`. */
function asIso(value: unknown): string | null {
  const ms = timeMs(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Видимость из формы: мусор считаем приватностью, а не публичностью. */
export function parseVisibility(value: unknown): JumpScheduleVisibility {
  return text(value).toLowerCase() === 'public' ? 'public' : 'private';
}

/** Название расписания: обрезаем пробелы и длину, но не отвергаем ввод. */
export function normalizeScheduleTitle(value: unknown): string {
  return text(value).replace(/\s+/g, ' ').slice(0, SCHEDULE_TITLE_MAX);
}

/**
 * Проверка шапки расписания. Название обязательно, заметка обрезается по
 * пределу (пилот вставил длинный текст — пусть сохранится, сколько влезает).
 */
export function normalizeSchedule(input: {
  title?: unknown;
  note?: unknown;
  visibility?: unknown;
}): ScheduleNormalized {
  const title = normalizeScheduleTitle(input.title);
  if (!title) return { ok: false, error: 'title is required' };
  const note = text(input.note);
  return {
    ok: true,
    value: {
      title,
      note: note ? note.slice(0, SCHEDULE_NOTE_MAX) : null,
      visibility: parseVisibility(input.visibility),
    },
  };
}

/**
 * Проверка строки расписания: нужны обе системы и время вылета.
 * Носитель необязателен — план может быть «привезём груз таким-то рейсом».
 */
export function normalizeScheduleEntry(input: {
  carrierId?: unknown;
  callsign?: unknown;
  name?: unknown;
  from?: unknown;
  to?: unknown;
  departureAt?: unknown;
  note?: unknown;
}, now = Date.now()): EntryNormalized {
  const from = text(input.from).slice(0, 80);
  const to = text(input.to).slice(0, 80);
  if (!from) return { ok: false, error: 'from is required' };
  if (!to) return { ok: false, error: 'to is required' };
  const departureMs = timeMs(input.departureAt);
  if (!Number.isFinite(departureMs)) return { ok: false, error: 'departure_at is required' };
  if (departureMs > now + ENTRY_MAX_AHEAD_MS) return { ok: false, error: 'departure_at is too far ahead' };
  if (departureMs < now - ENTRY_MAX_AGO_MS) return { ok: false, error: 'departure_at is too far back' };

  const rawCarrier = text(input.carrierId);
  const carrierId = rawCarrier && /^\d+$/.test(rawCarrier) ? rawCarrier.slice(0, 32) : null;
  const note = text(input.note);
  return {
    ok: true,
    value: {
      carrierId,
      callsign: text(input.callsign).slice(0, 16) || null,
      name: text(input.name).slice(0, 80) || null,
      from,
      to,
      departureAt: new Date(departureMs).toISOString(),
      note: note ? note.slice(0, ENTRY_NOTE_MAX) : null,
    },
  };
}

/** Строка `carrier_jump_schedules` (+ данные владельца) → расписание. */
export function scheduleFromRow(
  row: Record<string, unknown>,
  options: { viewerId?: string | null; entryCount?: number; nextEntryAt?: string | null; ownerName?: string | null } = {},
): JumpSchedule {
  const ownerId = row.owner_id == null ? '' : String(row.owner_id);
  return {
    id: String(row.id ?? ''),
    title: String(row.title ?? ''),
    note: (row.note as string | null) ?? null,
    visibility: parseVisibility(row.visibility),
    mine: Boolean(ownerId) && ownerId === (options.viewerId ?? ''),
    ownerName: options.ownerName ?? null,
    entryCount: Math.max(0, Math.floor(options.entryCount ?? 0)),
    nextEntryAt: options.nextEntryAt ?? null,
    createdAt: asIso(row.created_at),
    updatedAt: asIso(row.updated_at),
  };
}

/** Строка `carrier_jump_schedule_entries` → прыжок расписания. */
export function entryFromRow(row: Record<string, unknown>): JumpScheduleEntry {
  return {
    id: String(row.id ?? ''),
    scheduleId: String(row.schedule_id ?? ''),
    carrierId: row.carrier_id == null ? null : String(row.carrier_id),
    callsign: (row.callsign as string | null) ?? null,
    name: (row.name as string | null) ?? null,
    from: String(row.from_system ?? ''),
    to: String(row.to_system ?? ''),
    departureAt: asIso(row.departure_at) ?? '',
    note: (row.note as string | null) ?? null,
    createdAt: asIso(row.created_at),
  };
}

/** Ключ дня в UTC: время на сайте везде в UTC, календарь не должен «плыть». */
export function entryDay(value: string | null | undefined): string {
  const ms = timeMs(value);
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toISOString().slice(0, 10);
}

/** Порядок: ближайший вылет сверху, одинаковое время — по позывному. */
export function compareEntries(left: JumpScheduleEntry, right: JumpScheduleEntry): number {
  const leftMs = timeMs(left.departureAt);
  const rightMs = timeMs(right.departureAt);
  if (Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs !== rightMs) return leftMs - rightMs;
  if (Number.isFinite(leftMs) !== Number.isFinite(rightMs)) return Number.isFinite(leftMs) ? -1 : 1;
  const label = (entry: JumpScheduleEntry) => entry.callsign || entry.name || entry.carrierId || '';
  return label(left).localeCompare(label(right), 'ru') || left.id.localeCompare(right.id);
}

/** Прыжки по дням: ключ — `YYYY-MM-DD` в UTC. */
export function groupEntriesByDay(entries: readonly JumpScheduleEntry[]): Map<string, JumpScheduleEntry[]> {
  const byDay = new Map<string, JumpScheduleEntry[]>();
  for (const entry of [...entries].sort(compareEntries)) {
    const day = entryDay(entry.departureAt);
    if (!day) continue;
    const list = byDay.get(day);
    if (list) list.push(entry);
    else byDay.set(day, [entry]);
  }
  return byDay;
}

export interface CalendarDay {
  /** `YYYY-MM-DD` — ключ дня и значение для фильтра. */
  date: string;
  /** Число месяца: 1…31. */
  day: number;
  /** День принадлежит показываемому месяцу (в сетке есть хвосты соседних). */
  inMonth: boolean;
  /** Сегодня по UTC. */
  today: boolean;
  /** Сколько прыжков в этот день. */
  count: number;
}

export interface CalendarMonth {
  /** Первое число месяца, `YYYY-MM-01`. */
  month: string;
  /** Недели по семь дней, неделя начинается с понедельника (как в игре). */
  weeks: CalendarDay[][];
}

/** Первое число месяца от любой даты — в UTC. */
export function monthKey(value: Date | number | string = new Date()): string {
  const date = value instanceof Date ? value : new Date(value);
  const ms = date.getTime();
  const safe = Number.isFinite(ms) ? date : new Date();
  return `${safe.toISOString().slice(0, 7)}-01`;
}

/** Сдвинуть месяц на `delta` месяцев: `monthKey` + арифметика по UTC. */
export function shiftMonth(month: string, delta: number): string {
  const ms = timeMs(`${month}T00:00:00.000Z`);
  if (!Number.isFinite(ms)) return monthKey();
  const date = new Date(ms);
  date.setUTCMonth(date.getUTCMonth() + Math.trunc(delta));
  // 31-е в коротком месяце переползает на следующий — выравниваем на первое.
  date.setUTCDate(1);
  return `${date.toISOString().slice(0, 7)}-01`;
}

/**
 * Сетка месяца для календаря.
 *
 * Неделя начинается с понедельника: в игре день прыжка считается по UTC, и
 * календарь не должен показывать «понедельник» дважды из-за локали. Хвосты
 * соседних месяцев попадают в сетку, как в бумажном календаре, но помечены
 * `inMonth: false` — по ним можно кликнуть, но они не считаются «этим месяцем».
 */
export function buildMonthGrid(month: string, entries: readonly JumpScheduleEntry[] = [], now = Date.now()): CalendarMonth {
  const monthMs = timeMs(`${month}T00:00:00.000Z`);
  const safeMonth = Number.isFinite(monthMs) ? month : monthKey();
  const start = new Date(`${safeMonth}T00:00:00.000Z`);
  const year = start.getUTCFullYear();
  const monthIndex = start.getUTCMonth();
  const byDay = groupEntriesByDay(entries);
  const today = new Date(now).toISOString().slice(0, 10);

  // Понедельник той недели, в которую попало первое число.
  const firstWeekday = (start.getUTCDay() + 6) % 7;
  const gridStart = new Date(Date.UTC(year, monthIndex, 1 - firstWeekday));
  const daysInMonth = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const cells = Math.ceil((firstWeekday + daysInMonth) / 7) * 7;

  const weeks: CalendarDay[][] = [];
  for (let index = 0; index < cells; index += 1) {
    const date = new Date(gridStart.getTime() + index * 86_400_000);
    const key = date.toISOString().slice(0, 10);
    const inMonth = date.getUTCMonth() === monthIndex && date.getUTCFullYear() === year;
    const cell: CalendarDay = {
      date: key,
      day: date.getUTCDate(),
      inMonth,
      today: key === today,
      count: byDay.get(key)?.length ?? 0,
    };
    if (index % 7 === 0) weeks.push([cell]);
    else weeks[weeks.length - 1].push(cell);
  }
  return { month: safeMonth, weeks };
}

/** Прыжки одного дня — для списка под календарём. */
export function entriesForDay(entries: readonly JumpScheduleEntry[], day: string): JumpScheduleEntry[] {
  if (!day) return [];
  return [...entries].filter((entry) => entryDay(entry.departureAt) === day).sort(compareEntries);
}

/** Прыжки месяца — весь календарь без хвостов соседних месяцев. */
export function entriesForMonth(entries: readonly JumpScheduleEntry[], month: string): JumpScheduleEntry[] {
  const prefix = month.slice(0, 7);
  return [...entries]
    .filter((entry) => entryDay(entry.departureAt).slice(0, 7) === prefix)
    .sort(compareEntries);
}

/** Ближайший будущий прыжок расписания: для списка и подписи «когда». */
export function nextEntryAt(entries: readonly JumpScheduleEntry[], now = Date.now()): string | null {
  const upcoming = entries
    .map((entry) => timeMs(entry.departureAt))
    .filter((ms) => Number.isFinite(ms) && ms >= now)
    .sort((left, right) => left - right);
  return upcoming.length ? new Date(upcoming[0]).toISOString() : null;
}

/**
 * Повтор уже есть в расписании: тот же носитель и то же время вылета.
 * Уникальный индекс в базе ловит это для носителей с MarketID, здесь — для
 * интерфейса, чтобы не показывать ошибку базы вместо понятного «уже есть».
 */
export function isDuplicateEntry(
  entries: readonly JumpScheduleEntry[],
  candidate: Pick<JumpScheduleEntry, 'carrierId' | 'departureAt'>,
): boolean {
  if (!candidate.carrierId) return false;
  const ms = timeMs(candidate.departureAt);
  if (!Number.isFinite(ms)) return false;
  return entries.some((entry) => entry.carrierId === candidate.carrierId && timeMs(entry.departureAt) === ms);
}

/** Строка живой таблицы → запись расписания: кнопка «в расписание» на прыжке. */
export function entryFromBoardRow(row: Pick<JumpBoardRow, 'id' | 'callsign' | 'from' | 'to' | 'departureAt' | 'carrier'>): {
  carrierId: string;
  callsign: string | null;
  name: string | null;
  from: string;
  to: string;
  departureAt: string;
} | null {
  if (!row.departureAt || !row.from || !row.to) return null;
  return {
    carrierId: row.id,
    callsign: row.callsign,
    name: row.carrier.name ?? null,
    from: row.from,
    to: row.to,
    departureAt: row.departureAt,
  };
}

/** Ссылка на расписание: публичную можно отдать кому угодно. */
export function scheduleHref(scheduleId: string): string {
  return `/carriers/jumps?tab=calendar&schedule=${encodeURIComponent(scheduleId)}`;
}

/** Поиск по списку расписаний: название, заметка и имя владельца. */
export function matchesScheduleQuery(schedule: JumpSchedule, query: unknown): boolean {
  const tokens = text(query).toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;
  const haystack = [schedule.title, schedule.note ?? '', schedule.ownerName ?? '']
    .join(' ')
    .toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

/** Порядок списка: свои сверху, дальше — по ближайшему прыжку. */
export function compareSchedules(left: JumpSchedule, right: JumpSchedule): number {
  if (left.mine !== right.mine) return left.mine ? -1 : 1;
  const leftMs = timeMs(left.nextEntryAt);
  const rightMs = timeMs(right.nextEntryAt);
  if (Number.isFinite(leftMs) !== Number.isFinite(rightMs)) return Number.isFinite(leftMs) ? -1 : 1;
  if (Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs !== rightMs) return leftMs - rightMs;
  return left.title.localeCompare(right.title, 'ru') || left.id.localeCompare(right.id);
}
