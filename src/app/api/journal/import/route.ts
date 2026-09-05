import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabaseServer';
import { authFromRequest } from '@/lib/supabaseServer';
import type { ParsedColonisationDepot, ParsedColonisationContribution } from '@/lib/journalParser';

export const dynamic = 'force-dynamic';

interface ImportBody {
  filename?: string;
  fileHash?: string;
  depotEvents: ParsedColonisationDepot[];
  contributionEvents: ParsedColonisationContribution[];
}

export async function POST(req: Request) {
  try {
    const { user } = await authFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body: ImportBody = await req.json();
    const svc = createServiceClient();

    // Create journal import record
    const { data: importRecord, error: importError } = await svc
      .from('journal_imports')
      .insert({
        user_id: user.id,
        filename: body.filename || null,
        file_hash: body.fileHash || 'manual',
        events_count: (body.depotEvents?.length || 0) + (body.contributionEvents?.length || 0),
        colonisation_events: body.depotEvents?.length || 0,
        status: 'processing',
      })
      .select()
      .single();

    if (importError) {
      return NextResponse.json({ error: importError.message }, { status: 500 });
    }

    const importId = importRecord.id;
    let insertedDepots = 0;
    let insertedContributions = 0;
    let snapshotCount = 0;

    // Insert depot events
    if (body.depotEvents && body.depotEvents.length > 0) {
      const depotRows = body.depotEvents.map((ev) => ({
        user_id: user.id,
        journal_import_id: importId,
        event_timestamp: ev.timestamp,
        system_name: ev.systemName,
        market_id: ev.marketId,
        construction_name: ev.constructionName,
        construction_id: ev.constructionId,
        construction_progress: ev.constructionProgress,
        resources_total: ev.resourcesRequired,
        raw_event: ev as unknown as Record<string, unknown>,
      }));

      const { data: depots, error: depotError } = await svc
        .from('colonisation_events')
        .insert(depotRows)
        .select();

      if (!depotError && depots) {
        insertedDepots = depots.length;

        // Create snapshots for unique system+construction combinations (latest only)
        const latestByConstruction = new Map<string, ParsedColonisationDepot>();
        for (const ev of body.depotEvents) {
          const key = `${ev.systemName}:${ev.constructionId}`;
          const existing = latestByConstruction.get(key);
          if (!existing || new Date(ev.timestamp) > new Date(existing.timestamp)) {
            latestByConstruction.set(key, ev);
          }
        }

        const snapshots = Array.from(latestByConstruction.values()).map((ev) => ({
          system_name: ev.systemName,
          construction_id: ev.constructionId,
          construction_name: ev.constructionName,
          progress: ev.constructionProgress,
          resources_total: ev.resourcesRequired,
          snapshot_at: ev.timestamp,
          source: 'journal',
        }));

        if (snapshots.length > 0) {
          const { error: snapError } = await svc
            .from('construction_depot_snapshots')
            .insert(snapshots);
          if (!snapError) snapshotCount = snapshots.length;
        }
      }
    }

    // Insert contribution events (as depot events with raw_event)
    if (body.contributionEvents && body.contributionEvents.length > 0) {
      const contribRows = body.contributionEvents.map((ev) => ({
        user_id: user.id,
        journal_import_id: importId,
        event_timestamp: ev.timestamp,
        system_name: ev.systemName,
        market_id: ev.marketId,
        construction_name: null,
        construction_id: null,
        construction_progress: null,
        resources_total: [{
          name: ev.commodity,
          nameLocalised: ev.commodityLocalised,
          requiredAmount: 0,
          providedAmount: ev.amount,
          payment: 0,
        }],
        raw_event: ev as unknown as Record<string, unknown>,
      }));

      const { data: contribs, error: contribError } = await svc
        .from('colonisation_events')
        .insert(contribRows)
        .select();

      if (!contribError && contribs) {
        insertedContributions = contribs.length;
      }
    }

    // Update import status
    await svc
      .from('journal_imports')
      .update({ status: 'completed' })
      .eq('id', importId);

    return NextResponse.json({
      importId,
      insertedDepots,
      insertedContributions,
      snapshotCount,
      totalEvents: insertedDepots + insertedContributions,
    });
  } catch (err: any) {
    console.error('[Journal Import] Error:', err);
    return NextResponse.json({ error: err.message || 'Internal error' }, { status: 500 });
  }
}
