/**
 * Конфиденциальность досье пилота.
 *
 * Досье `/cmdr/[name]` публично, но часть данных в нём — личная: баланс
 * кредитов и ARX, ранги, текущее положение корабля, история поставок. Командир
 * управляет этим в личном кабинете (`/account` → «Конфиденциальность»),
 * настройки лежат в `profiles.privacy_settings` (JSONB).
 *
 * Правила, которые обязан соблюдать любой, кто отдаёт чужие данные наружу:
 *
 * 1. **Отсутствующий ключ = показывать.** Профили, созданные до миграции
 *    `20260918010000_profile_privacy_settings`, не должны внезапно «погаснуть».
 * 2. **Фильтрация происходит на сервере**, до рендера: клиенту просто не
 *    приходят скрытые числа, поэтому их нельзя достать из HTML или из
 *    props'ов компонента.
 * 3. **Владелец видит всё.** На своей собственной странице командир всегда
 *    видит настоящие значения — иначе он не смог бы проверить, что скрыл.
 */

/** Ключи настроек; значение `true` = показывать другим. */
export type PrivacyKey = 'balance' | 'ranks' | 'cargo' | 'deliveries' | 'location';

export const PRIVACY_KEYS: readonly PrivacyKey[] = ['balance', 'ranks', 'cargo', 'deliveries', 'location'];

export type PrivacySettings = Record<PrivacyKey, boolean>;

/** Значения по умолчанию: всё публично (совпадает с поведением до настроек). */
export const DEFAULT_PRIVACY: PrivacySettings = {
  balance: true,
  ranks: true,
  cargo: true,
  deliveries: true,
  location: true,
};

/**
 * Разобрать `profiles.privacy_settings` в полный набор переключателей.
 *
 * Принимает что угодно из базы/клиента (JSONB, строку, null) и никогда не
 * бросает: битые настройки не должны ронять чужое досье.
 */
export function resolvePrivacy(raw: unknown): PrivacySettings {
  let source: unknown = raw;
  if (typeof raw === 'string') {
    try {
      source = JSON.parse(raw);
    } catch {
      source = null;
    }
  }
  if (!source || typeof source !== 'object' || Array.isArray(source)) return { ...DEFAULT_PRIVACY };

  const record = source as Record<string, unknown>;
  const resolved = { ...DEFAULT_PRIVACY };
  for (const key of PRIVACY_KEYS) {
    const value = record[key];
    // Принимаем только явный boolean: строка «false» из старого клиента
    // иначе стала бы `true` и открыла бы то, что командир закрыл.
    if (typeof value === 'boolean') resolved[key] = value;
    else if (typeof value === 'string' && (value === 'true' || value === 'false')) {
      resolved[key] = value === 'true';
    }
  }
  return resolved;
}

/** Настройки, которые увидит конкретный зритель. Владелец всегда видит всё. */
export function privacyForViewer(
  raw: unknown,
  viewerId: string | null | undefined,
  ownerId: string | null | undefined,
): PrivacySettings {
  const settings = resolvePrivacy(raw);
  if (viewerId && ownerId && viewerId === ownerId) return { ...DEFAULT_PRIVACY };
  return settings;
}

/** Payload для записи в `profiles.privacy_settings`. */
export function privacyPayload(partial: Partial<PrivacySettings>): Record<string, boolean> {
  const payload: Record<string, boolean> = {};
  for (const key of PRIVACY_KEYS) {
    const value = partial[key];
    if (typeof value === 'boolean') payload[key] = value;
  }
  return payload;
}

/** Подпись скрытого блока для досье (одинаковая во всех разделах). */
export const HIDDEN_PLACEHOLDER = '—';

/**
 * Обнулить поля, которые зритель видеть не должен.
 *
 * Используется страницей досье перед передачей данных в клиентский компонент:
 * скрытое не просто прячется вёрсткой, а не уходит в браузер вовсе.
 */
export function maskPilotStats<T extends Record<string, any> | null | undefined>(
  stats: T,
  privacy: PrivacySettings,
): T {
  if (!stats) return stats;
  const masked: Record<string, any> = { ...stats };

  if (!privacy.balance) {
    for (const field of ['credits', 'arx', 'mercenary_coins', 'bio_value_cr']) {
      if (field in masked) masked[field] = null;
    }
  }
  if (!privacy.ranks) {
    for (const field of [
      'combat_rank',
      'trade_rank',
      'explore_rank',
      'empire_rank',
      'federation_rank',
      'mercenary_rank',
      'exobiologist_rank',
    ]) {
      if (field in masked) masked[field] = null;
    }
  }
  if (!privacy.location) {
    for (const field of ['current_ship', 'current_system', 'current_station']) {
      if (field in masked) masked[field] = null;
    }
  }
  return masked as T;
}

/** То же для блока Frontier CAPI в досье. */
export function maskCapiProfile<T extends Record<string, any> | null | undefined>(
  profile: T,
  privacy: PrivacySettings,
): T {
  if (!profile) return profile;
  const masked: Record<string, any> = { ...profile };
  if (!privacy.balance && 'credits' in masked) masked.credits = null;
  if (!privacy.ranks) {
    for (const field of ['combat_rank', 'trade_rank', 'explore_rank', 'empire_rank', 'federation_rank']) {
      if (field in masked) masked[field] = null;
    }
  }
  if (!privacy.location) {
    for (const field of ['current_ship', 'current_system', 'current_station']) {
      if (field in masked) masked[field] = null;
    }
  }
  return masked as T;
}
