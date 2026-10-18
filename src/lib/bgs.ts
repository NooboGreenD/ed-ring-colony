/**
 * Минорные фракции (BGS): справочники, формат слоя карты, фильтры и выбор
 * фракций — общий модуль для сервера (импорт, API) и браузера (вкладка
 * «Фракции» в Atlas, 3D-слой карты).
 *
 * Названия приводятся к одному виду из трёх источников, которые пишут их
 * по-разному:
 *   * журнал игры: `$government_Corporate;`, `$economy_HighTech;`,
 *     `$SYSTEM_SECURITY_medium;`, `$Faction_HappinessBand2;`;
 *   * дамп EDSM: «Corporate», «High Tech», «Medium», «Happy», «Civil war»;
 *   * сама база — канонические ключи (`Corporate`, `HighTech`, `Medium`).
 *
 * Только стираемый TypeScript без зависимостей: тесты (`node --test`)
 * импортируют модуль напрямую, браузерный бандл — тоже.
 */

import { formatPowerplayDate, powerplayOverview, type PowerplayOverview } from './powerplay.ts';

/* ── Принадлежность ─────────────────────────────────────────────────────── */

export const BGS_ALLEGIANCES = [
  'Federation', 'Empire', 'Alliance', 'Independent', 'Thargoid', 'Guardian', 'PilotsFederation', 'None',
] as const;
export type BgsAllegiance = (typeof BGS_ALLEGIANCES)[number];

export const BGS_ALLEGIANCE_LABEL: Record<BgsAllegiance, string> = {
  Federation: 'Федерация',
  Empire: 'Империя',
  Alliance: 'Альянс',
  Independent: 'Независимые',
  Thargoid: 'Таргоиды',
  Guardian: 'Стражи',
  PilotsFederation: 'Федерация пилотов',
  None: 'Без принадлежности',
};

/** Цвета точек слоя «все населённые системы» — те же, что у значков принадлежности на сайте. */
export const BGS_ALLEGIANCE_COLOR: Record<BgsAllegiance, string> = {
  Federation: '#3b82f6',
  Empire: '#a855f7',
  Alliance: '#22c55e',
  Independent: '#cbd5e1',
  Thargoid: '#14b8a6',
  Guardian: '#f59e0b',
  PilotsFederation: '#fb923c',
  None: '#6b7280',
};

/** Ключ сравнения: без `$…;`, префиксов журнала, пробелов и регистра. */
function key(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase().replace(/^\$/, '').replace(/;$/, '').replace(/[^a-z0-9]/g, '');
}

export function normalizeAllegiance(value: unknown): BgsAllegiance {
  const k = key(value);
  if (!k || k === 'none' || k === 'null') return 'None';
  if (k.includes('pilotsfederation')) return 'PilotsFederation';
  for (const allegiance of BGS_ALLEGIANCES) {
    if (k === allegiance.toLowerCase()) return allegiance;
  }
  return 'None';
}

/* ── Справочники: канонический ключ → подпись ───────────────────────────── */

function canonical(table: Record<string, string>, synonyms: Record<string, string>, prefix: RegExp | null) {
  const byKey = new Map<string, string>();
  for (const name of Object.keys(table)) byKey.set(name.toLowerCase(), name);
  for (const [alias, name] of Object.entries(synonyms)) byKey.set(alias, name);
  return (value: unknown): string | null => {
    let k = key(value);
    if (!k) return null;
    if (prefix) k = k.replace(prefix, '');
    const known = byKey.get(k);
    if (known) return known;
    // Неизвестное значение сохраняем как есть (коротко): новые состояния игры
    // не должны пропадать из данных из-за устаревшего справочника.
    const raw = typeof value === 'string' ? value.trim().replace(/^\$[a-z]+_/i, '').replace(/;$/, '') : '';
    return raw ? raw.slice(0, 40) : null;
  };
}

export const BGS_GOVERNMENT_LABEL: Record<string, string> = {
  Anarchy: 'Анархия',
  Communism: 'Коммунизм',
  Confederacy: 'Конфедерация',
  Cooperative: 'Кооператив',
  Corporate: 'Корпорация',
  Democracy: 'Демократия',
  Dictatorship: 'Диктатура',
  Feudal: 'Феодализм',
  Patronage: 'Патронат',
  PrisonColony: 'Колония-тюрьма',
  Theocracy: 'Теократия',
  Engineer: 'Инженер',
  Prison: 'Тюрьма',
  PrivateOwnership: 'Частная собственность',
  None: 'Нет',
};

export const normalizeGovernment = canonical(
  BGS_GOVERNMENT_LABEL,
  { carrier: 'PrivateOwnership', privateownership: 'PrivateOwnership' },
  /^government/,
);

export const BGS_ECONOMY_LABEL: Record<string, string> = {
  Agriculture: 'Сельское хозяйство',
  Extraction: 'Добыча',
  HighTech: 'Высокие технологии',
  Industrial: 'Промышленность',
  Military: 'Военная',
  Refinery: 'Переработка',
  Service: 'Сфера услуг',
  Terraforming: 'Терраформирование',
  Tourism: 'Туризм',
  Colony: 'Колония',
  Prison: 'Тюрьма',
  Damaged: 'Разрушена',
  Rescue: 'Спасательная',
  Repair: 'Ремонт',
  PrivateEnterprise: 'Частное предприятие',
  Engineering: 'Инженерная',
  None: 'Нет',
};

export const normalizeEconomy = canonical(
  BGS_ECONOMY_LABEL,
  { agri: 'Agriculture', carrier: 'PrivateEnterprise', engineer: 'Engineering' },
  /^economy/,
);

export const BGS_SECURITY_LABEL: Record<string, string> = {
  High: 'Высокая',
  Medium: 'Средняя',
  Low: 'Низкая',
  Anarchy: 'Анархия',
  Lawless: 'Беззаконие',
};

export function normalizeSecurity(value: unknown): string | null {
  const k = key(value);
  if (!k) return null;
  if (k.includes('lawless')) return 'Lawless';
  if (k.includes('anarchy')) return 'Anarchy';
  if (k.includes('high')) return 'High';
  if (k.includes('medium')) return 'Medium';
  if (k.includes('low')) return 'Low';
  return null;
}

export const BGS_STATE_LABEL: Record<string, string> = {
  None: 'Нет',
  Boom: 'Бум',
  Bust: 'Спад',
  CivilUnrest: 'Беспорядки',
  CivilWar: 'Гражданская война',
  Election: 'Выборы',
  Expansion: 'Экспансия',
  Famine: 'Голод',
  Investment: 'Инвестиции',
  Lockdown: 'Изоляция',
  Outbreak: 'Эпидемия',
  Retreat: 'Отступление',
  War: 'Война',
  CivilLiberty: 'Гражданские свободы',
  PirateAttack: 'Нападение пиратов',
  PublicHoliday: 'Праздник',
  Terrorism: 'Терроризм',
  NaturalDisaster: 'Стихийное бедствие',
  InfrastructureFailure: 'Отказ инфраструктуры',
  Blight: 'Болезнь растений',
  Drought: 'Засуха',
  ColdWar: 'Холодная война',
  TradeWar: 'Торговая война',
  Revolution: 'Революция',
};

export const normalizeState = canonical(BGS_STATE_LABEL, { terroristattack: 'Terrorism' }, null);

/** Конфликтные состояния: в списке их видно сразу (красным). */
export const BGS_CONFLICT_STATES = new Set(['War', 'CivilWar', 'Election']);

export const BGS_HAPPINESS_LABEL: Record<string, string> = {
  Elated: 'Восторг',
  Happy: 'Довольны',
  Discontented: 'Недовольны',
  Unhappy: 'Несчастны',
  Despondent: 'Уныние',
};

const HAPPINESS_BANDS = ['Elated', 'Happy', 'Discontented', 'Unhappy', 'Despondent'];

export function normalizeHappiness(value: unknown): string | null {
  const k = key(value);
  if (!k) return null;
  const band = /happinessband([1-5])$/.exec(k);
  if (band) return HAPPINESS_BANDS[Number(band[1]) - 1];
  return HAPPINESS_BANDS.find((name) => name.toLowerCase() === k) ?? null;
}

function label(table: Record<string, string>, value: string | null | undefined): string {
  if (!value) return '—';
  return table[value] ?? value;
}

export const allegianceLabel = (value: string | null | undefined) => BGS_ALLEGIANCE_LABEL[normalizeAllegiance(value)];
export const governmentLabel = (value: string | null | undefined) => label(BGS_GOVERNMENT_LABEL, value);
export const economyLabel = (value: string | null | undefined) => label(BGS_ECONOMY_LABEL, value);
export const securityLabel = (value: string | null | undefined) => label(BGS_SECURITY_LABEL, value);
export const stateLabel = (value: string | null | undefined) => label(BGS_STATE_LABEL, value);
export const happinessLabel = (value: string | null | undefined) => label(BGS_HAPPINESS_LABEL, value);

/* ── Источники ──────────────────────────────────────────────────────────── */

export const BGS_SOURCES = ['edsm', 'helper', 'web', 'eddn'] as const;
export type BgsSource = (typeof BGS_SOURCES)[number];

export const BGS_SOURCE_LABEL: Record<BgsSource, string> = {
  edsm: 'дамп EDSM',
  helper: 'Colonial Helper',
  web: 'журнал на сайте',
  eddn: 'EDDN',
};

export function normalizeSource(value: unknown): BgsSource {
  return (BGS_SOURCES as readonly string[]).includes(String(value)) ? (value as BgsSource) : 'edsm';
}

/* ── Проверка значений ──────────────────────────────────────────────────── */

const MAX_ID64 = BigInt('9223372036854775807');
const COORD_LIMIT = 100_000;

export function cleanName(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text || text.length > max) return null;
  return text;
}

/** Адрес системы (id64) строкой: он бывает шире 2^53, числом его передавать нельзя. */
export function id64FromAny(raw: unknown): string | null {
  let digits: string | null = null;
  if (typeof raw === 'string' && /^\d{1,19}$/.test(raw.trim())) digits = raw.trim();
  else if (typeof raw === 'bigint' && raw > BigInt(0)) digits = raw.toString(10);
  else if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0) digits = String(raw);
  if (!digits) return null;
  const value = BigInt(digits);
  if (value <= BigInt(0) || value > MAX_ID64) return null;
  return value.toString(10);
}

export function coordinate(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(n) && Math.abs(n) <= COORD_LIMIT ? n : null;
}

/** Время наблюдения: ISO-строка UTC; из будущего (с запасом на часы) — нет. */
export function observationTime(value: unknown, nowMs = Date.now()): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms) || ms < Date.UTC(2014, 0, 1) || ms > nowMs + 15 * 60_000) return null;
  return new Date(ms).toISOString();
}

/* ── Наблюдение системы: общий вид для дампа EDSM и журналов ────────────── */

export interface BgsSnapshotFaction {
  name: string;
  allegiance: BgsAllegiance;
  government: string | null;
  /** null — источник не знает (журнал): флаг в базе не меняется. */
  isPlayer: boolean | null;
  edsmId: number | null;
  /** Доля 0…1. */
  influence: number | null;
  state: string | null;
  activeStates: string[];
  pendingStates: string[];
  recoveringStates: string[];
  happiness: string | null;
}

export interface BgsSnapshot {
  id64: string;
  name: string;
  x: number;
  y: number;
  z: number;
  allegiance: BgsAllegiance;
  government: string | null;
  economy: string | null;
  secondEconomy: string | null;
  security: string | null;
  state: string | null;
  population: number | null;
  controlling: string | null;
  observedAt: string | null;
  factions: BgsSnapshotFaction[];
}

/** Пачка для RPC `bgs_apply_snapshots` (имена полей — как в SQL). */
export function snapshotToRpcRow(snapshot: BgsSnapshot): Record<string, unknown> {
  return {
    id64: snapshot.id64,
    name: snapshot.name,
    x: snapshot.x,
    y: snapshot.y,
    z: snapshot.z,
    allegiance: snapshot.allegiance,
    government: snapshot.government,
    economy: snapshot.economy,
    second_economy: snapshot.secondEconomy,
    security: snapshot.security,
    state: snapshot.state,
    population: snapshot.population,
    controlling: snapshot.controlling,
    observed_at: snapshot.observedAt,
    factions: snapshot.factions.map((faction) => ({
      name: faction.name,
      allegiance: faction.allegiance,
      government: faction.government,
      is_player: faction.isPlayer,
      edsm_id: faction.edsmId,
      influence: faction.influence,
      state: faction.state,
      active_states: faction.activeStates,
      pending_states: faction.pendingStates,
      recovering_states: faction.recoveringStates,
      happiness: faction.happiness,
    })),
  };
}

/** Влияние 0…1: журнал пишет долю (0.452), иногда приходят проценты (45.2). */
export function normalizeInfluence(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  const share = n > 1.0001 ? n / 100 : n;
  return share > 1 ? null : Math.round(share * 10000) / 10000;
}

/** Список состояний `[{State: 'Boom'}]` / `[{state: 'Boom'}]` / `['Boom']` → канонические ключи. */
export function normalizeStateList(value: unknown, limit = 12): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const raw = typeof item === 'string'
      ? item
      : item && typeof item === 'object'
        ? (item as Record<string, unknown>).State ?? (item as Record<string, unknown>).state
        : null;
    const state = normalizeState(raw);
    if (state && state !== 'None' && !out.includes(state)) out.push(state);
    if (out.length >= limit) break;
  }
  return out;
}

/* ── Формат слоя карты ──────────────────────────────────────────────────── */

/**
 * Одна система в ответе API: `[id64, имя, x, y, z, индекс принадлежности,
 * индекс правительства, индекс контролирующей фракции (−1 — нет), население,
 * фракций в системе, наблюдение (unix-секунды) | null, индекс источника]`.
 */
export type BgsLayerTuple = [string, string, number, number, number, number, number, number, number | null, number, number | null, number];

export interface BgsLayerMeta {
  sourceUrl: string;
  dumpGeneratedAt: string | null;
  syncedAt: string | null;
  checkedAt: string | null;
  systems: number;
  factions: number;
  presence: number;
  oldestObservation: string | null;
  newestObservation: string | null;
  /** Последнее обновление от пилотов (Helper / сайт). */
  pilotUpdateAt: string | null;
  /** Сервер импортирует дамп EDSM прямо сейчас. */
  refreshing: boolean;
  progress: { stage: string | null; stageLabel: string; percent: number; message: string; startedAt: string | null } | null;
  lastError: string | null;
}

export const EMPTY_BGS_META: BgsLayerMeta = {
  sourceUrl: 'https://www.edsm.net/en/nightly-dumps',
  dumpGeneratedAt: null,
  syncedAt: null,
  checkedAt: null,
  systems: 0,
  factions: 0,
  presence: 0,
  oldestObservation: null,
  newestObservation: null,
  pilotUpdateAt: null,
  refreshing: false,
  progress: null,
  lastError: null,
};

export interface BgsLayerResponse {
  status: 'ready' | 'empty';
  version: string;
  meta: BgsLayerMeta;
  allegiances: string[];
  governments: string[];
  sources: string[];
  /** Контролирующие фракции: `[id, имя]`. */
  factions: Array<[number, string]>;
  systems: BgsLayerTuple[];
}

/** Строка слоя с сервера (RPC `bgs_layer_rows`). */
export interface BgsLayerRow {
  id64: string;
  name: string;
  x: number;
  y: number;
  z: number;
  allegiance: string | null;
  government: string | null;
  controllingId: number | null;
  controlling: string | null;
  population: number | null;
  factionsCount: number;
  observedSec: number | null;
  source: string | null;
}

export function encodeBgsLayer(rows: BgsLayerRow[]): Pick<BgsLayerResponse, 'allegiances' | 'governments' | 'sources' | 'factions' | 'systems'> {
  const allegiances: string[] = [...BGS_ALLEGIANCES];
  const governments: string[] = [];
  const governmentIndex = new Map<string, number>();
  const sources: string[] = [...BGS_SOURCES];
  const factions: Array<[number, string]> = [];
  const factionIndex = new Map<number, number>();
  const systems: BgsLayerTuple[] = [];
  for (const row of rows) {
    const allegiance = allegiances.indexOf(normalizeAllegiance(row.allegiance));
    const government = row.government ?? 'None';
    let gi = governmentIndex.get(government);
    if (gi === undefined) {
      gi = governments.length;
      governments.push(government);
      governmentIndex.set(government, gi);
    }
    let fi = -1;
    if (row.controllingId != null && row.controlling) {
      const known = factionIndex.get(row.controllingId);
      if (known !== undefined) fi = known;
      else {
        fi = factions.length;
        factions.push([row.controllingId, row.controlling]);
        factionIndex.set(row.controllingId, fi);
      }
    }
    systems.push([
      row.id64,
      row.name,
      row.x,
      row.y,
      row.z,
      allegiance,
      gi,
      fi,
      row.population,
      row.factionsCount,
      row.observedSec,
      Math.max(0, sources.indexOf(normalizeSource(row.source))),
    ]);
  }
  return { allegiances, governments, sources, factions, systems };
}

export interface BgsSystem {
  id64: string;
  name: string;
  nameLc: string;
  x: number;
  y: number;
  z: number;
  allegiance: BgsAllegiance;
  government: string | null;
  controllingId: number | null;
  controlling: string | null;
  population: number | null;
  factionsCount: number;
  /** Наблюдение, мс UTC. */
  observedAt: number | null;
  source: BgsSource;
}

export interface BgsLayerData {
  status: 'ready' | 'empty';
  version: string;
  meta: BgsLayerMeta;
  systems: BgsSystem[];
}

function num(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** `meta` ответа слоя (и короткого ответа `?meta=1`, которым вкладка следит за импортом). */
export function decodeBgsMeta(value: unknown): BgsLayerMeta {
  return metaFrom(value && typeof value === 'object' ? (value as Record<string, unknown>).meta : null);
}

function metaFrom(value: unknown): BgsLayerMeta {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const str = (field: string) => (typeof raw[field] === 'string' ? (raw[field] as string) : null);
  const progressRaw = raw.progress && typeof raw.progress === 'object' ? (raw.progress as Record<string, unknown>) : null;
  return {
    sourceUrl: str('sourceUrl') ?? EMPTY_BGS_META.sourceUrl,
    dumpGeneratedAt: str('dumpGeneratedAt'),
    syncedAt: str('syncedAt'),
    checkedAt: str('checkedAt'),
    systems: num(raw.systems) ?? 0,
    factions: num(raw.factions) ?? 0,
    presence: num(raw.presence) ?? 0,
    oldestObservation: str('oldestObservation'),
    newestObservation: str('newestObservation'),
    pilotUpdateAt: str('pilotUpdateAt'),
    refreshing: raw.refreshing === true,
    progress: progressRaw
      ? {
          stage: typeof progressRaw.stage === 'string' ? progressRaw.stage : null,
          stageLabel: typeof progressRaw.stageLabel === 'string' ? progressRaw.stageLabel : '',
          percent: Math.max(0, Math.min(100, num(progressRaw.percent) ?? 0)),
          message: typeof progressRaw.message === 'string' ? progressRaw.message.slice(0, 200) : '',
          startedAt: typeof progressRaw.startedAt === 'string' ? progressRaw.startedAt : null,
        }
      : null,
    lastError: str('lastError'),
  };
}

/** Ответ `GET /api/factions/systems` → системы слоя. Битые кортежи пропускаются. */
export function decodeBgsLayer(value: unknown): BgsLayerData {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const allegiances = Array.isArray(raw.allegiances) ? raw.allegiances.map(String) : [...BGS_ALLEGIANCES];
  const governments = Array.isArray(raw.governments) ? raw.governments.map(String) : [];
  const sources = Array.isArray(raw.sources) ? raw.sources.map(String) : [...BGS_SOURCES];
  const factions = Array.isArray(raw.factions) ? raw.factions : [];
  const systems: BgsSystem[] = [];
  for (const item of Array.isArray(raw.systems) ? raw.systems : []) {
    if (!Array.isArray(item) || item.length < 6) continue;
    const [id64, name, x, y, z, ai, gi, fi, population, count, observed, si] = item as unknown[];
    const px = num(x);
    const py = num(y);
    const pz = num(z);
    if (typeof name !== 'string' || !name || px == null || py == null || pz == null) continue;
    const faction = typeof fi === 'number' && fi >= 0 && Array.isArray(factions[fi]) ? (factions[fi] as unknown[]) : null;
    const seconds = num(observed);
    const government = typeof gi === 'number' ? governments[gi] ?? null : null;
    systems.push({
      id64: id64 == null ? '' : String(id64),
      name,
      nameLc: name.toLowerCase(),
      x: px,
      y: py,
      z: pz,
      allegiance: normalizeAllegiance(typeof ai === 'number' ? allegiances[ai] : null),
      government: government && government !== 'None' ? government : null,
      controllingId: faction ? num(faction[0]) : null,
      controlling: faction && typeof faction[1] === 'string' ? faction[1] : null,
      population: num(population),
      factionsCount: Math.max(0, num(count) ?? 0),
      observedAt: seconds == null ? null : seconds * 1000,
      source: normalizeSource(typeof si === 'number' ? sources[si] : null),
    });
  }
  return {
    status: raw.status === 'ready' && systems.length > 0 ? 'ready' : 'empty',
    version: typeof raw.version === 'string' ? raw.version : 'none',
    meta: metaFrom(raw.meta),
    systems,
  };
}

/* ── Поиск фракций, присутствие, карточка системы ───────────────────────── */

export interface BgsFactionSummary {
  id: number;
  name: string;
  allegiance: BgsAllegiance;
  government: string | null;
  isPlayer: boolean;
  systems: number;
  controlled: number;
}

export function decodeFactionSearch(value: unknown): BgsFactionSummary[] {
  const list = value && typeof value === 'object' && Array.isArray((value as { results?: unknown }).results)
    ? (value as { results: unknown[] }).results
    : Array.isArray(value) ? value : [];
  const out: BgsFactionSummary[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    const id = num(raw.id);
    if (id == null || typeof raw.name !== 'string') continue;
    out.push({
      id,
      name: raw.name,
      allegiance: normalizeAllegiance(raw.allegiance),
      government: typeof raw.government === 'string' ? raw.government : null,
      isPlayer: raw.isPlayer === true || raw.is_player === true,
      systems: Math.max(0, num(raw.systems) ?? 0),
      controlled: Math.max(0, num(raw.controlled) ?? 0),
    });
  }
  return out;
}

export interface BgsPresenceSystem {
  id64: string;
  name: string;
  nameLc: string;
  x: number;
  y: number;
  z: number;
  influence: number | null;
  state: string | null;
  controls: boolean;
  observedAt: number | null;
  activeStates: string[];
  pendingStates: string[];
  recoveringStates: string[];
  happiness: string | null;
  population: number | null;
  allegiance: BgsAllegiance;
}

export interface BgsFactionPresence {
  id: number;
  name: string;
  allegiance: BgsAllegiance;
  government: string | null;
  isPlayer: boolean;
  systemsCount: number;
  controlledCount: number;
  systems: BgsPresenceSystem[];
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function decodeFactionPresence(value: unknown): BgsFactionPresence[] {
  const list = value && typeof value === 'object' && Array.isArray((value as { factions?: unknown }).factions)
    ? (value as { factions: unknown[] }).factions
    : Array.isArray(value) ? value : [];
  const out: BgsFactionPresence[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    const id = num(raw.id);
    if (id == null || typeof raw.name !== 'string') continue;
    const systems: BgsPresenceSystem[] = [];
    for (const tuple of Array.isArray(raw.systems) ? raw.systems : []) {
      if (!Array.isArray(tuple) || tuple.length < 8) continue;
      const [id64, name, x, y, z, influence, state, controls, observed, active, pending, recovering, happiness, population, allegiance] = tuple as unknown[];
      const px = num(x);
      const py = num(y);
      const pz = num(z);
      if (typeof name !== 'string' || px == null || py == null || pz == null) continue;
      const seconds = num(observed);
      systems.push({
        id64: id64 == null ? '' : String(id64),
        name,
        nameLc: name.toLowerCase(),
        x: px,
        y: py,
        z: pz,
        influence: num(influence),
        state: typeof state === 'string' ? state : null,
        controls: controls === true,
        observedAt: seconds == null ? null : seconds * 1000,
        activeStates: strings(active),
        pendingStates: strings(pending),
        recoveringStates: strings(recovering),
        happiness: typeof happiness === 'string' ? happiness : null,
        population: num(population),
        allegiance: normalizeAllegiance(allegiance),
      });
    }
    out.push({
      id,
      name: raw.name,
      allegiance: normalizeAllegiance(raw.allegiance),
      government: typeof raw.government === 'string' ? raw.government : null,
      isPlayer: raw.isPlayer === true || raw.is_player === true,
      systemsCount: Math.max(0, num(raw.systemsCount ?? raw.systems_count) ?? systems.length),
      controlledCount: Math.max(0, num(raw.controlledCount ?? raw.controlled_count) ?? systems.filter((s) => s.controls).length),
      systems,
    });
  }
  return out;
}

export interface BgsSystemDetailFaction {
  id: number;
  name: string;
  allegiance: BgsAllegiance;
  government: string | null;
  isPlayer: boolean;
  influence: number | null;
  state: string | null;
  activeStates: string[];
  pendingStates: string[];
  recoveringStates: string[];
  happiness: string | null;
  systemsCount: number;
  controlledCount: number;
}

export interface BgsSystemDetail {
  id64: string;
  name: string;
  x: number;
  y: number;
  z: number;
  allegiance: BgsAllegiance;
  government: string | null;
  economy: string | null;
  secondEconomy: string | null;
  security: string | null;
  state: string | null;
  population: number | null;
  controllingId: number | null;
  controlling: string | null;
  observedAt: string | null;
  source: BgsSource;
  factions: BgsSystemDetailFaction[];
}

export function decodeSystemDetail(value: unknown): BgsSystemDetail | null {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  const system = raw?.system && typeof raw.system === 'object' ? (raw.system as Record<string, unknown>) : null;
  if (!system || typeof system.name !== 'string') return null;
  const x = num(system.x);
  const y = num(system.y);
  const z = num(system.z);
  if (x == null || y == null || z == null) return null;
  const factions: BgsSystemDetailFaction[] = [];
  for (const item of Array.isArray(raw?.factions) ? (raw!.factions as unknown[]) : []) {
    if (!item || typeof item !== 'object') continue;
    const f = item as Record<string, unknown>;
    const id = num(f.id);
    if (id == null || typeof f.name !== 'string') continue;
    factions.push({
      id,
      name: f.name,
      allegiance: normalizeAllegiance(f.allegiance),
      government: typeof f.government === 'string' ? f.government : null,
      isPlayer: f.isPlayer === true || f.is_player === true,
      influence: num(f.influence),
      state: typeof f.state === 'string' ? f.state : null,
      activeStates: strings(f.activeStates ?? f.active_states),
      pendingStates: strings(f.pendingStates ?? f.pending_states),
      recoveringStates: strings(f.recoveringStates ?? f.recovering_states),
      happiness: typeof f.happiness === 'string' ? f.happiness : null,
      systemsCount: Math.max(0, num(f.systemsCount ?? f.systems_count) ?? 0),
      controlledCount: Math.max(0, num(f.controlledCount ?? f.controlled_count) ?? 0),
    });
  }
  const str = (field: string) => (typeof system[field] === 'string' ? (system[field] as string) : null);
  return {
    id64: system.id64 == null ? '' : String(system.id64),
    name: system.name,
    x,
    y,
    z,
    allegiance: normalizeAllegiance(system.allegiance),
    government: str('government'),
    economy: str('economy'),
    secondEconomy: str('secondEconomy') ?? str('second_economy'),
    security: str('security'),
    state: str('state'),
    population: num(system.population),
    controllingId: num(system.controllingId ?? system.controlling_faction_id),
    controlling: str('controlling') ?? str('controlling_faction'),
    observedAt: str('observedAt') ?? str('observed_at'),
    source: normalizeSource(system.source),
    factions,
  };
}

/* ── Фильтр вкладки и выбранные фракции ─────────────────────────────────── */

export interface BgsFilter {
  /** Скрытые принадлежности слоя «все населённые системы». */
  hiddenAllegiances: BgsAllegiance[];
  /** У выбранных фракций — только системы, где они у власти. */
  controlsOnly: boolean;
  /** При выбранных фракциях показывать остальные населённые системы бледным фоном. */
  background: boolean;
}

export const DEFAULT_BGS_FILTER: BgsFilter = { hiddenAllegiances: [], controlsOnly: false, background: false };

export function parseBgsFilter(value: unknown): BgsFilter {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const hidden = Array.isArray(raw.hiddenAllegiances)
    ? BGS_ALLEGIANCES.filter((allegiance) => (raw.hiddenAllegiances as unknown[]).includes(allegiance))
    : [];
  return { hiddenAllegiances: hidden, controlsOnly: raw.controlsOnly === true, background: raw.background === true };
}

export function toggleAllegiance(filter: BgsFilter, allegiance: BgsAllegiance): BgsFilter {
  const hidden = filter.hiddenAllegiances.includes(allegiance)
    ? filter.hiddenAllegiances.filter((item) => item !== allegiance)
    : [...filter.hiddenAllegiances, allegiance];
  return { ...filter, hiddenAllegiances: BGS_ALLEGIANCES.filter((item) => hidden.includes(item)) };
}

export function soloAllegiance(filter: BgsFilter, allegiance: BgsAllegiance): BgsFilter {
  return { ...filter, hiddenAllegiances: BGS_ALLEGIANCES.filter((item) => item !== allegiance) };
}

export interface BgsSelectedFaction {
  id: number;
  name: string;
  color: string;
  allegiance: BgsAllegiance;
  /** Временно скрыта на карте (остаётся в списке выбранных). */
  hidden: boolean;
}

/** Не больше дюжины фракций за раз: цвета должны оставаться различимыми. */
export const BGS_MAX_SELECTED = 12;

export const BGS_SELECTION_COLORS = [
  '#f0af28', '#ef4444', '#22d3ee', '#a3e635', '#f472b6', '#818cf8',
  '#fb923c', '#2dd4bf', '#facc15', '#c084fc', '#4ade80', '#60a5fa',
];

export function nextSelectionColor(selected: Array<Pick<BgsSelectedFaction, 'color'>>): string {
  const used = new Set(selected.map((item) => item.color));
  return BGS_SELECTION_COLORS.find((color) => !used.has(color)) ?? BGS_SELECTION_COLORS[selected.length % BGS_SELECTION_COLORS.length];
}

export function parseBgsSelection(value: unknown): BgsSelectedFaction[] {
  if (!Array.isArray(value)) return [];
  const out: BgsSelectedFaction[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    const id = num(raw.id);
    if (id == null || typeof raw.name !== 'string' || out.some((entry) => entry.id === id)) continue;
    const color = typeof raw.color === 'string' && /^#[0-9a-f]{6}$/i.test(raw.color) ? raw.color : nextSelectionColor(out);
    out.push({ id, name: raw.name.slice(0, 160), color, allegiance: normalizeAllegiance(raw.allegiance), hidden: raw.hidden === true });
    if (out.length >= BGS_MAX_SELECTED) break;
  }
  return out;
}

export function filterBgsSystems(systems: BgsSystem[], filter: BgsFilter): BgsSystem[] {
  if (filter.hiddenAllegiances.length === 0) return systems;
  const hidden = new Set(filter.hiddenAllegiances);
  return systems.filter((system) => !hidden.has(system.allegiance));
}

export function searchBgsSystems<T extends { nameLc: string }>(systems: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return systems;
  const prefix: T[] = [];
  const inner: T[] = [];
  for (const system of systems) {
    if (system.nameLc.startsWith(q)) prefix.push(system);
    else if (system.nameLc.includes(q)) inner.push(system);
  }
  return [...prefix, ...inner];
}

export function countBgsAllegiances(systems: BgsSystem[]): Record<BgsAllegiance, number> {
  const out = Object.fromEntries(BGS_ALLEGIANCES.map((allegiance) => [allegiance, 0])) as Record<BgsAllegiance, number>;
  for (const system of systems) out[system.allegiance] += 1;
  return out;
}

/* ── Точки слоя на карте ────────────────────────────────────────────────── */

/** Выбранная фракция в системе (для подсказки, карточки и списка). */
export interface BgsPointEntry {
  factionId: number;
  name: string;
  color: string;
  influence: number | null;
  state: string | null;
  controls: boolean;
}

export type BgsPointShape = 0 | 1 | 2;

export interface BgsMapPoint {
  key: string;
  id64: string;
  name: string;
  nameLc: string;
  x: number;
  y: number;
  z: number;
  color: string;
  /** 0 — точка (присутствие), 1 — кольцо (несколько выбранных фракций), 2 — звезда (у власти выбранная). */
  shape: BgsPointShape;
  /** Размер в CSS-пикселях. */
  size: number;
  /** Фоновая точка (остальные населённые системы при выбранных фракциях). */
  background: boolean;
  /** Система из общего слоя (контролирующая фракция, принадлежность), если он загружен. */
  system: BgsSystem | null;
  /** Выбранные фракции в системе — по убыванию влияния. */
  entries: BgsPointEntry[];
  /** Сильнейшее влияние выбранной фракции (сортировка списка). */
  influence: number | null;
  observedAt: number | null;
}

export const BGS_POINT_SIZE = { base: 4, background: 3, dot: 7, ring: 9, star: 12 } as const;
const BACKGROUND_COLOR = '#4b5563';

function systemKey(id64: string, nameLc: string): string {
  return id64 || nameLc;
}

/**
 * Что рисовать на карте. Без выбранных фракций — все населённые системы под
 * фильтром принадлежности (цвет — принадлежность). С выбранными — только
 * системы, где они присутствуют: цвет — сильнейшая из выбранных в системе,
 * звезда — выбранная фракция у власти, кольцо — выбранных несколько.
 */
export function buildBgsMapPoints(params: {
  systems: BgsSystem[];
  filter: BgsFilter;
  selection: BgsSelectedFaction[];
  presence: ReadonlyMap<number, BgsFactionPresence>;
}): BgsMapPoint[] {
  const { systems, filter, selection, presence } = params;
  const byKey = new Map<string, BgsSystem>();
  for (const system of systems) byKey.set(systemKey(system.id64, system.nameLc), system);

  if (selection.length === 0) {
    return filterBgsSystems(systems, filter).map((system) => ({
      key: systemKey(system.id64, system.nameLc),
      id64: system.id64,
      name: system.name,
      nameLc: system.nameLc,
      x: system.x,
      y: system.y,
      z: system.z,
      color: BGS_ALLEGIANCE_COLOR[system.allegiance],
      shape: 0 as BgsPointShape,
      size: BGS_POINT_SIZE.base,
      background: false,
      system,
      entries: [],
      influence: null,
      observedAt: system.observedAt,
    }));
  }

  const points = new Map<string, BgsMapPoint>();
  for (const selected of selection) {
    if (selected.hidden) continue;
    const data = presence.get(selected.id);
    if (!data) continue;
    for (const item of data.systems) {
      if (filter.controlsOnly && !item.controls) continue;
      const k = systemKey(item.id64, item.nameLc);
      let point = points.get(k);
      if (!point) {
        point = {
          key: k,
          id64: item.id64,
          name: item.name,
          nameLc: item.nameLc,
          x: item.x,
          y: item.y,
          z: item.z,
          color: selected.color,
          shape: 0,
          size: BGS_POINT_SIZE.dot,
          background: false,
          system: byKey.get(k) ?? null,
          entries: [],
          influence: null,
          observedAt: item.observedAt,
        };
        points.set(k, point);
      }
      point.entries.push({
        factionId: selected.id,
        name: data.name,
        color: selected.color,
        influence: item.influence,
        state: item.state,
        controls: item.controls,
      });
    }
  }

  for (const point of points.values()) {
    point.entries.sort((a, b) => (b.influence ?? -1) - (a.influence ?? -1) || Number(b.controls) - Number(a.controls));
    const lead = point.entries.find((entry) => entry.controls) ?? point.entries[0];
    point.color = lead.color;
    point.influence = point.entries[0]?.influence ?? null;
    if (point.entries.some((entry) => entry.controls)) {
      point.shape = 2;
      point.size = BGS_POINT_SIZE.star;
    } else if (point.entries.length > 1) {
      point.shape = 1;
      point.size = BGS_POINT_SIZE.ring;
    }
  }

  const out = Array.from(points.values());
  if (filter.background) {
    for (const system of filterBgsSystems(systems, filter)) {
      const k = systemKey(system.id64, system.nameLc);
      if (points.has(k)) continue;
      out.push({
        key: k,
        id64: system.id64,
        name: system.name,
        nameLc: system.nameLc,
        x: system.x,
        y: system.y,
        z: system.z,
        color: BACKGROUND_COLOR,
        shape: 0,
        size: BGS_POINT_SIZE.background,
        background: true,
        system,
        entries: [],
        influence: null,
        observedAt: system.observedAt,
      });
    }
  }
  return out;
}

/** Строки списка: сначала где выбранные фракции у власти, затем по влиянию, затем по имени. */
export function orderBgsPoints(points: BgsMapPoint[]): BgsMapPoint[] {
  return points
    .filter((point) => !point.background)
    .sort((a, b) => {
      const ac = a.entries.some((entry) => entry.controls) ? 1 : 0;
      const bc = b.entries.some((entry) => entry.controls) ? 1 : 0;
      if (ac !== bc) return bc - ac;
      const ai = a.influence ?? -1;
      const bi = b.influence ?? -1;
      if (ai !== bi) return bi - ai;
      return a.nameLc.localeCompare(b.nameLc);
    });
}

export type BgsOverview = PowerplayOverview;

/** Центр и радиус набора для «показать на карте целиком». */
export function bgsOverview(points: Array<{ x: number; y: number; z: number }>): BgsOverview | null {
  return powerplayOverview(points);
}

/* ── Подписи ────────────────────────────────────────────────────────────── */

/** «45,2 %» (влияние хранится долей 0…1). */
export function formatInfluence(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const percent = value * 100;
  return `${percent.toLocaleString('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`;
}

/** «22,8 млрд», «4,1 млн», «15 тыс.». */
export function formatPopulation(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value <= 0) return '—';
  const units: Array<[number, string]> = [[1e9, 'млрд'], [1e6, 'млн'], [1e3, 'тыс.']];
  for (const [size, unit] of units) {
    if (value >= size) {
      const scaled = value / size;
      return `${scaled.toLocaleString('ru-RU', { maximumFractionDigits: scaled >= 100 ? 0 : 1 })} ${unit}`;
    }
  }
  return Math.round(value).toLocaleString('ru-RU');
}

export const formatBgsDate = formatPowerplayDate;

/** «сегодня», «вчера», «5 дн. назад». */
export function bgsAge(observedAt: number | string | null | undefined, now = Date.now()): string {
  const ms = typeof observedAt === 'string' ? Date.parse(observedAt) : observedAt;
  if (ms == null || !Number.isFinite(ms)) return 'дата неизвестна';
  const days = Math.floor(Math.max(0, now - ms) / 86_400_000);
  if (days === 0) return 'сегодня';
  if (days === 1) return 'вчера';
  return `${days} дн. назад`;
}
