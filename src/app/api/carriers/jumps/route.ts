import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabaseServer';
import { resolveRequestUser } from '@/lib/helperAuth';
import { loadCarrierJumps } from '@/lib/carrierMapStore';
import { apiTranslate } from '@/lib/i18n/apiT';

export const dynamic = 'force-dynamic';

/**
 * GET /api/carriers/jumps
 *
 * «Авианосцы перед прыжком» (`/carriers/jumps`): носители с заказанным
 * прыжком — откуда и куда, время вылета и дистанция. Публично, как и слой
 * авианосцев карты: отметка в игре видна любому пилоту, а груза и финансов
 * здесь нет никогда.
 *
 * Источник — только учёт сайта: `CarrierJumpRequest` в EDDN не попадает,
 * реестр `carrier_directory` знает лишь уже случившиеся прыжки.
 * Личные подписки страница берёт из `/api/atlas/carriers/watch`.
 */
export async function GET(request: Request) {
  const t = await apiTranslate();
  try {
    const svc = createServiceClient();
    let viewerId: string | null = null;
    try {
      viewerId = (await resolveRequestUser(request))?.userId ?? null;
    } catch {
      viewerId = null;
    }
    const payload = await loadCarrierJumps(svc, viewerId);
    return NextResponse.json(payload, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[carriers/jumps]', error instanceof Error ? error.message : error);
    return NextResponse.json({ error: t('api.carriersLoadFailed') }, { status: 503 });
  }
}
