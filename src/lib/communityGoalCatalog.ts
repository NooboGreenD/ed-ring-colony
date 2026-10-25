import { communityGoalIdentityKey, normalizeCommunityGoal } from './inara/community-goals.mjs';

type GoalSource = 'inara' | 'capi' | 'journal';
type ServiceClient = any;
type CatalogGoal = Record<string, any> & {
  identity_key: string;
  cg_id: number;
  game_cg_id?: number | null;
};

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
export function normalizeJournalCommunityGoals(reports: unknown, now = new Date()): CatalogGoal[] {
  if (!Array.isArray(reports)) return [];
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  return reports.flatMap((item) => {
    const report = asObject(item);
    if (!report) return [];
    const title = report.title ?? report.Title;
    if (typeof title !== 'string' || !title.trim()) return [];
    const expiryValue = report.expiry_date ?? report.Expiry;
    const expiryMs = typeof expiryValue === 'string' ? Date.parse(expiryValue) : NaN;
    // A history import can contain years of CG snapshots. Keep those in the
    // private commander-report table, but only put still-active discoveries
    // in the public catalogue review queue.
    if (!Number.isFinite(nowMs) || !Number.isFinite(expiryMs) || expiryMs <= nowMs
        || report.is_complete === true || report.IsComplete === true) return [];
    const observedAt = cleanDate(report.observed_at ?? report.timestamp, new Date().toISOString());
    const normalized = normalizeCommunityGoal({
      communitygoalGameID: report.game_cg_id ?? report.CGID,
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
        game_cg_id: normalized.game_cg_id,
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

  // A historical import may contain multiple snapshots for one in-game goal
  // whose title/location fields changed. Collapse by actual game ID as well as
  // by text identity before constructing one database upsert batch.
  const byGameId = new Map<number, CatalogGoal>();
  const goalsWithoutGameId: CatalogGoal[] = [];
  for (const goal of byIdentity.values()) {
    const gameId = Number(goal.game_cg_id);
    if (!Number.isSafeInteger(gameId) || gameId <= 0) {
      goalsWithoutGameId.push(goal);
      continue;
    }
    const previous = byGameId.get(gameId);
    const previousAt = Date.parse(previous?.source_updated_at || '') || 0;
    const candidateAt = Date.parse(goal.source_updated_at || '') || 0;
    if (!previous || candidateAt >= previousAt) byGameId.set(gameId, goal);
  }
  const goals = [...goalsWithoutGameId, ...byGameId.values()];
  if (goals.length === 0) return 0;

  const identities = goals.map((goal) => goal.identity_key);
  const gameIds = Array.from(new Set(goals
    .map((goal) => Number(goal.game_cg_id))
    .filter((id) => Number.isSafeInteger(id) && id > 0)));
  const selectColumns = 'cg_id,game_cg_id,identity_key,source,source_updated_at,moderation_status,title,description,system_name,station_name,objective,reward,expiry_date,inara_url,raw_data';
  const { data: existingRows, error: lookupError } = await svc
    .from('community_goals')
    .select(selectColumns)
    .in('identity_key', identities);
  if (lookupError) throw new Error(`Community Goal identity lookup failed: ${lookupError.message}`);
  const existingByIdentity = new Map<string, Record<string, any>>();
  const preferExisting = (previous: Record<string, any> | undefined, candidate: Record<string, any>) => {
    if (!previous) return candidate;
    const previousPriority = SOURCE_PRIORITY[previous.source as keyof typeof SOURCE_PRIORITY] || 0;
    const candidatePriority = SOURCE_PRIORITY[candidate.source as keyof typeof SOURCE_PRIORITY] || 0;
    const previousAt = Date.parse(previous.source_updated_at || '') || 0;
    const candidateAt = Date.parse(candidate.source_updated_at || '') || 0;
    return candidatePriority > previousPriority
      || (candidatePriority === previousPriority && candidateAt > previousAt)
      ? candidate
      : previous;
  };
  for (const row of Array.isArray(existingRows) ? existingRows : []) {
    existingByIdentity.set(row.identity_key, preferExisting(existingByIdentity.get(row.identity_key), row));
  }

  const existingByGameId = new Map<number, Record<string, any>>();
  if (gameIds.length > 0) {
    const { data: gameRows, error: gameLookupError } = await svc
      .from('community_goals')
      .select(selectColumns)
      .in('game_cg_id', gameIds);
    if (gameLookupError) throw new Error(`Community Goal game-ID lookup failed: ${gameLookupError.message}`);
    for (const row of Array.isArray(gameRows) ? gameRows : []) {
      const gameId = Number(row.game_cg_id);
      existingByGameId.set(gameId, preferExisting(existingByGameId.get(gameId), row));
    }
  }

  // Rows imported before identity_key was introduced have NULL there. Match
  // their canonical fields/game ID so fallbacks don't create duplicate CGs.
  const { data: legacyRows, error: legacyLookupError } = await svc
    .from('community_goals')
    .select(selectColumns)
    .is('identity_key', null);
  if (legacyLookupError) throw new Error(`Legacy Community Goal lookup failed: ${legacyLookupError.message}`);
  const wantedIdentities = new Set(identities);
  const wantedGameIds = new Set(gameIds);
  for (const row of Array.isArray(legacyRows) ? legacyRows : []) {
    const identity = communityGoalIdentityKey({
      title: row.title,
      systemName: row.system_name,
      stationName: row.station_name,
      expiryDate: row.expiry_date,
    });
    if (wantedIdentities.has(identity)) {
      existingByIdentity.set(identity, preferExisting(existingByIdentity.get(identity), row));
    }
    const gameId = Number(row.game_cg_id);
    if (wantedGameIds.has(gameId)) {
      existingByGameId.set(gameId, preferExisting(existingByGameId.get(gameId), row));
    }
  }

  const candidates = goals.map((goal) => ({
    goal,
    // Identity is the strict match. Game ID is the stable fallback when a
    // source changes spelling, expiry precision, or station naming.
    existing: existingByIdentity.get(goal.identity_key)
      || (goal.game_cg_id ? existingByGameId.get(Number(goal.game_cg_id)) : undefined),
  }));
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
    const existingPriority = existing
      ? SOURCE_PRIORITY[existing.source as keyof typeof SOURCE_PRIORITY]
      : 0;
    if (existing && existingPriority > SOURCE_PRIORITY[source]) {
      // A weaker feed may enrich missing text/ID, but cannot replace the
      // canonical source, title, moderation decision, or non-empty details.
      const enrichment: Record<string, any> = {
        ...goal,
        ...existing,
        cg_id: existing.cg_id,
        game_cg_id: existing.game_cg_id ?? goal.game_cg_id ?? null,
        identity_key: existing.identity_key || goal.identity_key,
        source: existing.source,
        source_updated_at: existing.source_updated_at,
        updated_at: now,
      };
      let changed = existing.game_cg_id == null && goal.game_cg_id != null;
      for (const field of ['description', 'objective', 'reward', 'system_name', 'station_name', 'expiry_date', 'inara_url']) {
        const previous = existing[field];
        const incoming = goal[field];
        if ((previous === null || previous === undefined || previous === '')
            && incoming !== null && incoming !== undefined && incoming !== '') {
          enrichment[field] = incoming;
          changed = true;
        }
      }
      if (changed) rows.push(enrichment);
      continue;
    }
    const currentAt = Date.parse(existing?.source_updated_at || '') || 0;
    const incomingAt = Date.parse(goal.source_updated_at || '') || Date.parse(now);
    if (existing && existing.source === source && incomingAt < currentAt) continue;

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
      // Keep the existing identity as a canonical anchor after an ID-based
      // match; future reports from any source can still find this same row.
      identity_key: existing?.identity_key || goal.identity_key,
      game_cg_id: goal.game_cg_id ?? existing?.game_cg_id ?? null,
      source,
      source_updated_at: new Date(incomingAt).toISOString(),
      updated_at: now,
    };
    // Sparse upstream snapshots must not erase useful description/objective/
    // reward/location details collected from another independent source.
    if (existing) {
      for (const field of ['description', 'objective', 'reward', 'system_name', 'station_name', 'expiry_date', 'inara_url']) {
        const incoming = row[field];
        const previous = existing[field];
        if ((incoming === null || incoming === undefined || incoming === '')
            && previous !== null && previous !== undefined && previous !== '') {
          row[field] = previous;
        }
      }
    }
    if (!existing) {
      row.moderation_status = source === 'journal' && options.pendingJournalGoals !== false ? 'pending' : 'approved';
    } else {
      row.moderation_status = existing.moderation_status;
      if (SOURCE_PRIORITY[source] > SOURCE_PRIORITY[existing.source as keyof typeof SOURCE_PRIORITY]
          && existing.moderation_status === 'pending') {
        // Better authenticated sources clear automatic journal review, but
        // never undo an explicit moderator hide/rejection.
        row.moderation_status = 'approved';
      }
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

export async function syncCommunityGoalsFromJournal(
  svc: ServiceClient,
  reports: unknown,
  options: { now?: Date } = {},
): Promise<number> {
  return upsertCommunityGoalCatalog(
    svc,
    normalizeJournalCommunityGoals(reports, options.now ?? new Date()),
    'journal',
  );
}
