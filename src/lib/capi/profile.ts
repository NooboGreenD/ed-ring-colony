// ═══════════════════════════════════════════════════════════════
// Разбор ответа Frontier CAPI `/profile`
// ═══════════════════════════════════════════════════════════════
//
// Почему это отдельный модуль
// ---------------------------
// Раньше маршруты читали ответ CAPI напрямую: `profile.credits`,
// `profile.ranks?.combat`, `profile.currentSystem?.name`. Таких полей у
// Frontier НЕТ. Реальная структура (EDCD/FDevIDs → Frontier API):
//
//   { "commander": { "name", "id", "credits", "debt", "docked",
//                    "rank": { "combat", "trade", "explore", "empire",
//                              "federation", "cqc", "soldier",
//                              "exobiologist" } },
//     "lastSystem":   { "id", "name", "faction" },
//     "lastStarport": { "id", "name" },            ← пусто, если не пристыкован
//     "ship":  { "name": "<тип>", "shipName", "shipID", "starsystem" },
//     "ships": { "4": { ... } } | [ { ... } ] }    ← словарь ИЛИ массив
//
// Из-за расхождения в базу уходили NULL'ы: привязка «есть», данных нет.
// Теперь сырой ответ приводится к одной плоской форме здесь, и все три
// пути записи (колбэк OAuth, ручной синк, cron) используют один и тот же
// `capiProfileRow()` — расхождения между ними больше невозможны.

import type {
  CapiProfile,
  CapiRanks,
  CapiRawProfile,
  CapiRawShip,
  CapiShip,
} from '@/types/capi';

/** Число из CAPI: строки («12345») тоже встречаются, мусор → null. */
function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Непустая строка или null. Frontier отдаёт "" вместо отсутствия значения. */
function str(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function bool(value: unknown): boolean {
  return value === true || value === 'true' || value === 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeShip(raw: CapiRawShip | undefined | null): CapiShip | null {
  if (!isRecord(raw)) return null;
  const shipType = str(raw.name);
  const shipName = str(raw.shipName);
  if (!shipType && !shipName && num(raw.id) === null) return null;

  return {
    shipId: num(raw.id),
    shipType,
    shipName,
    shipIdent: str(raw.shipID),
    value: num(raw.value?.total),
    systemName: str(raw.starsystem?.name),
    stationName: str(raw.station?.name),
  };
}

/** `ships` — массив или словарь с строковыми ключами. Нормализуем в массив. */
export function normalizeShips(raw: CapiRawProfile['ships']): CapiShip[] {
  const list = Array.isArray(raw)
    ? raw
    : isRecord(raw)
      ? Object.values(raw as Record<string, CapiRawShip>)
      : [];

  return list
    .map((ship) => normalizeShip(ship))
    .filter((ship): ship is CapiShip => ship !== null);
}

function normalizeRanks(raw: CapiRawProfile): CapiRanks {
  // `commander.rank` — канон. `ranks` верхнего уровня оставлен как запасной
  // путь: так профиль присылает десктопный Colonial Helper (он уже
  // нормализует данные у себя).
  const rank = (isRecord(raw.commander?.rank) ? raw.commander?.rank : undefined)
    ?? (isRecord((raw as Record<string, unknown>).ranks)
      ? ((raw as Record<string, unknown>).ranks as Record<string, unknown>)
      : {});

  const pick = (key: string): number | null => num((rank as Record<string, unknown>)[key]);

  return {
    combat: pick('combat'),
    trade: pick('trade'),
    explore: pick('explore'),
    empire: pick('empire'),
    federation: pick('federation'),
    cqc: pick('cqc'),
    soldier: pick('soldier'),
    exobiologist: pick('exobiologist'),
  };
}

/**
 * Привести ответ `/profile` к форме, с которой работает сайт.
 *
 * Функция намеренно не бросает исключений: CAPI может вернуть частичный
 * объект (например, сразу после создания аккаунта), и это не повод рвать
 * привязку. «Пустоту» проверяйте через `isBlankProfile()`.
 */
export function normalizeCapiProfile(input: unknown): CapiProfile {
  const raw: CapiRawProfile = isRecord(input) ? (input as CapiRawProfile) : {};
  const commander = isRecord(raw.commander) ? raw.commander : {};
  const ship = isRecord(raw.ship) ? raw.ship : undefined;
  const docked = bool(commander.docked);

  const systemName = str(raw.lastSystem?.name) ?? str(ship?.starsystem?.name);
  const systemAddress = num(ship?.starsystem?.systemaddress) ?? num(raw.lastSystem?.id);
  const starportName = str(raw.lastStarport?.name) ?? str(ship?.station?.name);
  const starportId = num(raw.lastStarport?.id) ?? num(ship?.station?.id);

  const currentShipType = str(ship?.name);
  const currentShipName = str(ship?.shipName);

  const lastStarport = starportName ? { name: starportName, id: starportId } : null;

  return {
    commander: {
      name: str(commander.name),
      id: str(commander.id),
    },
    cmdrName: str(commander.name),
    // Кредиты и долг живут внутри `commander`; верхний уровень — запасной
    // путь для профиля, присланного Colonial Helper.
    credits: num(commander.credits) ?? num((raw as Record<string, unknown>).credits),
    loan: num(commander.debt) ?? num((raw as Record<string, unknown>).loan),
    ranks: normalizeRanks(raw),
    currentShip: currentShipName ?? currentShipType,
    currentShipType,
    currentShipIdent: str(ship?.shipID),
    currentSystem: systemName ? { name: systemName, systemAddress } : null,
    // «Текущая станция» — только когда пилот действительно пристыкован:
    // `lastStarport` остаётся заполненным и после вылета, и показывать его
    // как текущее положение было бы враньём на карте пилотов.
    currentStation: docked ? lastStarport : null,
    lastStarport,
    docked,
    onFoot: bool(commander.onfoot),
    alive: commander.alive === undefined ? true : bool(commander.alive),
    ships: normalizeShips(raw.ships),
    raw,
  };
}

/**
 * Профиль без единого полезного поля. Так выглядит ответ CAPI для аккаунта,
 * который ещё ни разу не заходил в игру: привязку рвать не надо, но и писать
 * в досье нечего.
 */
export function isBlankProfile(profile: CapiProfile): boolean {
  return (
    !profile.cmdrName &&
    profile.credits === null &&
    !profile.currentSystem &&
    !profile.currentShip &&
    profile.ships.length === 0
  );
}

/**
 * Строка для `capi_profiles`.
 *
 * `cmdrNameFallback` — имя из `capi_tokens`: CAPI изредка отдаёт профиль без
 * имени (обслуживание, частичный ответ), и затирать им сохранённое имя
 * командира нельзя, иначе досье «теряет» пилота до следующего синка.
 */
export function capiProfileRow(
  userId: string,
  profile: CapiProfile,
  options: { cmdrNameFallback?: string | null; now?: Date } = {},
): Record<string, unknown> {
  const now = options.now ?? new Date();
  const cmdrName = profile.cmdrName ?? options.cmdrNameFallback ?? null;

  return {
    user_id: userId,
    cmdr_name: cmdrName,
    frontier_id: profile.commander.id,
    credits: profile.credits,
    loan: profile.loan,
    combat_rank: profile.ranks.combat,
    trade_rank: profile.ranks.trade,
    explore_rank: profile.ranks.explore,
    empire_rank: profile.ranks.empire,
    federation_rank: profile.ranks.federation,
    cqc_rank: profile.ranks.cqc,
    mercenary_rank: profile.ranks.soldier,
    exobiologist_rank: profile.ranks.exobiologist,
    current_ship: profile.currentShip,
    current_system: profile.currentSystem?.name ?? null,
    current_station: profile.currentStation?.name ?? null,
    ships: profile.ships,
    last_updated: now.toISOString(),
  };
}

/**
 * Строка для `pilot_stats` — таблицы, из которой досье и рейтинги берут
 * данные в первую очередь (см. `/api/cmdr/stats`).
 *
 * Пишем только то, что действительно пришло из CAPI: `undefined`-поля
 * выбрасываются, чтобы синк не затирал нулями статистику, загруженную из
 * журналов (Colonial Helper шлёт её тем же upsert'ом).
 */
export function pilotStatsRow(
  userId: string,
  profile: CapiProfile,
  options: { cmdrNameFallback?: string | null; now?: Date } = {},
): Record<string, unknown> {
  const now = options.now ?? new Date();
  const row: Record<string, unknown> = {
    user_id: userId,
    last_updated: now.toISOString(),
  };

  const cmdrName = profile.cmdrName ?? options.cmdrNameFallback ?? null;
  if (cmdrName) row.cmdr_name = cmdrName;
  if (profile.credits !== null) row.credits = profile.credits;
  if (profile.ranks.combat !== null) row.combat_rank = profile.ranks.combat;
  if (profile.ranks.trade !== null) row.trade_rank = profile.ranks.trade;
  if (profile.ranks.explore !== null) row.explore_rank = profile.ranks.explore;
  if (profile.ranks.empire !== null) row.empire_rank = profile.ranks.empire;
  if (profile.ranks.federation !== null) row.federation_rank = profile.ranks.federation;
  if (profile.ranks.soldier !== null) row.mercenary_rank = profile.ranks.soldier;
  if (profile.ranks.exobiologist !== null) row.exobiologist_rank = profile.ranks.exobiologist;
  if (profile.currentShip) row.current_ship = profile.currentShip;
  if (profile.currentSystem?.name) row.current_system = profile.currentSystem.name;
  if (profile.currentStation?.name) row.current_station = profile.currentStation.name;

  return row;
}
