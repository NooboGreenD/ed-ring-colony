import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabaseServer';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { atlasSearchSchema } from '@/lib/zodSchemas';
import { checkRateLimit } from '@/lib/rateLimit';
import { catalogIsComplete, getGalaxyStats } from '@/lib/galaxySystemsDb';
import {
  resolveReferenceSystem,
  runWorldSearch,
  writeSearchProgress,
  type WorldSearchProgress,
} from '@/lib/atlasWorldSearch';
import { saveCachedSystems } from '@/lib/atlasSystemCache';
import type { AtlasSearchParams } from '@/types/atlas';

/**
 * Поиск миров Atlas.
 *
 * POST создаёт сессию и запускает обработку; GET отдаёт состояние сессии вместе
 * с живым прогрессом (`session.progress`) — по нему карта рисует куб поиска,
 * опорную точку и найденные объекты прямо во время работы поиска.
 */

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const ip = req.headers.get('x-forwarded-for') || 'unknown';
  if (!checkRateLimit(ip, 5)) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
  }

  const body = await req.json().catch(() => ({}));
  const parse = atlasSearchSchema.safeParse(body);
  if (!parse.success) {
    return NextResponse.json({ error: 'Invalid parameters', details: parse.error.flatten() }, { status: 400 });
  }

  const params = parse.data;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  // Каталог Spansh уже в БД: сначала смотрим в него, затем в кэш, и только
  // потом идём во внешние API.
  const reference = await resolveReferenceSystem(params.reference_system);
  if (!reference) {
    return NextResponse.json({ error: 'Reference system not found' }, { status: 404 });
  }

  const refCoords = { x: reference.x, y: reference.y, z: reference.z };
  let catalogReady = false;
  try {
    catalogReady = catalogIsComplete(await getGalaxyStats());
  } catch {
    catalogReady = false;
  }

  const { data: session, error: sessionError } = await supabaseAdmin
    .from('atlas_searches')
    .insert({
      reference_system: params.reference_system,
      reference_x: refCoords.x,
      reference_y: refCoords.y,
      reference_z: refCoords.z,
      cube_size_ly: params.cube_size_ly,
      world_types: params.world_types,
      extra_filters: {
        require_landable: params.require_landable,
        min_estimated_value: params.min_estimated_value,
        max_distance_to_arrival: params.max_distance_to_arrival,
      },
      created_by: user?.id || null,
      status: 'pending',
      progress: {
        stage: 'coords',
        percent: 2,
        message: `Опорная система найдена (${reference.source === 'catalog' ? 'каталог Spansh' : reference.source === 'cache' ? 'кэш Atlas' : reference.source})`,
        found: 0,
        batch: [],
      } satisfies WorldSearchProgress,
    })
    .select()
    .single();

  if (sessionError || !session) {
    return NextResponse.json({ error: sessionError?.message || 'Failed to create session' }, { status: 500 });
  }

  // Опорную систему тоже кладём в кэш проекта.
  void saveCachedSystems([{ name: params.reference_system, ...refCoords, source: reference.source }]).catch(() => 0);

  processSearchAsync(session.id, params as AtlasSearchParams, refCoords, params.reference_system, catalogReady).catch((error) => {
    console.error('[Atlas Search] фоновая обработка упала:', error);
  });

  return NextResponse.json({
    session_id: session.id,
    status: 'pending',
    catalog_ready: catalogReady,
    reference: { ...refCoords, source: reference.source },
    message: `Поиск запущен. Опрос: GET /api/atlas/search?session_id=${session.id}`,
  });
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const sessionId = searchParams.get('session_id');
  if (!sessionId) {
    return NextResponse.json({ error: 'session_id required' }, { status: 400 });
  }

  const supabase = await createClient();
  const { data: session } = await supabase
    .from('atlas_searches')
    .select('*')
    .eq('id', sessionId)
    .single();

  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 });

  let candidates: any[] = [];
  if (session.status === 'completed') {
    const { data } = await supabase
      .from('atlas_candidates')
      .select('*')
      .eq('search_id', sessionId)
      .order('distance_from_ref', { ascending: true })
      .limit(500);
    candidates = data || [];
  }

  return NextResponse.json({
    session,
    // Живой прогресс: этап, процент и последние найденные точки для карты.
    progress: (session.progress || {}) as WorldSearchProgress,
    candidates: candidates.slice(0, 200),
    total_candidates: session.total_found || candidates.length,
  });
}

async function processSearchAsync(
  sessionId: string,
  params: AtlasSearchParams,
  refCoords: { x: number; y: number; z: number },
  refName: string,
  catalogReady: boolean,
) {
  try {
    const result = await runWorldSearch({ sessionId, params, refCoords, refName, catalogReady });
    await supabaseAdmin
      .from('atlas_searches')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        total_found: result.candidates,
      })
      .eq('id', sessionId);
  } catch (error: any) {
    console.error('[Atlas Search] ошибка поиска:', error);
    await supabaseAdmin
      .from('atlas_searches')
      .update({ status: 'failed', error_message: error?.message || 'Ошибка поиска' })
      .eq('id', sessionId);
    await writeSearchProgress(sessionId, {
      stage: 'failed',
      percent: 0,
      message: error?.message || 'Ошибка поиска',
      found: 0,
      batch: [],
    });
  }
}
