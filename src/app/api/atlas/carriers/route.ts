import { NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabaseServer';
import { apiTranslate } from '@/lib/i18n/apiT';
import { searchMapCarriers } from '@/lib/carrierMapStore';
import { CARRIER_SEARCH_MAX, type CarrierWatch, type CarrierWatchScope } from '@/lib/carrierDirectory';
import { watchFromRow } from '@/lib/carrierWatch';

export const dynamic = 'force-dynamic';

/**
 * GET /api/atlas/carriers?q=…&scope=all|favorites&limit=…
 *
 * Поиск по реестру авианосцев сайта (`fleet_carriers`) для раздела «Трафик
 * авианосцев»: по позывному (тегу), имени, системе и MarketID. Ответ открыт
 * всем: сами носители — данные игры, а личное (избранное, заметки) лежит в
 * `atlas_carrier_watch` и отдаётся отдельным маршрутом только владельцу.
 *
 * `scope=favorites` требует сессии: без неё «избранного» не существует.
 * Гость хранит список в браузере и передаёт его в `scope=all` — порядок
 * подсказывает сервер, но чужих записей он не видит.
 */
export async function GET(request: Request) {
  const t = await apiTranslate();
  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q') ?? '';
  const scope: CarrierWatchScope = searchParams.get('scope') === 'favorites' ? 'favorites' : 'all';
  const limitRaw = Number(searchParams.get('limit'));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0
    ? Math.min(CARRIER_SEARCH_MAX, Math.floor(limitRaw))
    : undefined;

  // Сессия нужна только для `relation` (свой/эскадрилья) и для избранного.
  let supabase: Awaited<ReturnType<typeof createClient>> | null = null;
  let viewerId: string | null = null;
  try {
    supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    viewerId = user?.id ?? null;
  } catch {
    viewerId = null;
  }

  if (scope === 'favorites' && !viewerId) {
    return NextResponse.json({ error: t('api.unauthorized') }, { status: 401 });
  }

  // Избранное зрителя — для порядка выдачи (избранные и записи с заметкой
  // идут первыми) и для `scope=favorites`. Без сессии список пуст: у гостя он
  // в localStorage, и клиент присылает его сам, но только на сортировку.
  let watches: CarrierWatch[] = [];
  if (supabase && viewerId) {
    const { data } = await supabase
      .from('atlas_carrier_watch')
      .select('id, carrier_id, callsign, name, system_name, favorite, note, updated_at')
      .eq('user_id', viewerId)
      .order('updated_at', { ascending: false })
      .limit(500);
    watches = (data ?? []).map((row) => watchFromRow(row as Record<string, unknown>));
  }

  try {
    const svc = createServiceClient();
    const result = await searchMapCarriers(svc, viewerId, { query, scope, limit, watches });
    return NextResponse.json({
      ...result,
      viewer: { signedIn: Boolean(viewerId) },
      generatedAt: new Date().toISOString(),
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[atlas/carriers]', error instanceof Error ? error.message : error);
    return NextResponse.json({ error: t('api.carriersLoadFailed') }, { status: 503 });
  }
}
