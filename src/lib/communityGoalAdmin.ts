export const COMMUNITY_GOAL_MODERATION_STATUSES = ['approved', 'hidden', 'rejected'] as const;
export type CommunityGoalModerationStatus = typeof COMMUNITY_GOAL_MODERATION_STATUSES[number];

export const COMMUNITY_GOAL_EDITABLE_FIELDS = [
  'title',
  'description',
  'system_name',
  'station_name',
  'objective',
  'reward',
  'tier_current',
  'tier_max',
  'contributors',
  'contributions_total',
  'expiry_date',
  'is_complete',
  'is_colonisation_related',
  'inara_url',
] as const;

export type CommunityGoalEditableField = typeof COMMUNITY_GOAL_EDITABLE_FIELDS[number];
export type CommunityGoalOverrides = Partial<Record<CommunityGoalEditableField, unknown>>;

/** Apply persisted moderator edits without mutating the upstream Inara copy. */
export function effectiveCommunityGoal<T extends Record<string, any>>(goal: T): T {
  const overrides = goal.manual_overrides && typeof goal.manual_overrides === 'object'
    && !Array.isArray(goal.manual_overrides)
    ? goal.manual_overrides as Record<string, unknown>
    : {};
  const content: Record<string, unknown> = {};
  for (const field of COMMUNITY_GOAL_EDITABLE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(overrides, field)) content[field] = overrides[field];
  }
  return { ...goal, ...content };
}

export function isCommunityGoalModerationStatus(value: unknown): value is CommunityGoalModerationStatus {
  return typeof value === 'string'
    && (COMMUNITY_GOAL_MODERATION_STATUSES as readonly string[]).includes(value);
}
