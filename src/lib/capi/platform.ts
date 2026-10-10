/** Платформы Frontier OAuth. Выбранный audience не доказывает платформу токена. */
export const FRONTIER_AUDIENCES = ['frontier', 'steam', 'epic', 'xbox', 'psn'] as const;
export type FrontierAudience = (typeof FRONTIER_AUDIENCES)[number];
export const DEFAULT_AUDIENCE = 'frontier,steam,epic';

const ALIASES: Record<string, string> = {
  egs: 'epic',
  epicgames: 'epic',
  'epic-games': 'epic',
  'epic games store': 'epic',
  frontierstore: 'frontier',
};

/** Только подтверждённое одиночное значение; неизвестное НЕ становится frontier. */
export function normalizePlatform(value: unknown): FrontierAudience | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim().toLowerCase();
  const platform = ALIASES[raw] || raw;
  return FRONTIER_AUDIENCES.includes(platform as FrontierAudience) ? platform as FrontierAudience : null;
}

/** Пусто/auto/all → список EDMC; списки чистятся от мусора и дублей. */
export function normalizeAudience(value: unknown): string {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw || ['auto', 'all', 'any'].includes(raw)) return DEFAULT_AUDIENCE;
  const single = normalizePlatform(raw);
  if (single) return single;
  const kept = raw.split(/[,\s]+/).map(normalizePlatform).filter(Boolean);
  return [...new Set(kept)].join(',') || DEFAULT_AUDIENCE;
}

/** В UI список audience — «Авто», а не первый элемент списка (frontier). */
export function platformSelection(value: unknown): FrontierAudience | 'auto' {
  return normalizePlatform(value) || 'auto';
}
