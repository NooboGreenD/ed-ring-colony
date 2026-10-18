import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabaseServer';
import { loadPowerplayLayer } from '@/lib/powerplayStore';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/powerplay/systems
 *
 * Слой «PowerPlay» карты Atlas: все системы под контролем держав PowerPlay 2.0
 * (оплоты, укреплённые, эксплуатируемые) с координатами — одним ответом в
 * компактном формате (см. `lib/powerplay.ts` → `PowerplayLayerResponse`).
 * Открыт всем: это публичные игровые данные из ночного дампа EDSM.
 *
 * Пустая таблица или данные старше суток запускают импорт фоном; ответ его не
 * ждёт и сообщает `meta.refreshing`, чтобы клиент перезапросил позже.
 * ETag — версия набора: повторный визит получает 304 без тела.
 */
export async function GET(request: Request) {
  try {
    const layer = await loadPowerplayLayer(createServiceClient());
    // Пока набор пуст или обновляется, кэшировать нечего: клиент вернётся за свежим.
    const cacheControl = layer.status === 'ready' && !layer.refreshing
      ? 'public, max-age=300, stale-while-revalidate=3600'
      : 'no-store';
    const headers = { ETag: layer.etag, 'Cache-Control': cacheControl };
    const known = request.headers.get('if-none-match');
    if (known && known.split(',').map((tag) => tag.trim().replace(/^W\//, '')).includes(layer.etag)) {
      return new Response(null, { status: 304, headers });
    }
    return new Response(layer.body, {
      status: 200,
      headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' },
    });
  } catch (error) {
    console.error('[powerplay/systems]', error instanceof Error ? error.message : error);
    return NextResponse.json({ error: 'Не удалось загрузить системы PowerPlay' }, { status: 503 });
  }
}
