import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabaseServer';
import { resolveRequestUser } from '@/lib/helperAuth';
import { loadMapCarriers } from '@/lib/carrierMapStore';

export const dynamic = 'force-dynamic';

/**
 * GET /api/map/carriers
 *
 * Слой «Авианосцы» карты галактики и Atlas: где стоят носители, известные
 * сайту. Отметка открыта всем (как в игре и в публичной карточке носителя);
 * зритель с сессией видит, какие из них его и его эскадрильи, а имя владельца —
 * только если тот не скрыл местоположение. Груза и финансов здесь нет.
 */
export async function GET(request: Request) {
  try {
    const svc = createServiceClient();
    let viewerId: string | null = null;
    try {
      viewerId = (await resolveRequestUser(request))?.userId ?? null;
    } catch {
      viewerId = null;
    }
    const payload = await loadMapCarriers(svc, viewerId);
    return NextResponse.json(payload, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[map/carriers]', error instanceof Error ? error.message : error);
    return NextResponse.json({ error: 'Не удалось загрузить авианосцы' }, { status: 503 });
  }
}
