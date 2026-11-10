/**
 * Страница «Авианосцы перед прыжком» (`/carriers/jumps`).
 *
 * Frontier не публикует реестр носителей, но заказанный прыжок виден в учёте
 * сайта (`fleet_carriers.jump_*`): Helper и загрузка журналов присылают
 * `CarrierJumpRequest`, поэтому к моменту вылета сайт знает и цель, и время.
 * EDDN этого не даёт вовсе: `CarrierJumpRequest` в поток не ретранслируется —
 * там только уже случившийся прыжок (`CarrierJump`).
 *
 * Здесь чистые правила страницы, без React и без БД:
 *   * что считается «готовится к прыжку» (заказанный прыжок, включая момент,
 *     когда время вылета уже наступило, а подтверждения ещё нет);
 *   * дистанция прыжка в световых годах (координаты Elite и есть св. л.);
 *   * сравнение живого плана со снимком, который сохранил подписчик, —
 *     «план тот же», «план изменился», «уже прыгнул»;
 *   * нормализация снимка для записи подписки.
 *
 * Их проверяет `scripts/tests/carrier-jumps.test.mjs`, а страница и маршрут
 * используют одни и те же функции — расхождению взяться негде.
 */

import {
  carrierSystemKey,
  carrierTitle,
  carrierTone,
  type CarrierTone,
  type MapCarrier,
  type MapCarrierRelation,
  type MapCarrierSource,
  type MapCarrierType,
  type MapPoint,
} from './carrierMap.ts';
import { carrierSourceOf } from './carrierMap.ts';
import type { CarrierWatch } from './carrierDirectory.ts';

/**
 * Сколько назад смотрим заказы: время вылета прошло, а подтверждения нет —
 * носитель ещё «в прыжке» (сайт считает его прибывшим через пять минут).
 */
export const JUMP_LOOKBACK_MS = 30 * 60 * 1000;
/** Допуск сравнения плана: время вылета может уточняться на секунды. */
export const JUMP_PLAN_DRIFT_MS = 60 * 1000;
/** Сколько строк отдаёт маршрут: страница табличная, ей хватает. */
export const JUMP_BOARD_LIMIT = 200;

/** Что с планом прыжка у подписчика. */
export type JumpPlanState =
  /** Снимка нет: подписка оформлена не на прыжок. */
  | 'none'
  /** Живой план совпадает со снимком. */
  | 'same'
  /** Цель или время вылета изменились после подписки. */
  | 'changed'
  /** Носитель уже ушёл в цель из снимка. */
  | 'arrived'
  /** Плана больше нет (заказ отменён или носитель ушёл в другую систему). */
  | 'gone';

export interface JumpPlanView {
  state: JumpPlanState;
  /** Что было в снимке: куда и когда. */
  from: string | null;
  at: string | null;
  /** Что сейчас: куда и когда. */
  to: string | null;
  toAt: string | null;
}

/** Один заказ прыжка в том виде, в каком его видит страница. */
export interface JumpPlan {
  system: string;
  departureAt: string | null;
  state: 'scheduled' | 'jumping';
  position: MapPoint | null;
}

export interface JumpBoardRow {
  /** MarketID строкой — общий ключ карты, реестра и личных записей. */
  id: string;
  label: string;
  callsign: string | null;
  type: MapCarrierType;
  relation: MapCarrierRelation;
  source: MapCarrierSource;
  tone: CarrierTone;
  /** Откуда прыгает (текущая система носителя). */
  from: string;
  /** Куда прыгает. */
  to: string;
  departureAt: string | null;
  state: 'scheduled' | 'jumping';
  /** Длина прыжка в световых годах, если известны обе точки. */
  distanceLy: number | null;
  /** Целиком — карточке и ссылке на систему. */
  carrier: MapCarrier;
  /** Личная запись пилота, если он подписан на этот носитель. */
  watch: CarrierWatch | null;
  plan: JumpPlanView;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function timeMs(value: unknown): number {
  if (value == null || value === '') return NaN;
  return Date.parse(String(value));
}

/** Носитель сейчас «готовится к прыжку»: заказ есть и он ещё не завершён. */
export function isJumpPending(carrier: Pick<MapCarrier, 'jump'>, now = Date.now()): boolean {
  const jump = carrier.jump;
  if (!jump) return false;
  const at = timeMs(jump.departureAt);
  // Без времени вылета заказ всё равно заказ: показываем, время — «неизвестно».
  if (!Number.isFinite(at)) return true;
  return at >= now - JUMP_LOOKBACK_MS;
}

/**
 * Дистанция прыжка в световых годах: в Elite координаты системы уже в св. л.,
 * поэтому это просто евклидово расстояние. Округляем до сотых — в игре
 * лимит прыжка Drake 500 св. л., и «499.87» читается лучше, чем 499.8723.
 */
export function jumpDistanceLy(from: MapPoint | null | undefined, to: MapPoint | null | undefined): number | null {
  if (!from || !to) return null;
  const axes = [from.x, from.y, from.z, to.x, to.y, to.z];
  if (!axes.every((value) => typeof value === 'number' && Number.isFinite(value))) return null;
  const distance = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
  if (!Number.isFinite(distance)) return null;
  return Math.round(distance * 100) / 100;
}

/**
 * Сравнение живого плана со снимком подписки.
 *
 * Снимок записывается в момент подписки: «куда» и «когда» на тот момент.
 * Позже страница показывает, изменился ли план, — подписчику важно не
 * пропустить перенос прыжка, а не только сам факт «носитель куда-то летит».
 */
export function jumpPlanView(
  watch: Pick<CarrierWatch, 'jumpSystem' | 'jumpDepartureAt'> | null | undefined,
  carrier: Pick<MapCarrier, 'jump' | 'system'>,
  driftMs = JUMP_PLAN_DRIFT_MS,
): JumpPlanView {
  const from = watch?.jumpSystem ? text(watch.jumpSystem) : null;
  const at = watch?.jumpDepartureAt ?? null;
  const jump = carrier.jump;
  const to = jump ? text(jump.system) : null;
  const toAt = jump?.departureAt ?? null;

  if (!from && !at) return { state: 'none', from, at, to, toAt };
  if (!to) {
    // Носитель уже прибыл в цель из снимка — это ожидаемый конец подписки.
    const arrived = Boolean(from) && carrierSystemKey(carrier.system) === carrierSystemKey(from);
    return { state: arrived ? 'arrived' : 'gone', from, at, to, toAt };
  }
  const sameSystem = Boolean(from) && carrierSystemKey(from) === carrierSystemKey(to);
  const fromMs = timeMs(at);
  const toMs = timeMs(toAt);
  const sameTime = Number.isFinite(fromMs) && Number.isFinite(toMs)
    ? Math.abs(fromMs - toMs) <= driftMs
    : (at ?? null) === (toAt ?? null);
  return { state: sameSystem && sameTime ? 'same' : 'changed', from, at, to, toAt };
}

/** Порядок таблицы: ближайший вылет сверху, без времени — в конце. */
export function compareJumpRows(left: JumpBoardRow, right: JumpBoardRow): number {
  const leftMs = timeMs(left.departureAt);
  const rightMs = timeMs(right.departureAt);
  const leftKnown = Number.isFinite(leftMs);
  const rightKnown = Number.isFinite(rightMs);
  if (leftKnown !== rightKnown) return leftKnown ? -1 : 1;
  if (leftKnown && rightKnown && leftMs !== rightMs) return leftMs - rightMs;
  return left.label.localeCompare(right.label, 'ru') || left.id.localeCompare(right.id);
}

export interface JumpBoardOptions {
  now?: number;
  watches?: readonly CarrierWatch[];
  limit?: number;
}

/**
 * Строки таблицы: только носители с заказом прыжка, отсортированные по времени
 * вылета, с личной записью зрителя и состоянием плана.
 */
export function buildJumpBoard(carriers: readonly MapCarrier[], options: JumpBoardOptions = {}): JumpBoardRow[] {
  const now = options.now ?? Date.now();
  const limit = options.limit ?? JUMP_BOARD_LIMIT;
  const watches = new Map((options.watches ?? []).map((watch) => [String(watch.carrierId), watch]));
  const rows: JumpBoardRow[] = [];

  for (const carrier of carriers) {
    if (!carrier.jump || !isJumpPending(carrier, now)) continue;
    const watch = watches.get(carrier.id) ?? null;
    rows.push({
      id: carrier.id,
      label: carrierTitle(carrier),
      callsign: carrier.callsign,
      type: carrier.type,
      relation: carrier.relation,
      source: carrierSourceOf(carrier),
      tone: carrierTone(carrier),
      from: carrier.system,
      to: carrier.jump.system,
      departureAt: carrier.jump.departureAt,
      state: carrier.jump.state,
      distanceLy: jumpDistanceLy(carrier.position, carrier.jump.position),
      carrier,
      watch,
      plan: jumpPlanView(watch, carrier),
    });
  }

  return rows.sort(compareJumpRows).slice(0, Math.max(0, limit));
}

/** Поиск по таблице: позывной, имя, системы «откуда» и «куда». */
export function matchesJumpQuery(row: JumpBoardRow, query: unknown): boolean {
  const tokens = text(query).toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;
  const haystack = [
    row.callsign ?? '',
    row.label,
    row.from,
    row.to,
    row.id,
  ].join(' ').toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

/**
 * Снимок плана для записи подписки: `null`, когда подписка оформляется не на
 * прыжок (обычное избранное Атласа не должно терять свой снимок).
 */
export function jumpSnapshot(
  input: { jumpSystem?: unknown; jumpDepartureAt?: unknown },
  now = Date.now(),
): { jumpSystem: string | null; jumpDepartureAt: string | null; jumpSeenAt: string } | null {
  const hasSystem = Object.prototype.hasOwnProperty.call(input, 'jumpSystem');
  const hasAt = Object.prototype.hasOwnProperty.call(input, 'jumpDepartureAt');
  if (!hasSystem && !hasAt) return null;

  const system = text(input.jumpSystem).slice(0, 120) || null;
  const rawAt = text(input.jumpDepartureAt);
  const atMs = timeMs(rawAt);
  // Дата из будущего дальше суток — мусор (так же строго, как в реестре EDDN).
  const at = Number.isFinite(atMs) && atMs > now + 24 * 60 * 60 * 1000
    ? null
    : (Number.isFinite(atMs) ? new Date(atMs).toISOString() : null);
  if (!system && !at) return { jumpSystem: null, jumpDepartureAt: null, jumpSeenAt: new Date(now).toISOString() };
  return { jumpSystem: system, jumpDepartureAt: at, jumpSeenAt: new Date(now).toISOString() };
}

/**
 * «Мои подписки»: записи пилота, у которых есть снимок прыжка. Живой план
 * подставляется, если носитель есть в таблице «готовятся к прыжку»; иначе
 * строка показывает последний известный снимок — подписка не пропадает.
 */
export interface JumpWatchRow {
  watch: CarrierWatch;
  live: JumpBoardRow | null;
  plan: JumpPlanView;
}

export function buildJumpWatchRows(
  watches: readonly CarrierWatch[],
  rows: readonly JumpBoardRow[],
): JumpWatchRow[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return watches
    .filter((watch) => Boolean(watch.jumpSystem) || Boolean(watch.jumpDepartureAt))
    .map((watch) => {
      const live = byId.get(String(watch.carrierId)) ?? null;
      // План считаем от самой записи, а не от строки таблицы: строку могли
      // собрать без этого пилота (гость вошёл позже), и «без снимка» было бы
      // неверным ответом.
      const plan: JumpPlanView = live
        ? jumpPlanView(watch, live.carrier)
        : jumpPlanView(watch, { jump: null, system: watch.system ?? '' });
      return { watch, live, plan };
    })
    .sort((left, right) => {
      const leftMs = timeMs(left.live?.departureAt ?? left.watch.jumpDepartureAt);
      const rightMs = timeMs(right.live?.departureAt ?? right.watch.jumpDepartureAt);
      const leftKnown = Number.isFinite(leftMs);
      const rightKnown = Number.isFinite(rightMs);
      if (leftKnown !== rightKnown) return leftKnown ? -1 : 1;
      if (leftKnown && rightKnown && leftMs !== rightMs) return leftMs - rightMs;
      const label = (watch: CarrierWatch) => watch.name || watch.callsign || watch.carrierId;
      return label(left.watch).localeCompare(label(right.watch), 'ru');
    });
}
