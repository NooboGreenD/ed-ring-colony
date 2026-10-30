/**
 * Единое правило «цель завершена» для каталога CG.
 *
 * Frontier присылает в публичном фиде только активные инициативы: когда срок
 * цели истекает, строка просто исчезает из ответа, а её `is_complete` в базе
 * навсегда остаётся `false`. Поэтому завершённость считается не только по
 * флагу источника, но и по сроку: цель с прошедшим `expiry_date` считается
 * завершённой, даже если источник о ней уже молчит.
 */

export type CommunityGoalFilter = 'all' | 'active' | 'colonisation' | 'completed';

export interface CommunityGoalTiming {
  is_complete?: boolean | null;
  is_colonisation_related?: boolean | null;
  expiry_date?: string | null;
}

/** Момент истечения срока цели в миллисекундах, либо null для «бессрочной». */
export function communityGoalExpiryTime(goal: CommunityGoalTiming | null | undefined): number | null {
  const value = goal?.expiry_date;
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Срок цели уже прошёл к указанному моменту. */
export function isCommunityGoalExpired(
  goal: CommunityGoalTiming | null | undefined,
  now: number = Date.now(),
): boolean {
  const expiry = communityGoalExpiryTime(goal);
  return expiry !== null && expiry <= now;
}

/** Завершённость цели: явный флаг источника ИЛИ прошедший срок. */
export function isCommunityGoalComplete(
  goal: CommunityGoalTiming | null | undefined,
  now: number = Date.now(),
): boolean {
  return goal?.is_complete === true || isCommunityGoalExpired(goal, now);
}

/** Копия цели с пересчитанным `is_complete` (для API и клиентских фильтров). */
export function withCommunityGoalCompletion<T extends CommunityGoalTiming>(
  goal: T,
  now: number = Date.now(),
): T & { is_complete: boolean } {
  return { ...goal, is_complete: isCommunityGoalComplete(goal, now) };
}

/** Совпадение цели выбранному фильтру страницы. */
export function communityGoalMatchesFilter(
  goal: CommunityGoalTiming | null | undefined,
  filter: CommunityGoalFilter,
  now: number = Date.now(),
): boolean {
  if (filter === 'all') return true;
  const complete = isCommunityGoalComplete(goal, now);
  if (filter === 'completed') return complete;
  if (filter === 'active') return !complete;
  return !complete && goal?.is_colonisation_related === true;
}
