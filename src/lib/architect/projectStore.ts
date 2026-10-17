/**
 * «Проекты систем»: чтение и запись через service_role.
 *
 * Таблицы проектов закрыты RLS от прямой записи, а вклад пилотов собирается
 * из чужих `deliveries` — поэтому маршруты работают service-role клиентом и
 * сами решают, что показать. Здесь — загрузка доступа, имён, систем,
 * авианосцев и источников прогресса; правила — в `projects.ts`.
 *
 * Модуль без Next.js: маршрут передаёт сюда готовый клиент.
 */

import { resolvePrivacy } from '@/lib/privacy';
import { buildViews, relationFor, type ViewerContext } from '@/lib/fleetCarrierStore';
import { buildCarrierView, type CarrierView } from '@/lib/fleetCarriers';
import {
  PROJECT_LIMITS,
  editableSystemFields,
  isProjectRole,
  isProjectStatus,
  isSystemStage,
  isUuid,
  parseProgressSnapshot,
  progressSnapshot,
  projectPermissions,
  sortMembers,
  sortSystems,
  type ProjectActor,
  type ProjectMemberView,
  type ProjectPermissions,
  type ProjectPlanRef,
  type ProjectRole,
  type ProjectStatus,
  type ProjectSummary,
  type ProjectSystemView,
  type SystemStage,
} from './projects.ts';
import {
  buildProjectProgress,
  type ProgressSources,
  type ProjectProgressSummary,
  type ProjectProgressView,
} from './projectProgress.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Svc = any;

export const PROJECT_COLUMNS = 'id, name, description, status, color, target_date, tracking_since, progress_summary, progress_at, created_by, created_at, updated_at';
export const SYSTEM_COLUMNS = 'id, project_id, system_name, system_name_lc, stage, priority, plan_id, responsible_id, target_date, notes, sort_order, added_by, created_at, updated_at';
export const CARRIER_LINK_COLUMNS = 'project_id, carrier_id, system_id, purpose, share_cargo, added_by, created_at, updated_at';
const IN_CHUNK = 150;

export interface ProjectRow {
  id: string;
  name: string;
  description: string;
  status: ProjectStatus;
  color: string;
  target_date: string | null;
  tracking_since: string | null;
  progress_summary: unknown;
  progress_at: string | null;
  created_by: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface ProfileInfo {
  name: string;
  avatarUrl: string | null;
  squadron: string | null;
  /** `profiles.privacy_settings.deliveries`: показывать поставки другим. */
  showDeliveries: boolean;
}

export type AccessResult =
  | { ok: true; project: ProjectRow; role: ProjectRole | null; isAdmin: boolean; permissions: ProjectPermissions; actor: ProjectActor }
  | { ok: false; status: number; error: string };

function chunks<T>(items: T[], size = IN_CHUNK): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

function fail(message: string, error: { message?: string } | null | undefined): never {
  throw new Error(`${message}: ${error?.message ?? 'unknown error'}`);
}

export async function loadIsAdmin(svc: Svc, userId: string): Promise<boolean> {
  const { data, error } = await svc.from('profiles').select('role').eq('id', userId).maybeSingle();
  if (error) return false;
  return data?.role === 'admin';
}

/**
 * Проект и роль пилота в нём. Постороннему отвечаем 404, а не 403: само
 * существование закрытого проекта — тоже информация.
 */
export async function loadProjectAccess(svc: Svc, projectId: string, userId: string): Promise<AccessResult> {
  if (!isUuid(projectId)) return { ok: false, status: 404, error: 'Проект не найден' };
  const id = projectId.trim().toLowerCase();
  const [{ data: project, error }, { data: member, error: memberError }, isAdmin] = await Promise.all([
    svc.from('architect_projects').select(PROJECT_COLUMNS).eq('id', id).maybeSingle(),
    svc.from('architect_project_members').select('role').eq('project_id', id).eq('user_id', userId).maybeSingle(),
    loadIsAdmin(svc, userId),
  ]);
  if (error) fail('Architect project', error);
  if (memberError) fail('Architect project member', memberError);
  if (!project) return { ok: false, status: 404, error: 'Проект не найден' };
  const role = isProjectRole(member?.role) ? member!.role as ProjectRole : null;
  if (!role && !isAdmin) return { ok: false, status: 404, error: 'Проект не найден' };
  return {
    ok: true,
    project: project as ProjectRow,
    role,
    isAdmin,
    permissions: projectPermissions(role, isAdmin),
    actor: { userId, role, isAdmin },
  };
}

export async function loadProfiles(svc: Svc, ids: Iterable<string | null | undefined>): Promise<Map<string, ProfileInfo>> {
  const unique = Array.from(new Set(Array.from(ids).filter((id): id is string => typeof id === 'string' && id.length > 0)));
  const result = new Map<string, ProfileInfo>();
  for (const part of chunks(unique)) {
    const { data, error } = await svc
      .from('profiles')
      .select('id, cmdr_name, avatar_url, squadron, privacy_settings')
      .in('id', part);
    if (error) fail('Profiles', error);
    for (const row of Array.isArray(data) ? data : []) {
      result.set(String(row.id), {
        name: String(row.cmdr_name ?? '').trim(),
        avatarUrl: typeof row.avatar_url === 'string' && row.avatar_url ? row.avatar_url : null,
        squadron: typeof row.squadron === 'string' && row.squadron ? row.squadron : null,
        showDeliveries: resolvePrivacy(row.privacy_settings).deliveries,
      });
    }
  }
  return result;
}

export async function loadMemberRows(svc: Svc, projectId: string): Promise<Array<Record<string, any>>> {
  const { data, error } = await svc
    .from('architect_project_members')
    .select('project_id, user_id, role, duty, added_by, created_at, updated_at')
    .eq('project_id', projectId);
  if (error) fail('Architect project members', error);
  return Array.isArray(data) ? data : [];
}

export async function loadSystemRows(svc: Svc, projectId: string): Promise<Array<Record<string, any>>> {
  const { data, error } = await svc
    .from('architect_project_systems')
    .select(SYSTEM_COLUMNS)
    .eq('project_id', projectId)
    .order('sort_order', { ascending: true });
  if (error) fail('Architect project systems', error);
  return Array.isArray(data) ? data : [];
}

export async function loadCarrierLinks(svc: Svc, projectId: string): Promise<Array<Record<string, any>>> {
  const { data, error } = await svc
    .from('architect_project_carriers')
    .select(CARRIER_LINK_COLUMNS)
    .eq('project_id', projectId)
    .order('created_at', { ascending: true });
  if (error) fail('Architect project carriers', error);
  return Array.isArray(data) ? data : [];
}

export async function loadPlanRefs(svc: Svc, planIds: Iterable<string | null | undefined>): Promise<Map<string, ProjectPlanRef & { systemKey: string; authorId: string | null }>> {
  const ids = Array.from(new Set(Array.from(planIds).filter((id): id is string => isUuid(id))));
  const result = new Map<string, ProjectPlanRef & { systemKey: string; authorId: string | null }>();
  for (const part of chunks(ids)) {
    const { data, error } = await svc
      .from('system_plans')
      .select('id, system_name, system_name_lc, title, author_id, author_name, visibility, site_count, haul_tons, updated_at')
      .in('id', part);
    if (error) fail('System plans', error);
    for (const row of Array.isArray(data) ? data : []) {
      result.set(String(row.id), {
        id: String(row.id),
        title: String(row.title ?? '') || `План ${row.system_name ?? ''}`.trim(),
        authorName: String(row.author_name ?? ''),
        visibility: String(row.visibility ?? 'private'),
        siteCount: Number(row.site_count ?? 0) || 0,
        haulTons: Number(row.haul_tons ?? 0) || 0,
        updatedAt: row.updated_at ?? null,
        systemKey: String(row.system_name_lc ?? row.system_name ?? '').trim().toLowerCase(),
        authorId: row.author_id ? String(row.author_id) : null,
      });
    }
  }
  return result;
}

export function memberView(row: Record<string, any>, profiles: Map<string, ProfileInfo>, viewerId: string): ProjectMemberView {
  const userId = String(row.user_id);
  const profile = profiles.get(userId);
  return {
    userId,
    name: profile?.name || 'Командир без имени',
    avatarUrl: profile?.avatarUrl ?? null,
    squadron: profile?.squadron ?? null,
    role: isProjectRole(row.role) ? row.role : 'member',
    duty: String(row.duty ?? ''),
    joinedAt: row.created_at ?? null,
    addedByName: row.added_by && row.added_by !== row.user_id ? profiles.get(String(row.added_by))?.name ?? null : null,
    isYou: userId === viewerId,
  };
}

export function systemView(
  row: Record<string, any>,
  plans: Map<string, ProjectPlanRef>,
  profiles: Map<string, ProfileInfo>,
  actor: ProjectActor,
): ProjectSystemView {
  const planId = row.plan_id ? String(row.plan_id) : null;
  const plan = planId ? plans.get(planId) ?? null : null;
  const responsibleId = row.responsible_id ? String(row.responsible_id) : null;
  return {
    id: String(row.id),
    name: String(row.system_name),
    key: String(row.system_name_lc ?? String(row.system_name).toLowerCase()),
    stage: isSystemStage(row.stage) ? row.stage as SystemStage : 'planned',
    priority: Number(row.priority ?? 2) || 2,
    planId,
    plan: plan ? {
      id: plan.id, title: plan.title, authorName: plan.authorName, visibility: plan.visibility,
      siteCount: plan.siteCount, haulTons: plan.haulTons, updatedAt: plan.updatedAt,
    } : null,
    responsibleId,
    responsibleName: responsibleId ? profiles.get(responsibleId)?.name ?? null : null,
    targetDate: row.target_date ? String(row.target_date).slice(0, 10) : null,
    notes: String(row.notes ?? ''),
    sortOrder: Number(row.sort_order ?? 0) || 0,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
    editable: [...editableSystemFields(actor, responsibleId)],
  };
}

export function projectHeader(row: ProjectRow) {
  return {
    id: String(row.id),
    name: String(row.name),
    description: String(row.description ?? ''),
    status: isProjectStatus(row.status) ? row.status : 'active' as ProjectStatus,
    color: String(row.color ?? '#e67e22'),
    targetDate: row.target_date ? String(row.target_date).slice(0, 10) : null,
    trackingSince: row.tracking_since ?? null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

/** Карточки проектов для списка: счётчики, создатель, сохранённая сводка. */
export async function projectSummaries(
  svc: Svc,
  projects: ProjectRow[],
  roles: Map<string, ProjectRole>,
): Promise<ProjectSummary[]> {
  if (!projects.length) return [];
  const ids = projects.map((project) => String(project.id));
  const counts = new Map<string, { systems: number; members: number; carriers: number }>(ids.map((id) => [id, { systems: 0, members: 0, carriers: 0 }]));
  const owners = new Map<string, string>();
  for (const part of chunks(ids, 50)) {
    const [members, systems, carriers] = await Promise.all([
      svc.from('architect_project_members').select('project_id, user_id, role').in('project_id', part),
      svc.from('architect_project_systems').select('project_id').in('project_id', part),
      svc.from('architect_project_carriers').select('project_id').in('project_id', part),
    ]);
    for (const [response, field] of [[members, 'members'], [systems, 'systems'], [carriers, 'carriers']] as const) {
      if (response.error) fail(`Architect project ${field}`, response.error);
      for (const row of Array.isArray(response.data) ? response.data : []) {
        const entry = counts.get(String(row.project_id));
        if (entry) entry[field] += 1;
        if (field === 'members' && row.role === 'owner') owners.set(String(row.project_id), String(row.user_id));
      }
    }
  }
  const profiles = await loadProfiles(svc, owners.values());
  return projects.map((row) => {
    const header = projectHeader(row);
    const ownerId = owners.get(header.id);
    return {
      id: header.id,
      name: header.name,
      description: header.description,
      status: header.status,
      color: header.color,
      role: roles.get(header.id) ?? null,
      targetDate: header.targetDate,
      createdAt: header.createdAt,
      updatedAt: header.updatedAt,
      counts: counts.get(header.id) ?? { systems: 0, members: 0, carriers: 0 },
      progress: parseProgressSnapshot(row.progress_summary),
      progressAt: row.progress_at ?? null,
      ownerName: ownerId ? profiles.get(ownerId)?.name ?? null : null,
    };
  });
}

// ── Прогресс ───────────────────────────────────────────────────────────────

export async function loadProgressSources(svc: Svc, projectId: string, includePlans: boolean): Promise<ProgressSources> {
  const { data, error } = await svc.rpc('architect_project_progress_sources', {
    p_project_id: projectId,
    p_include_plans: includePlans,
  });
  if (error) fail('Architect project progress sources', error);
  const record = data && typeof data === 'object' ? data as Record<string, unknown> : {};
  return {
    raven: Array.isArray(record.raven) ? record.raven as ProgressSources['raven'] : [],
    depots: Array.isArray(record.depots) ? record.depots as ProgressSources['depots'] : [],
    plans: Array.isArray(record.plans) ? record.plans as ProgressSources['plans'] : [],
  };
}

export async function computeProjectProgress(
  svc: Svc,
  projectId: string,
  systemRows: Array<Record<string, any>>,
  options: { includePlans?: boolean } = {},
): Promise<ProjectProgressView> {
  const includePlans = options.includePlans ?? true;
  const sources = await loadProgressSources(svc, projectId, includePlans);
  const systems = sortSystems(systemRows.map((row) => ({
    id: String(row.id),
    name: String(row.system_name),
    planId: includePlans && row.plan_id ? String(row.plan_id) : null,
    priority: Number(row.priority ?? 2) || 2,
    sortOrder: Number(row.sort_order ?? 0) || 0,
  })));
  return buildProjectProgress(systems, sources);
}

/** Сохранить сводку для списка проектов. Ошибка записи не ломает ответ. */
export async function storeProgressSummary(svc: Svc, projectId: string, summary: ProjectProgressSummary): Promise<void> {
  try {
    await svc
      .from('architect_projects')
      .update({ progress_summary: progressSnapshot(summary), progress_at: new Date().toISOString() })
      .eq('id', projectId);
  } catch {
    // Сводка — кэш для списка, не источник истины.
  }
}

// ── Авианосцы ──────────────────────────────────────────────────────────────

/** Видит ли пилот груз носителя сам по себе: владелец или офицер эскадрильи носителя. */
export function canShareCarrier(row: Record<string, any> | null | undefined, viewer: ViewerContext): boolean {
  if (!row || !viewer.userId) return false;
  if (relationFor(row, viewer) === 'own') return true;
  return row.carrier_type === 'SquadronCarrier'
    && row.squadron_id != null
    && viewer.officerSquadronIds.includes(Number(row.squadron_id));
}

export async function loadCarrierRows(svc: Svc, carrierIds: string[]): Promise<Map<string, Record<string, any>>> {
  const result = new Map<string, Record<string, any>>();
  for (const part of chunks(Array.from(new Set(carrierIds)))) {
    const { data, error } = await svc.from('fleet_carriers').select('*').in('carrier_id', part);
    if (error) fail('Fleet carriers', error);
    for (const row of Array.isArray(data) ? data : []) result.set(String(row.carrier_id), row);
  }
  return result;
}

/**
 * Карточки носителей проекта. Груз виден, если пилот и так его видит
 * (свой/эскадрильи) или носитель привязан с `share_cargo`. Финансы в проекте
 * не показываются никогда.
 */
export async function projectCarrierViews(
  svc: Svc,
  rows: Array<Record<string, any>>,
  viewer: ViewerContext,
  sharedIds: Set<string>,
): Promise<Map<string, CarrierView & { sharedCargo: boolean }>> {
  const result = new Map<string, CarrierView & { sharedCargo: boolean }>();
  if (!rows.length) return result;
  const views = await buildViews(svc, rows, viewer);
  for (const view of views) result.set(view.carrierId, { ...view, finance: null, sharedCargo: false });

  const needCargo = rows.filter((row) => {
    const id = String(row.carrier_id);
    return sharedIds.has(id) && result.get(id)?.cargo == null;
  });
  if (needCargo.length) {
    const cargoByCarrier = new Map<string, Array<Record<string, any>>>();
    const { data, error } = await svc
      .from('fleet_carrier_cargo')
      .select('carrier_id, commodity, name_localised, quantity, baseline_at, baseline_source, updated_at')
      .in('carrier_id', needCargo.map((row) => String(row.carrier_id)))
      .gt('quantity', 0);
    if (error) fail('Fleet carrier cargo', error);
    for (const cargo of Array.isArray(data) ? data : []) {
      const key = String(cargo.carrier_id);
      if (!cargoByCarrier.has(key)) cargoByCarrier.set(key, []);
      cargoByCarrier.get(key)!.push(cargo);
    }
    for (const row of needCargo) {
      const id = String(row.carrier_id);
      const previous = result.get(id);
      const view = buildCarrierView(row, {
        relation: 'squadron',
        showFinance: false,
        cargoRows: cargoByCarrier.get(id) ?? [],
        market: previous?.market ? { observed_at: previous.market.observedAt, items: previous.market.items } : null,
      });
      result.set(id, { ...view, relation: previous?.relation ?? 'public', ownerSource: null, finance: null, sharedCargo: true });
    }
  }
  return result;
}

export { PROJECT_LIMITS };
