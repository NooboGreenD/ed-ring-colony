/**
 * Безопасная привязка имени CMDR из Frontier CAPI к профилю сайта.
 *
 * CAPI и Colonial Helper знают игровое имя, а публичное досье открывается по
 * `profiles.cmdr_name`. Нельзя искать CAPI только по имени: пользователь мог
 * изменить ник на сайте, а два источника могут вернуть разный регистр. UUID
 * пользователя остаётся главным ключом, имя используется только для URL и
 * первоначального заполнения пустого профиля.
 */

export type ProfileBindingStatus = 'linked' | 'already_linked' | 'conflict' | 'missing';

export interface ProfileBinding {
  status: ProfileBindingStatus;
  /** Имя, которое можно безопасно использовать для ссылки на досье. */
  displayName: string | null;
  /** Имя Frontier отличается от сохранённого профиля. */
  nameMismatch: boolean;
}

export function normalizePilotName(value: unknown): string {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

/**
 * Определить результат привязки без обращения к базе.
 *
 * Пустой профиль получает имя Frontier (`linked`). Непустой профиль никогда
 * не перезаписывается автоматически: совпадение — `already_linked`, различие
 * — `conflict`, чтобы смена ника в CAPI не перелила статистику в чужое URL.
 */
export function assessProfileBinding(
  profileName: unknown,
  frontierName: unknown,
): ProfileBinding {
  const profile = String(profileName ?? '').trim().replace(/\s+/g, ' ');
  const frontier = String(frontierName ?? '').trim().replace(/\s+/g, ' ');

  if (!frontier) {
    return { status: 'missing', displayName: profile || null, nameMismatch: false };
  }
  if (!profile) {
    return { status: 'linked', displayName: frontier, nameMismatch: false };
  }
  const same = normalizePilotName(profile) === normalizePilotName(frontier);
  return {
    status: same ? 'already_linked' : 'conflict',
    displayName: profile,
    nameMismatch: !same,
  };
}
