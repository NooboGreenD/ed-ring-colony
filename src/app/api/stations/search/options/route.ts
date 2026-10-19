import { NextResponse } from 'next/server';
import { z } from 'zod';
import { STATION_ITEMS_SOURCE, stationSearchOptions } from '@/lib/stationSearchCatalog';

/**
 * Списки быстрого выбора для `/station-search`: товары, модули, корабли,
 * услуги и инженеры. Справочник статический (EDCD/FDevIDs + словари проекта),
 * поэтому ответ кэшируется браузером и прокси; отбор под ввод — в браузере.
 */
export const dynamic = 'force-dynamic';

const kindSchema = z.enum(['market', 'outfitting', 'shipyard', 'services']);

export async function GET(request: Request) {
  const parsed = kindSchema.safeParse(new URL(request.url).searchParams.get('kind') ?? 'market');
  if (!parsed.success) return NextResponse.json({ error: 'Неизвестный раздел поиска станций.' }, { status: 400 });
  return NextResponse.json(
    { kind: parsed.data, options: stationSearchOptions(parsed.data), source: STATION_ITEMS_SOURCE },
    { headers: { 'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400' } },
  );
}
