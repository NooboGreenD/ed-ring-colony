import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabaseServer';
import { resolveRequestUser } from '@/lib/helperAuth';
import { carrierCardId } from '@/lib/carrierCard';
import { loadCarrierCard } from '@/lib/carrierCardStore';
import { apiTranslate } from '@/lib/i18n/apiT';

export const dynamic = 'force-dynamic';

/**
 * GET /api/carriers/{MarketID}/card
 *
 * Карточка авианосца для страницы `/carriers/<MarketID>`: где стоит (система и
 * тело), куда и когда прыгает, какие службы работают, что известно о владельце
 * и эскадрилье и вся статистика прыжков за год — окна, направления, графики.
 *
 * Публично, как и отметка носителя в игре. Личного нет ничего: груз и финансы
 * остаются капитану (`/api/carriers/{id}`), а имя владельца прячется его же
 * настройками приватности. Неизвестный MarketID — 404, а не пустая карточка.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const t = await apiTranslate();
  try {
    const { id } = await params;
    const carrierId = carrierCardId(decodeURIComponent(id));
    if (!carrierId) {
      return NextResponse.json({ error: t('api.carrierIdRequired') }, { status: 400 });
    }
    const svc = createServiceClient();
    let viewerId: string | null = null;
    try {
      viewerId = (await resolveRequestUser(request))?.userId ?? null;
    } catch {
      viewerId = null;
    }
    const card = await loadCarrierCard(svc, viewerId, carrierId);
    if (!card) return NextResponse.json({ error: t('api.carrierNotFound') }, { status: 404 });
    return NextResponse.json({ ok: true, card }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[carriers/:id/card]', error instanceof Error ? error.message : error);
    return NextResponse.json({ error: t('api.carrierLoadFailed') }, { status: 503 });
  }
}
