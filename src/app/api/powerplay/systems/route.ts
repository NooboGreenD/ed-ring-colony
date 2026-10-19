import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabaseServer';
import { loadPowerplayLayer } from '@/lib/powerplayStore';
import { ensureEddnListenerSoon } from '@/lib/eddn/listener';

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
 *
 * Заодно (не чаще раза в 5 минут на процесс) — проверка, включены ли живые
 * данные EDDN и запущен ли их слушатель: после перезапуска сайта он
 * поднимется, даже если задача `eddn-listener` не включена в JOBS_ENABLED.
 */
export async function GET(request: Request) {
  try {
    const svc = createServiceClient();
    ensureEddnListenerSoon(svc);
    const layer = await loadPowerplayLayer(svc);
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
      headers: {
        ...headers,
        'Content-Type': 'application/json; charset=utf-8',
        // Content-Length после gzip nginx с распакованными байтами не сравнить:
        // настоящий размер — для полосы «загружено 1,2 из 4,1 МБ» во вкладке.
        'X-Content-Bytes': String(layer.bytes),
      },
    });
  } catch (error) {
    console.error('[powerplay/systems]', error instanceof Error ? error.message : error);
    return NextResponse.json({ error: 'Не удалось загрузить системы PowerPlay' }, { status: 503 });
  }
}
