/**
 * Палитра и форматирование карты системы.
 *
 * Один источник цвета и подписей для 3D-сцены и боковой панели сайта; те же
 * строки цветов повторяет приложение (`uploader/system_view.py`), иначе карта
 * в окне и на сайте расходилась бы.
 */

/** Цвета классов планет (ключ ищется подстрокой в классе тела). */
export const BODY_CLASS_COLORS: Record<string, string> = {
  earthlike: '#2ecc71',
  'water world': '#3498db',
  water: '#3498db',
  ammonia: '#b39ddb',
  'metal-rich': '#e67e22',
  metal: '#e67e22',
  high: '#f1c40f',
  rich: '#f1c40f',
  rocky: '#a08c7d',
  icy: '#9fd8ef',
  'gas giant': '#ff9f43',
  gas: '#ff9f43',
  helium: '#48dbfb',
  'sudarsky class i': '#8fb8de',
  'sudarsky class ii': '#9fc9e8',
  'sudarsky class iii': '#c2a37a',
  'sudarsky class iv': '#a8746a',
  'sudarsky class v': '#6b5b4c',
  thargoid: '#7ee787',
};

/** Запасной цвет планеты/луны неизвестного класса. */
export const BODY_FALLBACK_COLOR = '#8d99ae';

/** Цвета звёзд по спектральному классу (когда температуры в данных нет). */
export const STAR_SPECTRAL_COLORS: Record<string, string> = {
  O: '#9bb0ff', B: '#bbccff', A: '#f8f9fa', F: '#fff4e8', G: '#ffd166',
  K: '#ff9e42', M: '#ff5533', L: '#b8432a', T: '#8b2a1a', Y: '#5c1b12',
  N: '#00d4ff', Neutron: '#00d4ff', H: '#4a0e4e', Black: '#2d004d',
  W: '#66aaff', WN: '#5599ff', WC: '#3377ff', C: '#ff4422', S: '#ff6633',
  D: '#d8f0ff', MS: '#ff7755', AeBe: '#ccccff', TTS: '#ff8844',
};

/** Цвет звезды по умолчанию (солнечный). */
export const STAR_FALLBACK_COLOR = '#ffd166';

/** Цвета колец по классу. */
export const RING_CLASS_COLORS: Record<string, string> = {
  icy: '#9fd8ef',
  metal: '#f1c40f',
  rich: '#e67e22',
  rocky: '#a08c7d',
  default: '#b4c8dc',
};

/** Статусы построек — те же цвета, что и в списках сайта. */
export const STRUCTURE_COLORS = {
  active: '#ff9f43',
  complete: '#2ecc71',
  planned: '#64748b',
} as const;

/** Цвета слоёв сцены. */
export const SCENE_COLORS = {
  background: '#05070d',
  backgroundTop: '#0b1220',
  grid: '#16233a',
  ecliptic: '#1e3a5f',
  orbit: '#3d6c9c',
  orbitMoon: '#4a5c78',
  orbitReal: '#5aa9e6',
  orbitHint: '#2b3f57',
  habitableZone: '#2ecc71',
  label: '#dbe7f5',
  labelMuted: '#8fa3bf',
  player: '#00f3ff',
  selection: '#00f3ff',
  hover: '#ffe08a',
  bodyWarn: '#e74c3c',
} as const;

/** Цвет по строке `Hue` (R,G,B) — вспомогательная утилита для тестов. */
export function clampChannel(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

/** Цвет звезды: сначала настоящая температура, потом спектральный класс. */
export function starColor(subType: string | null | undefined, tempK: number, byTemperature?: (temp: number) => string | null): string {
  const byTemp = tempK > 0 && byTemperature ? byTemperature(tempK) : null;
  if (byTemp) return byTemp;
  const clean = (subType || '').trim();
  if (clean) {
    const upper = clean.toUpperCase();
    const keys = Object.keys(STAR_SPECTRAL_COLORS).sort((a, b) => b.length - a.length);
    for (const key of keys) {
      if (upper.startsWith(key.toUpperCase())) return STAR_SPECTRAL_COLORS[key];
    }
  }
  return STAR_FALLBACK_COLOR;
}

/** Цвет планеты/луны по её классу. */
export function bodyColor(subType: string | null | undefined, bodyClass?: string | null): string {
  const source = `${subType || ''} ${bodyClass || ''}`.toLowerCase();
  if (!source.trim()) return BODY_FALLBACK_COLOR;
  const keys = Object.keys(BODY_CLASS_COLORS).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (source.includes(key)) return BODY_CLASS_COLORS[key];
  }
  // Планеты с атмосферой, но без знакомого класса — не серые: у них есть лицо.
  if (source.includes('gas') || source.includes('sudarsky')) return '#ffb066';
  if (source.includes('high metal')) return '#c9a227';
  return BODY_FALLBACK_COLOR;
}

/** Цвет кольца по классу (`Icy`, `Metal Rich`, …). */
export function ringColor(ringClass: string | null | undefined): string {
  const source = (ringClass || '').toLowerCase();
  if (source.includes('icy')) return RING_CLASS_COLORS.icy;
  if (source.includes('rich')) return RING_CLASS_COLORS.rich;
  if (source.includes('metal')) return RING_CLASS_COLORS.metal;
  if (source.includes('rock')) return RING_CLASS_COLORS.rocky;
  return RING_CLASS_COLORS.default;
}

/** Цвет постройки по её состоянию. */
export function structureColor(structure: { complete: boolean; progress: number; requiredTons?: number }): string {
  if (structure.complete || structure.progress >= 100) return STRUCTURE_COLORS.complete;
  if (structure.progress > 0 || (structure.requiredTons ?? 0) > 0) return STRUCTURE_COLORS.active;
  return STRUCTURE_COLORS.planned;
}

/** Цвет орбиты: настоящая орбита ярче, у луны — тише. */
export function orbitColor(kind: 'star' | 'planet' | 'moon', real: boolean): string {
  if (kind === 'moon') return SCENE_COLORS.orbitMoon;
  return real ? SCENE_COLORS.orbitReal : SCENE_COLORS.orbit;
}

const NUMBER_FORMAT = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });

/** «1 234,5» — единый формат чисел во всех карточках. */
export function formatNumber(value: number | null | undefined, digits = 1): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: digits }).format(value);
}

/** Тоннаж: «12 345 т». */
export function formatTons(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return `${NUMBER_FORMAT.format(Math.round(value))} т`;
}

/** Дистанция в световых секундах и (крупно) в астрономических единицах. */
export function formatLightSeconds(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '—';
  const ls = `${formatNumber(value, value < 100 ? 1 : 0)} св. с`;
  const au = value / 499.00478;
  return au >= 0.05 ? `${ls} (${formatNumber(au, 2)} а.е.)` : ls;
}

/** Период обращения: сутки, если короткий, иначе годы. */
export function formatPeriod(days: number | null | undefined): string {
  if (typeof days !== 'number' || !Number.isFinite(days) || days <= 0) return '—';
  if (days >= 365.25) return `${formatNumber(days / 365.25, 2)} лет`;
  if (days >= 1) return `${formatNumber(days, 1)} сут`;
  return `${formatNumber(days * 24, 1)} ч`;
}

/** Радиус тела в километрах (или в радиусах Земли для планет). */
export function formatRadius(radiusM: number | null | undefined): string {
  if (typeof radiusM !== 'number' || !Number.isFinite(radiusM) || radiusM <= 0) return '—';
  const km = radiusM / 1000;
  const earths = radiusM / 6_371_000;
  if (earths >= 0.3 && earths <= 20) return `${NUMBER_FORMAT.format(Math.round(km))} км (${formatNumber(earths, 2)} R⊕)`;
  return `${NUMBER_FORMAT.format(Math.round(km))} км`;
}

/** Гравитация: м/с² в привычные g. */
export function formatGravity(gravity: number | null | undefined): string {
  if (typeof gravity !== 'number' || !Number.isFinite(gravity) || gravity <= 0) return '—';
  return `${formatNumber(gravity / 9.80665, 2)} g`;
}

/** Короткое имя тела: без префикса системы, если он есть. */
export function shortBodyName(name: string, systemName: string): string {
  if (!name) return '';
  const system = (systemName || '').trim();
  if (system && name.toLowerCase().startsWith(system.toLowerCase())) {
    const tail = name.slice(system.length).trim();
    if (tail) return tail;
  }
  return name;
}
