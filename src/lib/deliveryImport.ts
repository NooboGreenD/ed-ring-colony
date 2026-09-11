import { createHash } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface DeliveryImportOutcome {
  inserted: number;
  duplicates: number;
  eventsFound: number;
}

type SystemPlacement = {
  systemName: string;
  isHub: boolean;
  routeSystemId: number | null;
};

type DeliveryRow = {
  user_id: string;
  system_name: string;
  commodity: string;
  amount: number;
  delivered_at: string;
  is_hub: boolean;
  route_system_id: number | null;
  source_hash: string;
};

// A Journal can contain thousands of events. Keep each PostgREST mutation
// deliberately small: after the source-hash index rollout, a failed request
// can be retried safely and never turns one large INSERT/RETURNING statement
// into a database statement timeout.
export const DELIVERY_IMPORT_WRITE_BATCH_SIZE = 100;
const PLACEMENT_LOOKUP_BATCH_SIZE = 50;

// A deployment can add source_hash before its optional concurrent unique index
// is built. Remember that capability per warm server instance so every 100-row
// batch does not first issue a deliberately failing UPSERT. Compatibility
// results deliberately expire: a warm server must discover a completed schema
// rollout without requiring a restart/redeploy.
type SourceHashWriteMode = 'unknown' | 'unique-index' | 'column-without-index' | 'no-column';
const SOURCE_HASH_CAPABILITY_REPROBE_MS = 2 * 60_000;
let sourceHashWriteMode: SourceHashWriteMode = 'unknown';
let sourceHashWriteModeExpiresAt = 0;

function rememberSourceHashWriteMode(mode: SourceHashWriteMode) {
  sourceHashWriteMode = mode;
  sourceHashWriteModeExpiresAt = mode === 'unique-index'
    ? 0
    : Date.now() + SOURCE_HASH_CAPABILITY_REPROBE_MS;
}

function shouldTryAtomicSourceHashWrite(): boolean {
  return (
    sourceHashWriteMode === 'unknown'
    || sourceHashWriteMode === 'unique-index'
    || Date.now() >= sourceHashWriteModeExpiresAt
  );
}

function normalized(value: unknown): string {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function fallbackHash(value: string): string {
  return `legacy-v2-${createHash('sha256').update(value).digest('hex')}`;
}

function safeSourceHash(value: unknown, fallback: string): string {
  const sourceHash = typeof value === 'string' ? value.trim() : '';
  // Browser parser hashes and the desktop helper hashes are opaque IDs. Limit
  // their shape/length so an import cannot use unbounded DB values, while old
  // helper versions still get a deterministic server-side fingerprint.
  if (sourceHash && sourceHash.length <= 180 && /^[A-Za-z0-9:_-]+$/.test(sourceHash)) {
    return sourceHash;
  }
  return fallbackHash(fallback);
}

function chunk<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function placementCandidates(deliveries: unknown[]): string[] {
  const names = new Map<string, string>();
  for (const raw of deliveries) {
    if (!raw || typeof raw !== 'object') continue;
    const name = String((raw as Record<string, unknown>).system_name ?? '')
      .trim()
      .replace(/\s+/g, ' ');
    const key = normalized(name);
    if (name && name.length <= 250 && key && !names.has(key)) names.set(key, name);
  }
  return Array.from(names.values());
}

function placementMap(
  hubs: Array<{ system_name?: unknown }> | null | undefined,
  routeSystems: Array<{ id?: unknown; system_name?: unknown }> | null | undefined,
): Map<string, SystemPlacement> {
  const placements = new Map<string, SystemPlacement>();
  for (const routeSystem of routeSystems || []) {
    const key = normalized(routeSystem.system_name);
    const id = Number(routeSystem.id);
    if (!key || !Number.isSafeInteger(id)) continue;
    placements.set(key, {
      systemName: String(routeSystem.system_name).trim(),
      isHub: false,
      routeSystemId: id,
    });
  }
  for (const hub of hubs || []) {
    const key = normalized(hub.system_name);
    if (!key) continue;
    const existing = placements.get(key);
    placements.set(key, {
      systemName: String(hub.system_name).trim(),
      isHub: true,
      routeSystemId: existing?.routeSystemId ?? null,
    });
  }
  return placements;
}

function isMissingPlacementResolver(error: { code?: string; message?: string }): boolean {
  return (
    error.code === 'PGRST202'
    || /resolve_delivery_system_placements|could not find the function/i.test(error.message || '')
  );
}

async function loadExactPlacementLookup(
  svc: SupabaseClient,
  candidateNames: string[],
): Promise<Map<string, SystemPlacement>> {
  const hubs: Array<{ system_name?: unknown }> = [];
  const routeSystems: Array<{ id?: unknown; system_name?: unknown }> = [];

  // The compatibility path intentionally only reads names present in this
  // upload. It keeps installations that have not yet run the resolver
  // migration from repeatedly downloading every hub and route system.
  for (const names of chunk(candidateNames, PLACEMENT_LOOKUP_BATCH_SIZE)) {
    const [hubsResponse, routesResponse] = await Promise.all([
      svc.from('hubs').select('system_name').in('system_name', names),
      svc.from('route_systems').select('id, system_name').in('system_name', names),
    ]);
    if (hubsResponse.error) {
      console.warn('[delivery import] Could not load matching hubs:', hubsResponse.error.message);
    } else if (hubsResponse.data) {
      hubs.push(...hubsResponse.data);
    }
    if (routesResponse.error) {
      console.warn('[delivery import] Could not load matching route systems:', routesResponse.error.message);
    } else if (routesResponse.data) {
      routeSystems.push(...routesResponse.data);
    }
  }

  return placementMap(hubs, routeSystems);
}

async function loadPlacementLookup(
  svc: SupabaseClient,
  deliveries: unknown[],
): Promise<Map<string, SystemPlacement>> {
  const candidateNames = placementCandidates(deliveries);
  if (candidateNames.length === 0) return new Map();

  // The SQL resolver added with the import-performance migration matches the
  // same case/whitespace-normalized key as the Journal parser and uses
  // expression indexes. Do not scan the complete hubs/route_systems tables on
  // every batch.
  const { data, error } = await svc.rpc('resolve_delivery_system_placements', {
    system_names: candidateNames,
  });
  if (!error) {
    const placements = new Map<string, SystemPlacement>();
    for (const row of data || []) {
      const key = normalized(row?.input_system_name);
      const routeSystemId = row?.route_system_id == null ? null : Number(row.route_system_id);
      const systemName = String(row?.system_name ?? '').trim();
      if (!key || !systemName || (routeSystemId !== null && !Number.isSafeInteger(routeSystemId))) continue;
      placements.set(key, {
        systemName,
        isHub: Boolean(row?.is_hub),
        routeSystemId,
      });
    }
    return placements;
  }

  // During a rolling deployment the API can run before Supabase migrations are
  // applied or before PostgREST reloads its schema cache. The exact-name
  // fallback remains bounded and avoids making journal imports unavailable.
  if (!isMissingPlacementResolver(error)) {
    console.warn('[delivery import] Placement resolver failed; using bounded fallback:', error.message);
  }
  return loadExactPlacementLookup(svc, candidateNames);
}

function validRows(userId: string, deliveries: unknown[], placements: Map<string, SystemPlacement>): DeliveryRow[] {
  const rows: DeliveryRow[] = [];

  for (const raw of deliveries) {
    if (!raw || typeof raw !== 'object') continue;
    const delivery = raw as Record<string, unknown>;
    const originalSystem = String(delivery.system_name ?? '').trim().replace(/\s+/g, ' ');
    const commodity = String(delivery.commodity ?? '').trim();
    const numericAmount = typeof delivery.amount === 'number' ? delivery.amount : Number(delivery.amount);
    const amount = Number.isFinite(numericAmount) ? Math.trunc(numericAmount) : 0;
    const rawTimestamp = String(delivery.delivered_at ?? delivery.timestamp ?? '').trim();
    const date = new Date(rawTimestamp);
    if (
      !originalSystem
      || originalSystem.length > 250
      || !commodity
      || amount <= 0
      || amount > 2_147_483_647
      || !Number.isFinite(date.getTime())
    ) continue;

    const placement = placements.get(normalized(originalSystem));
    const systemName = placement?.systemName ?? originalSystem;
    const deliveredAt = date.toISOString();
    const sourceHash = safeSourceHash(
      delivery.source_hash,
      [userId, systemName, commodity.toLowerCase(), amount, deliveredAt, String(delivery.source ?? '')].join('\u0000'),
    );
    rows.push({
      user_id: userId,
      system_name: systemName,
      commodity: commodity.slice(0, 250),
      amount,
      delivered_at: deliveredAt,
      // Placement is server-authoritative; browser/API payload flags are never
      // trusted for leaderboard hub/route statistics.
      is_hub: placement?.isHub ?? false,
      route_system_id: placement?.routeSystemId ?? null,
      source_hash: sourceHash,
    });
  }
  return rows;
}

function collapseBatchDuplicates(rows: DeliveryRow[]): { rows: DeliveryRow[]; duplicates: number } {
  const unique = new Map<string, DeliveryRow>();
  let duplicates = 0;
  for (const row of rows) {
    const key = `${row.user_id}\u0000${row.source_hash}`;
    if (unique.has(key)) {
      duplicates += 1;
      continue;
    }
    unique.set(key, row);
  }
  return { rows: Array.from(unique.values()), duplicates };
}

function isMissingConflictTarget(error: { code?: string; message?: string }): boolean {
  return error.code === '42P10' || /no unique or exclusion constraint|there is no unique or exclusion constraint/i.test(error.message || '');
}

function isMissingSourceHash(error: { code?: string; message?: string }): boolean {
  return (
    error.code === '42703'
    || error.code === 'PGRST204'
    || /source_hash.*(?:does not exist|could not find)|could not find.*source_hash/i.test(error.message || '')
  );
}

async function persistDeliveryChunk(
  svc: SupabaseClient,
  userId: string,
  incomingDeliveries: unknown[],
): Promise<DeliveryImportOutcome> {
  const placements = await loadPlacementLookup(svc, incomingDeliveries);
  const initialRows = validRows(userId, incomingDeliveries, placements);
  const collapsed = collapseBatchDuplicates(initialRows);
  if (collapsed.rows.length === 0) {
    return { inserted: 0, duplicates: collapsed.duplicates, eventsFound: 0 };
  }

  if (shouldTryAtomicSourceHashWrite()) {
    const { data, error } = await svc
      .from('deliveries')
      .upsert(collapsed.rows, { onConflict: 'user_id,source_hash', ignoreDuplicates: true })
      .select('id');

    if (!error) {
      rememberSourceHashWriteMode('unique-index');
      const inserted = data?.length ?? 0;
      return {
        inserted,
        duplicates: collapsed.duplicates + Math.max(0, collapsed.rows.length - inserted),
        eventsFound: initialRows.length,
      };
    }

    if (isMissingSourceHash(error)) {
      rememberSourceHashWriteMode('no-column');
    } else if (isMissingConflictTarget(error)) {
      rememberSourceHashWriteMode('column-without-index');
    } else {
      throw new Error(error.message);
    }
  }

  if (sourceHashWriteMode === 'no-column') {
    // A rolling deploy can serve the API before ADD COLUMN source_hash reaches
    // PostgREST. Retain valid deliveries rather than rejecting the upload;
    // retries become idempotent after the column/index rollout completes.
    const legacyRows = collapsed.rows.map(({ source_hash: _sourceHash, ...row }) => row);
    const { data: insertedRows, error: insertError } = await svc
      .from('deliveries')
      .insert(legacyRows)
      .select('id');
    if (insertError) throw new Error(insertError.message);
    return {
      inserted: insertedRows?.length ?? legacyRows.length,
      duplicates: collapsed.duplicates,
      eventsFound: initialRows.length,
    };
  }

  // Compatibility path for a deployment with source_hash but before the
  // optional concurrent unique index. It is not race-proof, but each lookup
  // and write stays bounded and repeated sequential imports remain safe.
  const hashes = collapsed.rows.map((row) => row.source_hash);
  const { data: existing, error: existingError } = await svc
    .from('deliveries')
    .select('source_hash')
    .eq('user_id', userId)
    .in('source_hash', hashes);
  if (existingError) throw new Error(existingError.message);
  const existingHashes = new Set((existing || []).map((row: { source_hash?: string | null }) => row.source_hash).filter(Boolean));
  const missing = collapsed.rows.filter((row) => !existingHashes.has(row.source_hash));
  if (missing.length === 0) {
    return {
      inserted: 0,
      duplicates: collapsed.duplicates + collapsed.rows.length,
      eventsFound: initialRows.length,
    };
  }

  const { data: insertedRows, error: insertError } = await svc
    .from('deliveries')
    .insert(missing)
    .select('id');
  if (insertError) throw new Error(insertError.message);
  const inserted = insertedRows?.length ?? 0;
  return {
    inserted,
    duplicates: collapsed.duplicates + existingHashes.size + Math.max(0, missing.length - inserted),
    eventsFound: initialRows.length,
  };
}

/**
 * Persist arbitrary client-sized batches safely. Older desktop helpers used
 * 500-item requests; processing them in 100-row writes prevents a single
 * long-running statement while retaining compatibility with those releases.
 */
export async function persistImportedDeliveries(
  svc: SupabaseClient,
  userId: string,
  incomingDeliveries: unknown[],
): Promise<DeliveryImportOutcome> {
  let inserted = 0;
  let duplicates = 0;
  let eventsFound = 0;

  for (const deliveryChunk of chunk(incomingDeliveries, DELIVERY_IMPORT_WRITE_BATCH_SIZE)) {
    const outcome = await persistDeliveryChunk(svc, userId, deliveryChunk);
    inserted += outcome.inserted;
    duplicates += outcome.duplicates;
    eventsFound += outcome.eventsFound;
  }

  return { inserted, duplicates, eventsFound };
}
