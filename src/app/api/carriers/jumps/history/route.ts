import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabaseServer';
import { loadCarrierJumpHistory } from '@/lib/carrierJumpHistoryStore';
import { apiTranslate } from '@/lib/i18n/apiT';

export const dynamic = 'force-dynamic';

/**
 * GET /api/carriers/jumps/history?period=1h|1d|1m|1y&q=…&limit=…
 *
 * История состоявшихся прыжков всех авианосцев за период: корзины графика
 * интенсивности, сводка (всего, носителей, топ) и последние строки.
 *
 * Данные публичные, как и отметки носителей на карте: прыжок виден в игре
 * любому пилоту. Груза, финансов и владельцев здесь нет — только «кто, откуда,
 * куда и когда». Пишут историю триггеры учёта сайта и EDDN, маршрут её только
 * читает.
 */
export async function GET(request: Request) {
  const t = await apiTranslate();
  const params = new URL(request.url).searchParams;
  const limitRaw = Number(params.get('limit'));
  try {
    const svc = createServiceClient();
    const payload = await loadCarrierJumpHistory(svc, {
      period: params.get('period'),
      query: params.get('q') ?? '',
      limit: Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(500, Math.floor(limitRaw)) : undefined,
    });
    return NextResponse.json(payload, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[carriers/jumps/history]', error instanceof Error ? error.message : error);
    return NextResponse.json(
      { error: t('api.jumpHistoryFailed') },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
