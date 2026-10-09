import { createServiceClient } from '@/lib/supabaseServer';
import {
  enrichRavenSystemWithDepotSnapshots,
  type RavenDepotSnapshot,
  type RavenSystemV2,
} from '@/lib/ravenColonial';

/** Площадок в одном запросе: короткий `in.(…)` вместо запроса на каждую. */
const MARKET_LOOKUP_CHUNK = 200;

type SiteRow = {
  market_id: number | string;
  resources_total: unknown;
};

/**
 * Enrich a live Raven response with the latest depot state of each site, as
 * imported from Elite journals (`colonisation_sites`: одна строка на площадку).
 * Only the public construction state (MarketID and commodity totals) is read;
 * no commander or raw journal data is exposed.
 *
 * A journal snapshot supplies each commodity's original requirement, while
 * Raven supplies the live outstanding amount. The pure merger derives the
 * current delivered amount from those two source facts.
 */
export async function enrichRavenSystemWithJournalSnapshots(
  system: RavenSystemV2,
): Promise<RavenSystemV2> {
  const marketIds = Array.from(new Set(
    system.projects
      .map((project) => project.marketId)
      // Journal parsing uses 0 as the sentinel for a missing MarketID.
      .filter((marketId): marketId is string => Boolean(marketId && marketId !== '0')),
  ));

  if (marketIds.length === 0) return system;

  try {
    const supabase = createServiceClient();
    const snapshots: RavenDepotSnapshot[] = [];
    for (let index = 0; index < marketIds.length; index += MARKET_LOOKUP_CHUNK) {
      const chunk = marketIds.slice(index, index + MARKET_LOOKUP_CHUNK);
      // MarketID — 64-битное число, но реальные значения Elite далеко ниже 2^53,
      // поэтому их безопасно сверять строкой после JSON-разбора.
      const { data, error } = await supabase
        .from('colonisation_sites')
        .select('market_id, resources_total')
        .in('market_id', chunk);
      if (error) throw new Error(error.message);
      for (const row of (data ?? []) as SiteRow[]) {
        snapshots.push({
          marketId: String(row.market_id),
          resources: row.resources_total,
        } satisfies RavenDepotSnapshot);
      }
    }

    return enrichRavenSystemWithDepotSnapshots(system, snapshots);
  } catch {
    // Raven data remains useful when journal storage is unavailable or this
    // deployment intentionally has no service-role key.
    return system;
  }
}
