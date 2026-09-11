import { NextResponse } from 'next/server';
import { createServiceClient, authFromRequest } from '@/lib/supabaseServer';
import type { ParsedColonisationDepot, ParsedColonisationContribution } from '@/lib/journalParser';

const JOURNAL_DATABASE_BATCH_SIZE = 100;
const MAX_EVENTS_PER_REQUEST = 500;

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface ImportBody {
  filename?: string;
  fileHash?: string;
  importId?: number;
  totalEvents?: number;
  /** `false` keeps a multi-request import open; absent remains compatible with the old one-shot client. */
  finalize?: boolean;
  depotEvents?: ParsedColonisationDepot[];
  contributionEvents?: ParsedColonisationContribution[];
}

function batches<T>(rows: T[]): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < rows.length; index += JOURNAL_DATABASE_BATCH_SIZE) {
    result.push(rows.slice(index, index + JOURNAL_DATABASE_BATCH_SIZE));
  }
  return result;
}

function asEventArray<T>(value: unknown): T[] {
  return Array.isArray(value)
    ? value.filter((item): item is T => !!item && typeof item === 'object')
    : [];
}

function boundedNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 1_000_000
    ? parsed
    : fallback;
}

async function insertColonisationEvents(
  svc: ReturnType<typeof createServiceClient>,
  rows: Record<string, unknown>[],
): Promise<number> {
  let inserted = 0;
  for (const batch of batches(rows)) {
    const { data, error } = await svc
      .from('colonisation_events')
      .upsert(batch, {
        onConflict: 'user_id,event_timestamp,system_name,construction_id',
        ignoreDuplicates: true,
      })
      .select('id');
    if (error) throw new Error(error.message);
    inserted += data?.length ?? 0;
  }
  return inserted;
}

async function insertSnapshots(
  svc: ReturnType<typeof createServiceClient>,
  rows: Record<string, unknown>[],
): Promise<number> {
  let inserted = 0;
  for (const batch of batches(rows)) {
    // No returning payload is needed for snapshots. Avoid transferring a large
    // JSON response for every Journal status update.
    const { error } = await svc
      .from('construction_depot_snapshots')
      .insert(batch);
    if (error) throw new Error(error.message);
    inserted += batch.length;
  }
  return inserted;
}

export async function POST(req: Request) {
  let svc: ReturnType<typeof createServiceClient> | null = null;
  let importId: number | null = null;

  try {
    const { user } = await authFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const parsed = await req.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const body = parsed as ImportBody;
    const depotEvents = asEventArray<ParsedColonisationDepot>(body.depotEvents);
    const contributionEvents = asEventArray<ParsedColonisationContribution>(body.contributionEvents);
    const requestEventCount = depotEvents.length + contributionEvents.length;
    if (requestEventCount > MAX_EVENTS_PER_REQUEST) {
      return NextResponse.json(
        { error: `Too many Journal events in one request (max ${MAX_EVENTS_PER_REQUEST})` },
        { status: 413 },
      );
    }

    svc = createServiceClient();
    const totalEvents = boundedNumber(body.totalEvents, requestEventCount);
    const requestedImportId = boundedNumber(body.importId, 0);

    if (requestedImportId > 0) {
      const { data: existingImport, error: existingImportError } = await svc
        .from('journal_imports')
        .select('id')
        .eq('id', requestedImportId)
        .eq('user_id', user.id)
        .maybeSingle();
      if (existingImportError) throw new Error(existingImportError.message);
      if (!existingImport) {
        return NextResponse.json({ error: 'Journal import not found' }, { status: 404 });
      }
      importId = existingImport.id;
    } else {
      const filename = typeof body.filename === 'string' ? body.filename.slice(0, 500) : null;
      const fileHash = typeof body.fileHash === 'string' && body.fileHash.trim()
        ? body.fileHash.trim().slice(0, 500)
        : 'manual';
      const { data: importRecord, error: importError } = await svc
        .from('journal_imports')
        .insert({
          user_id: user.id,
          filename,
          file_hash: fileHash,
          events_count: totalEvents,
          colonisation_events: depotEvents.length,
          status: 'processing',
        })
        .select('id')
        .single();
      if (importError || !importRecord) {
        throw new Error(importError?.message || 'Could not create Journal import');
      }
      importId = importRecord.id;
    }

    const depotRows = depotEvents.map((ev) => ({
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
    const insertedDepots = await insertColonisationEvents(svc, depotRows);

    // Keep one snapshot per construction in this request. The browser now
    // sends bounded requests, so a large log no longer forms one huge INSERT.
    const latestByConstruction = new Map<string, ParsedColonisationDepot>();
    for (const ev of depotEvents) {
      const key = `${ev.systemName}:${ev.constructionId ?? ''}`;
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
    const snapshotCount = await insertSnapshots(svc, snapshots);

    const contributionRows = contributionEvents.map((ev) => ({
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
    const insertedContributions = await insertColonisationEvents(svc, contributionRows);

    // Old clients issue a single request without `finalize`; preserve their
    // completed status while a new client explicitly closes the final chunk.
    const complete = body.finalize !== false;
    if (complete) {
      const { error: completeError } = await svc
        .from('journal_imports')
        .update({ status: 'completed', error_message: null })
        .eq('id', importId)
        .eq('user_id', user.id);
      if (completeError) throw new Error(completeError.message);
    }

    return NextResponse.json({
      importId,
      insertedDepots,
      insertedContributions,
      snapshotCount,
      totalEvents: insertedDepots + insertedContributions,
      complete,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error';
    console.error('[Journal Import] Error:', message);
    if (svc && importId) {
      const { error: statusError } = await svc
        .from('journal_imports')
        .update({ status: 'failed', error_message: message.slice(0, 1_000) })
        .eq('id', importId);
      if (statusError) console.warn('[Journal Import] Could not record failed status:', statusError.message);
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
