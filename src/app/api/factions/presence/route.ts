import { NextResponse } from 'next/server';
import { BGS_MAX_SELECTED } from '@/lib/bgs';
import { createServiceClient } from '@/lib/supabaseServer';
import { readBgsPresence } from '@/lib/bgsStore';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/factions/presence?ids=12,345
 *
 * Где присутствуют выбранные фракции (до 12 за раз): для каждой — карточка
 * фракции и её системы с влиянием, состоянием, флагом «у власти» и временем
 * наблюдения. Кортеж системы описан в `bgs_faction_presence_rows`
 * (миграция 20261019120000_minor_factions.sql), разбор — `decodeFactionPresence`.
 */
export async function GET(request: Request) {
  const raw = new URL(request.url).searchParams.get('ids') ?? '';
  const ids = Array.from(new Set(
    raw.split(',').map((part) => Number(part.trim())).filter((id) => Number.isSafeInteger(id) && id > 0),
  )).slice(0, BGS_MAX_SELECTED);
  if (ids.length === 0) {
    return NextResponse.json({ error: 'Нужен параметр ids: идентификаторы фракций через запятую' }, { status: 400 });
  }
  try {
    const factions = await readBgsPresence(createServiceClient(), ids);
    return NextResponse.json(
      { factions },
      { headers: { 'Cache-Control': 'public, max-age=60, stale-while-revalidate=300' } },
    );
  } catch (error) {
    console.error('[factions/presence]', error instanceof Error ? error.message : error);
    return NextResponse.json({ error: 'Не удалось загрузить системы фракций' }, { status: 503 });
  }
}
