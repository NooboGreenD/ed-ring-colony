import { NextResponse } from 'next/server';
import { createServiceClient, authFromRequest } from '@/lib/supabaseServer';
import type { ParsedColonisationDepot, ParsedColonisationContribution } from '@/lib/journalParser';
import {
  persistColonisationSites,
  siteRowFromDepot,
  snapshotRowsForChangedSites,
  type ColonisationSiteRow,
  type DepotSnapshotRow,
} from '@/lib/colonisationEvents';

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

async function insertSnapshots(
  svc: ReturnType<typeof createServiceClient>,
  rows: DepotSnapshotRow[],
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

    // Состояния площадок строятся общим модулем — тем же, что у браузерного
    // загрузчика, Colonial Helper'а и CAPI. Одна строка на площадку (ключ —
    // MarketID), повтор того же состояния базе не нужен.
    const depotRows: ColonisationSiteRow[] = [];
    for (const ev of depotEvents) {
      const row = siteRowFromDepot(user.id, ev);
      if (row) depotRows.push(row);
    }
    const depotWrite = await persistColonisationSites(svc, depotRows);
    const insertedDepots = depotWrite.changed;

    // Снимок прогресса — только по площадкам, чьё состояние изменилось: повторная
    // отправка того же состояния не должна добавлять строку в историю графиков.
    const snapshots = snapshotRowsForChangedSites(depotRows, depotWrite.changedMarkets);
    const snapshotCount = await insertSnapshots(svc, snapshots);

    // Вклады (`ColonisationContribution`) в базу больше НЕ пишем. Строку не читает
    // ни один потребитель (тоннаж командира живёт в `deliveries` с собственным
    // идемпотентным `source_hash`), а множились они по каждой позиции груза —
    // это была заметная доля роста таблицы до 12+ ГБ. События по-прежнему
    // считаем и показываем в предпросмотре страницы журнала.
    const insertedContributions = 0;
    const skippedContributions = contributionEvents.length;

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
      // Вклады не пишутся (см. комментарий выше) — их видно отдельным числом.
      skippedContributions,
      // Сколько площадок уже знали в этом состоянии (или строка устарела).
      duplicateDepots: depotWrite.unchanged + depotWrite.stale,
      duplicateContributions: 0,
      snapshotCount,
      totalEvents: insertedDepots,
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
