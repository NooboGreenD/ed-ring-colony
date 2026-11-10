import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabaseServer';
import { resolveRequestUser } from '@/lib/helperAuth';
import { loadMapCarriers } from '@/lib/carrierMapStore';
import { apiTranslate } from '@/lib/i18n/apiT';

export const dynamic = 'force-dynamic';

/**
 * GET /api/map/carriers
 *
 * Слой «Авианосцы» карты галактики и Atlas: где стоят носители. Отметка
 * открыта всем (как в игре и в публичной карточке носителя); зритель с сессией
 * видит, какие из них его и его эскадрильи, а имя владельца — только если тот
 * не скрыл местоположение. Груза и финансов здесь нет.
 *
 * `?directory=0` — только учёт сайта (подтверждённые стоянки). По умолчанию
 * подмешивается реестр EDDN: карта показывает все известные носители, а
 * переключатель в панели слоя решает, что из этого рисовать.
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
    const url = new URL(request.url);
    const directory = !/^(0|false|no|off)$/i.test(url.searchParams.get('directory') ?? '');
    const payload = await loadMapCarriers(svc, viewerId, { includeDirectory: directory });
    return NextResponse.json(payload, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[map/carriers]', error instanceof Error ? error.message : error);
    return NextResponse.json({ error: t('api.carriersLoadFailed') }, { status: 503 });
  }
}
