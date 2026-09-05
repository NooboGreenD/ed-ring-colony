import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabaseServer';
import { CapiClient } from '@/lib/capi/client';
import { refreshAccessToken } from '@/lib/capi/oauth';
import { parseColonisationEvents } from '@/lib/journalParser';
import { updateProjectProgress } from '@/lib/projects/autoProgress';
import { syncMemberLocation } from '@/lib/capi/locationSync';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const secret = req.headers.get('x-cron-secret') || new URL(req.url).searchParams.get('secret');
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const svc = createServiceClient();
  const { data: tokens } = await svc
    .from('capi_tokens')
    .select('*')
    .eq('is_active', true)
    .order('last_synced_at', { ascending: true })
    .limit(10);

  if (!tokens || tokens.length === 0) {
    return NextResponse.json({ synced: 0 });
  }

  let synced = 0;
  for (const token of tokens) {
    try {
      let accessToken = token.access_token;
      const client = new CapiClient(accessToken);
      let profile;

      try {
        profile = await client.getProfile();
      } catch (e: any) {
        if (e.message === 'UNAUTHORIZED') {
          const refreshed = await refreshAccessToken(token.refresh_token);
          accessToken = refreshed.access_token;
          await svc.from('capi_tokens').update({
            access_token: refreshed.access_token,
            refresh_token: refreshed.refresh_token,
            expires_at: new Date(Date.now() + refreshed.expires_in * 1000).toISOString(),
          }).eq('id', token.id);
          profile = await new CapiClient(accessToken).getProfile();
        } else {
          throw e;
        }
      }

      await svc.from('capi_profiles').upsert({
        user_id: token.user_id,
        cmdr_name: profile.commander?.name,
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

      await syncMemberLocation(token.user_id, accessToken);

      const journal = await new CapiClient(accessToken).getJournal();
      const events = parseColonisationEvents(
        journal.events.map((e: any) => JSON.stringify(e)).join('\n')
      );

      for (const ev of events.depotEvents) {
        await updateProjectProgress(ev.systemName, ev.constructionProgress, ev.resourcesRequired, 'capi');
      }

      await svc.from('capi_tokens').update({
        last_synced_at: new Date().toISOString(),
      }).eq('id', token.id);

      synced++;
    } catch (err) {
      console.error(`[Cron CAPI] User ${token.user_id}:`, err);
    }
  }

  return NextResponse.json({ synced, total: tokens.length });
}
