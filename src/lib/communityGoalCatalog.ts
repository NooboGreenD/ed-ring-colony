import { communityGoalIdentityKey, normalizeCommunityGoal } from './inara/community-goals.mjs';

type GoalSource = 'inara' | 'capi' | 'journal';
type ServiceClient = any;
type CatalogGoal = Record<string, any> & { identity_key: string; cg_id: number };

const SOURCE_PRIORITY: Record<GoalSource | 'manual', number> = {
  journal: 1,
  capi: 2,
  inara: 3,
  manual: 4,
};
const MAX_CG_ID = 2_147_483_647;

function stableId(identity: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < identity.length; index += 1) {
    hash ^= identity.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) & MAX_CG_ID || 1;
}

function cleanDate(value: unknown, fallback: string): string {
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return fallback;
}

function asObject(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : null;
}

/** Convert Frontier CAPI's public goal overview into the canonical DB shape. */
export function normalizeCapiCommunityGoals(payload: unknown, observedAt = new Date().toISOString()): CatalogGoal[] {
  const container = asObject(payload);
  const goals = Array.isArray(payload)
    ? payload
    : Array.isArray(container?.goals)
      ? container.goals
      : Array.isArray(container?.communityGoals)
        ? container.communityGoals
        : [];
  return goals.flatMap((item) => {
    const goal = asObject(item);
    if (!goal) return [];
    const title = goal.title ?? goal.communitygoalName ?? goal.cgName;
    if (typeof title !== 'string' || !title.trim()) return [];
    const normalized = normalizeCommunityGoal({
      communitygoalGameID: goal.cg_id ?? goal.cgID ?? goal.communitygoalGameID,
      communitygoalName: title,
      starsystemName: goal.system_name ?? goal.starsystemName ?? goal.systemName,
      stationName: goal.station_name ?? goal.stationName ?? goal.marketName,
      goalObjectiveText: goal.objective ?? goal.goalObjectiveText,
      goalDescriptionText: goal.description ?? goal.goalDescriptionText,
      goalRewardText: goal.reward ?? goal.goalRewardText,
      tierReached: goal.tier_current ?? goal.tierReached,
      tierMax: goal.tier_max ?? goal.tierMax,
      contributorsNum: goal.contributors ?? goal.contributorsNum,
      contributionsTotal: goal.contributions_total ?? goal.contributionsTotal,
      goalExpiry: goal.expiry_date ?? goal.goalExpiry ?? goal.expiryDate,
      isCompleted: goal.is_complete ?? goal.isCompleted,
      inaraURL: goal.inara_url ?? goal.inaraURL,
      lastUpdate: observedAt,
    });
    return [{
      ...normalized,
      source_updated_at: observedAt,
      raw_data: {
        cg_id: goal.cg_id ?? goal.cgID ?? null,
        title: normalized.title,
        system_name: normalized.system_name,
        station_name: normalized.station_name,
        expiry_date: normalized.expiry_date,
      },
    }];
  });
}

/**
 * Turn journal CurrentGoals into public catalogue candidates. PlayerContribution
 * is intentionally omitted: it remains only in the account-scoped reports table.
 */
export function normalizeJournalCommunityGoals(reports: unknown): CatalogGoal[] {
  if (!Array.isArray(reports)) return [];
  return reports.flatMap((item) => {
    const report = asObject(item);
    if (!report) return [];
    const title = report.title ?? report.Title;
    if (typeof title !== 'string' || !title.trim()) return [];
    const observedAt = cleanDate(report.observed_at ?? report.timestamp, new Date().toISOString());
    const normalized = normalizeCommunityGoal({
      communitygoalName: title,
      starsystemName: report.system_name ?? report.SystemName,
      stationName: report.station_name ?? report.MarketName,
      goalExpiry: report.expiry_date ?? report.Expiry,
      tierReached: report.tier_reached ?? report.TierReached,
      tierMax: report.tier_max ?? report.TierMax,
      contributorsNum: report.contributors_num ?? report.NumContributors,
      contributionsTotal: report.current_total ?? report.CurrentTotal,
      isCompleted: report.is_complete ?? report.IsComplete,
      lastUpdate: observedAt,
    });
    return [{
      ...normalized,
      source_updated_at: observedAt,
      // Do not put per-commander contribution/rank data in this shared row.
      raw_data: {
        title: normalized.title,
        system_name: normalized.system_name,
        station_name: normalized.station_name,
        expiry_date: normalized.expiry_date,
      },
    }];
  });
}

/**
 * Upsert a source without letting weaker observations replace better ones.
 * Match by normalized identity first because Inara omits the game's CGID while
 * CAPI and journal events include it. Moderator fields/overrides are omitted
 * from the upsert and therefore remain untouched.
 */
export async function upsertCommunityGoalCatalog(
  svc: ServiceClient,
  input: unknown,
  source: GoalSource,
  options: { pendingJournalGoals?: boolean } = {},
): Promise<number> {
  if (!Array.isArray(input) || input.length === 0) return 0;
  const now = new Date().toISOString();
  const byIdentity = new Map<string, CatalogGoal>();
  for (const item of input) {
    const candidate = asObject(item) as CatalogGoal | null;
    if (!candidate?.identity_key || !candidate.title) continue;
    const previous = byIdentity.get(candidate.identity_key);
    const previousAt = Date.parse(previous?.source_updated_at || '') || 0;
    const candidateAt = Date.parse(candidate.source_updated_at || '') || 0;
    if (!previous || candidateAt >= previousAt) byIdentity.set(candidate.identity_key, candidate);
  }
  const goals = Array.from(byIdentity.values());
  if (goals.length === 0) return 0;

  const identities = goals.map((goal) => goal.identity_key);
  const { data: existingRows, error: lookupError } = await svc
    .from('community_goals')
    .select('cg_id,identity_key,source,source_updated_at,moderation_status')
    .in('identity_key', identities);
  if (lookupError) throw new Error(`Community Goal identity lookup failed: ${lookupError.message}`);
  const existingByIdentity = new Map<string, Record<string, any>>();
  for (const row of Array.isArray(existingRows) ? existingRows : []) {
    const previous = existingByIdentity.get(row.identity_key);
    if (!previous || SOURCE_PRIORITY[row.source as keyof typeof SOURCE_PRIORITY] > SOURCE_PRIORITY[previous.source as keyof typeof SOURCE_PRIORITY]) {
      existingByIdentity.set(row.identity_key, row);
    }
  }
  // Rows imported before identity_key was introduced have NULL there. Match
  // their canonical fields in JS so the first CAPI/journal fallback does not
  // create duplicate goals while a deployment is upgrading its old catalogue.
  const { data: legacyRows, error: legacyLookupError } = await svc
    .from('community_goals')
    .select('cg_id,identity_key,source,source_updated_at,moderation_status,title,system_name,station_name,expiry_date')
    .is('identity_key', null);
  if (legacyLookupError) throw new Error(`Legacy Community Goal lookup failed: ${legacyLookupError.message}`);
  const wantedIdentities = new Set(identities);
  for (const row of Array.isArray(legacyRows) ? legacyRows : []) {
    const identity = communityGoalIdentityKey({
      title: row.title,
      systemName: row.system_name,
      stationName: row.station_name,
      expiryDate: row.expiry_date,
    });
    if (!wantedIdentities.has(identity)) continue;
    const previous = existingByIdentity.get(identity);
    if (!previous || SOURCE_PRIORITY[row.source as keyof typeof SOURCE_PRIORITY] > SOURCE_PRIORITY[previous.source as keyof typeof SOURCE_PRIORITY]) {
      existingByIdentity.set(identity, row);
    }
  }

  const candidates = goals.map((goal) => {
    const existing = existingByIdentity.get(goal.identity_key);
    return { goal, existing };
  });
  // The canonical ID is a hash of the normalized identity for every source.
  // That makes simultaneous Inara/CAPI first-seen upserts converge on one
  // conflict key instead of creating two rows for the same CG.
  const wantedIds = candidates
    .filter(({ existing }) => !existing)
    .map(({ goal }) => stableId(goal.identity_key));
  const { data: idRows, error: idLookupError } = wantedIds.length
    ? await svc.from('community_goals').select('cg_id,identity_key').in('cg_id', wantedIds)
    : { data: [], error: null };
  if (idLookupError) throw new Error(`Community Goal ID lookup failed: ${idLookupError.message}`);
  const identityById = new Map<number, string>();
  for (const row of Array.isArray(idRows) ? idRows : []) identityById.set(row.cg_id, row.identity_key || '');

  const rows = [];
  const reservedIds = new Set(identityById.keys());
  for (const { goal, existing } of candidates) {
    if (existing?.source === 'manual') continue;
    if (existing && SOURCE_PRIORITY[existing.source as keyof typeof SOURCE_PRIORITY] > SOURCE_PRIORITY[source]) continue;
    const currentAt = Date.parse(existing?.source_updated_at || '') || 0;
    const incomingAt = Date.parse(goal.source_updated_at || '') || Date.parse(now);
    if (
      existing
      && existing.source === source
      && incomingAt < currentAt
    ) continue;

    let cgId = existing?.cg_id ?? stableId(goal.identity_key);
    if (!existing) {
      let attempts = 0;
      while (reservedIds.has(cgId) && identityById.get(cgId) !== goal.identity_key && attempts < 100) {
        cgId = cgId >= MAX_CG_ID ? 1 : cgId + 1;
        attempts += 1;
      }
      if (reservedIds.has(cgId) && identityById.get(cgId) !== goal.identity_key) {
        throw new Error('Could not allocate a unique Community Goal ID');
      }
      reservedIds.add(cgId);
      identityById.set(cgId, goal.identity_key);
    }

    const row: Record<string, any> = {
      ...goal,
      cg_id: cgId,
      source,
      source_updated_at: new Date(incomingAt).toISOString(),
      updated_at: now,
    };
    if (!existing) {
      row.moderation_status = source === 'journal' && options.pendingJournalGoals !== false ? 'pending' : 'approved';
    } else if (SOURCE_PRIORITY[source] > SOURCE_PRIORITY[existing.source as keyof typeof SOURCE_PRIORITY]) {
      // Better authenticated sources can clear an automatic journal-only review
      // queue, but never undo an explicit moderator hide/rejection.
      if (existing.moderation_status === 'pending') row.moderation_status = 'approved';
    }
    rows.push(row);
  }

  if (rows.length === 0) return 0;
  const { error } = await svc.from('community_goals').upsert(rows, { onConflict: 'cg_id' });
  if (error) throw new Error(`Community Goal catalog upsert failed: ${error.message}`);
  return rows.length;
}

export async function syncCommunityGoalsFromCapi(svc: ServiceClient, payload: unknown): Promise<number> {
  return upsertCommunityGoalCatalog(svc, normalizeCapiCommunityGoals(payload), 'capi');
}

export async function syncCommunityGoalsFromJournal(svc: ServiceClient, reports: unknown): Promise<number> {
  return upsertCommunityGoalCatalog(svc, normalizeJournalCommunityGoals(reports), 'journal');
}
