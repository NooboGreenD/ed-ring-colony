import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createHash } from 'crypto';
import { persistImportedDeliveries } from '@/lib/deliveryImport';

// Current browser/desktop clients send 100 rows. Keep a 500-row allowance for
// older helpers, while preventing an unbounded legacy payload from turning one
// serverless request into many sequential database batches.
const MAX_DELIVERIES_PER_REQUEST = 500;
const MAX_CONSTRUCTION_EVENTS_PER_REQUEST = 100;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function getAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Server delivery-import credentials are not configured');
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    const svc = getAdminClient();

    let body: Record<string, unknown> = {};
    try {
      const parsed = await req.json();
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>;
      }
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const token = typeof body.token === 'string' ? body.token.trim() : '';
    const deliveries = Array.isArray(body.deliveries) ? body.deliveries : [];
    const cmdr = typeof body.cmdr === 'string' ? body.cmdr.trim() : '';

    if (!token) {
      return NextResponse.json({ error: 'API token required' }, { status: 401 });
    }
    if (deliveries.length > MAX_DELIVERIES_PER_REQUEST) {
      return NextResponse.json(
        { error: `Too many deliveries in one request (max ${MAX_DELIVERIES_PER_REQUEST})` },
        { status: 413 },
      );
    }

    // Валидируем токен
    const tokenHash = hashToken(token);
    const { data: apiToken, error: tokenError } = await svc
      .from('api_tokens')
      .select('user_id, is_revoked')
      .eq('token_hash', tokenHash)
      .maybeSingle();

    if (tokenError || !apiToken || apiToken.is_revoked) {
      return NextResponse.json({ error: 'Invalid or revoked token' }, { status: 401 });
    }

    const userId = apiToken.user_id;

    // This timestamp is informative only; an unavailable update must never
    // make an otherwise valid Journal batch fail.
    void svc.from('api_tokens').update({ last_used_at: new Date().toISOString() }).eq('token_hash', tokenHash);

    // A Journal may contain the commander's original in-game name. It should
    // initialise an empty legacy profile only, never overwrite a saved nick.
    if (cmdr) {
      const { data: profile, error: profileError } = await svc
        .from('profiles')
        .select('cmdr_name')
        .eq('id', userId)
        .maybeSingle();
      if (profileError) {
        console.warn('[logs/upload] Could not inspect profile nickname:', profileError.message);
      } else if (!profile?.cmdr_name) {
        const { error: updateError } = await svc
          .from('profiles')
          .update({ cmdr_name: cmdr.slice(0, 250) })
          .eq('id', userId);
        if (updateError) console.warn('[logs/upload] Could not initialise profile nickname:', updateError.message);
      }
    }

    const outcome = await persistImportedDeliveries(svc, userId, deliveries);

    // Journal snapshots describe the shared construction state, not the
    // commander's personal delivery total. Keep them in the project-history
    // tables so graphs and Raven/project views can use the same source.
    const constructionEvents = Array.isArray(body.construction_events) ? body.construction_events : [];
    if (constructionEvents.length > MAX_CONSTRUCTION_EVENTS_PER_REQUEST) {
      return NextResponse.json(
        { error: `Too many construction events in one request (max ${MAX_CONSTRUCTION_EVENTS_PER_REQUEST})` },
        { status: 413 },
      );
    }
    let constructionInserted = 0;
    let snapshotInserted = 0;
    if (constructionEvents.length > 0) {
      const eventRows = constructionEvents
        .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
        .map((event) => ({
          user_id: userId,
          event_timestamp: typeof event.timestamp === 'string' ? event.timestamp : new Date().toISOString(),
          system_name: String(event.system_name ?? '').trim().slice(0, 250),
          market_id: event.market_id == null ? null : Number(event.market_id),
          construction_name: event.construction_name == null ? null : String(event.construction_name).slice(0, 500),
          construction_id: event.construction_id == null ? null : Number(event.construction_id),
          construction_progress: event.construction_progress == null ? null : Number(event.construction_progress),
          resources_total: Array.isArray(event.resources_total) ? event.resources_total : [],
          raw_event: event.raw_event && typeof event.raw_event === 'object' ? event.raw_event : event,
        }))
        .filter((event) => event.system_name && Number.isFinite(new Date(event.event_timestamp).getTime()));

      if (eventRows.length > 0) {
        const { data, error } = await svc
          .from('colonisation_events')
          .upsert(eventRows, {
            onConflict: 'user_id,event_timestamp,system_name,construction_id',
            ignoreDuplicates: true,
          })
          .select('id');
        if (error) throw new Error(`Could not save construction events: ${error.message}`);
        constructionInserted = data?.length ?? 0;

        const snapshots = eventRows.map((event) => ({
          system_name: event.system_name,
          construction_id: event.construction_id,
          construction_name: event.construction_name,
          progress: event.construction_progress,
          resources_total: event.resources_total,
          snapshot_at: event.event_timestamp,
          source: 'journal',
        }));
        const { error: snapshotError } = await svc
          .from('construction_depot_snapshots')
          .insert(snapshots);
        if (snapshotError) throw new Error(`Could not save construction snapshots: ${snapshotError.message}`);
        snapshotInserted = snapshots.length;
      }
    }

    return NextResponse.json({ ...outcome, constructionInserted, snapshotInserted });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not import deliveries';
    console.error('[logs/upload] Failed:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
