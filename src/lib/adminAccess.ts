/**
 * Почему админка решила, что у пилота нет прав.
 *
 * Раньше ответ был один на все случаи: «Доступ запрещён. Нужна роль moderator
 * или admin». Худший из этих случаев — когда роль в базе есть, но страница
 * профиль не получила: устаревший кэш схемы PostgREST, снятый грант, истёкшая
 * сессия. Снаружи это выглядит как «пропали админские права», а человек идёт
 * проверять базу в psql и видит там `role = 'admin'`.
 *
 * Модуль намеренно чистый: никаких импортов, только разбор ответа PostgREST.
 * Его читает страница админки и серверный маршрут `/api/admin/access`.
 */

/** Роли, которым открыта админка. */
export const STAFF_ROLES = ['admin', 'moderator', 'support_manager'] as const;

export type StaffRole = (typeof STAFF_ROLES)[number];

/** Почему доступ выдан или не выдан. */
export type AccessReason =
  | 'staff'          // профиль прочитан, роль в списке
  | 'not-staff'      // профиль прочитан, роль обычная
  | 'signed-out'     // сессии нет
  | 'query-failed';  // профиль прочитать не удалось (RLS, схема, сеть)

/** Что именно помешало прочитать профиль — по этому коду UI выбирает подсказку. */
export type AccessHint =
  | 'none'
  | 'session'
  | 'schema'
  | 'grant'
  | 'missing-row'
  | 'missing-table'
  | 'network'
  | 'unknown';

export interface ProfileErrorLike {
  message?: string | null;
  code?: string | null;
  details?: string | null;
  hint?: string | null;
}

export interface AccessInput {
  userId: string | null;
  /** Строка `profiles`, если PostgREST её вернул. */
  profile?: { role?: string | null; cmdr_name?: string | null } | null;
  /** Ошибка PostgREST/сети, если запрос не удался. */
  error?: ProfileErrorLike | null;
}

export interface AccessDecision {
  role: string;
  staff: boolean;
  reason: AccessReason;
  hint: AccessHint;
  /** Дословный ответ сервера — его показываем человеку, а не пересказываем. */
  serverMessage: string;
}

/** Приводит ошибку PostgREST к коду подсказки. Порядок проверок важен. */
export function classifyProfileError(error: ProfileErrorLike | null | undefined): AccessHint {
  if (!error) return 'none';
  const code = String(error.code ?? '').toUpperCase();
  const text = `${error.message ?? ''} ${error.details ?? ''} ${error.hint ?? ''}`.toLowerCase();

  // Строки нет — это не поломка прав, а отсутствующий профиль.
  if (code === 'PGRST116') return 'missing-row';

  // Таблицы/колонки нет: миграции не применены до конца.
  if (code === '42P01' || code === '42703' || text.includes('does not exist')) return 'missing-table';

  // Устаревший кэш схемы PostgREST: база цела, описание схемы в REST-слое — нет.
  if (code === 'PGRST204' || code === 'PGRST202' || text.includes('schema cache')) return 'schema';

  // Гранты и политики RLS.
  if (code === '42501' || text.includes('permission denied') || text.includes('row-level security')) {
    return 'grant';
  }

  // Сессия: просроченный или отсутствующий JWT.
  if (code === 'PGRST301' || code === '401' || text.includes('jwt') || text.includes('token is expired')) {
    return 'session';
  }

  if (
    text.includes('fetch failed') ||
    text.includes('eai_again') ||
    text.includes('econnrefused') ||
    text.includes('networkerror') ||
    text.includes('failed to fetch')
  ) {
    return 'network';
  }

  return 'unknown';
}

/**
 * Решение о доступе. `staff` — единственное, что решает, пускать ли в админку;
 * `hint` и `serverMessage` нужны, чтобы объяснить отказ, не гадая.
 */
export function decideAccess(input: AccessInput): AccessDecision {
  const serverMessage = String(input.error?.message ?? '').trim();

  if (!input.userId) {
    return { role: 'guest', staff: false, reason: 'signed-out', hint: 'session', serverMessage };
  }

  if (input.error) {
    return {
      role: 'guest',
      staff: false,
      reason: 'query-failed',
      hint: classifyProfileError(input.error),
      serverMessage: serverMessage || String(input.error.code ?? 'profiles: unknown error'),
    };
  }

  if (!input.profile) {
    return { role: 'user', staff: false, reason: 'not-staff', hint: 'missing-row', serverMessage };
  }

  const role = String(input.profile.role ?? 'user');
  const staff = (STAFF_ROLES as readonly string[]).includes(role);
  return {
    role,
    staff,
    reason: staff ? 'staff' : 'not-staff',
    hint: 'none',
    serverMessage,
  };
}
