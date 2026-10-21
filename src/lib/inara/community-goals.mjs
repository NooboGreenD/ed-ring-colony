/**
 * Convert the documented Inara getCommunityGoalsRecent payload to the
 * community_goals table shape. Inara does not expose a goal ID in this
 * read-only event, so use a stable numeric key derived from its identity.
 */

function asText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function asNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function asTier(value) {
  const numeric = asNumber(value);
  if (numeric !== null) return numeric;
  const match = asText(value).match(/\d+/);
  return match ? Number(match[0]) : null;
}

function stableGoalId(identity) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < identity.length; index += 1) {
    hash ^= identity.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  // Keep the value within PostgreSQL's positive INTEGER range.
  return (hash >>> 0) & 0x7fffffff || 1;
}

/** @param {Record<string, unknown>} goal */
export function normalizeCommunityGoal(goal) {
  const title = asText(goal.communitygoalName ?? goal.cgName);
  const systemName = asText(goal.starsystemName ?? goal.systemName);
  const stationName = asText(goal.stationName ?? goal.marketName);
  const objective = asText(goal.goalObjectiveText ?? goal.objective);
  const description = asText(goal.goalDescriptionText ?? goal.description);
  const reward = asText(goal.goalRewardText ?? goal.reward);
  const expiryDate = asText(goal.goalExpiry ?? goal.expiryDate ?? goal.expiry);
  const sourceId = asNumber(goal.communitygoalGameID ?? goal.cgID);
  const identity = JSON.stringify([title, systemName, stationName, expiryDate]);
  const id = sourceId !== null && Number.isInteger(sourceId) && sourceId > 0
    ? sourceId
    : stableGoalId(identity);
  const inaraUrl = asText(goal.inaraURL);
  const sourceUpdatedAt = asText(goal.lastUpdate);
  const searchableText = `${title} ${objective} ${description}`;

  return {
    cg_id: id,
    title,
    description: description || objective || null,
    system_name: systemName || null,
    station_name: stationName || null,
    objective: objective || null,
    reward: reward || null,
    tier_current: asTier(goal.tierReached),
    tier_max: asTier(goal.tierMax),
    contributors: asNumber(goal.contributorsNum ?? goal.contributors),
    contributions_total: asNumber(goal.contributionsTotal),
    expiry_date: expiryDate || null,
    is_complete: goal.isCompleted === true || goal.isCompleted === 1 || goal.isCompleted === 'true',
    is_colonisation_related: /colonisation|coloni[sz]ation|colony|construction|settlement/i.test(searchableText),
    inara_url: /^https:\/\/inara\.cz\//i.test(inaraUrl) ? inaraUrl : null,
    source_updated_at: Number.isFinite(Date.parse(sourceUpdatedAt)) ? sourceUpdatedAt : null,
    raw_data: goal,
    updated_at: new Date().toISOString(),
  };
}

/**
 * @param {Record<string, unknown>[]} goals
 * @returns {ReturnType<typeof normalizeCommunityGoal>[]}
 */
export function normalizeCommunityGoals(goals) {
  return goals
    .filter((goal) => asText(goal.communitygoalName ?? goal.cgName))
    .map(normalizeCommunityGoal);
}
