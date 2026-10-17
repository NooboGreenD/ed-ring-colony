import { NextResponse } from 'next/server';
import {
  PROJECT_LIMITS,
  canChangeRole,
  canEditDuty,
  canRemoveMember,
  cleanLine,
  isProjectRole,
  isUuid,
  type ProjectRole,
} from '@/lib/architect/projects';
import { errorResponse, jsonError, openProject, readJson } from '@/lib/architect/projectRouteKit';

export const dynamic = 'force-dynamic';

/**
 * Участники проекта систем.
 *
 *   GET    ?search=<позывной> — подсказка пилотов для приглашения (ведущие проекта);
 *   POST   { userId | cmdr, role?, duty? } — добавить участника. Модератора
 *            сразу может добавить только создатель;
 *   PATCH  { userId, role?, duty? } — роль (только создатель; `owner` —
 *            передача проекта) и обязанность (ведущие проекта или сам пилот);
 *   DELETE { userId } — убрать участника или выйти самому (создатель выйти
 *            не может, пока не передаст проект).
 */

type Params = { params: Promise<{ id: string }> };

/** Поисковый запрос по позывному: вычищаем спецсимволы PostgREST/LIKE. */
function sanitizeSearch(value: string): string {
  return value.replace(/["(),%_\\*]/g, '').replace(/\s+/g, ' ').trim().slice(0, 64);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function memberRole(svc: any, projectId: string, userId: string): Promise<ProjectRole | null> {
  const { data, error } = await svc
    .from('architect_project_members')
    .select('role')
    .eq('project_id', projectId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return isProjectRole(data?.role) ? data.role : null;
}

export async function GET(req: Request, { params }: Params) {
  try {
    const opened = await openProject(req, (await params).id);
    if (!opened.ok) return opened.response;
    const { svc, access } = opened;
    if (!access.permissions.manageMembers) return jsonError('Приглашать могут создатель и модераторы', 403);
    const search = sanitizeSearch(new URL(req.url).searchParams.get('search') || '');
    if (search.length < 2) return NextResponse.json({ search, candidates: [] });

    const [{ data, error }, { data: members, error: membersError }] = await Promise.all([
      svc.from('public_profiles').select('id, cmdr_name, avatar_url, squadron').ilike('cmdr_name', `%${search}%`).limit(12),
      svc.from('architect_project_members').select('user_id').eq('project_id', access.project.id),
    ]);
    if (error) throw new Error(error.message);
    if (membersError) throw new Error(membersError.message);
    const existing = new Set((members ?? []).map((row: { user_id: string }) => String(row.user_id)));
    const candidates = ((data ?? []) as Array<Record<string, unknown>>)
      .map((row) => ({
        id: String(row.id ?? ''),
        name: String(row.cmdr_name ?? '').trim(),
        avatarUrl: typeof row.avatar_url === 'string' ? row.avatar_url : null,
        squadron: typeof row.squadron === 'string' ? row.squadron : null,
        member: existing.has(String(row.id ?? '')),
      }))
      .filter((row) => row.id && row.name)
      .slice(0, 8);
    return NextResponse.json({ search, candidates });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(req: Request, { params }: Params) {
  try {
    const opened = await openProject(req, (await params).id);
    if (!opened.ok) return opened.response;
    const { svc, userId, access } = opened;
    if (!access.permissions.manageMembers) return jsonError('Добавлять участников могут создатель и модераторы', 403);
    const parsed = await readJson(req);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;

    const role: ProjectRole = body.role === 'moderator' ? 'moderator' : 'member';
    if (body.role !== undefined && body.role !== 'moderator' && body.role !== 'member') {
      return jsonError('Новый участник может быть только участником или модератором', 400);
    }
    if (role === 'moderator' && !access.permissions.manageModerators) {
      return jsonError('Модераторов назначает только создатель проекта', 403);
    }

    let target: { id: string; name: string } | null = null;
    if (isUuid(body.userId)) {
      const { data, error } = await svc.from('profiles').select('id, cmdr_name').eq('id', String(body.userId).toLowerCase()).maybeSingle();
      if (error) throw new Error(error.message);
      if (data) target = { id: String(data.id), name: String(data.cmdr_name ?? '') };
    } else if (typeof body.cmdr === 'string' && sanitizeSearch(body.cmdr)) {
      const { data, error } = await svc
        .from('profiles')
        .select('id, cmdr_name')
        .ilike('cmdr_name', sanitizeSearch(body.cmdr))
        .limit(2);
      if (error) throw new Error(error.message);
      if ((data ?? []).length > 1) return jsonError('Несколько пилотов с таким позывным — выберите из подсказки', 409);
      if (data?.[0]) target = { id: String(data[0].id), name: String(data[0].cmdr_name ?? '') };
    } else {
      return jsonError('Укажите пилота', 400);
    }
    if (!target) return jsonError('Пилот не найден на сайте — он должен зарегистрироваться', 404);

    const { data: members, error: membersError } = await svc
      .from('architect_project_members')
      .select('user_id')
      .eq('project_id', access.project.id);
    if (membersError) throw new Error(membersError.message);
    if ((members ?? []).some((row: { user_id: string }) => String(row.user_id) === target!.id)) {
      return jsonError('Пилот уже в проекте', 409);
    }
    if ((members ?? []).length >= PROJECT_LIMITS.members) {
      return jsonError(`В проекте не больше ${PROJECT_LIMITS.members} участников`, 400);
    }

    const now = new Date().toISOString();
    const { error } = await svc.from('architect_project_members').insert({
      project_id: access.project.id,
      user_id: target.id,
      role,
      duty: cleanLine(body.duty, PROJECT_LIMITS.duty),
      added_by: userId,
      created_at: now,
      updated_at: now,
    });
    if (error) {
      if (/duplicate key/i.test(error.message ?? '')) return jsonError('Пилот уже в проекте', 409);
      throw new Error(error.message);
    }
    return NextResponse.json({ ok: true, member: { userId: target.id, name: target.name, role } }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(req: Request, { params }: Params) {
  try {
    const opened = await openProject(req, (await params).id);
    if (!opened.ok) return opened.response;
    const { svc, access } = opened;
    const parsed = await readJson(req);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    if (!isUuid(body.userId)) return jsonError('Укажите участника', 400);
    const targetId = String(body.userId).toLowerCase();
    const targetRole = await memberRole(svc, access.project.id, targetId);
    if (!targetRole) return jsonError('Пилот не участвует в проекте', 404);
    const target = { userId: targetId, role: targetRole };

    if (body.role !== undefined) {
      if (!isProjectRole(body.role)) return jsonError('Неизвестная роль', 400);
      const decision = canChangeRole(access.actor, target, body.role);
      if (!decision.ok) return jsonError(decision.reason ?? 'Нет прав', decision.reason === 'Роль не изменилась' ? 400 : 403);
      if (body.role === 'owner') {
        const { error } = await svc.rpc('architect_project_transfer', { p_project: access.project.id, p_to: targetId });
        if (error) throw new Error(error.message);
      } else {
        const { error } = await svc
          .from('architect_project_members')
          .update({ role: body.role, updated_at: new Date().toISOString() })
          .eq('project_id', access.project.id)
          .eq('user_id', targetId);
        if (error) throw new Error(error.message);
      }
    }

    if (body.duty !== undefined) {
      if (!canEditDuty(access.actor, target)) return jsonError('Обязанности назначают создатель и модераторы', 403);
      const { error } = await svc
        .from('architect_project_members')
        .update({ duty: cleanLine(body.duty, PROJECT_LIMITS.duty), updated_at: new Date().toISOString() })
        .eq('project_id', access.project.id)
        .eq('user_id', targetId);
      if (error) throw new Error(error.message);
    }

    if (body.role === undefined && body.duty === undefined) return jsonError('Нечего менять', 400);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(req: Request, { params }: Params) {
  try {
    const opened = await openProject(req, (await params).id);
    if (!opened.ok) return opened.response;
    const { svc, userId, access } = opened;
    const url = new URL(req.url);
    let targetId = url.searchParams.get('userId') ?? '';
    if (!targetId) {
      const parsed = await readJson(req);
      if (!parsed.ok) return parsed.response;
      targetId = String(parsed.body.userId ?? '');
    }
    if (!isUuid(targetId)) return jsonError('Укажите участника', 400);
    targetId = targetId.toLowerCase();
    const targetRole = await memberRole(svc, access.project.id, targetId);
    if (!targetRole) return jsonError('Пилот не участвует в проекте', 404);
    const decision = canRemoveMember(access.actor, { userId: targetId, role: targetRole });
    if (!decision.ok) return jsonError(decision.reason ?? 'Нет прав', 403);

    const { error } = await svc
      .from('architect_project_members')
      .delete()
      .eq('project_id', access.project.id)
      .eq('user_id', targetId);
    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true, left: targetId === userId });
  } catch (error) {
    return errorResponse(error);
  }
}
