import { NextResponse } from 'next/server';
import { findCarrier, findOrCreateCarrier, viewerContext } from '@/lib/fleetCarrierStore';
import { parseCarrierReference } from '@/lib/fleetCarriers';
import { PROJECT_LIMITS, cleanLine, isUuid } from '@/lib/architect/projects';
import { canShareCarrier } from '@/lib/architect/projectStore';
import { errorResponse, jsonError, openProject, readJson } from '@/lib/architect/projectRouteKit';
import { apiTranslate } from '@/lib/i18n/apiT';

export const dynamic = 'force-dynamic';

/**
 * Авианосцы проекта.
 *
 *   POST   { carrier: "<Carrier ID или позывной>", systemId?, purpose? }
 *   PATCH  { carrierId, systemId?, purpose?, shareCargo? }
 *   DELETE { carrierId }
 *
 * Привязать любой носитель (публичная карточка: где стоит, куда прыгает,
 * заказы) могут создатель и модераторы. Участник привязывает свой носитель
 * или носитель эскадрильи, где он офицер, — тогда груз носителя виден всем
 * участникам проекта (`share_cargo`). Включить показ груза может только тот,
 * кто и так его видит; выключить — он же, ведущие проекта или привязавший.
 * Финансы носителя в проекте не показываются никогда.
 */

type Params = { params: Promise<{ id: string }> };

async function loadLink(svc: any, projectId: string, carrierId: string) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const { data, error } = await svc
    .from('architect_project_carriers')
    .select('project_id, carrier_id, system_id, purpose, share_cargo, added_by')
    .eq('project_id', projectId)
    .eq('carrier_id', carrierId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data as Record<string, unknown> | null;
}

async function systemInProject(svc: any, projectId: string, systemId: unknown): Promise<string | null | undefined> { // eslint-disable-line @typescript-eslint/no-explicit-any
  if (systemId === undefined) return undefined;
  if (systemId === null || systemId === '') return null;
  if (!isUuid(systemId)) return undefined;
  const { data, error } = await svc
    .from('architect_project_systems')
    .select('id')
    .eq('project_id', projectId)
    .eq('id', String(systemId).toLowerCase())
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? String(data.id) : undefined;
}

function carrierIdOf(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  return /^\d{1,19}$/.test(raw) ? raw : null;
}

export async function POST(req: Request, { params }: Params) {
  const t = await apiTranslate();
  try {
    const opened = await openProject(req, (await params).id);
    if (!opened.ok) return opened.response;
    const { svc, userId, access } = opened;
    if (!access.role && !access.isAdmin) return jsonError(t('prj.noAccess'), 403);
    const parsed = await readJson(req);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;

    const reference = parseCarrierReference(body.carrier);
    if (!reference) return jsonError(t('prj.carrierIdFormat'), 400);
    const carrier = access.permissions.bindAnyCarrier
      ? await findOrCreateCarrier(svc, reference)
      : await findCarrier(svc, reference);
    if (!carrier) {
      return jsonError(t('prj.carrierNotFound'), 404);
    }
    const carrierId = String(carrier.carrier_id);
    const viewer = await viewerContext(svc, userId);
    const canShare = canShareCarrier(carrier, viewer);
    if (!access.permissions.bindAnyCarrier && !canShare) {
      return jsonError(t('prj.carrierLinkOwn'), 403);
    }

    const systemId = await systemInProject(svc, access.project.id, body.systemId);
    if (body.systemId !== undefined && body.systemId !== null && body.systemId !== '' && systemId === undefined) {
      return jsonError(t('prj.systemNotInProject'), 400);
    }

    const { data: links, error: linksError } = await svc
      .from('architect_project_carriers')
      .select('carrier_id')
      .eq('project_id', access.project.id);
    if (linksError) throw new Error(linksError.message);
    if ((links ?? []).some((row: { carrier_id: unknown }) => String(row.carrier_id) === carrierId)) {
      return jsonError(t('prj.carrierAlreadyLinked'), 409);
    }
    if ((links ?? []).length >= PROJECT_LIMITS.carriers) {
      return jsonError(t('prj.carriersLimit', { max: PROJECT_LIMITS.carriers }), 400);
    }

    const now = new Date().toISOString();
    const { error } = await svc.from('architect_project_carriers').insert({
      project_id: access.project.id,
      carrier_id: carrierId,
      system_id: systemId ?? null,
      purpose: cleanLine(body.purpose, PROJECT_LIMITS.purpose),
      share_cargo: canShare && body.shareCargo !== false,
      added_by: userId,
      created_at: now,
      updated_at: now,
    });
    if (error) {
      if (/duplicate key/i.test(error.message ?? '')) return jsonError(t('prj.carrierAlreadyLinked'), 409);
      throw new Error(error.message);
    }
    return NextResponse.json({
      ok: true,
      carrierId,
      name: carrier.name ?? null,
      callsign: carrier.callsign ?? null,
      shareCargo: canShare && body.shareCargo !== false,
    }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(req: Request, { params }: Params) {
  const t = await apiTranslate();
  try {
    const opened = await openProject(req, (await params).id);
    if (!opened.ok) return opened.response;
    const { svc, userId, access } = opened;
    const parsed = await readJson(req);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    const carrierId = carrierIdOf(body.carrierId);
    if (!carrierId) return jsonError(t('prj.carrierRequired'), 400);
    const link = await loadLink(svc, access.project.id, carrierId);
    if (!link) return jsonError(t('prj.carrierNotLinked'), 404);

    const viewer = await viewerContext(svc, userId);
    const carrier = await findCarrier(svc, { carrierId });
    const canShare = canShareCarrier(carrier, viewer);
    const manages = access.permissions.bindAnyCarrier || String(link.added_by ?? '') === userId || canShare;
    if (!manages) return jsonError(t('prj.carrierEditDenied'), 403);

    const patch: Record<string, unknown> = {};
    if (body.systemId !== undefined) {
      const systemId = await systemInProject(svc, access.project.id, body.systemId);
      if (systemId === undefined) return jsonError(t('prj.systemNotInProject'), 400);
      patch.system_id = systemId;
    }
    if (body.purpose !== undefined) patch.purpose = cleanLine(body.purpose, PROJECT_LIMITS.purpose);
    if (body.shareCargo !== undefined) {
      const share = body.shareCargo === true;
      if (share && !canShare) {
        return jsonError(t('prj.carrierCargoDenied'), 403);
      }
      patch.share_cargo = share;
    }
    if (!Object.keys(patch).length) return jsonError(t('prj.nothingToChange'), 400);

    const { error } = await svc
      .from('architect_project_carriers')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('project_id', access.project.id)
      .eq('carrier_id', carrierId);
    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(req: Request, { params }: Params) {
  const t = await apiTranslate();
  try {
    const opened = await openProject(req, (await params).id);
    if (!opened.ok) return opened.response;
    const { svc, userId, access } = opened;
    const url = new URL(req.url);
    let raw = url.searchParams.get('carrierId') ?? '';
    if (!raw) {
      const parsed = await readJson(req);
      if (!parsed.ok) return parsed.response;
      raw = String(parsed.body.carrierId ?? '');
    }
    const carrierId = carrierIdOf(raw);
    if (!carrierId) return jsonError(t('prj.carrierRequired'), 400);
    const link = await loadLink(svc, access.project.id, carrierId);
    if (!link) return jsonError(t('prj.carrierNotLinked'), 404);

    let allowed = access.permissions.bindAnyCarrier || String(link.added_by ?? '') === userId;
    if (!allowed) {
      const viewer = await viewerContext(svc, userId);
      allowed = canShareCarrier(await findCarrier(svc, { carrierId }), viewer);
    }
    if (!allowed) return jsonError(t('prj.carrierUnlinkDenied'), 403);

    const { error } = await svc
      .from('architect_project_carriers')
      .delete()
      .eq('project_id', access.project.id)
      .eq('carrier_id', carrierId);
    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
