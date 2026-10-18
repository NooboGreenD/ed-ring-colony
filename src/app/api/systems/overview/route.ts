import { NextResponse } from 'next/server';
import { loadIsAdmin } from '@/lib/architect/projectStore';
import { authFromRequest, createServiceClient } from '@/lib/supabaseServer';
import { loadSystemOverview } from '@/lib/systemOverview';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const NO_STORE = { 'Cache-Control': 'private, no-store' };

/**
 * GET /api/systems/overview?name=<система>[&id64=<адрес>] — карточка системы:
 * всё, что проект знает о системе, одним ответом (`src/lib/systemOverview.ts`).
 *
 * Открыт всем: гость видит публичное (каталог, стройку, проекты эскадрилий,
 * станции, фракции, PowerPlay, публичные авианосцы, цели, суммы поставок),
 * вошедший пилот — ещё свои планы, свои «Проекты систем» и носители, которые
 * ему видны на карте. Ответ зависит от зрителя, поэтому не кэшируется.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const name = (url.searchParams.get('name') ?? '').slice(0, 200);
  const id64 = (url.searchParams.get('id64') ?? '').slice(0, 24);
  if (!name.trim() && !id64.trim()) {
    return NextResponse.json({ error: 'name или id64 обязателен' }, { status: 400, headers: NO_STORE });
  }

  let userId: string | null = null;
  try {
    const { user } = await authFromRequest(request);
    userId = user?.id ?? null;
  } catch {
    userId = null;
  }

  try {
    const svc = createServiceClient();
    const isAdmin = userId ? await loadIsAdmin(svc, userId) : false;
    const overview = await loadSystemOverview(svc, { name, id64 }, { userId, isAdmin });
    if (!overview) return NextResponse.json({ error: 'name или id64 обязателен' }, { status: 400, headers: NO_STORE });
    return NextResponse.json(overview, { headers: NO_STORE });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[systems/overview]', message);
    const missing = /system_overview_sources|schema cache|does not exist/i.test(message);
    return NextResponse.json(
      { error: missing ? 'Карточка системы ждёт миграцию 20261020120000_unified_system_data.sql' : 'Не удалось собрать карточку системы' },
      { status: 503, headers: NO_STORE },
    );
  }
}
