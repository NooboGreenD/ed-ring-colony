import { NextResponse } from 'next/server';
import { viewerContext } from '@/lib/fleetCarrierStore';
import { PROJECT_LIMITS, sanitizeProjectPatch, sortMembers, sortSystems } from '@/lib/architect/projects';
import {
  PROJECT_COLUMNS,
  canShareCarrier,
  loadCarrierLinks,
  loadCarrierRows,
  loadMemberRows,
  loadPlanRefs,
  loadProfiles,
  loadSystemRows,
  memberView,
  projectCarrierViews,
  projectHeader,
  systemView,
  type ProjectRow,
} from '@/lib/architect/projectStore';
import { errorResponse, jsonError, openProject, readJson } from '@/lib/architect/projectRouteKit';

export const dynamic = 'force-dynamic';

/**
 * Один проект систем.
 *
 *   GET    — проект, мои права, участники, системы, авианосцы;
 *   PATCH  { name?, description?, status?, color?, targetDate?, trackingSince? }
 *            — создатель и модераторы;
 *   DELETE — только создатель (и администратор сайта).
 */

type Params = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Params) {
  try {
    const opened = await openProject(req, (await params).id);
    if (!opened.ok) return opened.response;
    const { svc, userId, access } = opened;
    const projectId = access.project.id;

    const [memberRows, systemRows, linkRows, viewer] = await Promise.all([
      loadMemberRows(svc, projectId),
      loadSystemRows(svc, projectId),
      loadCarrierLinks(svc, projectId),
      viewerContext(svc, userId),
    ]);
    const [plans, carrierRows, profiles] = await Promise.all([
      loadPlanRefs(svc, systemRows.map((row) => row.plan_id)),
      loadCarrierRows(svc, linkRows.map((row) => String(row.carrier_id))),
      loadProfiles(svc, [
        ...memberRows.map((row) => row.user_id),
        ...memberRows.map((row) => row.added_by),
        ...systemRows.map((row) => row.responsible_id),
        ...linkRows.map((row) => row.added_by),
      ]),
    ]);
    const sharedIds = new Set(linkRows.filter((row) => row.share_cargo === true).map((row) => String(row.carrier_id)));
    const views = await projectCarrierViews(
      svc,
      linkRows
        .map((row) => carrierRows.get(String(row.carrier_id)))
        .filter((row): row is Record<string, any> => Boolean(row)),
      viewer,
      sharedIds,
    );

    const systems = sortSystems(systemRows.map((row) => systemView(row, plans, profiles, access.actor)));
    const systemNames = new Map(systems.map((system) => [system.id, system.name]));
    const carriers = linkRows.map((row) => {
      const carrierId = String(row.carrier_id);
      const canShare = canShareCarrier(carrierRows.get(carrierId), viewer);
      const binder = row.added_by ? String(row.added_by) : null;
      return {
        carrierId,
        systemId: row.system_id ? String(row.system_id) : null,
        systemName: row.system_id ? systemNames.get(String(row.system_id)) ?? null : null,
        purpose: String(row.purpose ?? ''),
        shareCargo: row.share_cargo === true,
        addedById: binder,
        addedByName: binder ? profiles.get(binder)?.name ?? null : null,
        createdAt: row.created_at ?? null,
        canManage: access.permissions.bindAnyCarrier || binder === userId || canShare,
        canShare,
        carrier: views.get(carrierId) ?? null,
      };
    });

    return NextResponse.json({
      project: projectHeader(access.project),
      viewer: { userId, role: access.role, isAdmin: access.isAdmin, permissions: access.permissions },
      members: sortMembers(memberRows.map((row) => memberView(row, profiles, userId))),
      systems,
      carriers,
      limits: PROJECT_LIMITS,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(req: Request, { params }: Params) {
  try {
    const opened = await openProject(req, (await params).id);
    if (!opened.ok) return opened.response;
    const { svc, access } = opened;
    if (!access.permissions.editProject) return jsonError('Менять проект могут создатель и модераторы', 403);
    const parsed = await readJson(req);
    if (!parsed.ok) return parsed.response;
    const { patch, errors } = sanitizeProjectPatch(parsed.body);
    if (errors.length) return jsonError(errors.join('; '), 400);
    if (!Object.keys(patch).length) return jsonError('Нечего менять', 400);

    const { data, error } = await svc
      .from('architect_projects')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', access.project.id)
      .select(PROJECT_COLUMNS)
      .maybeSingle();
    if (error) return jsonError(error.message, 400);
    return NextResponse.json({ project: projectHeader((data ?? access.project) as ProjectRow) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(req: Request, { params }: Params) {
  try {
    const opened = await openProject(req, (await params).id);
    if (!opened.ok) return opened.response;
    const { svc, access } = opened;
    if (!access.permissions.deleteProject) return jsonError('Удалить проект может только его создатель', 403);
    const { error } = await svc.from('architect_projects').delete().eq('id', access.project.id);
    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
