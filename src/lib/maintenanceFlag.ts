/**
 * Признак технических работ и отметка о последней копии БД — чистая логика.
 *
 * Модуль намеренно не импортирует ничего: его читают и веб-процесс
 * (`src/lib/maintenance.ts`), и прокси в edge-рантайме (`src/proxy.ts`),
 * и тесты. Любая работа с сетью/БД — в вызывающих модулях.
 *
 * Смысл полей:
 *  - `maintenance` — пока флаг активен, прокси отдаёт заглушку «Ведутся
 *    технические работы» вместо сайта (админка и API остаются доступными);
 *  - `db_backup`   — когда, какая и какого размера копия сделана последней:
 *    по ней панель показывает «прошла неделя — пора».
 */

/** Ключи строк в `public.app_flags`. */
export const MAINTENANCE_KEY = 'maintenance';
export const DB_BACKUP_KEY = 'db_backup';

/** Сколько раз в миллисекундах прокси перечитывает флаг (на запрос не читаем). */
export const MAINTENANCE_REFRESH_MS = 5_000;

/**
 * Потолок окна техработ. Если веб-процесс умер посреди дампа и не снял флаг,
 * заглушка отпустит сайт сама — сидеть под ней вечно недопустимо.
 */
export const MAINTENANCE_MAX_MS = 3 * 60 * 60 * 1000;

/** Ритм резервного копирования: неделя. */
export const BACKUP_DUE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export interface MaintenanceState {
  active: boolean;
  reason: string;
  startedAt: string | null;
  expiresAt: string | null;
}

export interface BackupRecord {
  /** Момент успешного завершения последней копии. */
  lastAt: string | null;
  /** Имя файла на хосте (из журнала агента). */
  file: string | null;
  bytes: number | null;
  /** Полный дамп (с каталогом систем) или обычный. */
  full: boolean;
  /** Чем закончилась последняя попытка — в том числе неудачная. */
  lastResult: 'succeeded' | 'failed' | 'aborted' | null;
  error: string | null;
}

const DEFAULT_REASON = 'Резервное копирование базы данных';

function isoOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * Разбирает строку `app_flags.value` в признак техработ.
 *
 * Возвращает `null`, если признака нет. Возвращает `active: false`, если срок
 * истёк, — прокси обязан отпустить сайт даже тогда, когда снять флаг некому.
 */
export function parseMaintenanceState(value: unknown, now: number = Date.now()): MaintenanceState | null {
  // PostgREST обычно отдаёт jsonb объектом, но строка с JSON тоже возможна.
  const record = objectOrNull(typeof value === 'string' ? tryParseJson(value) : value);
  if (!record) return null;
  const startedAt = isoOrNull(record.startedAt);
  const expiresAt = isoOrNull(record.expiresAt);
  const reason = typeof record.reason === 'string' && record.reason.trim() ? record.reason.trim() : DEFAULT_REASON;
  const expired = expiresAt ? Date.parse(expiresAt) <= now : true;
  return {
    active: record.active === true && !expired,
    reason,
    startedAt,
    expiresAt,
  };
}

/** Значение для записи в `app_flags` при начале технических работ. */
export function maintenanceValue(reason: string, now: number = Date.now(), ttlMs: number = MAINTENANCE_MAX_MS) {
  const startedAt = new Date(now).toISOString();
  const safeTtl = Number.isFinite(ttlMs) && ttlMs > 0 ? Math.min(ttlMs, MAINTENANCE_MAX_MS) : MAINTENANCE_MAX_MS;
  return {
    active: true,
    reason: (reason || '').trim() || DEFAULT_REASON,
    startedAt,
    expiresAt: new Date(now + safeTtl).toISOString(),
  };
}

/**
 * Маршруты, которые остаются доступными под заглушкой.
 *
 * Без `/admin` и `/api/` админ не увидит прогресс и не сможет отменить дамп,
 * а без `/login` и `/auth` — даже войти, чтобы это сделать.
 */
export const MAINTENANCE_EXEMPT_PREFIXES = [
  '/admin',
  '/api/',
  '/auth',
  '/login',
  '/register',
  '/forgot-password',
  '/reset-password',
  '/resend-confirmation',
  '/maintenance',
  '/_next',
] as const;

export const MAINTENANCE_EXEMPT_FILES = ['/favicon.ico', '/robots.txt', '/manifest.json'] as const;

export function isMaintenanceExemptPath(path: string): boolean {
  // Прокси передаёт pathname, но вызывающий может прислать и полный адрес:
  // «/admin?tab=backup» обязан остаться доступным так же, как «/admin».
  const bare = String(path ?? '').split(/[?#]/)[0];
  const clean = bare.startsWith('/') ? bare : `/${bare}`;
  if (MAINTENANCE_EXEMPT_FILES.includes(clean as (typeof MAINTENANCE_EXEMPT_FILES)[number])) return true;
  return MAINTENANCE_EXEMPT_PREFIXES.some((prefix) =>
    prefix.endsWith('/') ? clean.startsWith(prefix) : clean === prefix || clean.startsWith(`${prefix}/`),
  );
}

/** «Пора ли делать копию»: неделя с последней успешной. */
export function backupDue(lastAt: string | null | undefined, now: number = Date.now()) {
  const parsed = isoOrNull(lastAt ?? null);
  if (!parsed) return { lastAt: null, daysSince: null, due: true, overdueMs: null as number | null };
  const elapsed = now - Date.parse(parsed);
  return {
    lastAt: parsed,
    daysSince: Math.floor(elapsed / (24 * 60 * 60 * 1000)),
    due: elapsed >= BACKUP_DUE_AFTER_MS,
    overdueMs: Math.max(0, elapsed - BACKUP_DUE_AFTER_MS),
  };
}

/** Разбирает строку `app_flags.value` в отметку о последней копии. */
export function parseBackupRecord(value: unknown): BackupRecord | null {
  const record = objectOrNull(typeof value === 'string' ? tryParseJson(value) : value);
  if (!record) return null;
  const result = record.lastResult;
  const bytes = Number(record.bytes);
  return {
    lastAt: isoOrNull(record.lastAt),
    file: typeof record.file === 'string' && record.file.trim() ? record.file.trim() : null,
    bytes: Number.isFinite(bytes) && bytes > 0 ? Math.round(bytes) : null,
    full: record.full === true,
    lastResult: result === 'succeeded' || result === 'failed' || result === 'aborted' ? result : null,
    error: typeof record.error === 'string' && record.error.trim() ? record.error.trim().slice(0, 300) : null,
  };
}

/**
 * Слияние отметки о копии с предыдущей.
 *
 * `lastAt`/`file`/`bytes` сдвигаются только при успехе: неудачная или
 * прерванная попытка не должна делать вид, что недельный ритм соблюдён, —
 * иначе панель перестанет напоминать о копии именно тогда, когда она нужна.
 */
export function mergeBackupRecord(
  previous: BackupRecord | null,
  update: { result: 'succeeded' | 'failed' | 'aborted'; file?: string | null; bytes?: number | null; full?: boolean; error?: string | null },
  now: number = Date.now(),
): BackupRecord {
  const succeeded = update.result === 'succeeded';
  return {
    lastAt: succeeded ? new Date(now).toISOString() : previous?.lastAt ?? null,
    file: succeeded ? update.file ?? previous?.file ?? null : previous?.file ?? null,
    bytes: succeeded ? update.bytes ?? previous?.bytes ?? null : previous?.bytes ?? null,
    full: succeeded ? update.full === true : previous?.full === true,
    lastResult: update.result,
    error: succeeded ? null : update.error ?? null,
  };
}

/** Человекочитаемый размер без зависимостей. */
export function formatBytes(bytes: number | null | undefined): string {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '—';
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(size >= 100 || index === 0 ? 0 : 1)} ${units[index]}`;
}
