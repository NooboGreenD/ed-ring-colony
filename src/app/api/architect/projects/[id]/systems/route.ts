import { NextResponse } from 'next/server';
import {
  PROJECT_LIMITS,
  editableSystemFields,
  isUuid,
  parseSystemList,
  sanitizeSystemPatch,
  systemKey,
} from '@/lib/architect/projects';
import { SYSTEM_COLUMNS, loadPlanRefs, loadProfiles, systemView } from '@/lib/architect/projectStore';
import { errorResponse, jsonError, openProject, readJson } from '@/lib/architect/projectRouteKit';

export const dynamic = 'force-dynamic';

/**
 * Системы проекта.
 *
 *   POST   { systems: "HIP 1\nHIP 2" | string[] } — добавить (создатель и модераторы);
 *   PATCH  { systemId, stage?, priority?, planId?, responsibleId?, targetDate?, notes?, sortOrder?, name? }
 *            — ведущие проекта меняют всё; ответственный пилот — этап и заметки;
 *   DELETE { systemId } — убрать систему (ведущие проекта).
 *
 * План привязывается только к той же системе и только видимый пилоту:
 * свой, «по ссылке» или публичный. Ответственным может быть лишь участник.
 */

type Params = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: Params) {
  try {
    const opened = await openProject(req, (await params).id);
    if (!opened.ok) return opened.response;
    const { svc, userId, access } = opened;
    if (!access.permissions.manageSystems) return jsonError('Добавлять системы могут создатель и модераторы', 403);
    const parsed = await readJson(req);
    if (!parsed.ok) return parsed.response;

    const { data: existing, error: existingError } = await svc
      .from('architect_project_systems')
      .select('system_name, sort_order')
      .eq('project_id', access.project.id);
    if (existingError) throw new Error(existingError.message);
    const rows = (existing ?? []) as Array<{ system_name: string; sort_order: number }>;
    const list = parseSystemList(parsed.body.systems ?? parsed.body.system ?? '', {
      existing: rows.map((row) => row.system_name),
      limit: Math.max(0, PROJECT_LIMITS.systems - rows.length),
    });
    if (!list.names.length) {
      const reason = list.overflow.length
        ? `В проекте не больше ${PROJECT_LIMITS.systems} систем`
        : list.duplicates.length ? 'Эти системы уже в проекте' : 'Укажите хотя бы одну систему';
      return NextResponse.json({ error: reason, ...list, added: [] }, { status: 400 });
    }

    const start = rows.reduce((max, row) => Math.max(max, Number(row.sort_order) || 0), 0) + 1;
    const now = new Date().toISOString();
    const { data: inserted, error } = await svc
      .from('architect_project_systems')
      .insert(list.names.map((name, index) => ({
        project_id: access.project.id,
        system_name: name,
        sort_order: start + index,
        added_by: userId,
        created_at: now,
        updated_at: now,
      })))
      .select(SYSTEM_COLUMNS);
    if (error) {
      if (/duplicate key/i.test(error.message ?? '')) return jsonError('Система уже в проекте', 409);
      throw new Error(error.message);
    }
    await svc.from('architect_projects').update({ updated_at: now }).eq('id', access.project.id);
    const added = ((inserted ?? []) as Array<Record<string, unknown>>)
      .map((row) => systemView(row, new Map(), new Map(), access.actor));
    return NextResponse.json({
      added,
      duplicates: list.duplicates,
      invalid: list.invalid,
      overflow: list.overflow,
    }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(req: Request, { params }: Params) {
  try {
    const opened = await openProject(req, (await params).id);
    if (!opened.ok) return opened.response;
    const { svc, userId, access } = opened;
    const parsed = await readJson(req);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    if (!isUuid(body.systemId)) return jsonError('Укажите систему', 400);

    const { data: row, error: rowError } = await svc
      .from('architect_project_systems')
      .select(SYSTEM_COLUMNS)
      .eq('project_id', access.project.id)
      .eq('id', String(body.systemId).toLowerCase())
      .maybeSingle();
    if (rowError) throw new Error(rowError.message);
    if (!row) return jsonError('Система не найдена в проекте', 404);

    const allowed = editableSystemFields(access.actor, row.responsible_id);
    if (!allowed.length) return jsonError('Менять систему могут ведущие проекта и ответственный пилот', 403);
    const { patch, errors, forbidden } = sanitizeSystemPatch(body, allowed);
    if (forbidden.length) {
      return jsonError(`Ответственный пилот меняет только этап и заметки (запрещено: ${forbidden.join(', ')})`, 403);
    }
    if (errors.length) return jsonError(errors.join('; '), 400);
    if (!Object.keys(patch).length) return jsonError('Нечего менять', 400);

    const nextKey = typeof patch.system_name === 'string' ? systemKey(patch.system_name) : String(row.system_name_lc);
    if (typeof patch.plan_id === 'string') {
      const plans = await loadPlanRefs(svc, [patch.plan_id]);
      const plan = plans.get(patch.plan_id);
      const visible = plan && (plan.visibility !== 'private' || plan.authorId === userId || access.isAdmin);
      if (!plan || !visible) return jsonError('План не найден или закрыт автором', 404);
      if (plan.systemKey !== nextKey) return jsonError('План составлен для другой системы', 400);
    } else if (typeof patch.system_name === 'string' && row.plan_id && nextKey !== row.system_name_lc) {
      // Переименование отвязывает план чужой системы.
      patch.plan_id = null;
    }
    if (typeof patch.responsible_id === 'string') {
      const { data: member, error } = await svc
        .from('architect_project_members')
        .select('user_id')
        .eq('project_id', access.project.id)
        .eq('user_id', patch.responsible_id)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!member) return jsonError('Ответственным может быть только участник проекта', 400);
    }

    const now = new Date().toISOString();
    const { data: updated, error } = await svc
      .from('architect_project_systems')
      .update({ ...patch, updated_at: now })
      .eq('project_id', access.project.id)
      .eq('id', row.id)
      .select(SYSTEM_COLUMNS)
      .maybeSingle();
    if (error) {
      if (/duplicate key/i.test(error.message ?? '')) return jsonError('Такая система уже есть в проекте', 409);
      return jsonError(error.message, 400);
    }
    await svc.from('architect_projects').update({ updated_at: now }).eq('id', access.project.id);
    const fresh = (updated ?? row) as Record<string, unknown>;
    const [plans, profiles] = await Promise.all([
      loadPlanRefs(svc, [fresh.plan_id as string | null]),
      loadProfiles(svc, [fresh.responsible_id as string | null]),
    ]);
    return NextResponse.json({ system: systemView(fresh, plans, profiles, access.actor) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(req: Request, { params }: Params) {
  try {
    const opened = await openProject(req, (await params).id);
    if (!opened.ok) return opened.response;
    const { svc, access } = opened;
    if (!access.permissions.manageSystems) return jsonError('Убирать системы могут создатель и модераторы', 403);
    const url = new URL(req.url);
    let systemId = url.searchParams.get('systemId') ?? '';
    if (!systemId) {
      const parsed = await readJson(req);
      if (!parsed.ok) return parsed.response;
      systemId = String(parsed.body.systemId ?? '');
    }
    if (!isUuid(systemId)) return jsonError('Укажите систему', 400);
    const { data, error } = await svc
      .from('architect_project_systems')
      .delete()
      .eq('project_id', access.project.id)
      .eq('id', systemId.toLowerCase())
      .select('id');
    if (error) throw new Error(error.message);
    if (!(data ?? []).length) return jsonError('Система не найдена в проекте', 404);
    await svc.from('architect_projects').update({ updated_at: new Date().toISOString() }).eq('id', access.project.id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
