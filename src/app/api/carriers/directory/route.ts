import { NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabaseServer';
import { apiTranslate } from '@/lib/i18n/apiT';
import { loadCarrierCatalogPage } from '@/lib/carrierCatalogStore';

export const dynamic = 'force-dynamic';

/**
 * GET /api/carriers/directory?q=&origin=&scope=&jump=&sort=&page=&pageSize=
 *
 * Каталог авианосцев для страницы `/carriers`: все известные носители
 * (учёт сайта + реестр EDDN) одной страницей таблицы.
 *
 * Ответ открыт всем: это данные игры, ровно то, что пилот видит в навигационной
 * панели и в EDDN. Личного здесь нет — избранное пилота живёт в
 * `atlas_carrier_watch` и читается отдельным маршрутом. `scope=mine` (свои
 * носители и эскадрильи) без сессии честно не находит ничего.
 *
 * `page` за концом списка не ошибка: сервер отдаёт последнюю существующую
 * страницу и говорит, какая она на самом деле. Иначе сужение фильтра
 * выбрасывало бы пилота в пустую таблицу.
 */
export async function GET(request: Request) {
  const t = await apiTranslate();
  const { searchParams } = new URL(request.url);

  // Сессия нужна только для отношения (`own`/`squadron`) и фильтра «мои».
  let viewerId: string | null = null;
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    viewerId = user?.id ?? null;
  } catch {
    viewerId = null;
  }

  try {
    const svc = createServiceClient();
    const page = await loadCarrierCatalogPage(svc, viewerId, {
      q: searchParams.get('q'),
      origin: searchParams.get('origin'),
      scope: searchParams.get('scope'),
      jump: searchParams.get('jump'),
      sort: searchParams.get('sort'),
      page: searchParams.get('page'),
      pageSize: searchParams.get('pageSize'),
    });
    return NextResponse.json({
      ok: true,
      carriers: page.rows,
      total: page.total,
      page: page.page,
      pageSize: page.pageSize,
      pages: page.pages,
      viewer: { signedIn: Boolean(viewerId) },
      generatedAt: new Date().toISOString(),
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[carriers/directory]', error instanceof Error ? error.message : error);
    return NextResponse.json(
      { error: t('api.carriersLoadFailed') },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
