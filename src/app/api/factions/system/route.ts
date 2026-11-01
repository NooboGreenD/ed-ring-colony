import { NextResponse } from 'next/server';
import { id64FromAny } from '@/lib/bgs';
import { createServiceClient } from '@/lib/supabaseServer';
import { findBgsSystemIdByName, readBgsSystem } from '@/lib/bgsStore';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/factions/system?id64=10477373803
 * GET /api/factions/system?name=Sol
 *
 * Карточка системы для слоя «Фракции»: принадлежность, правительство,
 * экономика, безопасность, население, контролирующая фракция, все фракции
 * системы с влиянием и состояниями, время наблюдения и источник.
 *
 * `id64` — основной ключ: его знает журнал пилота (`SystemAddress`). `name`
 * нужен там, где адрес неизвестен (например, старый журнал без
 * `SystemAddress`): имя приводится к `name_lc` и находится в тех же данных.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const id64 = id64FromAny(params.get('id64') ?? '');
  const name = (params.get('name') ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!id64 && !name) {
    return NextResponse.json({ error: 'Нужен параметр id64 или name' }, { status: 400 });
  }
  try {
    const svc = createServiceClient();
    const key = id64 ?? (await findBgsSystemIdByName(svc, name));
    if (!key) return NextResponse.json({ error: 'Системы нет в данных о фракциях' }, { status: 404 });
    const detail = await readBgsSystem(svc, key);
    if (!detail) return NextResponse.json({ error: 'Системы нет в данных о фракциях' }, { status: 404 });
    return NextResponse.json(detail, { headers: { 'Cache-Control': 'public, max-age=30, stale-while-revalidate=120' } });
  } catch (error) {
    console.error('[factions/system]', error instanceof Error ? error.message : error);
    return NextResponse.json({ error: 'Не удалось загрузить систему' }, { status: 503 });
  }
}
