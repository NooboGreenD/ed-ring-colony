import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { authFromRequest } from '@/lib/supabaseServer';
import { createHash } from 'crypto';

export const dynamic = 'force-dynamic';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const cmdr = (searchParams.get('cmdr') || searchParams.get('name') || '').trim();

    if (!cmdr) {
      return NextResponse.json({ error: 'cmdr parameter is required' }, { status: 400 });
    }

    // 1. Поиск в pilot_stats
    const { data: pilotStats } = await supabaseAdmin
      .from('pilot_stats')
      .select('*')
      .ilike('cmdr_name', cmdr)
      .maybeSingle();

    // 2. Поиск в capi_profiles
    const { data: capiProfile } = await supabaseAdmin
      .from('capi_profiles')
      .select('*')
      .ilike('cmdr_name', cmdr)
      .maybeSingle();

    // 3. Агрегация открытий из system_scans
    const { count: firstDiscoveriesCount } = await supabaseAdmin
      .from('system_scans')
      .select('id', { count: 'exact', head: true })
      .ilike('first_discovered_by', cmdr);

    const { count: firstMappedCount } = await supabaseAdmin
      .from('system_scans')
      .select('id', { count: 'exact', head: true })
      .ilike('first_mapped_by', cmdr);

    const merged = {
      cmdr_name: cmdr,
      credits: pilotStats?.credits ?? capiProfile?.credits ?? 0,
      arx: pilotStats?.arx ?? capiProfile?.arx ?? 0,
      mercenary_coins: pilotStats?.mercenary_coins ?? capiProfile?.mercenary_coins ?? 0,
      mercenary_rank: pilotStats?.mercenary_rank ?? capiProfile?.mercenary_rank ?? 0,
      exobiologist_rank: pilotStats?.exobiologist_rank ?? capiProfile?.exobiologist_rank ?? 0,
      combat_rank: pilotStats?.combat_rank ?? capiProfile?.combat_rank ?? 0,
      trade_rank: pilotStats?.trade_rank ?? capiProfile?.trade_rank ?? 0,
      explore_rank: pilotStats?.explore_rank ?? capiProfile?.explore_rank ?? 0,
      empire_rank: pilotStats?.empire_rank ?? capiProfile?.empire_rank ?? 0,
      federation_rank: pilotStats?.federation_rank ?? capiProfile?.federation_rank ?? 0,
      current_ship: pilotStats?.current_ship || capiProfile?.current_ship || null,
      current_system: pilotStats?.current_system || capiProfile?.current_system || null,
      current_station: pilotStats?.current_station || capiProfile?.current_station || null,
      first_discoveries_count: Math.max(
        pilotStats?.first_discoveries_count ?? 0,
        capiProfile?.first_discoveries_count ?? 0,
        firstDiscoveriesCount ?? 0,
      ),
      first_mapped_count: Math.max(
        pilotStats?.first_mapped_count ?? 0,
        capiProfile?.first_mapped_count ?? 0,
        firstMappedCount ?? 0,
      ),
      first_footfalls_count: Math.max(
        pilotStats?.first_footfalls_count ?? 0,
        capiProfile?.first_footfalls_count ?? 0,
      ),
      bio_samples_count: Math.max(
        pilotStats?.bio_samples_count ?? 0,
        capiProfile?.bio_samples_count ?? 0,
      ),
      bio_species_count: Math.max(
        pilotStats?.bio_species_count ?? 0,
        capiProfile?.bio_species_count ?? 0,
      ),
      bio_value_cr: Math.max(
        pilotStats?.bio_value_cr ?? 0,
        capiProfile?.bio_value_cr ?? 0,
      ),
      exploration_stats: {
        ...(capiProfile?.exploration_stats || {}),
        ...(pilotStats?.exploration_stats || {}),
      },
      last_updated: pilotStats?.last_updated || capiProfile?.last_updated || null,
    };

    return NextResponse.json({ ok: true, stats: merged });
  } catch (err: any) {
    console.error('[cmdr/stats] GET error:', err);
    return NextResponse.json({ error: err.message || 'Internal server error' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    let body: any = {};
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    let userId: string | null = null;
    let cmdrName = (body.cmdr || body.cmdr_name || '').trim();

    // Аутентификация: через токен helper'а или веб-сессию
    if (body.token) {
      const tokenHash = hashToken(String(body.token).trim());
      const { data: apiToken } = await supabaseAdmin
        .from('api_tokens')
        .select('user_id, is_revoked')
        .eq('token_hash', tokenHash)
        .maybeSingle();

      if (apiToken && !apiToken.is_revoked) {
        userId = apiToken.user_id;
      }
    }

    if (!userId) {
      const { user } = await authFromRequest(req);
      if (user) userId = user.id;
    }

    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized: valid API token or session required' }, { status: 401 });
    }

    // Получаем имя командира из профиля, если не передано
    if (!cmdrName) {
      const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('cmdr_name')
        .eq('id', userId)
        .maybeSingle();
      cmdrName = profile?.cmdr_name || '';
    }

    const statsPayload: Record<string, any> = {
      user_id: userId,
      cmdr_name: cmdrName || null,
      last_updated: new Date().toISOString(),
    };

    if (body.credits != null) statsPayload.credits = Number(body.credits) || 0;
    if (body.arx != null) statsPayload.arx = Number(body.arx) || 0;
    if (body.mercenary_coins != null) statsPayload.mercenary_coins = Number(body.mercenary_coins) || 0;
    if (body.mercenary_rank != null) statsPayload.mercenary_rank = Number(body.mercenary_rank) || 0;
    if (body.exobiologist_rank != null) statsPayload.exobiologist_rank = Number(body.exobiologist_rank) || 0;
    // Боевые/торговые/исследовательские ранги и фракции: приходят из CAPI
    // (авторизация PKCE в Colonial Helper), поэтому раньше в pilot_stats не
    // попадали вовсе, хотя досье их показывает.
    if (body.combat_rank != null) statsPayload.combat_rank = Number(body.combat_rank) || 0;
    if (body.trade_rank != null) statsPayload.trade_rank = Number(body.trade_rank) || 0;
    if (body.explore_rank != null) statsPayload.explore_rank = Number(body.explore_rank) || 0;
    if (body.empire_rank != null) statsPayload.empire_rank = Number(body.empire_rank) || 0;
    if (body.federation_rank != null) statsPayload.federation_rank = Number(body.federation_rank) || 0;
    if (typeof body.current_ship === 'string') statsPayload.current_ship = body.current_ship.slice(0, 200);
    if (typeof body.current_system === 'string') statsPayload.current_system = body.current_system.slice(0, 200);
    if (typeof body.current_station === 'string') statsPayload.current_station = body.current_station.slice(0, 200);
    if (body.first_discoveries_count != null) statsPayload.first_discoveries_count = Number(body.first_discoveries_count) || 0;
    if (body.first_mapped_count != null) statsPayload.first_mapped_count = Number(body.first_mapped_count) || 0;
    if (body.first_footfalls_count != null) statsPayload.first_footfalls_count = Number(body.first_footfalls_count) || 0;
    if (body.bio_samples_count != null) statsPayload.bio_samples_count = Number(body.bio_samples_count) || 0;
    if (body.bio_species_count != null) statsPayload.bio_species_count = Number(body.bio_species_count) || 0;
    if (body.bio_value_cr != null) statsPayload.bio_value_cr = Number(body.bio_value_cr) || 0;
    if (body.exploration_stats != null && typeof body.exploration_stats === 'object') {
      statsPayload.exploration_stats = body.exploration_stats;
    }

    // 1. Запись в pilot_stats
    await supabaseAdmin
      .from('pilot_stats')
      .upsert(statsPayload, { onConflict: 'user_id' });

    // 2. Также обновляем capi_profiles, если запись есть
    await supabaseAdmin
      .from('capi_profiles')
      .update(statsPayload)
      .eq('user_id', userId);

    return NextResponse.json({ ok: true, stats: statsPayload });
  } catch (err: any) {
    console.error('[cmdr/stats] POST error:', err);
    return NextResponse.json({ error: err.message || 'Internal server error' }, { status: 500 });
  }
}
