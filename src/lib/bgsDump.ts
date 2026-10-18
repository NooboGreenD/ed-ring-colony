/**
 * Разбор ночного дампа EDSM `systemsPopulated.json.gz`
 * (https://www.edsm.net/en/nightly-dumps) — все населённые системы с
 * минорными фракциями.
 *
 * Формат: JSON-массив, по одной системе на строку (`EDSM-NET/Process`,
 * Dump/SystemsPopulated.php) —
 *   [
 *       {"id":8713,"id64":663329196387,"name":"4 Sextantis","coords":{"x":87.25,…},
 *        "allegiance":"Federation","government":"Corporate","state":null,
 *        "economy":null,"security":"Low","population":14455,
 *        "controllingFaction":{"id":13949,"name":"4 Sextantis Inc",…,"isPlayer":false},
 *        "factions":[{"id":…,"name":…,"allegiance":…,"government":…,
 *                     "influence":0.52,"state":"Boom","activeStates":[{"state":"Boom"}],
 *                     "recoveringStates":[…],"pendingStates":[…],"happiness":"Happy",
 *                     "isPlayer":false,"lastUpdate":1610000000}, …],
 *        "stations":[…], "bodies":[…], "date":"2015-05-12 15:29:33"},
 *       …
 *   ]
 *
 * Файл большой (≈0,5 ГБ gzip, несколько ГБ JSON) почти целиком из-за станций
 * и тел, которые здесь не нужны. Поэтому строка обрезается до разбора: от
 * `,"stations":` до `,"date":` — порядок ключей у EDSM фиксирован. Если
 * обрезанная строка вдруг не разбирается, разбирается целиком.
 *
 * id64 читается из текста строки, а не из `JSON.parse`: адрес системы бывает
 * шире 2^53 и в number терял бы младшие разряды.
 */

import { edsmDateToIso } from './powerplayDump.ts';
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
  type BgsAllegiance,
  type BgsSnapshot,
  type BgsSnapshotFaction,
} from './bgs.ts';

export type BgsDumpSkipReason = 'invalid' | 'no_factions';

export type BgsDumpLine =
  | { kind: 'empty' }
  | { kind: 'system'; snapshot: BgsSnapshot }
  | { kind: 'skip'; reason: BgsDumpSkipReason };

/** Первое вхождение — id64 самой системы: ключ идёт вторым, раньше станций и тел. */
const ID64_IN_LINE = /"id64"\s*:\s*"?(\d{1,20})"?/;
const MAX_FACTIONS = 24;

/** Строка дампа без станций и тел — их тут сотни килобайт, а нужны только фракции. */
export function trimEdsmPopulatedLine(line: string): string {
  const stations = line.indexOf(',"stations":');
  if (stations < 0) return line;
  const date = line.lastIndexOf(',"date":');
  if (date <= stations) return line;
  return line.slice(0, stations) + line.slice(date);
}

function epochToIso(value: unknown): string | null {
  const seconds = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString();
}

function faction(raw: unknown): BgsSnapshotFaction | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const name = cleanName(item.name, 160);
  if (!name) return null;
  const edsmId = typeof item.id === 'number' && Number.isSafeInteger(item.id) && item.id > 0 ? item.id : null;
  return {
    name,
    allegiance: normalizeAllegiance(item.allegiance),
    government: normalizeGovernment(item.government),
    isPlayer: typeof item.isPlayer === 'boolean' ? item.isPlayer : null,
    edsmId,
    influence: normalizeInfluence(item.influence),
    state: normalizeState(item.state),
    activeStates: normalizeStateList(item.activeStates),
    pendingStates: normalizeStateList(item.pendingStates),
    recoveringStates: normalizeStateList(item.recoveringStates),
    happiness: normalizeHappiness(item.happiness),
  };
}

/** Одна запись дампа (уже разобранная) → наблюдение системы. */
export function edsmPopulatedRecord(record: unknown, line: string | null = null): BgsDumpLine {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return { kind: 'skip', reason: 'invalid' };
  const item = record as Record<string, unknown>;
  const name = cleanName(item.name, 120);
  const coords = (item.coords && typeof item.coords === 'object' ? item.coords : {}) as Record<string, unknown>;
  const x = coordinate(coords.x);
  const y = coordinate(coords.y);
  const z = coordinate(coords.z);
  const fromLine = line ? ID64_IN_LINE.exec(line)?.[1] ?? null : null;
  const id64 = id64FromAny(fromLine ?? item.id64);
  if (!name || x == null || y == null || z == null || !id64) return { kind: 'skip', reason: 'invalid' };

  const controllingRaw = item.controllingFaction && typeof item.controllingFaction === 'object'
    ? item.controllingFaction as Record<string, unknown>
    : null;
  const controlling = cleanName(controllingRaw?.name, 160);

  const factions: BgsSnapshotFaction[] = [];
  const seen = new Set<string>();
  let newest = -Infinity;
  for (const raw of Array.isArray(item.factions) ? item.factions : []) {
    const parsed = faction(raw);
    if (!parsed) continue;
    const k = parsed.name.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    factions.push(parsed);
    const updated = Number((raw as Record<string, unknown>).lastUpdate);
    if (Number.isFinite(updated) && updated > newest) newest = updated;
    if (factions.length >= MAX_FACTIONS) break;
  }
  // Бывает контролирующая фракция без списка влияния — тогда она одна.
  if (factions.length === 0 && controlling) {
    factions.push({
      name: controlling,
      allegiance: normalizeAllegiance(controllingRaw?.allegiance),
      government: normalizeGovernment(controllingRaw?.government),
      isPlayer: typeof controllingRaw?.isPlayer === 'boolean' ? (controllingRaw.isPlayer as boolean) : null,
      edsmId: typeof controllingRaw?.id === 'number' && Number.isSafeInteger(controllingRaw.id) ? (controllingRaw.id as number) : null,
      influence: null,
      state: normalizeState(item.state),
      activeStates: [],
      pendingStates: [],
      recoveringStates: [],
      happiness: null,
    });
  }
  if (factions.length === 0) return { kind: 'skip', reason: 'no_factions' };

  const population = typeof item.population === 'number' && Number.isFinite(item.population) && item.population >= 0
    ? Math.round(item.population)
    : null;
  // Время наблюдения — когда EDSM последний раз обновлял влияние фракций
  // системы; без него — время записи системы.
  const observedAt = Number.isFinite(newest) ? epochToIso(newest) : edsmDateToIso(item.date);
  const allegiance: BgsAllegiance = normalizeAllegiance(item.allegiance ?? controllingRaw?.allegiance);

  return {
    kind: 'system',
    snapshot: {
      id64,
      name,
      x,
      y,
      z,
      allegiance,
      government: normalizeGovernment(item.government),
      economy: normalizeEconomy(item.economy),
      secondEconomy: null,
      security: normalizeSecurity(item.security),
      state: normalizeState(item.state),
      population,
      controlling: controlling ?? null,
      observedAt,
      factions,
    },
  };
}

/** Одна строка файла дампа: `[`, `]`, `    {…},` или последняя запись без запятой. */
export function parseEdsmPopulatedLine(rawLine: string): BgsDumpLine {
  let line = rawLine.trim();
  if (line.startsWith('[')) line = line.slice(1).trim();
  if (line.endsWith(']')) line = line.slice(0, -1).trim();
  if (line.endsWith(',')) line = line.slice(0, -1).trim();
  if (!line) return { kind: 'empty' };
  if (!line.startsWith('{')) return { kind: 'skip', reason: 'invalid' };
  const trimmed = trimEdsmPopulatedLine(line);
  let record: unknown;
  try {
    record = JSON.parse(trimmed);
  } catch {
    if (trimmed === line) return { kind: 'skip', reason: 'invalid' };
    try {
      record = JSON.parse(line);
    } catch {
      return { kind: 'skip', reason: 'invalid' };
    }
  }
  return edsmPopulatedRecord(record, trimmed);
}

/* ── Статистика прохода ─────────────────────────────────────────────────── */

export interface BgsDumpStats {
  /** Записей в дампе (включая отброшенные). */
  records: number;
  /** Систем с фракциями. */
  systems: number;
  skipped: Record<BgsDumpSkipReason, number>;
  /** Разных фракций (по имени без регистра). */
  factions: number;
  /** Пар «система — фракция». */
  presence: number;
  playerFactions: number;
  allegiances: Record<string, number>;
  oldestObservation: string | null;
  newestObservation: string | null;
}

export class BgsDumpCounter {
  readonly stats: BgsDumpStats = {
    records: 0,
    systems: 0,
    skipped: { invalid: 0, no_factions: 0 },
    factions: 0,
    presence: 0,
    playerFactions: 0,
    allegiances: {},
    oldestObservation: null,
    newestObservation: null,
  };
  private readonly names = new Set<string>();
  private readonly players = new Set<string>();
  private oldest = Infinity;
  private newest = -Infinity;

  add(result: BgsDumpLine): void {
    if (result.kind === 'empty') return;
    this.stats.records += 1;
    if (result.kind === 'skip') {
      this.stats.skipped[result.reason] += 1;
      return;
    }
    const { snapshot } = result;
    this.stats.systems += 1;
    this.stats.allegiances[snapshot.allegiance] = (this.stats.allegiances[snapshot.allegiance] ?? 0) + 1;
    this.stats.presence += snapshot.factions.length;
    for (const item of snapshot.factions) {
      const k = item.name.toLowerCase();
      this.names.add(k);
      if (item.isPlayer) this.players.add(k);
    }
    this.stats.factions = this.names.size;
    this.stats.playerFactions = this.players.size;
    const ms = snapshot.observedAt ? Date.parse(snapshot.observedAt) : NaN;
    if (Number.isFinite(ms)) {
      if (ms < this.oldest) {
        this.oldest = ms;
        this.stats.oldestObservation = new Date(ms).toISOString();
      }
      if (ms > this.newest) {
        this.newest = ms;
        this.stats.newestObservation = new Date(ms).toISOString();
      }
    }
  }
}
