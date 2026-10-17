/**
 * «Проекты систем» Архитектора: общие типы, подписи и правила доступа.
 *
 * Проект — группа систем, которые команда строит вместе: участники с ролями,
 * системы (с планом и ответственным пилотом) и привязанные авианосцы. Таблицы
 * и SQL-функции — `supabase/migrations/20261017120000_architect_projects.sql`,
 * маршруты — `src/app/api/architect/projects/**`, страницы —
 * `/architect/projects`.
 *
 * Модуль чистый (без БД и React): его импортируют маршруты, интерфейс и
 * node-тесты напрямую, поэтому импорты относительные с расширением `.ts`.
 *
 * Права (решаются здесь, маршруты только применяют их):
 *   * смотреть проект — любой участник и администратор сайта;
 *   * создатель и модераторы ведут проект: описание, системы, участников,
 *     привязку любых авианосцев (публичная карточка, без груза);
 *   * только создатель назначает и снимает модераторов, передаёт и удаляет
 *     проект (администратор сайта может то же — для разбора);
 *   * ответственный за систему меняет её этап и заметки;
 *   * любой участник привязывает свой авианосец (или носитель эскадрильи,
 *     где он офицер), выходит из проекта и обновляет прогресс из Raven.
 */

export const PROJECT_ROLES = ['owner', 'moderator', 'member'] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

export const PROJECT_STATUSES = ['planning', 'active', 'paused', 'completed', 'archived'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const SYSTEM_STAGES = ['planned', 'claimed', 'building', 'done', 'on_hold'] as const;
export type SystemStage = (typeof SYSTEM_STAGES)[number];

export const ROLE_LABELS: Record<ProjectRole, string> = {
  owner: 'Создатель',
  moderator: 'Модератор',
  member: 'Участник',
};

export const STATUS_LABELS: Record<ProjectStatus, string> = {
  planning: 'Подготовка',
  active: 'В работе',
  paused: 'На паузе',
  completed: 'Завершён',
  archived: 'Архив',
};

export const STAGE_LABELS: Record<SystemStage, string> = {
  planned: 'В планах',
  claimed: 'Заявлена',
  building: 'Строится',
  done: 'Готова',
  on_hold: 'Отложена',
};

export const PRIORITY_LABELS: Record<number, string> = {
  1: 'Высокий',
  2: 'Обычный',
  3: 'Низкий',
};

/** Палитра меток проекта — те же акценты, что в DESIGN.md. */
export const PROJECT_COLORS = ['#e67e22', '#3498db', '#2ecc71', '#e74c3c', '#9b59b6', '#1abc9c', '#f1c40f', '#95a5a6'] as const;
export const DEFAULT_PROJECT_COLOR = '#e67e22';

export const PROJECT_LIMITS = {
  /** Систем в проекте. */
  systems: 100,
  /** Участников в проекте (с создателем). */
  members: 200,
  /** Авианосцев в проекте. */
  carriers: 50,
  /** Проектов, которые пилот может создать (быть создателем). */
  ownedProjects: 20,
  name: 120,
  description: 4000,
  notes: 2000,
  duty: 80,
  purpose: 80,
  systemName: 128,
} as const;

// ── Права ──────────────────────────────────────────────────────────────────

export interface ProjectPermissions {
  view: boolean;
  /** Название, описание, статус, срок, отсчёт вклада. */
  editProject: boolean;
  deleteProject: boolean;
  /** Добавлять, менять и убирать системы. */
  manageSystems: boolean;
  /** Добавлять и убирать участников, менять их обязанности. */
  manageMembers: boolean;
  /** Назначать и снимать модераторов. */
  manageModerators: boolean;
  transfer: boolean;
  /** Привязывать любой авианосец (публичная карточка). */
  bindAnyCarrier: boolean;
  /** Привязывать свой авианосец или носитель своей эскадрильи. */
  bindOwnCarrier: boolean;
  leave: boolean;
  /** Запросить свежий прогресс из Raven Colonial. */
  refresh: boolean;
}

export function isProjectRole(value: unknown): value is ProjectRole {
  return typeof value === 'string' && (PROJECT_ROLES as readonly string[]).includes(value);
}

export function isProjectStatus(value: unknown): value is ProjectStatus {
  return typeof value === 'string' && (PROJECT_STATUSES as readonly string[]).includes(value);
}

export function isSystemStage(value: unknown): value is SystemStage {
  return typeof value === 'string' && (SYSTEM_STAGES as readonly string[]).includes(value);
}

export function projectPermissions(role: ProjectRole | null, isAdmin = false): ProjectPermissions {
  const owner = role === 'owner';
  const manager = owner || role === 'moderator';
  const member = role !== null;
  return {
    view: member || isAdmin,
    editProject: manager || isAdmin,
    deleteProject: owner || isAdmin,
    manageSystems: manager || isAdmin,
    manageMembers: manager || isAdmin,
    manageModerators: owner || isAdmin,
    transfer: owner || isAdmin,
    bindAnyCarrier: manager || isAdmin,
    bindOwnCarrier: member,
    leave: member && !owner,
    refresh: member || isAdmin,
  };
}

export interface ProjectActor {
  userId: string;
  role: ProjectRole | null;
  isAdmin: boolean;
}

export interface MemberTarget {
  userId: string;
  role: ProjectRole;
}

/** Можно ли убрать участника (или выйти самому). */
export function canRemoveMember(actor: ProjectActor, target: MemberTarget): { ok: boolean; reason?: string } {
  if (target.role === 'owner') {
    return { ok: false, reason: 'Создатель не может покинуть проект — сначала передайте его другому участнику' };
  }
  if (actor.userId === target.userId) return { ok: actor.role !== null };
  const perms = projectPermissions(actor.role, actor.isAdmin);
  if (target.role === 'moderator') {
    return perms.manageModerators ? { ok: true } : { ok: false, reason: 'Модератора убирает только создатель проекта' };
  }
  return perms.manageMembers ? { ok: true } : { ok: false, reason: 'Участников убирают создатель и модераторы' };
}

/** Можно ли сменить роль участника. `owner` — передача проекта. */
export function canChangeRole(actor: ProjectActor, target: MemberTarget, next: ProjectRole): { ok: boolean; reason?: string } {
  const perms = projectPermissions(actor.role, actor.isAdmin);
  if (target.role === next) return { ok: false, reason: 'Роль не изменилась' };
  if (next === 'owner') {
    return perms.transfer ? { ok: true } : { ok: false, reason: 'Передать проект может только его создатель' };
  }
  if (target.role === 'owner') {
    return { ok: false, reason: 'Роль создателя меняется только передачей проекта' };
  }
  return perms.manageModerators ? { ok: true } : { ok: false, reason: 'Модераторов назначает только создатель проекта' };
}

/** Можно ли менять обязанность участника: ведущие проекта — любую, участник — свою. */
export function canEditDuty(actor: ProjectActor, target: MemberTarget): boolean {
  if (actor.userId === target.userId && actor.role !== null) return true;
  return projectPermissions(actor.role, actor.isAdmin).manageMembers;
}

/** Поля системы, которые ответственный пилот может менять без прав модератора. */
export const RESPONSIBLE_SYSTEM_FIELDS = ['stage', 'notes'] as const;

/** Какие поля системы может менять пилот. Пустой список — никакие. */
export function editableSystemFields(actor: ProjectActor, responsibleId: string | null | undefined): readonly string[] {
  if (projectPermissions(actor.role, actor.isAdmin).manageSystems) {
    return ['stage', 'priority', 'planId', 'responsibleId', 'targetDate', 'notes', 'sortOrder', 'name'];
  }
  if (actor.role !== null && responsibleId && responsibleId === actor.userId) return RESPONSIBLE_SYSTEM_FIELDS;
  return [];
}

// ── Нормализация ввода ─────────────────────────────────────────────────────

/** Имя системы так, как его хранит проект: без лишних пробелов. */
export function normalizeSystemName(value: unknown): string {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Ключ системы — тот же, что `system_name_lc` в БД. */
export function systemKey(value: unknown): string {
  return normalizeSystemName(value).toLowerCase();
}

export interface ParsedSystemList {
  /** Уникальные имена в порядке ввода. */
  names: string[];
  /** Повторы (уже были выше в списке или в проекте). */
  duplicates: string[];
  /** Слишком длинные строки. */
  invalid: string[];
  /** Не вошли из-за лимита. */
  overflow: string[];
}

/**
 * Список систем из textarea: по одной в строке (запятая и точка с запятой
 * тоже разделяют — так удобнее вставлять из таблиц). Знак табуляции отсекает
 * хвост строки: из таблицы обычно копируется имя и ещё колонки.
 */
export function parseSystemList(
  input: unknown,
  options: { existing?: Iterable<string>; limit?: number } = {},
): ParsedSystemList {
  const raw: string[] = Array.isArray(input)
    ? input.map((value) => String(value ?? ''))
    : String(input ?? '').split(/[\r\n;]+/).flatMap((line) => {
      const head = line.split('\t')[0] ?? '';
      // Запятая в именах систем Elite не встречается, а в списках — часто.
      return head.split(',');
    });
  const seen = new Set<string>();
  for (const name of options.existing ?? []) seen.add(systemKey(name));
  const limit = Math.max(0, options.limit ?? PROJECT_LIMITS.systems);
  const result: ParsedSystemList = { names: [], duplicates: [], invalid: [], overflow: [] };
  for (const entry of raw) {
    const name = normalizeSystemName(entry);
    if (!name) continue;
    if (name.length > PROJECT_LIMITS.systemName) {
      result.invalid.push(name.slice(0, 40));
      continue;
    }
    const key = name.toLowerCase();
    if (seen.has(key)) {
      result.duplicates.push(name);
      continue;
    }
    seen.add(key);
    if (result.names.length >= limit) {
      result.overflow.push(name);
      continue;
    }
    result.names.push(name);
  }
  return result;
}

function cleanText(value: unknown, max: number): string {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
    .slice(0, max);
}

export function cleanLine(value: unknown, max: number): string {
  return cleanText(value, max * 2).replace(/\s+/g, ' ').trim().slice(0, max);
}

export function normalizeColor(value: unknown): string | null {
  const raw = String(value ?? '').trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(raw) ? raw : null;
}

/** `YYYY-MM-DD` или null; undefined — поле не передано. */
export function parseDateOnly(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const raw = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return undefined;
  const ms = Date.parse(`${raw}T00:00:00Z`);
  if (!Number.isFinite(ms)) return undefined;
  // `2026-02-31` Date.parse превращает в март — такие даты отклоняем.
  return new Date(ms).toISOString().slice(0, 10) === raw ? raw : undefined;
}

/** ISO-время или null; undefined — значение неразборчиво. */
export function parseTimestamp(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const ms = Date.parse(String(value));
  if (!Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
}

export interface ProjectInput {
  name: string;
  description: string;
  color: string;
  systems: ParsedSystemList;
}

export function validateNewProject(body: unknown): { value?: ProjectInput; error?: string } {
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const name = cleanLine(record.name, PROJECT_LIMITS.name);
  if (!name) return { error: 'Укажите название проекта' };
  const description = cleanText(record.description, PROJECT_LIMITS.description);
  const color = normalizeColor(record.color) ?? DEFAULT_PROJECT_COLOR;
  const systems = parseSystemList(record.systems ?? '', { limit: PROJECT_LIMITS.systems });
  return { value: { name, description, color, systems } };
}

/** Патч проекта из тела PATCH: только допустимые и изменённые поля. */
export function sanitizeProjectPatch(body: unknown): { patch: Record<string, unknown>; errors: string[] } {
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const patch: Record<string, unknown> = {};
  const errors: string[] = [];
  if ('name' in record) {
    const name = cleanLine(record.name, PROJECT_LIMITS.name);
    if (name) patch.name = name;
    else errors.push('Название не может быть пустым');
  }
  if ('description' in record) patch.description = cleanText(record.description, PROJECT_LIMITS.description);
  if ('status' in record) {
    if (isProjectStatus(record.status)) patch.status = record.status;
    else errors.push('Неизвестный статус проекта');
  }
  if ('color' in record) {
    const color = normalizeColor(record.color);
    if (color) patch.color = color;
    else errors.push('Цвет задаётся как #rrggbb');
  }
  if ('targetDate' in record) {
    const date = parseDateOnly(record.targetDate);
    if (date === undefined) errors.push('Срок — дата в формате ГГГГ-ММ-ДД');
    else patch.target_date = date;
  }
  if ('trackingSince' in record) {
    const since = parseTimestamp(record.trackingSince);
    if (since === undefined) errors.push('Начало отсчёта вклада — дата или пусто');
    else patch.tracking_since = since;
  }
  return { patch, errors };
}

/** Патч системы проекта; `allowed` — поля, которые может менять пилот. */
export function sanitizeSystemPatch(
  body: unknown,
  allowed: readonly string[],
): { patch: Record<string, unknown>; errors: string[]; forbidden: string[] } {
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const patch: Record<string, unknown> = {};
  const errors: string[] = [];
  const forbidden: string[] = [];
  const has = (field: string) => field in record && record[field] !== undefined;
  const take = (field: string, apply: () => void) => {
    if (!has(field)) return;
    if (!allowed.includes(field)) {
      forbidden.push(field);
      return;
    }
    apply();
  };
  take('name', () => {
    const name = normalizeSystemName(record.name);
    if (!name || name.length > PROJECT_LIMITS.systemName) errors.push('Имя системы пустое или слишком длинное');
    else patch.system_name = name;
  });
  take('stage', () => {
    if (isSystemStage(record.stage)) patch.stage = record.stage;
    else errors.push('Неизвестный этап системы');
  });
  take('priority', () => {
    const priority = Number(record.priority);
    if (Number.isInteger(priority) && priority >= 1 && priority <= 3) patch.priority = priority;
    else errors.push('Приоритет — 1, 2 или 3');
  });
  take('planId', () => {
    const planId = record.planId;
    if (planId === null || planId === '') patch.plan_id = null;
    else if (isUuid(planId)) patch.plan_id = String(planId).toLowerCase();
    else errors.push('Неверный идентификатор плана');
  });
  take('responsibleId', () => {
    const responsible = record.responsibleId;
    if (responsible === null || responsible === '') patch.responsible_id = null;
    else if (isUuid(responsible)) patch.responsible_id = String(responsible).toLowerCase();
    else errors.push('Неверный ответственный');
  });
  take('targetDate', () => {
    const date = parseDateOnly(record.targetDate);
    if (date === undefined) errors.push('Срок — дата в формате ГГГГ-ММ-ДД');
    else patch.target_date = date;
  });
  take('notes', () => {
    patch.notes = cleanText(record.notes, PROJECT_LIMITS.notes);
  });
  take('sortOrder', () => {
    const order = Number(record.sortOrder);
    if (Number.isInteger(order) && Math.abs(order) <= 1_000_000) patch.sort_order = order;
    else errors.push('Неверный порядок');
  });
  return { patch, errors, forbidden };
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim());
}

// ── Представления для интерфейса ───────────────────────────────────────────

export interface ProjectSummary {
  id: string;
  name: string;
  description: string;
  status: ProjectStatus;
  color: string;
  role: ProjectRole | null;
  targetDate: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  counts: { systems: number; members: number; carriers: number };
  /** Последняя посчитанная сводка (`progress_summary`). */
  progress: ProjectProgressSnapshot | null;
  progressAt: string | null;
  ownerName: string | null;
}

/** Компактная сводка прогресса, которую хранит `architect_projects.progress_summary`. */
export interface ProjectProgressSnapshot {
  progress: number | null;
  systems: number;
  systemsDone: number;
  systemsBuilding: number;
  sites: number;
  sitesComplete: number;
  doneTons: number;
  totalTons: number;
  remaining: number | null;
}

export interface ProjectMemberView {
  userId: string;
  name: string;
  avatarUrl: string | null;
  squadron: string | null;
  role: ProjectRole;
  duty: string;
  joinedAt: string | null;
  addedByName: string | null;
  isYou: boolean;
}

export interface ProjectPlanRef {
  id: string;
  title: string;
  authorName: string;
  visibility: string;
  siteCount: number;
  haulTons: number;
  updatedAt: string | null;
}

export interface ProjectSystemView {
  id: string;
  name: string;
  key: string;
  stage: SystemStage;
  priority: number;
  planId: string | null;
  plan: ProjectPlanRef | null;
  responsibleId: string | null;
  responsibleName: string | null;
  targetDate: string | null;
  notes: string;
  sortOrder: number;
  createdAt: string | null;
  updatedAt: string | null;
  /** Поля, которые текущий пилот может менять. */
  editable: string[];
}

export interface ProjectDetail {
  project: {
    id: string;
    name: string;
    description: string;
    status: ProjectStatus;
    color: string;
    targetDate: string | null;
    trackingSince: string | null;
    createdAt: string | null;
    updatedAt: string | null;
  };
  viewer: { userId: string; role: ProjectRole | null; isAdmin: boolean; permissions: ProjectPermissions };
  members: ProjectMemberView[];
  systems: ProjectSystemView[];
  limits: typeof PROJECT_LIMITS;
}

export function sortSystems<T extends { priority: number; sortOrder: number; name: string }>(systems: T[]): T[] {
  return systems.slice().sort((left, right) => (
    left.sortOrder - right.sortOrder
    || left.priority - right.priority
    || left.name.localeCompare(right.name, 'ru')
  ));
}

const ROLE_ORDER: Record<ProjectRole, number> = { owner: 0, moderator: 1, member: 2 };

export function sortMembers<T extends { role: ProjectRole; name: string }>(members: T[]): T[] {
  return members.slice().sort((left, right) => (
    ROLE_ORDER[left.role] - ROLE_ORDER[right.role] || left.name.localeCompare(right.name, 'ru')
  ));
}

/** Сводка для `progress_summary`: только числа, без имён и площадок. */
export function progressSnapshot(summary: {
  progress: number | null;
  systems: number;
  systemsDone: number;
  systemsBuilding: number;
  sites: number;
  sitesComplete: number;
  doneTons: number;
  totalTons: number;
  remaining: number | null;
}): ProjectProgressSnapshot {
  return {
    progress: summary.progress,
    systems: summary.systems,
    systemsDone: summary.systemsDone,
    systemsBuilding: summary.systemsBuilding,
    sites: summary.sites,
    sitesComplete: summary.sitesComplete,
    doneTons: summary.doneTons,
    totalTons: summary.totalTons,
    remaining: summary.remaining,
  };
}

export function parseProgressSnapshot(value: unknown): ProjectProgressSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const num = (key: string) => {
    const parsed = Number(record[key]);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const progress = record.progress == null ? null : Number(record.progress);
  const remaining = record.remaining == null ? null : Number(record.remaining);
  return {
    progress: progress != null && Number.isFinite(progress) ? progress : null,
    systems: num('systems'),
    systemsDone: num('systemsDone'),
    systemsBuilding: num('systemsBuilding'),
    sites: num('sites'),
    sitesComplete: num('sitesComplete'),
    doneTons: num('doneTons'),
    totalTons: num('totalTons'),
    remaining: remaining != null && Number.isFinite(remaining) ? remaining : null,
  };
}
