/**
 * Назначенный архитектор системы — администрирование планов.
 *
 * Модель прав (миграция `20261006000000_system_architects.sql`):
 *
 *   * пока у системы нет строки в `system_architects` — планы сохраняет
 *     любой авторизованный командир, правки идут у авторов своих планов;
 *   * когда архитектор назначен — создавать и менять планы системы может
 *     только он (админ тоже может, для разбора споров). RLS тот же набор
 *     правил повторяет в базе, так что обойти API нельзя;
 *   * назначить/сменить архитектора может только админ, сам архитектор
 *     может отказаться от системы.
 *
 * Модуль не знает про Supabase: строки маппятся в представления чистыми
 * функциями, а маршруты принимают «что угодно с методом from».
 */

export const GOVERNANCE_TABLE = 'system_architects';

/** Ключ сравнения имён систем: регистр и лишние пробелы не должны плодить дубли. */
export function systemKey(value: unknown): string {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Строка `system_architects`, как её отдаёт Supabase. */
export interface SystemArchitectRow {
  id?: string;
  system_name?: string | null;
  system_name_lc?: string | null;
  user_id?: string | null;
  architect_name?: string | null;
  assigned_by?: string | null;
  assigned_by_name?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

/** Кто закреплён за системой — в виде, удобном интерфейсу. */
export interface ArchitectAssignment {
  userId: string;
  name: string;
  assignedBy: string | null;
  assignedByName: string;
  assignedAt: string | null;
}

/** Что API отвечает вопрошающему про него самого. */
export interface GovernanceViewer {
  userId: string | null;
  isAdmin: boolean;
  /** Текущий пользователь и есть назначенный архитектор этой системы. */
  isArchitect: boolean;
}

/** Ответ GET /api/architect/governance за одну систему. */
export interface GovernanceInfo {
  system: string;
  architect: ArchitectAssignment | null;
  viewer: GovernanceViewer;
}

/** Минимальный кусок Supabase-клиента, которого хватает хелперам. */
export interface QueryClientLike {
  from(table: string): any;
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/** Строка → назначение; `null` на мусоре и пустой выборке. */
export function rowToAssignment(row: SystemArchitectRow | null | undefined): ArchitectAssignment | null {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const userId = str(row.user_id);
  if (!userId) return null;
  return {
    userId,
    name: str(row.architect_name) || 'Командир',
    assignedBy: str(row.assigned_by) || null,
    assignedByName: str(row.assigned_by_name),
    assignedAt: str(row.updated_at) || str(row.created_at) || null,
  };
}

/** Прочитать назначение системы (без учёта регистра имени). */
export async function loadAssignment(
  supabase: QueryClientLike,
  system: string,
): Promise<ArchitectAssignment | null> {
  const { data, error } = await supabase
    .from(GOVERNANCE_TABLE)
    .select('id,system_name,user_id,architect_name,assigned_by,assigned_by_name,created_at,updated_at')
    .eq('system_name_lc', systemKey(system))
    .maybeSingle();
  if (error) throw new Error(error.message);
  return rowToAssignment(data as SystemArchitectRow | null);
}

/** Профиль вызывающего: роль нужна проверкам «админ», имя — подписи назначения. */
export async function loadCallerProfile(
  supabase: QueryClientLike,
  userId: string,
): Promise<{ role: string; cmdrName: string }> {
  const { data, error } = await supabase
    .from('profiles')
    .select('role, cmdr_name')
    .eq('id', userId)
    .maybeSingle();
  if (error) return { role: '', cmdrName: '' };
  const row = data as { role?: unknown; cmdr_name?: unknown } | null;
  return { role: str(row?.role), cmdrName: str(row?.cmdr_name) };
}

/**
 * Может ли пользователь сохранять/менять планы системы. Ошибка чтения
 * `system_architects` возвращается в поле `error`, чтобы маршрут ответил 500,
 * а не случайно запретил/разрешил.
 */
export async function checkPlanEditRights(
  supabase: QueryClientLike,
  system: string,
  userId: string,
): Promise<{ allowed: boolean; isAdmin: boolean; architect: ArchitectAssignment | null; error?: string }> {
  let architect: ArchitectAssignment | null = null;
  try {
    architect = await loadAssignment(supabase, system);
  } catch (err) {
    return {
      allowed: false,
      isAdmin: false,
      architect: null,
      error: err instanceof Error ? err.message : 'Ошибка чтения system_architects',
    };
  }
  if (!architect) return { allowed: true, isAdmin: false, architect: null };
  if (architect.userId === userId) return { allowed: true, isAdmin: false, architect };
  const profile = await loadCallerProfile(supabase, userId);
  if (profile.role === 'admin') return { allowed: true, isAdmin: true, architect };
  return { allowed: false, isAdmin: false, architect };
}

/** Текст запрета для интерфейса и API — единый, чтобы не разъезжался. */
export function lockReasonRu(architect: ArchitectAssignment): string {
  return `У системы назначен архитектор ${architect.name}: создавать и изменять планы теперь может только он (или админ).`;
}
