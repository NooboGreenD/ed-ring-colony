/**
 * Карточка авианосца (`/carriers/<MarketID>`): правила без React и без БД.
 *
 * Носитель — не станция: в игре он прыгает раз в 15–20 минут и меняет систему,
 * поэтому «где он сейчас» мало. Пилоту важно другое: куда он ходит, как часто,
 * какие службы у него работают и когда видели его в последний раз. Всё это
 * сайт уже собирает — учёт (`fleet_carriers`), реестр EDDN (`carrier_directory`)
 * и журнал прыжков (`carrier_jump_history`), — но по отдельности.
 *
 * Здесь только правила карточки: как из строк истории получаются окна
 * (неделя/месяц/год), корзины графиков, направления и доля каждого из них,
 * как подписываются службы и как строится адрес карточки. Их импортируют
 * маршрут `/api/carriers/[id]/card`, страница и тесты
 * (`scripts/tests/carrier-card.test.mjs`), чтобы у сервера и интерфейса был
 * один и тот же ответ на вопрос «сколько носитель прыгал».
 */

import { carrierServiceActive, carrierServiceRole, serviceLabel } from './carrierServices.ts';

/** Сколько истории берёт карточка: год — как самый длинный период вкладки. */
export const CARRIER_CARD_WINDOW_DAYS = 365;
/** Сколько строк истории отдаёт маршрут: список в карточке, а не выгрузка. */
export const CARRIER_CARD_JUMPS_LIMIT = 120;
/** Столбцов в дневном графике: месяц активности. */
export const CARRIER_CARD_DAILY_BUCKETS = 30;
/** Столбцов в месячном графике: год. */
export const CARRIER_CARD_MONTHLY_BUCKETS = 12;
/** Сколько направлений показываем полосами «куда чаще всего». */
export const CARRIER_CARD_TOP_DESTINATIONS = 6;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** Один прыжок в карточке: без имени носителя — оно в заголовке. */
export interface CarrierCardJump {
  id: string;
  from: string;
  to: string;
  jumpedAt: string;
  source: 'site' | 'eddn';
}

/** Корзина графика: начало окна (UTC) и сколько в него попало прыжков. */
export interface CarrierCardBucket {
  start: string;
  jumps: number;
}

/** Направление: куда носитель ходил и какую долю это заняло. */
export interface CarrierCardDestination {
  system: string;
  jumps: number;
  /** 0…1 от всех прыжков года: полоса «куда чаще всего» рисуется по ней. */
  share: number;
}

export interface CarrierCardStats {
  /** Все прыжки года (то, что пришло в карточку). */
  total: number;
  last7: number;
  last30: number;
  /** Источник наблюдения: сайт и EDDN — видно, насколько учёт полон. */
  site: number;
  eddn: number;
  uniqueDestinations: number;
  top: CarrierCardDestination[];
  firstAt: string | null;
  lastAt: string | null;
  /** Прыжков в неделю за окно: «раз в два дня» читается лучше, чем 47 строк. */
  perWeek: number;
  daily: CarrierCardBucket[];
  monthly: CarrierCardBucket[];
}

/** Служба носителя в карточке: роль, подпись и работает ли она. */
export interface CarrierCardService {
  role: string;
  label: string;
  active: boolean;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asIso(value: unknown): string | null {
  if (value == null || value === '') return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function timeMs(value: unknown): number {
  if (value == null || value === '') return NaN;
  return Date.parse(String(value));
}

/** MarketID носителя: только цифры — карточка живёт по нему, а не по позывному. */
export function carrierCardId(value: unknown): string | null {
  const clean = String(value ?? '').trim();
  return /^\d{1,20}$/.test(clean) ? clean : null;
}

/** Адрес карточки носителя. Мусор возвращает `null`: страницы не существует. */
export function carrierCardHref(id: unknown): string | null {
  const clean = carrierCardId(id);
  return clean ? `/carriers/${clean}` : null;
}

/** Начало окна истории в ISO — его маршрут передаёт в `gte('jumped_at', …)`. */
export function carrierCardSince(now = Date.now(), days = CARRIER_CARD_WINDOW_DAYS): string {
  return new Date(now - Math.max(1, Math.floor(days)) * DAY).toISOString();
}

/** Строка `carrier_jump_history` → прыжок карточки. Мусор отбрасывается. */
export function carrierCardJumpFromRow(row: Record<string, unknown>): CarrierCardJump | null {
  const from = text(row.from_system);
  const to = text(row.to_system);
  const jumpedAt = asIso(row.jumped_at);
  if (!from || !to || !jumpedAt) return null;
  return {
    id: String(row.id ?? ''),
    from,
    to,
    jumpedAt,
    source: row.source === 'eddn' ? 'eddn' : 'site',
  };
}

/** Сортировка «свежие сверху» + отсев повторов по id (один прыжок — одна строка). */
export function orderCarrierCardJumps(jumps: readonly CarrierCardJump[]): CarrierCardJump[] {
  const seen = new Set<string>();
  const out: CarrierCardJump[] = [];
  for (const jump of jumps) {
    if (jump.id) {
      if (seen.has(jump.id)) continue;
      seen.add(jump.id);
    }
    out.push(jump);
  }
  return out.sort((left, right) => {
    const leftMs = timeMs(left.jumpedAt);
    const rightMs = timeMs(right.jumpedAt);
    if (Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs !== rightMs) return rightMs - leftMs;
    if (Number.isFinite(leftMs) !== Number.isFinite(rightMs)) return Number.isFinite(leftMs) ? -1 : 1;
    return left.id.localeCompare(right.id);
  });
}

/** Начала корзин: дни (UTC) или месяцы (UTC), последняя — текущая. */
export function carrierCardBuckets(unit: 'day' | 'month', count: number, now = Date.now()): number[] {
  const size = Math.max(1, Math.floor(count));
  const date = new Date(now);
  if (unit === 'month') {
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth();
    return Array.from({ length: size }, (_, index) => Date.UTC(year, month - (size - 1 - index), 1));
  }
  const last = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return Array.from({ length: size }, (_, index) => last - (size - 1 - index) * DAY);
}

/** Индекс корзины для времени; `-1` — время вне окна графика. */
export function carrierCardBucketIndex(unit: 'day' | 'month', at: number, buckets: readonly number[]): number {
  if (!buckets.length || !Number.isFinite(at)) return -1;
  if (unit === 'day') {
    const first = buckets[0];
    const index = Math.floor((Date.UTC(new Date(at).getUTCFullYear(), new Date(at).getUTCMonth(), new Date(at).getUTCDate()) - first) / DAY);
    return index >= 0 && index < buckets.length ? index : -1;
  }
  const date = new Date(at);
  const index = (date.getUTCFullYear() - new Date(buckets[0]).getUTCFullYear()) * 12
    + (date.getUTCMonth() - new Date(buckets[0]).getUTCMonth());
  return index >= 0 && index < buckets.length ? index : -1;
}

function fillBuckets(unit: 'day' | 'month', count: number, jumps: readonly CarrierCardJump[], now: number): CarrierCardBucket[] {
  const starts = carrierCardBuckets(unit, count, now);
  const counts = new Array<number>(starts.length).fill(0);
  for (const jump of jumps) {
    const index = carrierCardBucketIndex(unit, timeMs(jump.jumpedAt), starts);
    if (index >= 0) counts[index] += 1;
  }
  return starts.map((start, index) => ({ start: new Date(start).toISOString(), jumps: counts[index] }));
}

/**
 * Сводка прыжков носителя за год.
 *
 * «Сколько всего» само по себе бесполезно: у активного носителя это десятки в
 * месяц, у редкого — два за год. Поэтому рядом окна (7 и 30 дней), темп
 * (прыжков в неделю), направления с долями и два графика — по дням месяца и
 * по месяцам года. Всё в UTC: время в игре и на сайте уже UTC.
 */
export function carrierCardStats(
  jumps: readonly CarrierCardJump[],
  options: { now?: number; daily?: number; monthly?: number; top?: number } = {},
): CarrierCardStats {
  const now = options.now ?? Date.now();
  const ordered = orderCarrierCardJumps(jumps);
  const daily = fillBuckets('day', options.daily ?? CARRIER_CARD_DAILY_BUCKETS, ordered, now);
  const monthly = fillBuckets('month', options.monthly ?? CARRIER_CARD_MONTHLY_BUCKETS, ordered, now);

  let last7 = 0;
  let last30 = 0;
  let site = 0;
  let eddn = 0;
  const destinations = new Map<string, { system: string; jumps: number }>();
  let firstMs = Infinity;
  let lastMs = -Infinity;

  for (const jump of ordered) {
    const at = timeMs(jump.jumpedAt);
    if (Number.isFinite(at)) {
      if (now - at <= 7 * DAY) last7 += 1;
      if (now - at <= 30 * DAY) last30 += 1;
      if (at < firstMs) firstMs = at;
      if (at > lastMs) lastMs = at;
    }
    if (jump.source === 'eddn') eddn += 1;
    else site += 1;
    const key = jump.to.toLowerCase();
    const current = destinations.get(key);
    if (current) current.jumps += 1;
    else destinations.set(key, { system: jump.to, jumps: 1 });
  }

  const total = ordered.length;
  const top = Array.from(destinations.values())
    .sort((left, right) => right.jumps - left.jumps || left.system.localeCompare(right.system, 'ru'))
    .slice(0, Math.max(1, options.top ?? CARRIER_CARD_TOP_DESTINATIONS))
    .map((entry) => ({ ...entry, share: total > 0 ? entry.jumps / total : 0 }));

  return {
    total,
    last7,
    last30,
    site,
    eddn,
    uniqueDestinations: destinations.size,
    top,
    firstAt: Number.isFinite(firstMs) ? new Date(firstMs).toISOString() : null,
    lastAt: Number.isFinite(lastMs) ? new Date(lastMs).toISOString() : null,
    perWeek: Math.round((total / CARRIER_CARD_WINDOW_DAYS) * 7 * 100) / 100,
    daily,
    monthly,
  };
}

/**
 * Службы носителя одним списком.
 *
 * У учёта сайта служба — объект с `activated`/`enabled` (`fleet_carriers.services`),
 * у реестра EDDN — просто роль в массиве (носитель передаёт только работающие).
 * Приводим оба вида к одному: роль, подпись, «работает ли». Порядок — рабочие
 * сверху, дальше по алфавиту: так сразу видно, за чем вообще лететь.
 */
export function carrierCardServices(value: unknown): CarrierCardService[] {
  const out = new Map<string, CarrierCardService>();
  const add = (role: string, active: boolean) => {
    const clean = text(role);
    if (!clean) return;
    const key = clean.toLowerCase();
    const current = out.get(key);
    if (current) {
      current.active = current.active || active;
      return;
    }
    out.set(key, { role: clean, label: serviceLabel(clean), active });
  };
  for (const item of Array.isArray(value) ? value : []) {
    const role = carrierServiceRole(item);
    if (!role) continue;
    add(role, carrierServiceActive(item));
  }
  return Array.from(out.values()).sort((left, right) => (
    Number(right.active) - Number(left.active) || left.label.localeCompare(right.label, 'ru')
  ));
}

/** Сколько служб работает: «9 из 12» честнее, чем просто список. */
export function carrierCardServiceSummary(services: readonly CarrierCardService[]): { active: number; total: number } {
  return {
    active: services.filter((service) => service.active).length,
    total: services.length,
  };
}

/** Заголовок карточки: имя (если известно), иначе позывной, иначе MarketID. */
export function carrierCardTitle(carrier: { id?: unknown; callsign?: unknown; name?: unknown }): string {
  const name = text(carrier.name);
  if (name) return name;
  const callsign = text(carrier.callsign);
  if (callsign) return callsign;
  return carrierCardId(carrier.id) ? `#${carrierCardId(carrier.id)}` : '—';
}

/** «3 ч назад» — но в часах UTC, без зависимости от локали браузера в правилах. */
export function carrierCardClock(at: unknown): { hour: number; minute: number } | null {
  const ms = timeMs(at);
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  return { hour: date.getUTCHours(), minute: date.getUTCMinutes() };
}
