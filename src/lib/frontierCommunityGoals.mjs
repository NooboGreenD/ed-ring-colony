import { normalizeCommunityGoal } from './inara/community-goals.mjs';

export const FRONTIER_PUBLIC_COMMUNITY_GOALS_URL = 'https://api.orerve.net/2.0/website/initiatives/list?lang=en';

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function asText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function asQuantity(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const normalized = value.trim().replace(/[\s,\u00a0\u202f]/g, '');
  if (!/^\d+$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function asGameId(value) {
  const parsed = asQuantity(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function asExpiry(value) {
  const text = asText(value);
  if (!text) return null;
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)
    ? text
    : `${text.replace(' ', 'T')}Z`;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/** Normalize Frontier's public website initiatives response. It contains no pilot-specific fields. */
export function normalizeFrontierPublicCommunityGoals(payload, observedAt = new Date().toISOString()) {
  const container = asObject(payload);
  const initiatives = Array.isArray(container?.activeInitiatives) ? container.activeInitiatives : [];

  return initiatives.flatMap((value) => {
    const initiative = asObject(value);
    if (!initiative) return [];
    const title = asText(initiative.title);
    if (!title) return [];

    const expiryDate = asExpiry(initiative.expiry);
    const currentTotal = asQuantity(initiative.qty);
    const targetTotal = asQuantity(initiative.target_qty);
    const systemName = asText(initiative.starsystem_name);
    const stationName = asText(initiative.market_name);
    const description = asText(initiative.bulletin);
    const objective = asText(initiative.objective);
    const gameId = asGameId(initiative.id);

    const normalized = normalizeCommunityGoal({
      communitygoalGameID: gameId,
      communitygoalName: title,
      starsystemName: systemName,
      stationName,
      goalDescriptionText: description,
      goalObjectiveText: objective,
      contributionsTotal: currentTotal,
      goalExpiry: expiryDate,
      isCompleted: false,
      lastUpdate: observedAt,
    });

    return [{
      ...normalized,
      contributions_total: currentTotal,
      contributions_target: targetTotal,
      source_updated_at: observedAt,
      // Keep only this public feed's catalog data; it contains no commander contribution.
      raw_data: {
        id: initiative.id ?? null,
        title,
        bulletin: description || null,
        objective: objective || null,
        qty: currentTotal,
        target_qty: targetTotal,
        expiry: expiryDate,
        starsystem_name: systemName || null,
        market_name: stationName || null,
      },
    }];
  });
}

/** Frontier's public initiatives API is separate from Companion CAPI and requires no OAuth token. */
export async function fetchFrontierPublicCommunityGoals(fetchImpl = fetch) {
  const response = await fetchImpl(FRONTIER_PUBLIC_COMMUNITY_GOALS_URL, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'User-Agent': 'ED Ring Colony community-goal catalogue',
    },
    cache: 'no-store',
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`Frontier public Community Goals returned HTTP ${response.status}`);

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error('Frontier public Community Goals returned invalid JSON');
  }
  if (!Array.isArray(asObject(payload)?.activeInitiatives)) {
    throw new Error('Frontier public Community Goals response has no activeInitiatives list');
  }
  return payload;
}
