/**
 * Минорные фракции из журналов пилотов.
 *
 * В событиях FSDJump, Location и CarrierJump игра пишет состояние населённой
 * системы целиком: контролирующую фракцию (`SystemFaction`), принадлежность,
 * правительство, экономику, безопасность, население и список `Factions` —
 * влияние, состояние, активные / ожидающие / затухающие состояния каждой
 * фракции. Это и есть обновление данных о фракциях «с приложения»:
 *
 *   * Colonial Helper (`uploader/bgs_sync.py`) и загрузчик журналов на сайте
 *     (`BgsSnapshotCollector` ниже) отбирают такие события одинаково и шлют
 *     их проекцию на `POST /api/factions/sync`;
 *   * сервер (`journalEventToSnapshot`) приводит их к общему виду наблюдения
 *     (`BgsSnapshot`), а база применяет только наблюдения свежее сохранённых.
 *
 * Хеши доставок (`source_hash`) здесь ни при чём: фракции идут отдельным
 * маршрутом, а повтор одного журнала с сайта и из Helper'а безопасен — то же
 * наблюдение с тем же временем ничего не меняет.
 *
 * Без node-зависимостей: модуль собирается и в браузер, и в маршрут.
 */

import {
  cleanName,
  coordinate,
  id64FromAny,
  normalizeAllegiance,
  normalizeEconomy,
  normalizeGovernment,
  normalizeHappiness,
  normalizeInfluence,
  normalizeSecurity,
  normalizeState,
  normalizeStateList,
  observationTime,
  type BgsSnapshot,
  type BgsSnapshotFaction,
} from './bgs.ts';

type JournalEvent = Record<string, unknown>;

/** События, которые несут состояние фракций системы. */
export const BGS_JOURNAL_EVENTS = ['FSDJump', 'Location', 'CarrierJump'] as const;

/** Поля события, которые нужны серверу — тот же список, что `BGS_SYSTEM_FIELDS` в uploader/bgs_sync.py. */
export const BGS_SYSTEM_FIELDS = [
  'event', 'timestamp', 'StarSystem', 'SystemAddress', 'StarPos', 'SystemAllegiance', 'SystemGovernment',
  'SystemEconomy', 'SystemSecondEconomy', 'SystemSecurity', 'Population', 'SystemFaction', 'FactionState',
] as const;

/**
 * Поля элемента `Factions`. Личного (MyReputation, SquadronFaction,
 * HomeSystem, HappiestSystem) и локализованных подписей не отправляем.
 */
export const BGS_FACTION_FIELDS = [
  'Name', 'FactionState', 'Government', 'Influence', 'Allegiance', 'Happiness',
  'ActiveStates', 'PendingStates', 'RecoveringStates',
] as const;

const STATE_LISTS = new Set(['ActiveStates', 'PendingStates', 'RecoveringStates']);
const MAX_FACTIONS = 24;
const SYSTEM_ADDRESS_IN_LINE = /"SystemAddress"\s*:\s*"?(\d{1,20})"?/;

function projectStates(value: unknown): Array<{ State: string }> {
  if (!Array.isArray(value)) return [];
  const out: Array<{ State: string }> = [];
  for (const item of value) {
    const state = item && typeof item === 'object' ? (item as JournalEvent).State : null;
    if (typeof state === 'string' && state) out.push({ State: state });
  }
  return out;
}

function projectFaction(value: unknown): JournalEvent | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as JournalEvent;
  if (typeof item.Name !== 'string' || !item.Name.trim()) return null;
  const out: JournalEvent = {};
  for (const key of BGS_FACTION_FIELDS) {
    if (!(key in item) || item[key] == null) continue;
    out[key] = STATE_LISTS.has(key) ? projectStates(item[key]) : item[key];
  }
  return out;
}

/**
 * Проекция события журнала для `POST /api/factions/sync` или null, если
 * события о фракциях в нём нет (ненаселённая система, другое событие).
 * `line` — исходная строка журнала: из неё берётся SystemAddress без потери
 * разрядов (адрес шире 2^53, а `JSON.parse` превращает его в double).
 */
export function projectBgsEvent(event: JournalEvent, line: string | null = null): JournalEvent | null {
  const name = String(event?.event ?? '');
  if (!(BGS_JOURNAL_EVENTS as readonly string[]).includes(name)) return null;
  if (!Array.isArray(event.Factions) || event.Factions.length === 0) return null;
  if (typeof event.StarSystem !== 'string' || !event.StarSystem) return null;
  const out: JournalEvent = {};
  for (const key of BGS_SYSTEM_FIELDS) {
    if (!(key in event) || event[key] == null) continue;
    if (key === 'SystemFaction' && event[key] && typeof event[key] === 'object') {
      const faction = event[key] as JournalEvent;
      const projected: JournalEvent = {};
      if (typeof faction.Name === 'string') projected.Name = faction.Name;
      if (typeof faction.FactionState === 'string') projected.FactionState = faction.FactionState;
      out[key] = projected;
      continue;
    }
    out[key] = event[key];
  }
  const fromLine = line ? SYSTEM_ADDRESS_IN_LINE.exec(line)?.[1] : undefined;
  if (fromLine) out.SystemAddress = fromLine;
  else if (typeof out.SystemAddress === 'number' && Number.isSafeInteger(out.SystemAddress)) out.SystemAddress = String(out.SystemAddress);
  out.Factions = (event.Factions as unknown[]).map(projectFaction).filter((item): item is JournalEvent => item !== null);
  return (out.Factions as unknown[]).length > 0 ? out : null;
}

export type BgsJournalReject =
  | 'event'
  | 'timestamp'
  | 'system'
  | 'address'
  | 'position'
  | 'factions';

/** Проекция события (от Helper или сайта) → наблюдение системы для базы. */
export function journalEventToSnapshot(
  value: unknown,
  nowMs = Date.now(),
): { snapshot: BgsSnapshot } | { reject: BgsJournalReject } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { reject: 'event' };
  const event = value as JournalEvent;
  if (!(BGS_JOURNAL_EVENTS as readonly string[]).includes(String(event.event))) return { reject: 'event' };
  const observedAt = observationTime(event.timestamp, nowMs);
  if (!observedAt) return { reject: 'timestamp' };
  const name = cleanName(event.StarSystem, 120);
  if (!name) return { reject: 'system' };
  const id64 = id64FromAny(event.SystemAddress);
  if (!id64) return { reject: 'address' };
  const pos = Array.isArray(event.StarPos) ? event.StarPos : [];
  const x = coordinate(pos[0]);
  const y = coordinate(pos[1]);
  const z = coordinate(pos[2]);
  if (pos.length !== 3 || x == null || y == null || z == null) return { reject: 'position' };

  const factions: BgsSnapshotFaction[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(event.Factions) ? event.Factions : []) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as JournalEvent;
    const factionName = cleanName(item.Name, 160);
    if (!factionName || seen.has(factionName.toLowerCase())) continue;
    seen.add(factionName.toLowerCase());
    factions.push({
      name: factionName,
      allegiance: normalizeAllegiance(item.Allegiance),
      government: normalizeGovernment(item.Government),
      isPlayer: null,
      edsmId: null,
      influence: normalizeInfluence(item.Influence),
      state: normalizeState(item.FactionState),
      activeStates: normalizeStateList(item.ActiveStates),
      pendingStates: normalizeStateList(item.PendingStates),
      recoveringStates: normalizeStateList(item.RecoveringStates),
      happiness: normalizeHappiness(item.Happiness),
    });
    if (factions.length >= MAX_FACTIONS) break;
  }
  if (factions.length === 0) return { reject: 'factions' };

  // SystemFaction — объект {Name, FactionState} (с 3.0) или строка (старые журналы).
  const systemFaction = event.SystemFaction;
  const controlling = typeof systemFaction === 'string'
    ? cleanName(systemFaction, 160)
    : systemFaction && typeof systemFaction === 'object'
      ? cleanName((systemFaction as JournalEvent).Name, 160)
      : null;
  const systemState = systemFaction && typeof systemFaction === 'object'
    ? (systemFaction as JournalEvent).FactionState
    : event.FactionState;
  const population = typeof event.Population === 'number' && Number.isFinite(event.Population) && event.Population >= 0
    ? Math.round(event.Population)
    : null;

  return {
    snapshot: {
      id64,
      name,
      x,
      y,
      z,
      allegiance: normalizeAllegiance(event.SystemAllegiance),
      government: normalizeGovernment(event.SystemGovernment),
      economy: normalizeEconomy(event.SystemEconomy),
      secondEconomy: normalizeEconomy(event.SystemSecondEconomy),
      security: normalizeSecurity(event.SystemSecurity),
      state: normalizeState(systemState),
      population,
      controlling,
      observedAt,
      factions,
    },
  };
}

/**
 * Сборщик для загрузчика журналов на сайте: тот же отбор, что у
 * `uploader/bgs_sync.py`. Из многих посещений одной системы остаётся самое
 * свежее — серверу старые всё равно не нужны.
 */
export class BgsSnapshotCollector {
  private readonly bySystem = new Map<string, JournalEvent>();
  collected = 0;

  feed(line: string, event: JournalEvent): void {
    try {
      const projected = projectBgsEvent(event, line);
      if (!projected) return;
      this.collected += 1;
      const key = String(projected.SystemAddress ?? projected.StarSystem);
      const current = this.bySystem.get(key);
      const at = Date.parse(String(projected.timestamp ?? ''));
      const currentAt = current ? Date.parse(String(current.timestamp ?? '')) : NaN;
      if (current && Number.isFinite(currentAt) && (!Number.isFinite(at) || at < currentAt)) return;
      this.bySystem.set(key, projected);
    } catch {
      // Сбой отбора фракций не должен ломать разбор журнала.
    }
  }

  get size(): number {
    return this.bySystem.size;
  }

  /** Собранное (по времени) и очистка. */
  drain(): JournalEvent[] {
    const out = Array.from(this.bySystem.values()).sort((a, b) => String(a.timestamp ?? '').localeCompare(String(b.timestamp ?? '')));
    this.bySystem.clear();
    return out;
  }
}
