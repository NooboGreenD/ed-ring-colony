import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabaseServer';
import { findSystemByName } from '@/lib/galaxySystemsDb';
import { resolveCommodity } from '@/lib/commodities';
import { stationSearchSchema, serviceLabel, type StationSearchResult } from '@/lib/stationSearch';
import { stationQueryAliases, stationItemLabel } from '@/lib/stationSearchCatalog';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request: Request) {
  const parsed = stationSearchSchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return NextResponse.json({ error: 'Укажите запрос от 2 до 120 символов и корректные фильтры.' }, { status: 400 });
  const query = parsed.data;
  try {
    const svc = createServiceClient();
    let center: { x: number; y: number; z: number } | null = null;
    if (query.reference) {
      const name = query.reference.toLowerCase();
      const { data, error } = await svc.from('commerce_systems').select('x,y,z').eq('name_lc', name).maybeSingle();
      if (error) throw new Error(error.message);
      if (data && [data.x, data.y, data.z].every((v) => v != null && Number.isFinite(Number(v)))) {
        center = { x: Number(data.x), y: Number(data.y), z: Number(data.z) };
      } else {
        const row = await findSystemByName(query.reference);
        if (row) center = { x: row.x, y: row.y, z: row.z };
      }
      if (!center) return NextResponse.json({ error: 'Координаты опорной системы не найдены в БД. Выберите известную систему или ищите без ограничения расстояния.' }, { status: 404 });
    }
    const text = query.kind === 'market' ? resolveCommodity(query.q) : query.q;
    const aliases = stationQueryAliases(query.kind, text);
    const { data, error } = await svc.rpc('search_station_catalog', {
      search_kind: query.kind, needles: aliases, cx: center?.x ?? null, cy: center?.y ?? null, cz: center?.z ?? null,
      radius_ly: query.radius, minimum_stock: query.min_stock, filter_class: query.module_class ?? null,
      filter_rating: query.rating ?? null, fresh_only: query.fresh === 'true', sort_by: query.sort,
      page_offset: query.page * 50, row_limit: 50,
    });
    if (error) throw new Error(error.message);
    const rows = (data || []) as unknown as StationSearchResult[];
    return NextResponse.json({
      kind: query.kind, query: text, reference: query.reference || null, page: query.page, has_more: rows.length > 50,
      results: rows.slice(0, 50).map((row) => ({ ...row, item_display: query.kind === 'services' ? serviceLabel(row.item.name) : stationItemLabel(query.kind, row.item) })),
      source: 'project-db',
    });
  } catch (error) {
    console.error('[Station Search]', error);
    return NextResponse.json({ error: 'Поиск станций временно недоступен. Проверьте подключение БД и применение миграций справочника станций.' }, { status: 503 });
  }
}
