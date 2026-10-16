/**
 * Чтение и запись учёта авианосцев через service_role.
 *
 * Права решаются здесь, а не в RLS: таблицы fleet_* закрыты для anon и
 * authenticated, маршруты сами определяют, что видит конкретный пилот.
 */

import {
  buildCarrierView,
  isCarrierMarketId,
  type CarrierMarketItem,
  type CarrierOp,
  type CarrierRelation,
  type CarrierSource,
  type CarrierView,
} from './fleetCarriers';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Svc = any;

/** Сколько операций уходит в одном вызове SQL-функции (лимит функции — 5000). */
const OPS_PER_CALL = 2000;

export interface ApplyTotals {
  applied: number;
  duplicates: number;
  ignored: number;
  stationsMoved: number;
  carriers: string[];
}

export async function applyCarrierOps(
  svc: Svc,
  userId: string | null,
  source: CarrierSource,
  ops: CarrierOp[],
): Promise<ApplyTotals> {
  const totals: ApplyTotals = { applied: 0, duplicates: 0, ignored: 0, stationsMoved: 0, carriers: [] };
  if (!ops.length) return totals;
  // Хронологический порядок и между вызовами: «owner» должен видеть тип
  // носителя, записанный «identity» того же CarrierStats.
  const ordered = ops
    .map((op, index) => ({ op, index }))
    .sort((left, right) => Date.parse(left.op.at) - Date.parse(right.op.at) || left.index - right.index)
    .map(({ op }) => op);
  const carriers = new Set<string>();
  for (let start = 0; start < ordered.length; start += OPS_PER_CALL) {
    const chunk = ordered.slice(start, start + OPS_PER_CALL);
    const { data, error } = await svc.rpc('apply_fleet_carrier_batch', {
      p_user_id: userId,
      p_source: source,
      p_ops: chunk,
    });
    if (error) throw new Error(`Fleet carriers: ${error.message}`);
    totals.applied += Number(data?.applied ?? 0);
    totals.duplicates += Number(data?.duplicates ?? 0);
    totals.ignored += Number(data?.ignored ?? 0);
    totals.stationsMoved += Number(data?.stations_moved ?? 0);
    for (const id of Array.isArray(data?.carriers) ? data.carriers : []) carriers.add(String(id));
  }
  totals.carriers = Array.from(carriers);
  return totals;
}

export interface ViewerContext {
  userId: string | null;
  squadronIds: number[];
  /** Эскадрильи, где пилот может управлять носителем (создатель или can_edit_squadron). */
  officerSquadronIds: number[];
}

export async function viewerContext(svc: Svc, userId: string | null): Promise<ViewerContext> {
  const context: ViewerContext = { userId, squadronIds: [], officerSquadronIds: [] };
  if (!userId) return context;
  const { data: memberships, error } = await svc
    .from('squadron_members')
    .select('squadron_id, rank_id')
    .eq('user_id', userId);
  if (error || !Array.isArray(memberships) || memberships.length === 0) return context;
  context.squadronIds = memberships.map((row: any) => Number(row.squadron_id)).filter(Number.isFinite);

  const officers = new Set<number>();
  const rankIds = memberships.map((row: any) => row.rank_id).filter((value: unknown) => value != null);
  if (rankIds.length) {
    const { data: ranks } = await svc
      .from('squadron_ranks')
      .select('id, squadron_id, can_edit_squadron')
      .in('id', rankIds);
    for (const rank of Array.isArray(ranks) ? ranks : []) {
      if (rank.can_edit_squadron === true) officers.add(Number(rank.squadron_id));
    }
  }
  const { data: created } = await svc
    .from('squadrons')
    .select('id')
    .in('id', context.squadronIds)
    .eq('created_by', userId);
  for (const squadron of Array.isArray(created) ? created : []) officers.add(Number(squadron.id));
  context.officerSquadronIds = Array.from(officers).filter((id) => context.squadronIds.includes(id));
  return context;
}

export function relationFor(row: Record<string, any>, viewer: ViewerContext): CarrierRelation {
  if (viewer.userId && row.owner_id === viewer.userId) return 'own';
  if (row.squadron_id != null && viewer.squadronIds.includes(Number(row.squadron_id))) return 'squadron';
  return 'public';
}

async function loadMarketSnapshots(svc: Svc, carrierIds: string[]) {
  const snapshots = new Map<string, { observed_at: string; items: CarrierMarketItem[] }>();
  if (!carrierIds.length) return snapshots;
  try {
    const { data, error } = await svc
      .from('station_inventory_snapshots')
      .select('station_key, items, observed_at')
      .eq('kind', 'market')
      .in('station_key', carrierIds.map((id) => `market:${id}`));
    if (error) return snapshots;
    for (const row of Array.isArray(data) ? data : []) {
      snapshots.set(String(row.station_key).slice('market:'.length), {
        observed_at: row.observed_at,
        items: Array.isArray(row.items) ? row.items : [],
      });
    }
  } catch {
    // Каталог станций может отсутствовать на старой установке — рынок просто не покажем.
  }
  return snapshots;
}

export async function buildViews(svc: Svc, rows: Array<Record<string, any>>, viewer: ViewerContext): Promise<CarrierView[]> {
  if (!rows.length) return [];
  const ids = rows.map((row) => String(row.carrier_id));
  const relations = new Map(rows.map((row) => [String(row.carrier_id), relationFor(row, viewer)]));
  const privateIds = ids.filter((id) => relations.get(id) !== 'public');

  const cargoByCarrier = new Map<string, Array<Record<string, any>>>();
  if (privateIds.length) {
    const { data, error } = await svc
      .from('fleet_carrier_cargo')
      .select('carrier_id, commodity, name_localised, quantity, baseline_at, baseline_source, updated_at')
      .in('carrier_id', privateIds)
      .gt('quantity', 0);
    if (error) throw new Error(`Fleet carrier cargo: ${error.message}`);
    for (const row of Array.isArray(data) ? data : []) {
      const key = String(row.carrier_id);
      if (!cargoByCarrier.has(key)) cargoByCarrier.set(key, []);
      cargoByCarrier.get(key)!.push(row);
    }
  }
  const markets = await loadMarketSnapshots(svc, ids);

  return rows.map((row) => {
    const id = String(row.carrier_id);
    const relation = relations.get(id) ?? 'public';
    const showFinance = relation === 'own'
      || (relation === 'squadron' && row.carrier_type === 'SquadronCarrier'
        && viewer.officerSquadronIds.includes(Number(row.squadron_id)));
    return buildCarrierView(row, {
      relation,
      showFinance,
      cargoRows: cargoByCarrier.get(id) ?? [],
      market: markets.get(id) ?? null,
    });
  });
}

export async function findCarrier(
  svc: Svc,
  reference: { carrierId: string } | { callsign: string },
): Promise<Record<string, any> | null> {
  const query = svc.from('fleet_carriers').select('*');
  const { data, error } = 'carrierId' in reference
    ? await query.eq('carrier_id', reference.carrierId).maybeSingle()
    : await query.ilike('callsign', reference.callsign).order('updated_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error(`Fleet carriers: ${error.message}`);
  return data ?? null;
}

/** Найти или (для ручной привязки по Carrier ID) создать строку носителя. */
export async function findOrCreateCarrier(
  svc: Svc,
  reference: { carrierId: string } | { callsign: string },
  options: { allowAnyId?: boolean } = {},
): Promise<Record<string, any> | null> {
  const existing = await findCarrier(svc, reference);
  if (existing || !('carrierId' in reference)) return existing;
  if (!options.allowAnyId && !isCarrierMarketId(reference.carrierId)) return null;
  const { data, error } = await svc
    .from('fleet_carriers')
    .upsert({ carrier_id: reference.carrierId }, { onConflict: 'carrier_id', ignoreDuplicates: true })
    .select('*')
    .maybeSingle();
  if (error) throw new Error(`Fleet carriers: ${error.message}`);
  return data ?? (await findCarrier(svc, reference));
}
