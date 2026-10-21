import { communityGoalIdentityKey } from './inara/community-goals.mjs';

type ServiceClient = any;
type ReportSource = 'helper' | 'capi' | 'web';

function nonNegativeInteger(value: unknown): number | null {
  const parsed = typeof value === 'number'
    ? value
    : (typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 500) : '';
}

function isoDate(value: unknown): string | null {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

/** Persist the newest account-scoped journal snapshot for each in-game CG. */
export async function persistCommunityGoalReports(
  svc: ServiceClient,
  userId: string,
  reports: unknown,
  source: ReportSource,
): Promise<number> {
  if (!Array.isArray(reports) || reports.length === 0) return 0;

  // A history import can contain hundreds of snapshots for the same goal.
  // PostgreSQL upsert cannot update one conflict target twice in a single
  // INSERT, so collapse each request to the newest snapshot per in-game ID.
  const newestByGameId = new Map<number, { observedAt: string; row: Record<string, unknown> }>();
  for (const report of reports) {
    if (!report || typeof report !== 'object' || Array.isArray(report)) continue;
    const value = report as Record<string, unknown>;
    const gameCgId = nonNegativeInteger(value.game_cg_id ?? value.gameCgId);
    const title = text(value.title ?? value.Title);
    const systemName = text(value.system_name ?? value.SystemName);
    const stationName = text(value.station_name ?? value.MarketName);
    const expiryDate = isoDate(value.expiry_date ?? value.Expiry);
    const observedAt = isoDate(value.observed_at ?? value.timestamp);
    if (!gameCgId || !title || !observedAt) continue;

    const row = {
      user_id: userId,
      game_cg_id: gameCgId,
      goal_key: communityGoalIdentityKey({ title, systemName, stationName, expiryDate }),
      title,
      system_name: systemName || null,
      station_name: stationName || null,
      expiry_date: expiryDate,
      player_contribution: nonNegativeInteger(value.player_contribution ?? value.PlayerContribution) ?? 0,
      current_total: nonNegativeInteger(value.current_total ?? value.CurrentTotal),
      tier_reached: nonNegativeInteger(value.tier_reached ?? value.TierReached),
      tier_max: nonNegativeInteger(value.tier_max ?? value.TierMax),
      contributors_num: nonNegativeInteger(value.contributors_num ?? value.NumContributors),
      percentile_band: nonNegativeInteger(value.percentile_band ?? value.PlayerPercentileBand),
      is_top_rank: typeof (value.is_top_rank ?? value.PlayerInTopRank) === 'boolean'
        ? (value.is_top_rank ?? value.PlayerInTopRank) as boolean
        : null,
      is_complete: typeof (value.is_complete ?? value.IsComplete) === 'boolean'
        ? (value.is_complete ?? value.IsComplete) as boolean
        : null,
      observed_at: observedAt,
      source,
    };
    const previous = newestByGameId.get(gameCgId);
    if (!previous || observedAt >= previous.observedAt) {
      newestByGameId.set(gameCgId, { observedAt, row });
    }
  }

  const rows = Array.from(newestByGameId.values(), ({ row }) => row);
  if (rows.length === 0) return 0;
  const { data, error } = await svc.rpc('upsert_community_goal_commander_reports', { p_rows: rows });
  if (error) throw new Error(`Community Goal reports were not stored: ${error.message}`);
  return typeof data === 'number' ? data : rows.length;
}
