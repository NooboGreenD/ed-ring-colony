import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabaseServer';
import {
  PROJECT_LIMITS,
  isProjectRole,
  systemKey,
  validateNewProject,
  type ProjectRole,
} from '@/lib/architect/projects';
import { PROJECT_COLUMNS, loadIsAdmin, projectSummaries, type ProjectRow } from '@/lib/architect/projectStore';
import { currentUserId, errorResponse, jsonError, readJson } from '@/lib/architect/projectRouteKit';

export const dynamic = 'force-dynamic';

/**
 * Проекты систем Архитектора.
 *
 *   GET                — мои проекты (карточки со сводкой прогресса);
 *   GET ?all=1         — все проекты (только администратор сайта);
 *   GET ?system=<имя>  — мои проекты, где есть эта система, и проекты, куда
 *                        я могу её добавить (панель в планировщике);
 *   POST { name, description?, color?, systems? } — создать проект; создатель
 *                        становится его участником с ролью owner.
 */

export async function GET(req: Request) {
  try {
    const userId = await currentUserId(req);
    if (!userId) return NextResponse.json({ error: 'Войдите, чтобы видеть проекты систем' }, { status: 401 });
    const svc = createServiceClient();
    const url = new URL(req.url);

    const { data: memberships, error: membershipError } = await svc
      .from('architect_project_members')
      .select('project_id, role')
      .eq('user_id', userId);
    if (membershipError) throw new Error(membershipError.message);
    const roles = new Map<string, ProjectRole>();
    for (const row of memberships ?? []) {
      if (isProjectRole(row.role)) roles.set(String(row.project_id), row.role);
    }

    const system = String(url.searchParams.get('system') ?? '').trim().slice(0, 128);
    if (system) {
      const ids = Array.from(roles.keys());
      if (!ids.length) return NextResponse.json({ system, projects: [], manageable: [] });
      const [{ data: projects, error }, { data: systems, error: systemsError }] = await Promise.all([
        svc.from('architect_projects').select('id, name, color, status').in('id', ids),
        svc.from('architect_project_systems')
          .select('id, project_id, stage, plan_id')
          .in('project_id', ids)
          .eq('system_name_lc', systemKey(system)),
      ]);
      if (error) throw new Error(error.message);
      if (systemsError) throw new Error(systemsError.message);
      const bySystem = new Map((systems ?? []).map((row: Record<string, unknown>) => [String(row.project_id), row]));
      const list = (projects ?? []) as Array<Record<string, unknown>>;
      return NextResponse.json({
        system,
        projects: list
          .filter((project) => bySystem.has(String(project.id)))
          .map((project) => {
            const row = bySystem.get(String(project.id))!;
            return {
              id: String(project.id),
              name: String(project.name),
              color: String(project.color),
              status: String(project.status),
              role: roles.get(String(project.id)) ?? null,
              systemId: String(row.id),
              stage: String(row.stage),
              planId: row.plan_id ? String(row.plan_id) : null,
            };
          }),
        manageable: list
          .filter((project) => !bySystem.has(String(project.id)))
          .filter((project) => {
            const role = roles.get(String(project.id));
            return role === 'owner' || role === 'moderator';
          })
          .map((project) => ({ id: String(project.id), name: String(project.name), color: String(project.color) })),
      });
    }

    const isAdmin = await loadIsAdmin(svc, userId);
    const wantAll = url.searchParams.get('all') === '1' && isAdmin;
    let rows: ProjectRow[] = [];
    if (wantAll) {
      const { data, error } = await svc
        .from('architect_projects')
        .select(PROJECT_COLUMNS)
        .order('updated_at', { ascending: false })
        .limit(300);
      if (error) throw new Error(error.message);
      rows = (data ?? []) as ProjectRow[];
    } else if (roles.size) {
      const { data, error } = await svc
        .from('architect_projects')
        .select(PROJECT_COLUMNS)
        .in('id', Array.from(roles.keys()))
        .order('updated_at', { ascending: false });
      if (error) throw new Error(error.message);
      rows = (data ?? []) as ProjectRow[];
    }
    const projects = await projectSummaries(svc, rows, roles);
    const owned = Array.from(roles.values()).filter((role) => role === 'owner').length;
    return NextResponse.json({ projects, isAdmin, all: wantAll, owned, limits: PROJECT_LIMITS });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(req: Request) {
  try {
    const userId = await currentUserId(req);
    if (!userId) return NextResponse.json({ error: 'Войдите, чтобы создать проект' }, { status: 401 });
    const parsed = await readJson(req);
    if (!parsed.ok) return parsed.response;
    const { value, error: invalid } = validateNewProject(parsed.body);
    if (!value) return jsonError(invalid ?? 'Неверные данные проекта', 400);

    const svc = createServiceClient();
    const { data: owned, error: ownedError } = await svc
      .from('architect_project_members')
      .select('project_id')
      .eq('user_id', userId)
      .eq('role', 'owner');
    if (ownedError) throw new Error(ownedError.message);
    if ((owned ?? []).length >= PROJECT_LIMITS.ownedProjects) {
      return NextResponse.json({
        error: `Можно вести не больше ${PROJECT_LIMITS.ownedProjects} проектов — передайте или удалите старые`,
      }, { status: 400 });
    }

    const { data: id, error } = await svc.rpc('architect_project_create', {
      p_owner: userId,
      p_name: value.name,
      p_description: value.description,
      p_color: value.color,
      p_systems: value.systems.names,
    });
    if (error) {
      const status = /violates check constraint|invalid input/i.test(error.message ?? '') ? 400 : 500;
      return NextResponse.json({ error: error.message }, { status });
    }
    return NextResponse.json({
      id: String(id),
      systems: value.systems.names.length,
      skipped: {
        duplicates: value.systems.duplicates,
        invalid: value.systems.invalid,
        overflow: value.systems.overflow,
      },
    }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
