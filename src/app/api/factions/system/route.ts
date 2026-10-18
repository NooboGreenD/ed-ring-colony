import { NextResponse } from 'next/server';
import { id64FromAny } from '@/lib/bgs';
import { createServiceClient } from '@/lib/supabaseServer';
import { readBgsSystem } from '@/lib/bgsStore';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/factions/system?id64=10477373803
 *
 * Карточка системы для слоя «Фракции»: принадлежность, правительство,
 * экономика, безопасность, население, контролирующая фракция, все фракции
 * системы с влиянием и состояниями, время наблюдения и источник.
 */
export async function GET(request: Request) {
  const id64 = id64FromAny(new URL(request.url).searchParams.get('id64') ?? '');
  if (!id64) return NextResponse.json({ error: 'Нужен параметр id64' }, { status: 400 });
  try {
    const detail = await readBgsSystem(createServiceClient(), id64);
    if (!detail) return NextResponse.json({ error: 'Системы нет в данных о фракциях' }, { status: 404 });
    return NextResponse.json(detail, { headers: { 'Cache-Control': 'public, max-age=30, stale-while-revalidate=120' } });
  } catch (error) {
    console.error('[factions/system]', error instanceof Error ? error.message : error);
    return NextResponse.json({ error: 'Не удалось загрузить систему' }, { status: 503 });
  }
}
