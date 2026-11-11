/**
 * Каталог авианосцев (`/carriers`) — правила страницы без React и без БД.
 *
 * Страница показывает **все** известные сайту носители одной таблицей: учёт
 * сайта (`fleet_carriers`) плюс реестр EDDN (`carrier_directory`). Строки
 * собирает сервер (`carrier_catalog_page`, миграция
 * `20261116090000_carrier_catalog.sql`), а здесь живёт всё, что нужно обоим
 * концам: разбор адреса (`?q=&origin=&scope=&jump=&sort=&page=`), очистка
 * поисковой строки, окно страниц, приведение строки базы к виду для таблицы.
 *
 * Почему адрес, а не состояние компонента: ссылкой на список делятся («смотри,
 * какие носители стоят у Lave»), а после перезагрузки должно открыться то же
 * самое. Поэтому каждое изменение фильтра пишется в адрес.
 *
 * Приватности здесь нет по построению: в строке нет ни владельца, ни трюма,
 * ни финансов — только то, что видно в игре любому пилоту. Имя владельца
 * остаётся в карточке носителя, где решается по его настройкам.
 */

import { carrierCardServices, carrierCardServiceSummary, type CarrierCardService } from './carrierCard.ts';
import { dockingLabel } from './carrierServices.ts';

/** Сколько строк на страницу по умолчанию и максимум (тот же предел у SQL-функции). */
export const CARRIER_CATALOG_PAGE_SIZE = 50;
export const CARRIER_CATALOG_MAX_PAGE_SIZE = 100;
/** Длиннее искать бессмысленно: в позывном 7 знаков, в системе — 40. */
export const CARRIER_CATALOG_SEARCH_MAX = 60;
/** С какого номера страницы начинается счёт (для ссылок и подписей). */
export const CARRIER_CATALOG_FIRST_PAGE = 1;

export type CarrierCatalogSort = 'recent' | 'name' | 'system';
export type CarrierCatalogOrigin = 'all' | 'site' | 'eddn';
export type CarrierCatalogScope = 'all' | 'mine';
export type CarrierCatalogJump = 'all' | 'planned';

/** Всё состояние таблицы, которое видно в адресе. */
export interface CarrierCatalogState {
  q: string;
  origin: CarrierCatalogOrigin;
  scope: CarrierCatalogScope;
  jump: CarrierCatalogJump;
  sort: CarrierCatalogSort;
  page: number;
}

export interface CarrierCatalogPosition {
  x: number;
  y: number;
  z: number;
}

export interface CarrierCatalogJumpOrder {
  system: string;
  departureAt: string | null;
  /** `scheduled` — время вылета ещё не пришло, `jumping` — носитель в прыжке. */
  state: 'scheduled' | 'jumping';
}

/** Строка таблицы. Груза, финансов и имени владельца здесь нет и быть не может. */
export interface CarrierCatalogRow {
  id: string;
  callsign: string | null;
  name: string | null;
  type: 'FleetCarrier' | 'SquadronCarrier';
  origin: 'site' | 'eddn';
  system: string | null;
  body: string | null;
  position: CarrierCatalogPosition | null;
  relation: 'own' | 'squadron' | 'other';
  decommission: boolean;
  jump: CarrierCatalogJumpOrder | null;
  docking: string | null;
  notorious: boolean | null;
  services: { active: number; total: number };
  sightings: number | null;
  seenAt: string | null;
  updatedAt: string | null;
}

export const CARRIER_CATALOG_DEFAULT_STATE: CarrierCatalogState = {
  q: '',
  origin: 'all',
  scope: 'all',
  jump: 'all',
  sort: 'recent',
  page: CARRIER_CATALOG_FIRST_PAGE,
};

function text(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

/** Момент времени строкой ISO или `null`: SQL отдаёт `+00:00`, браузеру нужен `Z`. */
export function catalogIso(value: unknown): string | null {
  if (value == null || value === '') return null;
  const ms = typeof value === 'number' ? value : Date.parse(String(value));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Поисковая строка: то, что действительно уходит в SQL.
 *
 * `%`, `_` и `\` — служебные символы `LIKE`, а кавычки и скобки ломают
 * PostgREST-фильтры. Их проще выкинуть, чем экранировать: пилот ищет
 * «k7q-bql», а не шаблон. Регистр не важен — `search_text` уже в нижнем.
 */
export function normalizeCatalogSearch(value: unknown): string {
  return text(value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[%_\\'"`,;()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, CARRIER_CATALOG_SEARCH_MAX)
    .trim();
}

/** Номер страницы из адреса: мусор и отрицательные значения — первая. */
export function catalogPageNumber(value: unknown): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const number = Number(raw);
  if (!Number.isFinite(number) || number < 1) return CARRIER_CATALOG_FIRST_PAGE;
  return Math.min(100_000, Math.floor(number));
}

export function catalogOrigin(value: unknown): CarrierCatalogOrigin {
  const raw = text(value).toLowerCase();
  return raw === 'site' || raw === 'eddn' ? raw : 'all';
}

export function catalogScope(value: unknown): CarrierCatalogScope {
  return text(value).toLowerCase() === 'mine' ? 'mine' : 'all';
}

export function catalogJumpFilter(value: unknown): CarrierCatalogJump {
  const raw = text(value).toLowerCase();
  return raw === 'planned' || raw === 'jump' ? 'planned' : 'all';
}

export function catalogSort(value: unknown): CarrierCatalogSort {
  const raw = text(value).toLowerCase();
  return raw === 'name' || raw === 'system' ? raw : 'recent';
}

/** Сколько всего страниц при таком количестве совпадений (минимум одна). */
export function catalogPageCount(total: number, pageSize = CARRIER_CATALOG_PAGE_SIZE): number {
  const size = Math.max(1, Math.floor(pageSize));
  const count = Math.ceil(Math.max(0, Math.floor(total)) / size);
  return Math.max(CARRIER_CATALOG_FIRST_PAGE, count);
}

/** Номер страницы, который точно существует: из адреса можно прийти на «999». */
export function catalogClampPage(page: number, pages: number): number {
  return Math.min(Math.max(CARRIER_CATALOG_FIRST_PAGE, page), Math.max(CARRIER_CATALOG_FIRST_PAGE, pages));
}

/**
 * Окно номеров страниц для пейджера: `1 … 4 5 6 … 20`.
 *
 * Ноль — разделитель: так разметка отличает «страница» от многоточия, и
 * кнопки не превращаются в ссылки на несуществующие номера.
 */
export function catalogPageWindow(page: number, pages: number, radius = 1): number[] {
  const last = Math.max(CARRIER_CATALOG_FIRST_PAGE, Math.floor(pages));
  const current = catalogClampPage(page, last);
  const numbers = new Set<number>([CARRIER_CATALOG_FIRST_PAGE, last]);
  for (let offset = -radius; offset <= radius; offset += 1) numbers.add(current + offset);
  const sorted = [...numbers].filter((number) => number >= CARRIER_CATALOG_FIRST_PAGE && number <= last).sort((a, b) => a - b);
  const out: number[] = [];
  for (const number of sorted) {
    if (out.length && number - out[out.length - 1] > 1) out.push(0);
    out.push(number);
  }
  return out;
}

/** Разбор адреса страницы (`URLSearchParams` или `location.search`). */
export function parseCatalogState(input: URLSearchParams | string | null | undefined): CarrierCatalogState {
  const params = typeof input === 'string'
    ? new URLSearchParams(input.startsWith('?') ? input.slice(1) : input)
    : input ?? new URLSearchParams();
  return {
    q: normalizeCatalogSearch(params.get('q')),
    origin: catalogOrigin(params.get('origin')),
    scope: catalogScope(params.get('scope')),
    jump: catalogJumpFilter(params.get('jump')),
    sort: catalogSort(params.get('sort')),
    page: catalogPageNumber(params.get('page')),
  };
}

/**
 * Адрес с состоянием таблицы: только то, что отличается от умолчаний.
 * Порядок параметров фиксирован, чтобы одинаковое состояние давало одинаковую
 * ссылку и `history.replaceState` не писал одно и то же.
 */
export function catalogQueryString(state: Partial<CarrierCatalogState>): string {
  const params = new URLSearchParams();
  const q = normalizeCatalogSearch(state.q);
  if (q) params.set('q', q);
  if (state.origin && state.origin !== 'all') params.set('origin', state.origin);
  if (state.scope && state.scope !== 'all') params.set('scope', state.scope);
  if (state.jump && state.jump !== 'all') params.set('jump', state.jump);
  if (state.sort && state.sort !== 'recent') params.set('sort', state.sort);
  const page = catalogPageNumber(state.page);
  if (page > CARRIER_CATALOG_FIRST_PAGE) params.set('page', String(page));
  return params.toString();
}

/** Полный адрес страницы: `/carriers?...` — для пейджера и кнопки «сбросить». */
export function catalogHref(state: Partial<CarrierCatalogState>): string {
  const query = catalogQueryString(state);
  return query ? `/carriers?${query}` : '/carriers';
}

/** Запрос к маршруту: те же параметры, что в адресе, плюс размер страницы. */
export function catalogApiHref(state: Partial<CarrierCatalogState>, pageSize = CARRIER_CATALOG_PAGE_SIZE): string {
  const params = new URLSearchParams(catalogQueryString(state));
  const size = Math.max(1, Math.min(CARRIER_CATALOG_MAX_PAGE_SIZE, Math.floor(pageSize)));
  if (size !== CARRIER_CATALOG_PAGE_SIZE) params.set('pageSize', String(size));
  const query = params.toString();
  return query ? `/api/carriers/directory?${query}` : '/api/carriers/directory';
}

/**
 * Состояние заказа прыжка по времени вылета.
 *
 * Прыжок считается начавшимся, когда время вылета прошло: подтверждение
 * приходит из журнала позже, и до него носитель уже не стоит на месте.
 */
export function catalogJumpState(departureAt: string | null, now = Date.now()): 'scheduled' | 'jumping' | null {
  if (!departureAt) return null;
  const ms = Date.parse(departureAt);
  if (!Number.isFinite(ms)) return null;
  return ms <= now ? 'jumping' : 'scheduled';
}

function pointOf(row: Record<string, unknown>): CarrierCatalogPosition | null {
  const x = Number(row.x);
  const y = Number(row.y);
  const z = Number(row.z);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return { x, y, z };
}

/**
 * Строка базы → строка таблицы.
 *
 * Службы приходят в двух форматах (объекты учёта сайта и роли реестра EDDN),
 * поэтому считает их `carrierCardServices` — то же правило, что в карточке
 * носителя: работает только установленная и включённая служба.
 */
export function catalogRowFromRow(raw: Record<string, unknown> | null | undefined, now = Date.now()): CarrierCatalogRow | null {
  if (!raw) return null;
  const id = text(raw.carrier_id ?? raw.carrierId ?? raw.id);
  if (!/^\d{1,20}$/.test(id)) return null;
  const services: CarrierCardService[] = carrierCardServices(
    Array.isArray(raw.services) && (raw.services as unknown[]).length
      ? raw.services
      : raw.station_services,
  );
  const jumpSystem = text(raw.jump_system_name);
  const departureAt = catalogIso(raw.jump_departure_at);
  const relation = raw.relation === 'own' || raw.relation === 'squadron' ? raw.relation : 'other';
  const sightings = Number(raw.sightings);
  return {
    id,
    callsign: text(raw.callsign) || null,
    name: text(raw.name) || null,
    type: raw.carrier_type === 'SquadronCarrier' ? 'SquadronCarrier' : 'FleetCarrier',
    origin: raw.origin === 'eddn' ? 'eddn' : 'site',
    system: text(raw.system_name) || null,
    body: text(raw.body_name) || null,
    position: pointOf(raw),
    relation,
    decommission: raw.decommission === true,
    jump: jumpSystem
      ? { system: jumpSystem, departureAt, state: catalogJumpState(departureAt, now) ?? 'scheduled' }
      : null,
    docking: dockingLabel(text(raw.docking_access)) || null,
    notorious: typeof raw.allow_notorious === 'boolean' ? raw.allow_notorious : null,
    services: carrierCardServiceSummary(services),
    sightings: Number.isFinite(sightings) ? sightings : null,
    seenAt: catalogIso(raw.seen_at),
    updatedAt: catalogIso(raw.updated_at),
  };
}

/** Номер первой строки страницы — для подписи «показаны 51–100 из 1234». */
export function catalogPageRange(page: number, pageSize: number, total: number): { from: number; to: number } {
  const size = Math.max(1, Math.floor(pageSize));
  const pages = catalogPageCount(total, size);
  const current = catalogClampPage(page, pages);
  const from = total === 0 ? 0 : (current - 1) * size + 1;
  const to = total === 0 ? 0 : Math.min(total, current * size);
  return { from, to };
}
