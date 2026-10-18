import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabaseServer';
import { searchBgsFactions } from '@/lib/bgsStore';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/factions/search?q=mother&limit=20&player=1
 *
 * Поиск минорных фракций по имени для вкладки «Фракции»: сначала точное
 * совпадение, затем начало имени, затем вхождение; внутри — по числу систем.
 * Пустой `q` — самые распространённые фракции; `player=1` — только фракции
 * игроков (PMF). Ответ: `{ results: [{ id, name, allegiance, government,
 * is_player, systems, controlled }] }`.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const query = (params.get('q') ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const limit = Math.max(1, Math.min(50, Number(params.get('limit')) || 20));
  const player = params.get('player') === '1';
  try {
    const results = await searchBgsFactions(createServiceClient(), query, { limit, player });
    return NextResponse.json(
      { query, results },
      { headers: { 'Cache-Control': 'public, max-age=60, stale-while-revalidate=300' } },
    );
  } catch (error) {
    console.error('[factions/search]', error instanceof Error ? error.message : error);
    return NextResponse.json({ error: 'Поиск фракций недоступен' }, { status: 503 });
  }
}
