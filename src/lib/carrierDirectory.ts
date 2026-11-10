/**
 * «Трафик авианосцев» Атласа — чистые правила поиска и личных записей.
 *
 * Реестр носителей (`fleet_carriers`) собирается всем сайтом: Helper и загрузка
 * журналов присылают `CarrierJump`, `CarrierLocation`, `Docked` и рыночные
 * события. Атлас показывает по нему **все** известные авианосцы галактики:
 * ищет по позывному (тегу), имени, системе и MarketID, позволяет добавить
 * носитель в избранное и написать к нему комментарий.
 *
 * Избранное и заметки — личные: на сервере они лежат в `atlas_carrier_watch`
 * (RLS по `auth.uid()`), а у гостя — в localStorage браузера. Поэтому все
 * правила «что считается одной записью», «как сливать сервер и браузер» и
 * «как искать» живут здесь, без React и без БД: их проверяют тесты
 * (`scripts/tests/atlas-carriers.test.mjs`), клиент и маршрут используют одни
 * и те же функции — дублей и расхождений между ними быть не может.
 */

/** Максимальная длина комментария — как у избранного Atlas (`atlas_favorites.note`). */
export const CARRIER_NOTE_MAX = 500;
/** Сколько результатов отдаём по умолчанию и максимум. */
export const CARRIER_SEARCH_LIMIT = 40;
export const CARRIER_SEARCH_MAX = 100;
/** Минимальная длина запроса: одна буква дала бы половину реестра. */
export const CARRIER_QUERY_MIN = 2;
/** Сколько избранного имеет смысл показывать без поиска. */
export const CARRIER_WATCH_LIMIT = 200;

export type CarrierWatchScope = 'all' | 'favorites';

/**
 * Личная запись об авианосце: избранное, комментарий и — если пилот подписался
 * на прыжок — снимок плана на момент подписки (страница `/carriers/jumps`).
 */
export interface CarrierWatch {
  id: string;
  /** MarketID носителя строкой — так он приходит со всех сторон. */
  carrierId: string;
  callsign: string | null;
  name: string | null;
  /** Система на момент добавления: у гостя это единственный источник. */
  system: string | null;
  favorite: boolean;
  note: string | null;
  updatedAt: string | null;
  /** Куда носитель собирался прыгнуть, когда пилот подписался на прыжок. */
  jumpSystem?: string | null;
  /** Когда был заказан тот прыжок. */
  jumpDepartureAt?: string | null;
  /** Когда снимок сделан (последняя подписка/обновление). */
  jumpSeenAt?: string | null;
}

/** Минимум, который нужен от авианосца, чтобы показать его в списке. */
export interface CarrierDirectoryEntry {
  id: string;
  callsign: string | null;
  name: string | null;
  owner: string | null;
  system: string;
}

function text(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

/**
 * Нормализованная строка запроса: без лишних пробелов, в нижнем регистре.
 * Дефисы в позывных («K7Q-BQL») не значимы для поиска — их снимает `tokens`.
 */
export function normalizeCarrierQuery(value: unknown): string {
  return text(value).replace(/\s+/g, ' ').toLowerCase();
}

/** Слова запроса: «K7Q steel» → ['k7q', 'steel']. */
export function carrierQueryTokens(value: unknown): string[] {
  const normalized = normalizeCarrierQuery(value);
  return normalized ? normalized.split(' ').filter(Boolean) : [];
}

/**
 * Совпадает ли запись с запросом. Все слова обязаны найтись — так же, как в
 * поиске фракций: «K7Q колония» не покажет все носители с «колония».
 */
export function carrierMatchesQuery(entry: CarrierDirectoryEntry, query: unknown): boolean {
  const tokens = carrierQueryTokens(query);
  if (tokens.length === 0) return true;
  const callsign = text(entry.callsign).toLowerCase();
  const haystack = [
    text(entry.id).toLowerCase(),
    callsign,
    // Позывной без дефиса: «k7qbql» находит «K7Q-BQL».
    callsign.replace(/[^a-z0-9]/g, ''),
    text(entry.name).toLowerCase(),
    text(entry.owner).toLowerCase(),
    text(entry.system).toLowerCase(),
  ].filter(Boolean);
  return tokens.every((token) => {
    if (haystack.some((value) => value.includes(token))) return true;
    // Второй проход без разделителей: «k7qbql» находит «K7Q-BQL»,
    // «hippione» — имя, записанное с апострофом или дефисом.
    const plain = token.replace(/[^a-z0-9]/g, '');
    return plain !== '' && haystack.some((value) => value.replace(/[^a-z0-9]/g, '').includes(plain));
  });
}

function watchIndex(watches: readonly CarrierWatch[]): Map<string, CarrierWatch> {
  const map = new Map<string, CarrierWatch>();
  for (const watch of watches) {
    const key = text(watch.carrierId);
    if (key) map.set(key, watch);
  }
  return map;
}

export function watchFor(watches: readonly CarrierWatch[], carrierId: string | number): CarrierWatch | null {
  return watchIndex(watches).get(text(carrierId)) ?? null;
}

export function isFavoriteCarrier(watches: readonly CarrierWatch[], carrierId: string | number): boolean {
  return watchFor(watches, carrierId)?.favorite === true;
}

/**
 * Слияние серверного и локального списков: сервер главнее.
 *
 * Гость добавляет носители в браузер, потом входит — серверные записи не
 * должны затираться локальными, но и локальные нельзя терять: они могли быть
 * сделаны только что, до следующей синхронизации.
 */
export function mergeCarrierWatches(
  server: readonly CarrierWatch[] | null | undefined,
  local: readonly CarrierWatch[] | null | undefined,
): CarrierWatch[] {
  const merged: CarrierWatch[] = [];
  const seen = new Set<string>();
  for (const watch of [...(server ?? []), ...(local ?? [])]) {
    const key = text(watch.carrierId);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(watch);
  }
  return merged;
}

/** Поля записи, которые приходят из формы или из карточки носителя. */
export interface CarrierWatchInput {
  carrierId?: unknown;
  callsign?: unknown;
  name?: unknown;
  system?: unknown;
  favorite?: unknown;
  note?: unknown;
}

export type CarrierWatchNormalized =
  | { ok: true; value: Omit<CarrierWatch, 'id' | 'updatedAt'> }
  | { ok: false; error: string };

/**
 * Проверить запись перед сохранением: нужен MarketID, остальное — по желанию.
 * Комментарий обрезается по `CARRIER_NOTE_MAX`, а не отвергается: пилот
 * вставил длинный текст — пусть сохранится столько, сколько влезает.
 */
export function normalizeCarrierWatch(input: CarrierWatchInput): CarrierWatchNormalized {
  const carrierId = text(input.carrierId).slice(0, 32);
  if (!carrierId) return { ok: false, error: 'carrier_id is required' };
  if (!/^\d+$/.test(carrierId)) return { ok: false, error: 'carrier_id must be a MarketID' };
  const noteRaw = text(input.note);
  return {
    ok: true,
    value: {
      carrierId,
      callsign: text(input.callsign).slice(0, 16) || null,
      name: text(input.name).slice(0, 80) || null,
      system: text(input.system).slice(0, 80) || null,
      favorite: input.favorite !== false,
      note: noteRaw ? noteRaw.slice(0, CARRIER_NOTE_MAX) : null,
    },
  };
}

/** Порядок в списке: избранные, затем те, где есть заметка, затем по имени. */
export function orderCarrierDirectory<T extends CarrierDirectoryEntry>(
  entries: readonly T[],
  watches: readonly CarrierWatch[],
): T[] {
  const index = watchIndex(watches);
  const weight = (entry: T) => {
    const watch = index.get(text(entry.id));
    if (watch?.favorite) return 0;
    if (watch?.note) return 1;
    return 2;
  };
  return [...entries].sort((left, right) => {
    const byWeight = weight(left) - weight(right);
    if (byWeight !== 0) return byWeight;
    const leftLabel = `${left.callsign ?? ''} ${left.name ?? ''}`.trim().toLowerCase();
    const rightLabel = `${right.callsign ?? ''} ${right.name ?? ''}`.trim().toLowerCase();
    if (leftLabel !== rightLabel) return leftLabel < rightLabel ? -1 : 1;
    return text(left.system).localeCompare(text(right.system));
  });
}

/** Сколько из списка в избранном — для счётчика на панели. */
export function countFavorites(entries: readonly CarrierDirectoryEntry[], watches: readonly CarrierWatch[]): number {
  const index = watchIndex(watches);
  return entries.reduce((sum, entry) => sum + (index.get(text(entry.id))?.favorite ? 1 : 0), 0);
}

/** Подпись носителя: позывной важнее имени, если есть оба. */
export function carrierLabel(entry: { callsign?: string | null; name?: string | null; id?: string | number }): string {
  const callsign = text(entry.callsign);
  const name = text(entry.name);
  if (callsign && name) return `${callsign} · ${name}`;
  return callsign || name || text(entry.id);
}

/** Ключ localStorage для гостевого избранного. */
export const CARRIER_WATCH_LOCAL_KEY = 'atlas:carrier-watch-local';

/** Прочитать локальные записи из localStorage (только в браузере). */
export function readLocalCarrierWatches(storage?: Storage | null): CarrierWatch[] {
  const store = storage ?? (typeof window === 'undefined' ? null : window.localStorage);
  if (!store) return [];
  try {
    const raw = store.getItem(CARRIER_WATCH_LOCAL_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((row) => row && typeof row === 'object' && row.carrierId) : [];
  } catch {
    return [];
  }
}

/** Записать локальные записи (тихо: приватный режим — не ошибка). */
export function writeLocalCarrierWatches(watches: readonly CarrierWatch[], storage?: Storage | null): void {
  const store = storage ?? (typeof window === 'undefined' ? null : window.localStorage);
  if (!store) return;
  try {
    store.setItem(CARRIER_WATCH_LOCAL_KEY, JSON.stringify(watches.slice(0, CARRIER_WATCH_LIMIT)));
  } catch {
    // Приватный режим: список останется только в памяти вкладки.
  }
}

/** Локальная запись с новым id — для гостя и для мгновенного отклика кнопки. */
export function localCarrierWatch(
  value: Omit<CarrierWatch, 'id' | 'updatedAt'>,
  now = Date.now(),
): CarrierWatch {
  return {
    ...value,
    id: `local:${value.carrierId}`,
    updatedAt: new Date(now).toISOString(),
  };
}
