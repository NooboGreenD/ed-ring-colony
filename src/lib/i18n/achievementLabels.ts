/**
 * Подписи достижений пилота.
 *
 * Данные (`src/lib/achievements.ts`) остаются русскими: по ним сверяют правки
 * и на них опираются тесты. Интерфейс берёт подпись из каталога по id дорожки
 * и номеру ранга — `ach.<дорожка>.title|subtitle|unit|r1…r10`, гербовые знаки —
 * `ach.hero.<дорожка>.name|desc`. Нет ключа — показываем русский оригинал.
 */

export type AchievementTranslate = (key: string, params?: Record<string, string | number>) => string;

function pick(key: string, fallback: string, t: AchievementTranslate): string {
  const value = t(key);
  return value === key ? fallback : value;
}

/** Заголовок дорожки: «Экспедиционер», «Металлург», … */
export function achievementTrackTitle(trackId: string, fallback: string, t: AchievementTranslate): string {
  return pick(`ach.${trackId}.title`, fallback, t);
}

/** Подпись дорожки: что именно считаем — «Завезено стали»… */
export function achievementTrackSubtitle(trackId: string, fallback: string, t: AchievementTranslate): string {
  return pick(`ach.${trackId}.subtitle`, fallback, t);
}

/** Название ранга T1–T10. */
export function achievementRankName(
  trackId: string,
  rank: number,
  fallback: string,
  t: AchievementTranslate,
): string {
  return pick(`ach.${trackId}.r${rank}`, fallback, t);
}

/**
 * Описание ранга: порог и единица измерения. Число форматируем локалью
 * интерфейса, а не русской, иначе в английском видно «25 000».
 */
export function achievementRankDesc(
  trackId: string,
  threshold: number,
  fallback: string,
  t: AchievementTranslate,
  locale: string,
): string {
  const unit = t(`ach.${trackId}.unit`);
  if (unit === `ach.${trackId}.unit`) return fallback;
  return `${threshold.toLocaleString(locale)}+ ${unit}`;
}

/** Имя гербового знака за пределами T10. */
export function heroBadgeName(trackId: string, fallback: string, t: AchievementTranslate): string {
  return pick(`ach.hero.${trackId}.name`, fallback, t);
}

/** Описание гербового знака: «50 000 000+ тонн груза». */
export function heroBadgeDesc(trackId: string, fallback: string, t: AchievementTranslate): string {
  return pick(`ach.hero.${trackId}.desc`, fallback, t);
}
