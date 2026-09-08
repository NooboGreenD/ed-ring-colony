import { NextResponse } from 'next/server';
import { authFromRequest, createServiceClient } from '@/lib/supabaseServer';
import { CapiClient } from '@/lib/capi/client';
import { refreshAccessToken } from '@/lib/capi/oauth';
import { parseColonisationEvents } from '@/lib/journalParser';
import { updateProjectProgress } from '@/lib/projects/autoProgress';
import { syncMemberLocation } from '@/lib/capi/locationSync';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const { user } = await authFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const svc = createServiceClient();
  const { data: tokenRow } = await svc
    .from('capi_tokens')
    .select('*')
    .eq('user_id', user.id)
    .single();

  if (!tokenRow) {
    return NextResponse.json({ error: 'No CAPI token found' }, { status: 404 });
  }

  try {
    let accessToken = tokenRow.access_token;
    const client = new CapiClient(accessToken);
    let profile;

    try {
      profile = await client.getProfile();
    } catch (e: any) {
      if (e.message === 'UNAUTHORIZED') {
        const refreshed = await refreshAccessToken(tokenRow.refresh_token);
        accessToken = refreshed.access_token;
        await svc.from('capi_tokens').update({
          access_token: refreshed.access_token,
          refresh_token: refreshed.refresh_token,
          expires_at: new Date(Date.now() + refreshed.expires_in * 1000).toISOString(),
        }).eq('user_id', user.id);
        profile = await new CapiClient(accessToken).getProfile();
      } else {
        throw e;
      }
    }

    const cmdrName = profile.commander?.name || tokenRow.cmdr_name;

    await svc.from('capi_profiles').upsert({
      user_id: user.id,
      cmdr_name: cmdrName,
      credits: profile.credits || 0,
      combat_rank: profile.ranks?.combat || 0,
      trade_rank: profile.ranks?.trade || 0,
      explore_rank: profile.ranks?.explore || 0,
      empire_rank: profile.ranks?.empire || 0,
      federation_rank: profile.ranks?.federation || 0,
      current_ship: profile.currentShip || null,
      current_system: profile.currentSystem?.name || null,
      current_station: profile.currentStation?.name || null,
      ships: profile.ships || [],
      last_updated: new Date().toISOString(),
    }, { onConflict: 'user_id' });

    await syncMemberLocation(user.id, accessToken);

    const journal = await new CapiClient(accessToken).getJournal();
    const events = parseColonisationEvents(
      journal.events.map((e) => JSON.stringify(e)).join('\n')
    );

    let inserted = 0;
    if (events.depotEvents.length > 0) {
      const rows = events.depotEvents.map((ev) => ({
        user_id: user.id,
        event_timestamp: ev.timestamp,
        system_name: ev.systemName,
        market_id: ev.marketId,
        construction_name: ev.constructionName,
        construction_id: ev.constructionId,
        construction_progress: ev.constructionProgress,
        resources_total: ev.resourcesRequired,
        raw_event: ev as unknown as Record<string, unknown>,
      }));
      const { data } = await svc.from('colonisation_events').insert(rows).select();
      inserted = data?.length || 0;

      for (const ev of events.depotEvents) {
        await updateProjectProgress(ev.systemName, ev.constructionProgress, ev.resourcesRequired, 'capi');
      }
    }

    await svc.from('capi_tokens').update({
      last_synced_at: new Date().toISOString(),
      cmdr_name: cmdrName,
    }).eq('user_id', user.id);

    return NextResponse.json({ synced: true, eventsImported: inserted, cmdrName });
  } catch (err: any) {
    console.error('[CAPI Sync]', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
