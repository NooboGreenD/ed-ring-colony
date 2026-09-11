import { createServiceClient } from '@/lib/supabaseServer';
import {
  enrichRavenSystemWithDepotSnapshots,
  type RavenDepotSnapshot,
  type RavenSystemV2,
} from '@/lib/ravenColonial';

type DepotEventRow = {
  resources_total: unknown;
};

/**
 * Enrich a live Raven response with the latest depot snapshots imported from
 * Elite journals. Only the public construction state (MarketID, timestamp,
 * and commodity totals) is read; no commander or raw journal data is exposed.
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
    // Elite MarketIDs are 64-bit numbers. Querying each ID lets us retain the
    // original string key instead of round-tripping a BIGINT through JSON and
    // potentially losing precision in JavaScript.
    const snapshots = await Promise.all(
      marketIds.map(async (marketId): Promise<RavenDepotSnapshot | null> => {
        const { data, error } = await supabase
          .from('colonisation_events')
          .select('resources_total')
          .eq('market_id', marketId)
          // Contribution events do not contain a complete depot resource list.
          .not('construction_id', 'is', null)
          .order('event_timestamp', { ascending: false })
          .limit(1);

        if (error || !data?.[0]) return null;
        return {
          marketId,
          resources: (data[0] as DepotEventRow).resources_total,
        } satisfies RavenDepotSnapshot;
      }),
    );

    return enrichRavenSystemWithDepotSnapshots(
      system,
      snapshots.filter((snapshot): snapshot is RavenDepotSnapshot => snapshot !== null),
    );
  } catch {
    // Raven data remains useful when journal storage is unavailable or this
    // deployment intentionally has no service-role key.
    return system;
  }
}
