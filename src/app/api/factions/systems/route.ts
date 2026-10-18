import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabaseServer';
import { loadBgsLayer } from '@/lib/bgsStore';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/factions/systems
 *
 * Слой «Фракции» карты Atlas: все населённые системы, где есть минорные
 * фракции, — координаты, принадлежность, правительство, контролирующая
 * фракция, население, время наблюдения и источник (дамп EDSM, Colonial Helper,
 * журнал на сайте) одним ответом в компактном формате (`lib/bgs.ts` →
 * `BgsLayerResponse`). Открыт всем: это публичные игровые данные.
 *
 * Сам импорт отсюда не запускается: дамп EDSM весит ≈0,5 ГБ, его загружает
 * администратор (Админка → Игровые данные → Фракции) или задача
 * `factions-sync`. `meta.refreshing` / `meta.progress` — идёт ли он сейчас;
 * `?meta=1` отдаёт только `status`, `version` и `meta`.
 */
export async function GET(request: Request) {
  try {
    // `?meta=1` — только состояние (без систем): так вкладка следит за идущим
    // импортом, не перекачивая мегабайты слоя каждые 15 секунд.
    const metaOnly = new URL(request.url).searchParams.get('meta') === '1';
    const layer = await loadBgsLayer(createServiceClient(), { metaOnly });
    const cacheControl = layer.status === 'ready' && !layer.refreshing && !metaOnly
      ? 'public, max-age=120, stale-while-revalidate=600'
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
        // Настоящий размер тела (до gzip nginx) — для полосы загрузки во вкладке.
        'X-Content-Bytes': String(layer.bytes),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[factions/systems]', message);
    const missing = /bgs_|schema cache|does not exist/i.test(message);
    return NextResponse.json(
      { error: missing ? 'Таблиц фракций нет в базе: нужна миграция 20261019120000_minor_factions.sql' : 'Не удалось загрузить системы фракций' },
      { status: 503 },
    );
  }
}
