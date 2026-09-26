import { NextResponse } from 'next/server';
import { authFromRequest, createServiceClient } from '@/lib/supabaseServer';
import { capiSession } from '@/lib/capi/session';
import { parseColonisationEvents } from '@/lib/journalParser';
import {
  depotEventRow,
  latestDepotEvents,
  persistColonisationEvents,
  type ColonisationEventRow,
} from '@/lib/colonisationEvents';
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
    // Одна сессия на весь синк: токен обновляется заранее по expires_at и
    // повторно при 401/403/422 на ЛЮБОМ из вызовов ниже, а не только на первом.
    const session = await capiSession(svc, user.id, tokenRow);
    const profile = await session.run((client) => client.getProfile());

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

    await syncMemberLocation(user.id, session.token);

    const journal = await session.run((client) => client.getJournal());
    const events = parseColonisationEvents(
      journal.events.map((e) => JSON.stringify(e)).join('\n')
    );

    // События CAPI пишутся тем же путём, что и журнальные: upsert по
    // `source_hash`. Раньше здесь был голый insert() без проверки ошибки —
    // повторный синк того же окна падал на первом же конфликте и молча терял
    // всю пачку, а события без системы (CAPI не всегда отдаёт StarSystem)
    // оседали строками с пустым system_name.
    const rows = events.depotEvents
      .map((ev) => depotEventRow(user.id, ev))
      .filter((row): row is ColonisationEventRow => row !== null);
    const write = await persistColonisationEvents(svc, rows);
    for (const warning of write.warnings) console.warn('[CAPI Sync]', warning);
    const inserted = write.inserted;

    // Прогресс проекта — по последнему состоянию каждой стройки: окно CAPI
    // на каждом синке содержит одни и те же события.
    for (const ev of latestDepotEvents(events.depotEvents)) {
      await updateProjectProgress(ev.systemName, ev.constructionProgress, ev.resourcesRequired, 'capi');
    }

    await svc.from('capi_tokens').update({
      last_synced_at: new Date().toISOString(),
      cmdr_name: cmdrName,
    }).eq('user_id', user.id);

    return NextResponse.json({
      synced: true,
      eventsImported: inserted,
      eventsDuplicate: write.duplicates,
      eventsSkipped: events.depotEvents.length - rows.length,
      cmdrName,
    });
  } catch (err: any) {
    console.error('[CAPI Sync]', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
