/**
 * PowerPlay 2.0 на карте Atlas: справочник держав, состояния систем,
 * компактный формат слоя `GET /api/powerplay/systems`, фильтр вкладки и
 * «зоны влияния».
 *
 * Чистые функции без зависимостей: модуль общий для сервера (импорт дампа,
 * API), браузера (вкладка «PowerPlay», 3D-слой) и тестов (`node --test`
 * импортирует его напрямую, поэтому здесь только стираемый TypeScript).
 *
 * Что считается «под контролем». В PowerPlay 2.0 у системы одно из четырёх
 * состояний (поле журнала `PowerplayState`):
 *   * Stronghold  — оплот державы, зона влияния 30 св. лет;
 *   * Fortified   — укреплённая система, зона 20 св. лет;
 *   * Exploited   — эксплуатируемая: под контролем, но своей зоны не даёт;
 *   * Unoccupied  — никем не контролируется (державы могут её захватывать).
 * Слой показывает три первых: у них есть `ControllingPower`.
 *
 * Чья система — отдельный вопрос (`PowerplayBasis`). Журнал игры пишет и
 * `ControllingPower` (владелец), и `Powers` — все державы, чьи зоны влияния
 * накрывают систему. Ночной дамп EDSM хранит только второе: по строке на
 * каждую державу из `Powers` с одним и тем же состоянием и датой. Поэтому
 * владелец по дампу ясен, лишь когда держава в списке одна; в пограничье, где
 * зоны нескольких держав пересекаются, он «не определён», пока его не скажет
 * журнал (Colonial Helper, загрузка журналов, CAPI, EDDN).
 */

import { sanitizePublicPowerplayProgress, type PowerplayPublicProgress } from './powerplayProgress.ts';

export type { PowerplayPublicProgress } from './powerplayProgress.ts';

export const POWERPLAY_STATES = ['Stronghold', 'Fortified', 'Exploited'] as const;
export type PowerplayState = (typeof POWERPLAY_STATES)[number];

export const POWERPLAY_STATE_LABEL: Record<PowerplayState, string> = {
  Stronghold: 'Оплот',
  Fortified: 'Укреплённая',
  Exploited: 'Эксплуатируемая',
};

/** Во множественном числе — для фильтров и счётчиков. */
export const POWERPLAY_STATE_PLURAL: Record<PowerplayState, string> = {
  Stronghold: 'Оплоты',
  Fortified: 'Укреплённые',
  Exploited: 'Эксплуатируемые',
};

export const POWERPLAY_STATE_HINT: Record<PowerplayState, string> = {
  Stronghold: 'Stronghold — оплот державы: зона влияния 30 св. лет',
  Fortified: 'Fortified — укреплённая система: зона влияния 20 св. лет',
  Exploited: 'Exploited — под контролем державы, своей зоны влияния не даёт',
};

/** Коротко о зоне — для карточки, где название состояния уже написано рядом. */
export const POWERPLAY_STATE_ZONE: Record<PowerplayState, string> = {
  Stronghold: 'зона влияния 30 св. лет',
  Fortified: 'зона влияния 20 св. лет',
  Exploited: 'своей зоны влияния не даёт',
};

/**
 * Радиус зоны влияния: в нём держава может захватывать свободные системы, а
 * её эксплуатируемые системы держатся, пока их накрывает хотя бы одна зона.
 */
export const POWERPLAY_STATE_RANGE_LY: Record<PowerplayState, number> = {
  Stronghold: 30,
  Fortified: 20,
  Exploited: 0,
};

const STATE_RANK: Record<PowerplayState, number> = { Stronghold: 0, Fortified: 1, Exploited: 2 };

export function powerplayStateRank(state: PowerplayState): number {
  return STATE_RANK[state] ?? 3;
}

export type PowerAllegiance = 'Empire' | 'Federation' | 'Alliance' | 'Independent';

export const POWER_ALLEGIANCE_LABEL: Record<PowerAllegiance, string> = {
  Empire: 'Империя',
  Federation: 'Федерация',
  Alliance: 'Альянс',
  Independent: 'Независимые',
};

export interface PowerInfo {
  /** Имя как в журнале игры и в дампах (`ControllingPower`). */
  name: string;
  /** Имя для подписи: в игре Арисса записана как «A. Lavigny-Duval». */
  label: string;
  allegiance: PowerAllegiance | null;
  /** Цвет державы, как в игре; подобран читаемым на тёмном фоне карты. */
  color: string;
}

/**
 * Двенадцать держав PowerPlay 2.0 (Zachary Hudson ушёл вместе с PowerPlay 1.0,
 * его место занял Jerome Archer). Неизвестная держава — новая в игре — не
 * теряется: она получает цвет из имени (`powerInfo`) и остаётся в фильтре.
 */
export const POWERPLAY_POWERS: readonly PowerInfo[] = [
  { name: 'A. Lavigny-Duval', label: 'Arissa Lavigny-Duval', allegiance: 'Empire', color: '#a13cf0' },
  { name: 'Aisling Duval', label: 'Aisling Duval', allegiance: 'Empire', color: '#19b5e6' },
  { name: 'Archon Delaine', label: 'Archon Delaine', allegiance: 'Independent', color: '#ef3b3d' },
  { name: 'Denton Patreus', label: 'Denton Patreus', allegiance: 'Empire', color: '#4ad4da' },
  { name: 'Edmund Mahon', label: 'Edmund Mahon', allegiance: 'Alliance', color: '#2fb53a' },
  { name: 'Felicia Winters', label: 'Felicia Winters', allegiance: 'Federation', color: '#f0af28' },
  { name: 'Jerome Archer', label: 'Jerome Archer', allegiance: 'Federation', color: '#e94ae6' },
  { name: 'Li Yong-Rui', label: 'Li Yong-Rui', allegiance: 'Independent', color: '#2df598' },
  { name: 'Nakato Kaine', label: 'Nakato Kaine', allegiance: 'Alliance', color: '#b6f837' },
  { name: 'Pranav Antal', label: 'Pranav Antal', allegiance: 'Independent', color: '#f8f62e' },
  { name: 'Yuri Grom', label: 'Yuri Grom', allegiance: 'Independent', color: '#ff7b2e' },
  { name: 'Zemina Torval', label: 'Zemina Torval', allegiance: 'Empire', color: '#3d82f5' },
  // Наследие PowerPlay 1.0: в свежих данных не встречается, но старый дамп не должен красить его серым.
  { name: 'Zachary Hudson', label: 'Zachary Hudson', allegiance: 'Federation', color: '#c2410c' },
];

/** Державы PowerPlay 2.0 — их фильтр вкладки показывает всегда, даже пока данные грузятся. */
export const POWERPLAY_ACTIVE_POWERS: readonly PowerInfo[] = POWERPLAY_POWERS.filter((power) => power.name !== 'Zachary Hudson');

const POWER_BY_KEY = new Map<string, PowerInfo>();
for (const power of POWERPLAY_POWERS) {
  POWER_BY_KEY.set(powerKey(power.name), power);
  POWER_BY_KEY.set(powerKey(power.label), power);
}
// Варианты написания из сторонних источников и старых дампов.
for (const [alias, name] of [
  ['arissa lavigny duval', 'A. Lavigny-Duval'],
  ['a lavigny duval', 'A. Lavigny-Duval'],
  ['lavigny duval', 'A. Lavigny-Duval'],
  ['li yong rui', 'Li Yong-Rui'],
  ['hudson', 'Zachary Hudson'],
] as const) {
  const info = POWERPLAY_POWERS.find((power) => power.name === name);
  if (info) POWER_BY_KEY.set(alias, info);
}

/** Ключ сравнения имени державы: регистр, точки, дефисы и кратные пробелы не важны. */
export function powerKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[.\-_'’]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Каноническое имя державы (как пишет журнал). Неизвестное имя возвращается
 * как есть, без лишних пробелов; пустое или явно мусорное — `null`.
 */
export function normalizePowerName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (!trimmed || trimmed.length > 64) return null;
  if (!/[a-z]/i.test(trimmed)) return null;
  return POWER_BY_KEY.get(powerKey(trimmed))?.name ?? trimmed;
}

/** Состояние PowerPlay 2.0 под контролем державы; Unoccupied и прочее — `null`. */
export function normalizePowerplayState(value: unknown): PowerplayState | null {
  if (typeof value !== 'string') return null;
  switch (value.trim().toLowerCase()) {
    case 'stronghold':
      return 'Stronghold';
    case 'fortified':
      return 'Fortified';
    case 'exploited':
      return 'Exploited';
    default:
      return null;
  }
}

function hashHue(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index++) hash = (Math.imul(hash, 31) + value.charCodeAt(index)) | 0;
  return Math.abs(hash) % 360;
}

function hslToHex(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number) => {
    const k = (n + h / 30) % 12;
    const color = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(color * 255).toString(16).padStart(2, '0');
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

/* ── Как определена держава системы ──────────────────────────────────────── */

/**
 * Откуда известно, чья система:
 *   * `journal` — поле `ControllingPower` журнала игры (Colonial Helper,
 *     загрузка журналов на сайте, CAPI, EDDN) — точно;
 *   * `sole`    — дамп EDSM перечисляет у системы одну державу: владелец она;
 *   * `kept`    — EDSM перечисляет несколько держав, и среди них та, что
 *     раньше была владельцем точно (по журналу или единственной в дампе):
 *     смена владельца в PowerPlay 2.0 идёт через «свободную» систему, и
 *     такое наблюдение её бы сняло;
 *   * `unknown` — EDSM перечисляет несколько держав, владелец среди них, но
 *     какой именно — дамп не знает.
 * `null` — строка записана до разбора по владельцу (старый импорт) и будет
 * заменена следующей загрузкой.
 */
export const POWERPLAY_BASES = ['journal', 'sole', 'kept', 'unknown'] as const;
export type PowerplayBasis = (typeof POWERPLAY_BASES)[number];

export const POWERPLAY_BASIS_LABEL: Record<PowerplayBasis, string> = {
  journal: 'по журналу игры (ControllingPower)',
  sole: 'по дампу EDSM: других держав в системе нет',
  kept: 'по прошлому точному наблюдению; сейчас EDSM видит здесь несколько держав',
  unknown: 'не определена: EDSM перечисляет несколько держав',
};

/** Коротко — для таблиц и CSV. */
export const POWERPLAY_BASIS_SHORT: Record<PowerplayBasis, string> = {
  journal: 'журнал',
  sole: 'EDSM, одна держава',
  kept: 'прошлое наблюдение',
  unknown: 'не определена',
};

export function normalizePowerplayBasis(value: unknown): PowerplayBasis | null {
  return typeof value === 'string' && (POWERPLAY_BASES as readonly string[]).includes(value) ? (value as PowerplayBasis) : null;
}

/**
 * Держава системы не определена. В браузере это обычный ключ: фильтр,
 * счётчики, цвет точки и карточка работают с ним как с ещё одной «державой».
 */
export const POWERPLAY_UNKNOWN_POWER = '?';

export const POWERPLAY_UNKNOWN_INFO: PowerInfo = {
  name: POWERPLAY_UNKNOWN_POWER,
  label: 'Держава не определена',
  allegiance: null,
  color: '#8b95a7',
};

export function isUnknownPower(power: string | null | undefined): boolean {
  return !power || power === POWERPLAY_UNKNOWN_POWER;
}

/** Справочник державы; неизвестной — подпись из имени и стабильный цвет. */
export function powerInfo(name: string): PowerInfo {
  if (isUnknownPower(name)) return POWERPLAY_UNKNOWN_INFO;
  const known = POWER_BY_KEY.get(powerKey(name));
  if (known) return known;
  return { name, label: name, allegiance: null, color: hslToHex(hashHue(name), 0.75, 0.62) };
}

export function powerColor(name: string): string {
  return powerInfo(name).color;
}

export function powerLabel(name: string): string {
  return powerInfo(name).label;
}

/** `#rrggbb` → [r, g, b] в долях единицы (для буферов three.js). */
export function hexToRgbUnit(hex: string): [number, number, number] {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return [0.8, 0.8, 0.8];
  const value = Number.parseInt(match[1], 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

/* ── Компактный формат слоя ─────────────────────────────────────────────── */

/**
 * Одна система в ответе API: `[id64, имя, x, y, z, индекс державы,
 * индекс состояния, наблюдение (unix-секунды) | null, индекс основания | null,
 * [индексы держав в системе]]`. Кортеж вместо объекта втрое короче на ~50
 * тысячах систем; id64 строкой — он шире 2^53.
 *
 * Индекс державы −1 — владелец не определён (дамп EDSM перечисляет несколько
 * держав). Старый клиент такой кортеж просто пропускает. Основание (`bases`)
 * и список держав — в конце кортежа и необязательны: держав в системе больше
 * одной или владелец неизвестен — тогда список есть.
 */
export type PowerplaySystemTuple = [
  string,
  string,
  number,
  number,
  number,
  number,
  number,
  number | null,
  (number | null)?,
  number[]?,
];

export type PowerplayLayerStatus = 'ready' | 'empty';

export interface PowerplayLayerMeta {
  /** Откуда данные: ночной дамп EDSM `powerPlay.json.gz`. */
  source: 'edsm';
  sourceUrl: string;
  /** Когда EDSM собрал дамп (Last-Modified). */
  dumpGeneratedAt: string | null;
  /** Когда сайт последний раз записал данные. */
  syncedAt: string | null;
  /** Когда сайт последний раз проверял источник (в том числе «без изменений»). */
  checkedAt: string | null;
  /** Самое старое и самое свежее наблюдение среди систем слоя. */
  oldestObservation: string | null;
  newestObservation: string | null;
  /** Идёт обновление из источника — пустой слой стоит перезапросить. */
  refreshing: boolean;
  /** Последняя ошибка обновления, понятная пользователю. */
  lastError: string | null;
  /** Ход идущего на сервере импорта: этап и процент (иначе null). */
  progress: PowerplayPublicProgress | null;
}

export interface PowerplayLayerResponse {
  status: PowerplayLayerStatus;
  /** Версия набора (импорт), она же ETag ответа. */
  version: string;
  powers: string[];
  states: PowerplayState[];
  /** Словарь оснований (`PowerplayBasis`) для девятого элемента кортежа. */
  bases: PowerplayBasis[];
  systems: PowerplaySystemTuple[];
  meta: PowerplayLayerMeta;
}

export interface PowerplaySystem {
  id64: string;
  name: string;
  /** Имя в нижнем регистре — для поиска по списку без повторных toLowerCase. */
  nameLc: string;
  x: number;
  y: number;
  z: number;
  /** Держава-владелец; `POWERPLAY_UNKNOWN_POWER`, если не определена. */
  power: string;
  state: PowerplayState;
  /** Когда источник видел систему в этом состоянии (мс), если известно. */
  observedAt: number | null;
  /** Откуда известен владелец; null — старый импорт. */
  basis: PowerplayBasis | null;
  /**
   * Державы в системе (поле журнала `Powers`): у неопределённой — претенденты
   * на роль владельца. Пусто, если держава в системе одна.
   */
  candidates: string[];
}

export interface PowerplayLayerData {
  status: PowerplayLayerStatus;
  version: string;
  powers: string[];
  systems: PowerplaySystem[];
  meta: PowerplayLayerMeta;
}

export interface PowerplayRow {
  id64: string;
  name: string;
  x: number;
  y: number;
  z: number;
  /** Держава-владелец или null, если не определена. */
  power: string | null;
  state: PowerplayState;
  observedAt: string | null;
  /** Откуда известен владелец; null — старый импорт. */
  basis?: PowerplayBasis | null;
  /** Державы в системе (`Powers`); у неопределённой — претенденты. */
  powers?: string[];
}

/**
 * Сборка ответа слоя. Державы — по числу систем (крупные первыми; державы,
 * которые только присутствуют в чужих системах, — в конце), системы — в
 * порядке строк (сервер отдаёт их отсортированными по имени).
 */
export function encodePowerplayLayer(
  rows: PowerplayRow[],
  meta: PowerplayLayerMeta,
  version: string,
): PowerplayLayerResponse {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.power) counts.set(row.power, (counts.get(row.power) ?? 0) + 1);
  }
  for (const row of rows) {
    for (const power of row.powers ?? []) {
      if (power && !counts.has(power)) counts.set(power, 0);
    }
  }
  const powers = Array.from(counts.keys()).sort((a, b) => (counts.get(b)! - counts.get(a)!) || a.localeCompare(b, 'en'));
  const powerIndex = new Map(powers.map((power, index) => [power, index]));
  const systems: PowerplaySystemTuple[] = rows.map((row) => {
    const observed = row.observedAt ? Date.parse(row.observedAt) : NaN;
    const tuple: PowerplaySystemTuple = [
      row.id64,
      row.name,
      row.x,
      row.y,
      row.z,
      row.power ? powerIndex.get(row.power)! : -1,
      POWERPLAY_STATES.indexOf(row.state),
      Number.isFinite(observed) ? Math.round(observed / 1000) : null,
    ];
    const basis = row.basis ? POWERPLAY_BASES.indexOf(row.basis) : -1;
    const present = row.powers ?? [];
    // Список держав нужен, когда он что-то добавляет к владельцу.
    const others = !row.power || present.length > 1
      ? present.map((power) => powerIndex.get(power)).filter((index): index is number => index != null)
      : [];
    if (basis >= 0 || others.length > 0) tuple.push(basis >= 0 ? basis : null);
    if (others.length > 0) tuple.push(others);
    return tuple;
  });
  return {
    status: rows.length > 0 ? 'ready' : 'empty',
    version,
    powers,
    states: [...POWERPLAY_STATES],
    bases: [...POWERPLAY_BASES],
    systems,
    meta,
  };
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export const EMPTY_POWERPLAY_META: PowerplayLayerMeta = {
  source: 'edsm',
  sourceUrl: 'https://www.edsm.net/en/nightly-dumps',
  dumpGeneratedAt: null,
  syncedAt: null,
  checkedAt: null,
  oldestObservation: null,
  newestObservation: null,
  refreshing: false,
  lastError: null,
  progress: null,
};

/** Разбор ответа API в браузере: битые кортежи пропускаются, а не роняют слой. */
export function decodePowerplayLayer(payload: unknown): PowerplayLayerData {
  const body = (payload && typeof payload === 'object' ? payload : {}) as Partial<PowerplayLayerResponse>;
  const powers = Array.isArray(body.powers) ? body.powers.map((power) => String(power)) : [];
  const states = Array.isArray(body.states) ? body.states : [...POWERPLAY_STATES];
  const bases = Array.isArray(body.bases) ? body.bases : [...POWERPLAY_BASES];
  const systems: PowerplaySystem[] = [];
  if (Array.isArray(body.systems)) {
    for (const tuple of body.systems) {
      if (!Array.isArray(tuple) || tuple.length < 7) continue;
      const [id64, name, x, y, z, powerIndex, stateIndex, observed, basisIndex, presentIndexes] = tuple as unknown[];
      // −1 — владелец не определён: система всё равно под контролем и видна на карте.
      const power = powerIndex === -1
        ? POWERPLAY_UNKNOWN_POWER
        : typeof powerIndex === 'number' ? powers[powerIndex] : undefined;
      const state = typeof stateIndex === 'number' ? normalizePowerplayState(states[stateIndex]) : null;
      const px = finite(x);
      const py = finite(y);
      const pz = finite(z);
      if (typeof name !== 'string' || !name || !power || !state || px == null || py == null || pz == null) continue;
      const observedSeconds = finite(observed);
      const candidates: string[] = [];
      if (Array.isArray(presentIndexes)) {
        for (const index of presentIndexes) {
          const candidate = typeof index === 'number' ? powers[index] : undefined;
          if (candidate && !candidates.includes(candidate)) candidates.push(candidate);
        }
      }
      systems.push({
        id64: id64 == null ? '' : String(id64),
        name,
        nameLc: name.toLowerCase(),
        x: px,
        y: py,
        z: pz,
        power,
        state,
        observedAt: observedSeconds == null ? null : observedSeconds * 1000,
        basis: typeof basisIndex === 'number' ? normalizePowerplayBasis(bases[basisIndex]) : null,
        candidates,
      });
    }
  }
  const rawMeta = (body.meta && typeof body.meta === 'object' ? body.meta : {}) as Partial<PowerplayLayerMeta>;
  const meta: PowerplayLayerMeta = {
    ...EMPTY_POWERPLAY_META,
    ...rawMeta,
    refreshing: rawMeta.refreshing === true,
    progress: sanitizePublicPowerplayProgress(rawMeta.progress),
  };
  const present = new Set(systems.map((system) => system.power));
  const listed = powers.filter((power) => present.has(power));
  // «Не определена» — в конце фильтра, как отдельная строка.
  if (present.has(POWERPLAY_UNKNOWN_POWER)) listed.push(POWERPLAY_UNKNOWN_POWER);
  return {
    status: body.status === 'ready' && systems.length > 0 ? 'ready' : 'empty',
    version: typeof body.version === 'string' ? body.version : '',
    powers: listed,
    systems,
    meta,
  };
}

/* ── Фильтр вкладки ─────────────────────────────────────────────────────── */

export interface PowerplayFilter {
  /**
   * Скрытые державы. Список «чего не показывать», а не «что показывать»:
   * держава, появившаяся в данных позже, видна сразу.
   */
  hiddenPowers: string[];
  states: Record<PowerplayState, boolean>;
}

export const DEFAULT_POWERPLAY_FILTER: PowerplayFilter = {
  hiddenPowers: [],
  states: { Stronghold: true, Fortified: true, Exploited: true },
};

export function isDefaultPowerplayFilter(filter: PowerplayFilter): boolean {
  return filter.hiddenPowers.length === 0 && POWERPLAY_STATES.every((state) => filter.states[state] !== false);
}

export function isPowerVisible(filter: PowerplayFilter, power: string): boolean {
  return !filter.hiddenPowers.includes(power);
}

export function togglePowerVisible(filter: PowerplayFilter, power: string): PowerplayFilter {
  const hidden = filter.hiddenPowers.includes(power)
    ? filter.hiddenPowers.filter((item) => item !== power)
    : [...filter.hiddenPowers, power];
  return { ...filter, hiddenPowers: hidden };
}

/** Только одна держава: остальные известные скрываются. */
export function soloPower(filter: PowerplayFilter, power: string, allPowers: string[]): PowerplayFilter {
  return { ...filter, hiddenPowers: allPowers.filter((item) => item !== power) };
}

export function showAllPowers(filter: PowerplayFilter): PowerplayFilter {
  return { ...filter, hiddenPowers: [] };
}

export function hideAllPowers(filter: PowerplayFilter, allPowers: string[]): PowerplayFilter {
  return { ...filter, hiddenPowers: [...allPowers] };
}

/** Только державы одной фракции (Империя, Федерация, Альянс, независимые). */
export function soloAllegiance(filter: PowerplayFilter, allegiance: PowerAllegiance, allPowers: string[]): PowerplayFilter {
  return { ...filter, hiddenPowers: allPowers.filter((power) => powerInfo(power).allegiance !== allegiance) };
}

/** Фильтр показывает ровно эту фракцию — подсветить её кнопку. */
export function isAllegianceSolo(filter: PowerplayFilter, allegiance: PowerAllegiance, allPowers: string[]): boolean {
  const own = allPowers.filter((power) => powerInfo(power).allegiance === allegiance);
  if (!own.length) return false;
  const hidden = new Set(filter.hiddenPowers);
  return own.every((power) => !hidden.has(power)) && allPowers.every((power) => powerInfo(power).allegiance === allegiance || hidden.has(power));
}

/**
 * Державы для фильтра: все двенадцать держав PowerPlay 2.0 — даже пока данные
 * не загрузились (галочки работают сразу и запоминаются), — плюс те, что
 * встретились в данных (новая держава или наследие PowerPlay 1.0).
 */
export function powerplayFilterPowers(dataPowers: string[] = []): string[] {
  const out: string[] = POWERPLAY_ACTIVE_POWERS.map((power) => power.name);
  const seen = new Set(out);
  for (const power of dataPowers) {
    if (!seen.has(power)) {
      seen.add(power);
      out.push(power);
    }
  }
  return out;
}

export function togglePowerplayState(filter: PowerplayFilter, state: PowerplayState): PowerplayFilter {
  return { ...filter, states: { ...filter.states, [state]: filter.states[state] === false } };
}

/** Фильтр из localStorage: всё непонятное заменяется значениями по умолчанию. */
export function parsePowerplayFilter(value: unknown): PowerplayFilter {
  const raw = (value && typeof value === 'object' ? value : {}) as Partial<PowerplayFilter>;
  const hiddenPowers = Array.isArray(raw.hiddenPowers)
    ? Array.from(new Set(raw.hiddenPowers.filter((item): item is string => typeof item === 'string' && item.length > 0 && item.length <= 64))).slice(0, 64)
    : [];
  const states = { ...DEFAULT_POWERPLAY_FILTER.states };
  if (raw.states && typeof raw.states === 'object') {
    for (const state of POWERPLAY_STATES) {
      if (typeof (raw.states as Record<string, unknown>)[state] === 'boolean') states[state] = (raw.states as Record<string, boolean>)[state];
    }
  }
  return { hiddenPowers, states };
}

export function filterPowerplaySystems(systems: PowerplaySystem[], filter: PowerplayFilter): PowerplaySystem[] {
  if (isDefaultPowerplayFilter(filter)) return systems;
  const hidden = new Set(filter.hiddenPowers);
  return systems.filter((system) => !hidden.has(system.power) && filter.states[system.state] !== false);
}

export interface PowerplayPowerCount {
  power: string;
  /** Систем, где держава — владелец (точно или по прошлому наблюдению). */
  total: number;
  states: Record<PowerplayState, number>;
  /**
   * Систем с неопределённым владельцем, где эта держава — среди претендентов.
   * Настоящее число её систем — от `total` до `total + contested`.
   */
  contested: number;
}

export interface PowerplayCounts {
  total: number;
  states: Record<PowerplayState, number>;
  /** По державам, крупные первыми; «не определена» — последней. */
  powers: PowerplayPowerCount[];
  /** Систем, у которых владелец не определён. */
  unknown: number;
}

function emptyStateCounts(): Record<PowerplayState, number> {
  return { Stronghold: 0, Fortified: 0, Exploited: 0 };
}

export function countPowerplay(systems: PowerplaySystem[], powersOrder: string[] = []): PowerplayCounts {
  const byPower = new Map<string, PowerplayPowerCount>();
  const entryFor = (power: string): PowerplayPowerCount => {
    let entry = byPower.get(power);
    if (!entry) {
      entry = { power, total: 0, states: emptyStateCounts(), contested: 0 };
      byPower.set(power, entry);
    }
    return entry;
  };
  for (const power of powersOrder) entryFor(power);
  const states = emptyStateCounts();
  let unknown = 0;
  for (const system of systems) {
    const entry = entryFor(system.power);
    entry.total += 1;
    entry.states[system.state] += 1;
    states[system.state] += 1;
    if (isUnknownPower(system.power)) {
      unknown += 1;
      for (const candidate of system.candidates ?? []) {
        if (!isUnknownPower(candidate)) entryFor(candidate).contested += 1;
      }
    }
  }
  const powers = Array.from(byPower.values()).sort((a, b) => {
    const unknownA = isUnknownPower(a.power) ? 1 : 0;
    const unknownB = isUnknownPower(b.power) ? 1 : 0;
    return (unknownA - unknownB) || (b.total - a.total) || a.power.localeCompare(b.power, 'en');
  });
  return { total: systems.length, states, powers, unknown };
}

/** Строка «откуда известен владелец» для карточки системы. */
export function powerplayBasisText(system: Pick<PowerplaySystem, 'power' | 'basis'>): string | null {
  if (isUnknownPower(system.power)) return POWERPLAY_BASIS_LABEL.unknown;
  return system.basis ? POWERPLAY_BASIS_LABEL[system.basis] : null;
}

/**
 * Список для панели: оплоты, затем укреплённые, затем эксплуатируемые; внутри —
 * порядок входа (сервер уже отсортировал по имени), поэтому без повторной
 * сортировки строк на ~50 тысячах записей.
 */
export function orderPowerplaySystems(systems: PowerplaySystem[]): PowerplaySystem[] {
  const buckets: PowerplaySystem[][] = [[], [], []];
  for (const system of systems) buckets[powerplayStateRank(system.state)]?.push(system);
  return buckets.flat();
}

export function searchPowerplaySystems(systems: PowerplaySystem[], query: string): PowerplaySystem[] {
  const needle = query.trim().replace(/\s+/g, ' ').toLowerCase();
  if (!needle) return systems;
  const exact: PowerplaySystem[] = [];
  const prefix: PowerplaySystem[] = [];
  const rest: PowerplaySystem[] = [];
  for (const system of systems) {
    if (system.nameLc === needle) exact.push(system);
    else if (system.nameLc.startsWith(needle)) prefix.push(system);
    else if (system.nameLc.includes(needle)) rest.push(system);
  }
  return [...exact, ...prefix, ...rest];
}

export function findPowerplaySystem(systems: PowerplaySystem[], name: string): PowerplaySystem | null {
  const key = name.trim().replace(/\s+/g, ' ').toLowerCase();
  if (!key) return null;
  return systems.find((system) => system.nameLc === key) ?? null;
}

/* ── Зоны влияния ───────────────────────────────────────────────────────── */

export interface PowerplayPoint {
  x: number;
  y: number;
  z: number;
}

export function distanceLy(a: PowerplayPoint, b: PowerplayPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export interface PowerplayInfluence {
  power: string;
  /** Ближайшая система державы, чья зона накрывает точку. */
  nearest: { id64: string; name: string; state: PowerplayState; distance: number };
  /** Сколько оплотов и укреплённых систем этой державы накрывают точку. */
  sources: number;
}

/**
 * Чьи зоны влияния накрывают точку: оплоты в 30 св. лет и укреплённые системы
 * в 20 св. лет. Для колонизации это ответ на вопрос «какая держава может
 * забрать мою систему». Сама система (`excludeId64`) в расчёт не идёт.
 */
export function powerplayInfluenceAt(
  point: PowerplayPoint,
  systems: PowerplaySystem[],
  options: { excludeId64?: string | null } = {},
): PowerplayInfluence[] {
  const byPower = new Map<string, PowerplayInfluence>();
  const maxRange = POWERPLAY_STATE_RANGE_LY.Stronghold;
  for (const system of systems) {
    const range = POWERPLAY_STATE_RANGE_LY[system.state];
    if (!range) continue;
    if (options.excludeId64 && system.id64 === options.excludeId64) continue;
    const dx = system.x - point.x;
    if (dx > maxRange || dx < -maxRange) continue;
    const dz = system.z - point.z;
    if (dz > maxRange || dz < -maxRange) continue;
    const distance = Math.hypot(dx, system.y - point.y, dz);
    if (distance > range) continue;
    const current = byPower.get(system.power);
    if (!current) {
      byPower.set(system.power, {
        power: system.power,
        nearest: { id64: system.id64, name: system.name, state: system.state, distance },
        sources: 1,
      });
    } else {
      current.sources += 1;
      if (distance < current.nearest.distance) {
        current.nearest = { id64: system.id64, name: system.name, state: system.state, distance };
      }
    }
  }
  return Array.from(byPower.values()).sort((a, b) => a.nearest.distance - b.nearest.distance);
}

/* ── Обзор на карте ──────────────────────────────────────────────────────── */

export interface PowerplayOverview extends PowerplayPoint {
  /** Радиус, в котором лежит основная часть систем (85-й перцентиль), св. лет. */
  radius: number;
  count: number;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Куда смотреть, чтобы увидеть набор целиком: центр — медиана по осям (одна
 * далёкая система не утаскивает камеру), радиус — 85-й перцентиль расстояний.
 */
export function powerplayOverview(systems: PowerplayPoint[]): PowerplayOverview | null {
  if (!systems.length) return null;
  const center = {
    x: median(systems.map((system) => system.x)),
    y: median(systems.map((system) => system.y)),
    z: median(systems.map((system) => system.z)),
  };
  const distances = systems.map((system) => distanceLy(system, center)).sort((a, b) => a - b);
  const radius = distances[Math.min(distances.length - 1, Math.floor(distances.length * 0.85))] ?? 0;
  return { ...center, radius: Math.max(20, radius), count: systems.length };
}

/* ── Подписи ────────────────────────────────────────────────────────────── */

export function formatLy(distance: number): string {
  const digits = distance < 10 ? 2 : 1;
  return `${distance.toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits })} св. лет`;
}

/** «16.10.2026» по UTC — даты наблюдений в дампе в UTC. */
export function formatPowerplayDate(value: number | string | null | undefined): string {
  if (value == null) return '—';
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return '—';
  const date = new Date(ms);
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}.${date.getUTCFullYear()}`;
}

/** «сегодня», «вчера», «5 дн. назад» — возраст наблюдения для карточки. */
export function powerplayAge(observedAt: number | null, now = Date.now()): string {
  if (observedAt == null || !Number.isFinite(observedAt)) return 'дата наблюдения неизвестна';
  const days = Math.floor(Math.max(0, now - observedAt) / 86_400_000);
  if (days === 0) return 'сегодня';
  if (days === 1) return 'вчера';
  return `${days} дн. назад`;
}
