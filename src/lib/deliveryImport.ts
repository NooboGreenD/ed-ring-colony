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

async function loadPlacementLookup(svc: SupabaseClient): Promise<Map<string, SystemPlacement>> {
  // Do not use a case-sensitive `in(system_name, ...)` lookup here. Journal
  // names often differ only in case/whitespace from stored route and hub rows.
  const [{ data: hubs, error: hubsError }, { data: routeSystems, error: routesError }] = await Promise.all([
    svc.from('hubs').select('system_name'),
    svc.from('route_systems').select('id, system_name'),
  ]);
  // Placement only enriches leaderboard statistics. A deployment that is in
  // the middle of a route-table migration can still retain a valid personal
  // delivery rather than rejecting the entire Journal batch.
  if (hubsError) console.warn('[delivery import] Could not load hubs:', hubsError.message);
  if (routesError) console.warn('[delivery import] Could not load route systems:', routesError.message);

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

/**
 * Persist a batch idempotently. The normal path uses the unique
 * (user_id, source_hash) index from the delivery-idempotency migration. The
 * fallback keeps current installations usable until that migration is applied.
 */
export async function persistImportedDeliveries(
  svc: SupabaseClient,
  userId: string,
  incomingDeliveries: unknown[],
): Promise<DeliveryImportOutcome> {
  const placements = await loadPlacementLookup(svc);
  const initialRows = validRows(userId, incomingDeliveries, placements);
  const collapsed = collapseBatchDuplicates(initialRows);
  if (collapsed.rows.length === 0) {
    return { inserted: 0, duplicates: collapsed.duplicates, eventsFound: 0 };
  }

  const { data, error } = await svc
    .from('deliveries')
    .upsert(collapsed.rows, { onConflict: 'user_id,source_hash', ignoreDuplicates: true })
    .select('id');

  if (!error) {
    const inserted = data?.length ?? 0;
    return {
      inserted,
      duplicates: collapsed.duplicates + Math.max(0, collapsed.rows.length - inserted),
      eventsFound: initialRows.length,
    };
  }

  if (!isMissingConflictTarget(error)) throw new Error(error.message);

  // Compatibility path for a deployment which has not run the migration yet.
  // It is not race-proof (the migration path is), but still makes repeated
  // uploads in an existing installation idempotent instead of failing.
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
