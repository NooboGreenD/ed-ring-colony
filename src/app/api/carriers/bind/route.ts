import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabaseServer';
import { resolveRequestUser } from '@/lib/helperAuth';
import { parseCarrierReference } from '@/lib/fleetCarriers';
import { buildViews, findCarrier, findOrCreateCarrier, viewerContext } from '@/lib/fleetCarrierStore';

export const dynamic = 'force-dynamic';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Ручная привязка авианосца.
 *
 * Обычно она не нужна: личный носитель привязывается сам по CarrierStats /
 * CarrierBuy из журнала, эскадренный — когда член эскадрильи видит его
 * CarrierStats или стыкуется к нему. Ручной ввод — для случаев, когда журнал
 * сброшен или носитель ещё не встречался.
 *
 *   POST   { kind: 'personal' | 'squadron', carrier: '<Carrier ID | ABC-123>', squadron_id? }
 *   DELETE { kind: 'personal' | 'squadron', carrier_id }
 */

async function readBody(request: Request): Promise<Record<string, any>> {
  try {
    const body = await request.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  } catch {
    return {};
  }
}

function fail(message: string, status: number) {
  return NextResponse.json({ ok: false, error: message }, { status });
}

export async function POST(request: Request) {
  try {
    const body = await readBody(request);
    const user = await resolveRequestUser(request, body.token);
    if (!user) return fail('Unauthorized', 401);
    const kind = body.kind === 'squadron' ? 'squadron' : body.kind === 'personal' ? 'personal' : null;
    if (!kind) return fail('kind: personal | squadron', 400);
    const reference = parseCarrierReference(body.carrier ?? body.carrier_id);
    if (!reference) return fail('Укажите Carrier ID (MarketID, например 3700005632) или позывной вида ABC-123', 400);

    const svc = createServiceClient();
    const viewer = await viewerContext(svc, user.userId);
    const now = new Date().toISOString();

    if (kind === 'personal') {
      const row = await findOrCreateCarrier(svc, reference);
      if (!row) {
        return fail('Носитель с таким позывным ещё не встречался в журналах. Укажите Carrier ID — его видно в журнале (CarrierID / MarketID).', 404);
      }
      if (row.carrier_type === 'SquadronCarrier') {
        return fail('Это эскадренный носитель — привяжите его на странице эскадрильи', 400);
      }
      if (row.owner_id && row.owner_id !== user.userId && ['journal', 'capi'].includes(row.owner_source)) {
        return fail('Этот носитель подтверждён журналом другого пилота', 409);
      }
      if (row.owner_id !== user.userId) {
        // Один личный носитель на профиль: прежняя привязка снимается.
        const { error: clearError } = await svc.from('fleet_carriers')
          .update({ owner_id: null, owner_source: null, owner_at: null })
          .eq('owner_id', user.userId).eq('carrier_type', 'FleetCarrier').neq('carrier_id', row.carrier_id);
        if (clearError) throw new Error(clearError.message);
        const { error } = await svc.from('fleet_carriers')
          .update({ owner_id: user.userId, owner_source: 'manual', owner_at: now, updated_at: now })
          .eq('carrier_id', row.carrier_id);
        if (error) throw new Error(error.message);
      }
      const updated = await findCarrier(svc, { carrierId: String(row.carrier_id) });
      const [carrier] = await buildViews(svc, updated ? [updated] : [], viewer);
      return NextResponse.json({ ok: true, carrier: carrier ?? null });
    }

    const squadronId = Number(body.squadron_id ?? viewer.squadronIds[0]);
    if (!Number.isSafeInteger(squadronId) || !viewer.squadronIds.includes(squadronId)) {
      return fail('Вы не состоите в этой эскадрилье', 403);
    }
    if (!viewer.officerSquadronIds.includes(squadronId)) {
      return fail('Привязывать носитель могут создатель эскадрильи и звания с правом редактирования', 403);
    }
    const row = await findOrCreateCarrier(svc, reference, { allowAnyId: true });
    if (!row) return fail('Носитель с таким позывным ещё не встречался. Укажите Carrier ID.', 404);
    if (row.squadron_id != null && Number(row.squadron_id) !== squadronId) {
      return fail('Носитель уже привязан к другой эскадрилье', 409);
    }
    const { error } = await svc.from('fleet_carriers')
      .update({ squadron_id: squadronId, squadron_source: 'manual', squadron_at: now, updated_at: now })
      .eq('carrier_id', row.carrier_id);
    if (error) throw new Error(error.message);
    const updated = await findCarrier(svc, { carrierId: String(row.carrier_id) });
    const [carrier] = await buildViews(svc, updated ? [updated] : [], viewer);
    return NextResponse.json({ ok: true, carrier: carrier ?? null });
  } catch (error) {
    console.error('[carriers/bind POST]', error instanceof Error ? error.message : error);
    return fail('Could not bind carrier', 503);
  }
}

export async function DELETE(request: Request) {
  try {
    const body = await readBody(request);
    const user = await resolveRequestUser(request, body.token);
    if (!user) return fail('Unauthorized', 401);
    const reference = parseCarrierReference(body.carrier_id ?? body.carrier);
    if (!reference) return fail('carrier_id required', 400);
    const svc = createServiceClient();
    const row = await findCarrier(svc, reference);
    if (!row) return fail('Not found', 404);

    if (body.kind === 'squadron') {
      const viewer = await viewerContext(svc, user.userId);
      if (row.squadron_id == null || !viewer.officerSquadronIds.includes(Number(row.squadron_id))) {
        return fail('Отвязать носитель могут создатель эскадрильи и звания с правом редактирования', 403);
      }
      const { error } = await svc.from('fleet_carriers')
        .update({ squadron_id: null, squadron_source: null, squadron_at: null, updated_at: new Date().toISOString() })
        .eq('carrier_id', row.carrier_id);
      if (error) throw new Error(error.message);
      return NextResponse.json({ ok: true });
    }

    if (row.owner_id !== user.userId) return fail('Это не ваш носитель', 403);
    const { error } = await svc.from('fleet_carriers')
      .update({ owner_id: null, owner_source: null, owner_at: null, updated_at: new Date().toISOString() })
      .eq('carrier_id', row.carrier_id);
    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[carriers/bind DELETE]', error instanceof Error ? error.message : error);
    return fail('Could not unbind carrier', 503);
  }
}
