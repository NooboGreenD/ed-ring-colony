import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabaseServer';
import { resolveRequestUser } from '@/lib/helperAuth';
import { parseCarrierReference } from '@/lib/fleetCarriers';
import { buildViews, findCarrier, findOrCreateCarrier, viewerContext } from '@/lib/fleetCarrierStore';
import { carrierSquadronTag, gameSquadronTag } from '@/lib/carrierTags';
import { apiTranslate } from '@/lib/i18n/apiT';

export const dynamic = 'force-dynamic';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Ручная привязка авианосца.
 *
 * Обычно она не нужна: личный носитель привязывается сам по CarrierStats /
 * CarrierBuy из журнала, эскадренный — по CarrierLocation (игра пишет его
 * участникам эскадрильи при каждом запуске) или CarrierStats. Стыковка к
 * носителю его не привязывает. Ручной ввод — для случаев, когда журнал сброшен
 * или носитель ещё не встречался.
 *
 * Позывной Javelin — тег его эскадрильи в игре: носитель с другим тегом к
 * эскадрилье не привязывается (тег эскадрильи из четырёх символов). Отвязка
 * офицером запоминается (`squadron_rejected`): журналы участников носитель к
 * эскадрилье не вернут, вернуть можно только вручную.
 *
 *   POST   { kind: 'personal' | 'squadron', carrier: '<Carrier ID | ABC-123 | ABCD>', squadron_id? }
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

/**
 * Эскадрильи, отказавшиеся от носителя. `undefined` — колонки ещё нет
 * (код выкатили раньше миграции 20261018000000): тогда её и не пишем.
 */
function rejectedSquadrons(row: Record<string, any>): number[] | undefined {
  if (!('squadron_rejected' in row)) return undefined;
  const list = Array.isArray(row.squadron_rejected) ? row.squadron_rejected : [];
  return Array.from(new Set(list.map(Number).filter((id: number) => Number.isSafeInteger(id) && id > 0)));
}

export async function POST(request: Request) {
  const t = await apiTranslate();
  try {
    const body = await readBody(request);
    const user = await resolveRequestUser(request, body.token);
    if (!user) return fail('Unauthorized', 401);
    const kind = body.kind === 'squadron' ? 'squadron' : body.kind === 'personal' ? 'personal' : null;
    if (!kind) return fail('kind: personal | squadron', 400);
    const reference = parseCarrierReference(body.carrier ?? body.carrier_id);
    if (!reference) return fail(t('cr.carrierRefRequired'), 400);

    const svc = createServiceClient();
    const viewer = await viewerContext(svc, user.userId);
    const now = new Date().toISOString();

    if (kind === 'personal') {
      const row = await findOrCreateCarrier(svc, reference);
      if (!row) {
        return fail(t('cr.carrierCallsignUnknown'), 404);
      }
      if (row.carrier_type === 'SquadronCarrier') {
        return fail(t('cr.squadronCarrierElsewhere'), 400);
      }
      if (row.owner_id && row.owner_id !== user.userId && ['journal', 'capi'].includes(row.owner_source)) {
        return fail(t('cr.confirmedByOtherJournal'), 409);
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
      return fail(t('cr.notInThisSquadron'), 403);
    }
    if (!viewer.officerSquadronIds.includes(squadronId)) {
      return fail(t('cr.bindOfficersOnly'), 403);
    }
    const row = await findOrCreateCarrier(svc, reference, { allowAnyId: true });
    if (!row) return fail(t('cr.carrierCallsignUnknownShort'), 404);
    if (row.squadron_id != null && Number(row.squadron_id) !== squadronId) {
      return fail(t('cr.linkedToOtherSquadron'), 409);
    }
    const carrierTag = carrierSquadronTag({ type: row.carrier_type, callsign: row.callsign });
    if (carrierTag) {
      const { data: squadron, error: squadronError } = await svc.from('squadrons')
        .select('id, tag').eq('id', squadronId).maybeSingle();
      if (squadronError) throw new Error(squadronError.message);
      const squadronTag = gameSquadronTag(squadron?.tag);
      if (squadronTag && squadronTag !== carrierTag) {
        return fail(t('cr.tagMismatch', { carrierTag, squadronTag }), 409);
      }
    }
    const update: Record<string, unknown> = { squadron_id: squadronId, squadron_source: 'manual', squadron_at: now, updated_at: now };
    // Ручная привязка отменяет прежний отказ эскадрильи от этого носителя.
    const rejected = rejectedSquadrons(row);
    if (rejected) update.squadron_rejected = rejected.filter((id) => id !== squadronId);
    const { error } = await svc.from('fleet_carriers')
      .update(update)
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
  const t = await apiTranslate();
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
        return fail(t('cr.unbindOfficersOnly'), 403);
      }
      const update: Record<string, unknown> = {
        squadron_id: null, squadron_source: null, squadron_at: null, updated_at: new Date().toISOString(),
      };
      // Отвязка — решение офицеров: журналы участников этой эскадрильи больше
      // не привяжут носитель к ней снова (иначе ошибочная привязка возвращалась
      // при следующем запуске игры кем-то из них).
      const rejected = rejectedSquadrons(row);
      if (rejected) update.squadron_rejected = Array.from(new Set([...rejected, Number(row.squadron_id)]));
      const { error } = await svc.from('fleet_carriers')
        .update(update)
        .eq('carrier_id', row.carrier_id);
      if (error) throw new Error(error.message);
      return NextResponse.json({ ok: true });
    }

    if (row.owner_id !== user.userId) return fail(t('cr.notYourCarrier'), 403);
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
