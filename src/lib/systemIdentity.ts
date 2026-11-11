/**
 * Единая идентичность звёздной системы для всего проекта.
 *
 * Раньше одна и та же функция «ключ имени системы» жила в десятке копий
 * (`systemNameKey`, `carrierSystemKey`, `coordinateNameKey`,
 * `normalizeSystemKey`, `nearbyNameKey`, `systemKey` в Архитекторе, лидерборде
 * и парсере журнала…). Копии совпадали по смыслу, но любая правка одной из них
 * незаметно ломала бы связь между разделами: система «Col 285 Sector AB-C d1»
 * из журнала, из каталога и из проекта должна давать один и тот же ключ.
 *
 * Здесь одно определение, а старые имена теперь просто ссылаются на него.
 *
 * Правило ключа: управляющие символы → пробел, пробелы схлопываются, края
 * обрезаются, регистр нижний. Для нормальных имён это ровно то, что пишут
 * колонки БД: `galaxy_systems.name_lc`, `bgs_systems.name_lc`,
 * `powerplay_systems.name_lc`, `system_plans.system_name_lc`,
 * `architect_project_systems.system_name_lc`, `station_commerce.system_lc`,
 * индексы `lower(btrim(system_name))`.
 *
 * Ссылки между разделами («открыть систему в Атласе / на карте фракций /
 * в поиске станций») тоже строятся здесь, чтобы каждая страница вела в одни
 * и те же места одинаковыми адресами.
 *
 * Модуль без зависимостей: его берут и браузер, и маршруты, и `node --test`.
 */

/** Отображаемое имя: без управляющих символов и лишних пробелов, регистр сохранён. */
export function cleanSystemName(value: unknown): string {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Ключ сравнения систем — один для всех таблиц и разделов. */
export function systemKey(value: unknown): string {
  return cleanSystemName(value).toLowerCase();
}

/** Две записи об одной системе? */
export function sameSystem(a: unknown, b: unknown): boolean {
  const left = systemKey(a);
  return left !== '' && left === systemKey(b);
}

const MAX_ID64 = BigInt('9223372036854775807');

/**
 * Адрес системы (id64 / SystemAddress) строкой без потери разрядов или null.
 * Адрес шире 2^53, поэтому число, уже потерявшее точность, не принимается.
 */
export function systemId64(value: unknown): string | null {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) return null;
    return String(value);
  }
  if (typeof value === 'bigint') return value > BigInt(0) && value <= MAX_ID64 ? value.toString() : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!/^\d{1,19}$/.test(text)) return null;
  const parsed = BigInt(text);
  return parsed > BigInt(0) && parsed <= MAX_ID64 ? parsed.toString() : null;
}

export interface SystemPoint {
  x: number;
  y: number;
  z: number;
}

function finitePoint(point: Partial<SystemPoint> | null | undefined): SystemPoint | null {
  if (!point) return null;
  const x = Number(point.x);
  const y = Number(point.y);
  const z = Number(point.z);
  return [x, y, z].every((n) => Number.isFinite(n) && Math.abs(n) <= 100_000) ? { x, y, z } : null;
}

/** Карточка системы на сайте: всё, что проект знает о системе, на одной странице. */
export function systemPageHref(name: unknown, options: { body?: string | null } = {}): string {
  const clean = cleanSystemName(name);
  const base = `/system/${encodeURIComponent(clean)}`;
  return options.body ? `${base}?body=${encodeURIComponent(options.body)}` : base;
}

export type AtlasSystemTab = 'search' | 'market' | 'nearby' | 'powerplay' | 'factions' | 'route-finder' | 'ship-route' | 'ring-route';

/**
 * Атлас с наведением на систему. Вкладки PowerPlay и «Фракции» по `focus_id64`
 * сами открывают карточку системы на своём слое, «Рынок» и «Поблизости» берут
 * её опорной системой; остальные вкладки показывают отметку системы на карте
 * (по координатам).
 */
export function atlasSystemHref(
  name: unknown,
  options: { tab?: AtlasSystemTab; point?: Partial<SystemPoint> | null; id64?: unknown; from?: 'system' | 'stations'; commodity?: string } = {},
): string {
  const params = new URLSearchParams();
  if (options.tab && options.tab !== 'search') params.set('tab', options.tab);
  const clean = cleanSystemName(name);
  // «Рынок» и «Поблизости» берут опорную систему из `system`.
  if ((options.tab === 'market' || options.tab === 'nearby') && clean) params.set('system', clean);
  const commodity = options.commodity?.trim();
  if (options.tab === 'market' && commodity) params.set('commodity', commodity);
  const point = finitePoint(options.point);
  if (clean && point) {
    params.set('focus_system', clean);
    params.set('x', String(point.x));
    params.set('y', String(point.y));
    params.set('z', String(point.z));
  }
  const id64 = systemId64(options.id64);
  if (id64) params.set('focus_id64', id64);
  if (options.from && point) params.set('from', options.from);
  const query = params.toString();
  return query ? `/atlas?${query}` : '/atlas';
}

/**
 * Параметры адреса Атласа для фокуса на носителе.
 *
 * `carrier` — MarketID носителя: вкладка «Авианосцы» включает слой и выбирает
 * систему, в которой носитель стоит сейчас (камера летит туда же, куда при
 * клике по значку на карте). `carrier_system` — запасной ориентир, если
 * носителя в ответе слоя уже нет: по нему ищется система. Координаты
 * (`focus_system`, `x/y/z`) добавляются, когда они известны на странице-
 * источнике (`/carriers/jumps`), — тогда камера прилетает сразу, не дожидаясь
 * загрузки слоя.
 */
export const ATLAS_CARRIER_PARAM = 'carrier';
export const ATLAS_CARRIER_SYSTEM_PARAM = 'carrier_system';

/** MarketID носителя: только цифры, иначе параметр считается мусором. */
export function carrierMarketId(value: unknown): string | null {
  const clean = String(value ?? '').trim();
  return /^\d{1,20}$/.test(clean) ? clean : null;
}

export interface AtlasCarrierTarget {
  /** MarketID носителя; `null` — в адресе была только система. */
  carrierId: string | null;
  system: string | null;
  /** Координаты системы, если страница-источник их передала. */
  point: SystemPoint | null;
}

/**
 * Адрес Атласа с фокусом на носителе: `/atlas?tab=carriers&carrier=<MarketID>`.
 *
 * Так строка `/carriers/jumps` (таблица, история, расписание) ведёт туда же,
 * куда ведёт строка вкладки «Авианосцы»: вкладка открывается, слой включён,
 * камера на системе носителя. Адрес без MarketID (старый план расписания без
 * привязки к реестру) остаётся просто ссылкой на вкладку.
 */
export function carrierAtlasHref(
  carrierId: unknown,
  options: { system?: unknown; point?: Partial<SystemPoint> | null } = {},
): string {
  const params = new URLSearchParams();
  params.set('tab', 'carriers');
  const id = carrierMarketId(carrierId);
  if (id) params.set(ATLAS_CARRIER_PARAM, id);
  const system = cleanSystemName(options.system);
  if (system) {
    params.set(ATLAS_CARRIER_SYSTEM_PARAM, system);
    const point = finitePoint(options.point);
    if (point) {
      params.set('focus_system', system);
      params.set('x', String(point.x));
      params.set('y', String(point.y));
      params.set('z', String(point.z));
      params.set('from', 'system');
    }
  }
  return `/atlas?${params.toString()}`;
}

/** Координаты из адреса: те же границы, что у `atlasSystemHref`. */
function pointFromParams(params: Pick<URLSearchParams, 'get'>): SystemPoint | null {
  const values = ['x', 'y', 'z'].map((key) => params.get(key));
  if (values.some((value) => value == null || value.trim() === '')) return null;
  const [x, y, z] = values.map(Number) as [number, number, number];
  if (![x, y, z].every((n) => Number.isFinite(n) && Math.abs(n) <= 100_000)) return null;
  return { x, y, z };
}

/**
 * Что фокусировать по адресу Атласа. `null` — адрес не про носителя, и
 * страница ведёт себя как раньше (вкладка, поиск, слой фракций).
 */
export function carrierAtlasTargetFromParams(params: Pick<URLSearchParams, 'get'>): AtlasCarrierTarget | null {
  const carrierId = carrierMarketId(params.get(ATLAS_CARRIER_PARAM));
  const system = cleanSystemName(params.get(ATLAS_CARRIER_SYSTEM_PARAM)).slice(0, 200) || null;
  if (!carrierId && !system) return null;
  return { carrierId, system, point: pointFromParams(params) };
}

/** Поиск станций с опорной системой (и, если нужно, вкладкой и запросом). */
export function stationSearchHref(
  reference: unknown,
  options: { kind?: 'market' | 'outfitting' | 'shipyard' | 'services'; q?: string } = {},
): string {
  const params = new URLSearchParams();
  const clean = cleanSystemName(reference);
  if (clean) params.set('reference', clean);
  if (options.kind && options.kind !== 'market') params.set('kind', options.kind);
  if (options.q) params.set('q', options.q);
  const query = params.toString();
  return query ? `/station-search?${query}` : '/station-search';
}

/** Внешние сервисы — одинаковые адреса на всех страницах. */
export function externalSystemLinks(name: unknown, id64?: unknown): { edsm: string; spansh: string | null; raven: string; inara: string } {
  const clean = cleanSystemName(name);
  const address = systemId64(id64);
  return {
    edsm: `https://www.edsm.net/en/system?systemName=${encodeURIComponent(clean)}`,
    spansh: address ? `https://spansh.co.uk/system/${address}` : null,
    raven: `https://ravencolonial.com/#sys=${encodeURIComponent(clean)}`,
    inara: `https://inara.cz/elite/starsystem/?search=${encodeURIComponent(clean)}`,
  };
}
