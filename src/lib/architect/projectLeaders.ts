/**
 * Лидеры проекта систем: кто сколько какого груза привёз и на какую площадку.
 * Чистые функции.
 *
 * Вход — уже сгруппированные строки SQL-функций
 * `architect_project_contributions` (пилот × цель × площадка × товар) и
 * `architect_project_activity` (пилот × день). Здесь они сводятся в рейтинг
 * пилотов, разбивки по площадкам, товарам, системам и авианосцам, матрицу
 * «пилот × площадка» и ленту активности.
 *
 * Правила:
 *   * рейтинг — по тоннам, сданным на стройплощадки систем проекта;
 *   * груз, проданный или перегруженный на авианосцы проекта, считается
 *     отдельно и к тоннам площадок не прибавляется (иначе одна и та же тонна
 *     учлась бы дважды: на носитель и потом с носителя на площадку);
 *   * товар в `deliveries` хранится отображаемым именем (часто русским), в
 *     учёте авианосцев — ключом; оба приводятся к одному ключу каталога;
 *   * участники проекта всегда видны по имени; посторонний пилот, закрывший
 *     поставки в настройках приватности, показывается «Скрытый командир N» —
 *     его тонны в сумме остаются, сам пилот всегда видит себя.
 */

import { COMMODITY_LABELS_RU } from './catalogue.ts';
import type { ProjectRole } from './projects.ts';

export const LEADER_PERIODS = ['all', '90d', '30d', '7d'] as const;
export type LeaderPeriod = (typeof LEADER_PERIODS)[number];
export type LeaderScope = 'all' | 'members';

export const PERIOD_LABELS: Record<LeaderPeriod, string> = {
  all: 'Всё время',
  '90d': '90 дней',
  '30d': '30 дней',
  '7d': '7 дней',
};

export function isLeaderPeriod(value: unknown): value is LeaderPeriod {
  return typeof value === 'string' && (LEADER_PERIODS as readonly string[]).includes(value);
}

/** Нижняя граница периода (ISO) или null для «всё время». */
export function periodSince(period: LeaderPeriod, now: number = Date.now()): string | null {
  const days = period === '7d' ? 7 : period === '30d' ? 30 : period === '90d' ? 90 : 0;
  return days ? new Date(now - days * 86_400_000).toISOString() : null;
}

// ── Товары ─────────────────────────────────────────────────────────────────

function foldLabel(value: string): string {
  return value.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, '');
}

const RU_TO_KEY = new Map<string, string>(
  Object.entries(COMMODITY_LABELS_RU).map(([key, label]) => [foldLabel(label), key]),
);

/** Английские имена игры, которые не совпадают с внутренним ключом. */
const EN_ALIASES: Record<string, string> = {
  agrimedicines: 'agriculturalmedicines',
  muonimager: 'mutomimager',
  hesuits: 'hazardousenvironmentsuits',
  hazardousenvironmentsuit: 'hazardousenvironmentsuits',
  landenrichmentsystems: 'terrainenrichmentsystems',
  cmmcomposites: 'cmmcomposite',
  microcontroller: 'microcontrollers',
  evacuationshelters: 'evacuationshelter',
  insulatingmembranes: 'insulatingmembrane',
};

function asciiKey(text: string): string {
  return text.replace(/^\$+/, '').replace(/_name;?$/i, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

/** Имя товара из любой строки учёта → единый ключ и русская подпись. */
export function canonicalCommodity(raw: unknown): { key: string; label: string } {
  const text = String(raw ?? '').trim();
  if (!text || text.toLowerCase() === 'unknown') return { key: 'unknown', label: 'Неизвестный груз' };
  const ascii = asciiKey(text);
  if (ascii && COMMODITY_LABELS_RU[ascii]) return { key: ascii, label: COMMODITY_LABELS_RU[ascii] };
  const alias = ascii ? EN_ALIASES[ascii] : undefined;
  if (alias && COMMODITY_LABELS_RU[alias]) return { key: alias, label: COMMODITY_LABELS_RU[alias] };
  const folded = foldLabel(text);
  const ru = RU_TO_KEY.get(folded);
  if (ru) return { key: ru, label: COMMODITY_LABELS_RU[ru] };
  if (ascii && /^[\x20-\x7e]+$/.test(text)) {
    const label = text.replace(/^\$+/, '').replace(/_name;?$/i, '').replace(/[_]+/g, ' ').trim();
    return { key: ascii, label: label ? label.charAt(0).toUpperCase() + label.slice(1) : ascii };
  }
  return { key: `x:${folded || text.toLowerCase()}`, label: text };
}

// ── Вход ───────────────────────────────────────────────────────────────────

export interface ContributionRow {
  user_id: string | null;
  target: string;
  system_name: string | null;
  market_id: string | null;
  station_name: string | null;
  commodity: string | null;
  tons: number | string | null;
  ops: number | string | null;
  first_at?: string | null;
  last_at?: string | null;
}

export interface ActivityRow {
  day: string;
  user_id: string | null;
  target: string;
  tons: number | string | null;
  ops?: number | string | null;
}

export interface PilotInfo {
  name: string | null;
  member: boolean;
  role: ProjectRole | null;
  /** Посторонний закрыл поставки в приватности. */
  hidden: boolean;
}

export interface SiteInfo {
  name: string;
  systemName: string;
  buildType?: string | null;
}

export interface LeaderInput {
  rows: ContributionRow[];
  activity?: ActivityRow[];
  pilots: Map<string, PilotInfo>;
  sites?: Map<string, SiteInfo>;
  carriers?: Map<string, string>;
  scope?: LeaderScope;
  viewerId?: string | null;
  period?: LeaderPeriod;
  since?: string | null;
}

// ── Результат ──────────────────────────────────────────────────────────────

export interface LeaderSlice {
  key: string;
  label: string;
  tons: number;
}

export interface LeaderBreakdownRow {
  siteKey: string;
  siteName: string;
  systemName: string;
  commodity: string;
  commodityLabel: string;
  tons: number;
  ops: number;
}

export interface LeaderPilot {
  key: string;
  name: string;
  hidden: boolean;
  member: boolean;
  role: ProjectRole | null;
  isYou: boolean;
  rank: number;
  siteTons: number;
  siteOps: number;
  carrierTons: number;
  carrierOps: number;
  /** Доля в тоннах площадок проекта, 0–1. */
  share: number;
  sites: number;
  systems: number;
  commodities: LeaderSlice[];
  carriers: LeaderSlice[];
  breakdown: LeaderBreakdownRow[];
  firstAt: string | null;
  lastAt: string | null;
}

export interface LeaderSite {
  key: string;
  marketId: string | null;
  name: string;
  systemName: string;
  buildType: string | null;
  tons: number;
  ops: number;
  pilotCount: number;
  pilots: LeaderSlice[];
  commodities: LeaderSlice[];
}

export interface LeaderCommodity {
  key: string;
  label: string;
  tons: number;
  ops: number;
  share: number;
  pilotCount: number;
  pilots: LeaderSlice[];
  sites: LeaderSlice[];
}

export interface LeaderSystem {
  name: string;
  tons: number;
  ops: number;
  pilotCount: number;
  siteCount: number;
  pilots: LeaderSlice[];
}

export interface LeaderCarrier {
  carrierId: string;
  name: string;
  tons: number;
  ops: number;
  pilots: LeaderSlice[];
  commodities: LeaderSlice[];
}

export interface LeaderTimeline {
  bucket: 'day' | 'week';
  points: Array<{ day: string; siteTons: number; carrierTons: number; byPilot: Record<string, number>; other: number }>;
  /** Пилоты, выделенные цветом (по ключу), остальные — `other`. */
  pilots: LeaderSlice[];
  max: number;
}

export interface LeaderMatrix {
  pilots: LeaderSlice[];
  sites: LeaderSlice[];
  cells: number[][];
  max: number;
}

export interface ProjectLeadersView {
  period: LeaderPeriod;
  since: string | null;
  scope: LeaderScope;
  totals: {
    siteTons: number;
    siteOps: number;
    carrierTons: number;
    carrierOps: number;
    pilots: number;
    members: number;
    guests: number;
    sites: number;
    systems: number;
    commodities: number;
  };
  pilots: LeaderPilot[];
  sites: LeaderSite[];
  commodities: LeaderCommodity[];
  systems: LeaderSystem[];
  carriers: LeaderCarrier[];
  matrix: LeaderMatrix;
  timeline: LeaderTimeline;
}

// ── Свод ───────────────────────────────────────────────────────────────────

const SLICE_LIMIT = 8;
const BREAKDOWN_LIMIT = 60;

function num(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function add(map: Map<string, number>, key: string, tons: number): void {
  map.set(key, (map.get(key) ?? 0) + tons);
}

function laterIso(left: string | null, right: string | null | undefined, pick: 'min' | 'max'): string | null {
  const rightMs = right ? Date.parse(right) : NaN;
  if (!Number.isFinite(rightMs)) return left;
  const leftMs = left ? Date.parse(left) : NaN;
  if (!Number.isFinite(leftMs)) return new Date(rightMs).toISOString();
  const chosen = pick === 'min' ? Math.min(leftMs, rightMs) : Math.max(leftMs, rightMs);
  return new Date(chosen).toISOString();
}

function slices(map: Map<string, number>, label: (key: string) => string, limit = SLICE_LIMIT): LeaderSlice[] {
  const sorted = Array.from(map.entries())
    .filter(([, tons]) => tons > 0)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  const head = sorted.slice(0, limit).map(([key, tons]) => ({ key, label: label(key), tons }));
  const rest = sorted.slice(limit).reduce((sum, [, tons]) => sum + tons, 0);
  if (rest > 0) head.push({ key: '__other', label: 'Остальные', tons: rest });
  return head;
}

interface PilotAcc {
  userId: string;
  siteTons: number;
  siteOps: number;
  carrierTons: number;
  carrierOps: number;
  sites: Set<string>;
  systems: Set<string>;
  commodities: Map<string, number>;
  carriers: Map<string, number>;
  breakdown: Map<string, LeaderBreakdownRow>;
  firstAt: string | null;
  lastAt: string | null;
}

function systemKeyOf(value: unknown): string {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function buildProjectLeaders(input: LeaderInput): ProjectLeadersView {
  const scope: LeaderScope = input.scope ?? 'all';
  const viewerId = input.viewerId ?? null;
  const pilotsInfo = input.pilots;
  const siteInfo = input.sites ?? new Map<string, SiteInfo>();
  const carrierNames = input.carriers ?? new Map<string, string>();
  const inScope = (userId: string | null): userId is string => {
    if (!userId) return false;
    if (scope === 'members') return pilotsInfo.get(userId)?.member === true;
    return true;
  };

  const pilots = new Map<string, PilotAcc>();
  const siteAcc = new Map<string, { marketId: string | null; name: string; systemName: string; buildType: string | null; tons: number; ops: number; pilots: Map<string, number>; commodities: Map<string, number> }>();
  const commodityAcc = new Map<string, { label: string; tons: number; ops: number; pilots: Map<string, number>; sites: Map<string, number> }>();
  const systemAcc = new Map<string, { name: string; tons: number; ops: number; pilots: Map<string, number>; sites: Set<string> }>();
  const carrierAcc = new Map<string, { tons: number; ops: number; pilots: Map<string, number>; commodities: Map<string, number> }>();
  const commodityLabels = new Map<string, string>();
  const siteNames = new Map<string, string>();

  const pilotAcc = (userId: string): PilotAcc => {
    let acc = pilots.get(userId);
    if (!acc) {
      acc = {
        userId, siteTons: 0, siteOps: 0, carrierTons: 0, carrierOps: 0,
        sites: new Set(), systems: new Set(), commodities: new Map(), carriers: new Map(), breakdown: new Map(),
        firstAt: null, lastAt: null,
      };
      pilots.set(userId, acc);
    }
    return acc;
  };

  for (const row of input.rows ?? []) {
    if (!inScope(row.user_id)) continue;
    const tons = num(row.tons);
    const ops = num(row.ops);
    if (tons <= 0) continue;
    const commodity = canonicalCommodity(row.commodity);
    commodityLabels.set(commodity.key, commodity.label);
    const pilot = pilotAcc(row.user_id);
    pilot.firstAt = laterIso(pilot.firstAt, row.first_at, 'min');
    pilot.lastAt = laterIso(pilot.lastAt, row.last_at, 'max');

    if (row.target === 'carrier') {
      const carrierId = String(row.market_id ?? '').trim();
      if (!carrierId) continue;
      pilot.carrierTons += tons;
      pilot.carrierOps += ops;
      add(pilot.carriers, carrierId, tons);
      const carrier = carrierAcc.get(carrierId) ?? { tons: 0, ops: 0, pilots: new Map(), commodities: new Map() };
      carrier.tons += tons;
      carrier.ops += ops;
      add(carrier.pilots, row.user_id, tons);
      add(carrier.commodities, commodity.key, tons);
      carrierAcc.set(carrierId, carrier);
      if (!carrierNames.has(carrierId) && row.station_name) carrierNames.set(carrierId, row.station_name);
      continue;
    }

    const systemName = String(row.system_name ?? '').trim();
    const systemKey = systemKeyOf(systemName);
    const marketId = row.market_id ? String(row.market_id).trim() : null;
    const siteKey = marketId || `sys:${systemKey}`;
    const known = marketId ? siteInfo.get(marketId) : undefined;
    const siteName = known?.name
      || (row.station_name ? row.station_name.trim() : '')
      || (marketId ? `Площадка ${marketId}` : `Без площадки · ${systemName}`);
    if (!siteNames.has(siteKey)) siteNames.set(siteKey, siteName);

    pilot.siteTons += tons;
    pilot.siteOps += ops;
    pilot.sites.add(siteKey);
    pilot.systems.add(systemKey);
    add(pilot.commodities, commodity.key, tons);
    const breakdownKey = `${siteKey}|${commodity.key}`;
    const line = pilot.breakdown.get(breakdownKey);
    if (line) {
      line.tons += tons;
      line.ops += ops;
    } else {
      pilot.breakdown.set(breakdownKey, {
        siteKey, siteName, systemName: known?.systemName || systemName,
        commodity: commodity.key, commodityLabel: commodity.label, tons, ops,
      });
    }

    const site = siteAcc.get(siteKey) ?? {
      marketId, name: siteName, systemName: known?.systemName || systemName, buildType: known?.buildType ?? null,
      tons: 0, ops: 0, pilots: new Map(), commodities: new Map(),
    };
    site.tons += tons;
    site.ops += ops;
    add(site.pilots, row.user_id, tons);
    add(site.commodities, commodity.key, tons);
    siteAcc.set(siteKey, site);

    const goods = commodityAcc.get(commodity.key) ?? { label: commodity.label, tons: 0, ops: 0, pilots: new Map(), sites: new Map() };
    goods.tons += tons;
    goods.ops += ops;
    add(goods.pilots, row.user_id, tons);
    add(goods.sites, siteKey, tons);
    commodityAcc.set(commodity.key, goods);

    const system = systemAcc.get(systemKey) ?? { name: known?.systemName || systemName, tons: 0, ops: 0, pilots: new Map(), sites: new Set() };
    system.tons += tons;
    system.ops += ops;
    add(system.pilots, row.user_id, tons);
    system.sites.add(siteKey);
    systemAcc.set(systemKey, system);
  }

  // Рейтинг и имена: скрытые пилоты нумеруются по месту в рейтинге.
  const ranked = Array.from(pilots.values()).sort((left, right) => (
    right.siteTons - left.siteTons || right.carrierTons - left.carrierTons || left.userId.localeCompare(right.userId)
  ));
  const keyOf = new Map<string, string>();
  const nameOf = new Map<string, string>();
  let hiddenNo = 0;
  for (const acc of ranked) {
    const info = pilotsInfo.get(acc.userId);
    const isYou = acc.userId === viewerId;
    const hidden = !isYou && info?.member !== true && info?.hidden === true;
    if (hidden) {
      hiddenNo += 1;
      keyOf.set(acc.userId, `hidden-${hiddenNo}`);
      nameOf.set(acc.userId, `Скрытый командир ${hiddenNo}`);
    } else {
      keyOf.set(acc.userId, acc.userId);
      nameOf.set(acc.userId, info?.name?.trim() || 'Командир без имени');
    }
  }
  const pilotLabel = (userId: string) => nameOf.get(userId) ?? 'Командир';
  const pilotSlices = (map: Map<string, number>, limit = SLICE_LIMIT) => slices(map, pilotLabel, limit)
    .map((slice) => (slice.key === '__other' ? slice : { ...slice, key: keyOf.get(slice.key) ?? slice.key }));
  const commodityLabel = (key: string) => commodityLabels.get(key) ?? key;
  const siteLabel = (key: string) => siteNames.get(key) ?? key;
  const carrierLabel = (id: string) => carrierNames.get(id) ?? `Авианосец ${id}`;

  const siteTons = ranked.reduce((sum, acc) => sum + acc.siteTons, 0);
  const leaderPilots: LeaderPilot[] = ranked.map((acc, index) => {
    const info = pilotsInfo.get(acc.userId);
    const isYou = acc.userId === viewerId;
    return {
      key: keyOf.get(acc.userId)!,
      name: nameOf.get(acc.userId)!,
      hidden: keyOf.get(acc.userId)!.startsWith('hidden-'),
      member: info?.member === true,
      role: info?.member ? info.role ?? 'member' : null,
      isYou,
      rank: index + 1,
      siteTons: acc.siteTons,
      siteOps: acc.siteOps,
      carrierTons: acc.carrierTons,
      carrierOps: acc.carrierOps,
      share: siteTons > 0 ? acc.siteTons / siteTons : 0,
      sites: acc.sites.size,
      systems: acc.systems.size,
      commodities: slices(acc.commodities, commodityLabel, 6),
      carriers: slices(acc.carriers, carrierLabel, 4),
      breakdown: Array.from(acc.breakdown.values())
        .sort((left, right) => right.tons - left.tons)
        .slice(0, BREAKDOWN_LIMIT),
      firstAt: acc.firstAt,
      lastAt: acc.lastAt,
    };
  });

  const sites: LeaderSite[] = Array.from(siteAcc.entries())
    .map(([key, site]) => ({
      key,
      marketId: site.marketId,
      name: site.name,
      systemName: site.systemName,
      buildType: site.buildType,
      tons: site.tons,
      ops: site.ops,
      pilotCount: site.pilots.size,
      pilots: pilotSlices(site.pilots),
      commodities: slices(site.commodities, commodityLabel, 6),
    }))
    .sort((left, right) => right.tons - left.tons || left.name.localeCompare(right.name, 'ru'));

  const commodities: LeaderCommodity[] = Array.from(commodityAcc.entries())
    .map(([key, goods]) => ({
      key,
      label: goods.label,
      tons: goods.tons,
      ops: goods.ops,
      share: siteTons > 0 ? goods.tons / siteTons : 0,
      pilotCount: goods.pilots.size,
      pilots: pilotSlices(goods.pilots, 6),
      sites: slices(goods.sites, siteLabel, 4),
    }))
    .sort((left, right) => right.tons - left.tons || left.label.localeCompare(right.label, 'ru'));

  const systems: LeaderSystem[] = Array.from(systemAcc.values())
    .map((system) => ({
      name: system.name,
      tons: system.tons,
      ops: system.ops,
      pilotCount: system.pilots.size,
      siteCount: system.sites.size,
      pilots: pilotSlices(system.pilots, 5),
    }))
    .sort((left, right) => right.tons - left.tons || left.name.localeCompare(right.name, 'ru'));

  const carriers: LeaderCarrier[] = Array.from(carrierAcc.entries())
    .map(([carrierId, carrier]) => ({
      carrierId,
      name: carrierLabel(carrierId),
      tons: carrier.tons,
      ops: carrier.ops,
      pilots: pilotSlices(carrier.pilots, 6),
      commodities: slices(carrier.commodities, commodityLabel, 6),
    }))
    .sort((left, right) => right.tons - left.tons);

  // Матрица «пилот × площадка»: самые тяжёлые строки и столбцы.
  const matrixPilots = ranked.filter((acc) => acc.siteTons > 0).slice(0, 12);
  const matrixSites = sites.slice(0, 10);
  const cells = matrixPilots.map((acc) => matrixSites.map((site) => siteAcc.get(site.key)?.pilots.get(acc.userId) ?? 0));
  const matrix: LeaderMatrix = {
    pilots: matrixPilots.map((acc) => ({ key: keyOf.get(acc.userId)!, label: pilotLabel(acc.userId), tons: acc.siteTons })),
    sites: matrixSites.map((site) => ({ key: site.key, label: site.name, tons: site.tons })),
    cells,
    max: cells.reduce((max, row) => Math.max(max, ...row, 0), 0),
  };

  const timeline = buildTimeline(input.activity ?? [], inScope, ranked.slice(0, 5).filter((acc) => acc.siteTons > 0).map((acc) => acc.userId), keyOf, pilotLabel);

  const members = ranked.filter((acc) => pilotsInfo.get(acc.userId)?.member === true).length;
  return {
    period: input.period ?? 'all',
    since: input.since ?? null,
    scope,
    totals: {
      siteTons,
      siteOps: ranked.reduce((sum, acc) => sum + acc.siteOps, 0),
      carrierTons: ranked.reduce((sum, acc) => sum + acc.carrierTons, 0),
      carrierOps: ranked.reduce((sum, acc) => sum + acc.carrierOps, 0),
      pilots: ranked.length,
      members,
      guests: ranked.length - members,
      sites: sites.length,
      systems: systems.length,
      commodities: commodities.length,
    },
    pilots: leaderPilots,
    sites,
    commodities,
    systems,
    carriers,
    matrix,
    timeline,
  };
}

function weekStart(day: string): string {
  const ms = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(ms)) return day;
  const date = new Date(ms);
  const shift = (date.getUTCDay() + 6) % 7; // понедельник = 0
  return new Date(ms - shift * 86_400_000).toISOString().slice(0, 10);
}

function buildTimeline(
  activity: ActivityRow[],
  inScope: (userId: string | null) => userId is string,
  highlighted: string[],
  keyOf: Map<string, string>,
  pilotLabel: (userId: string) => string,
): LeaderTimeline {
  const rows = activity
    .filter((row) => inScope(row.user_id) && num(row.tons) > 0 && /^\d{4}-\d{2}-\d{2}/.test(String(row.day)))
    .map((row) => ({ ...row, day: String(row.day).slice(0, 10) }));
  const days = rows.map((row) => Date.parse(`${row.day}T00:00:00Z`)).filter(Number.isFinite);
  const span = days.length ? (Math.max(...days) - Math.min(...days)) / 86_400_000 : 0;
  const bucket: LeaderTimeline['bucket'] = span > 92 ? 'week' : 'day';
  const highlightSet = new Set(highlighted);
  const points = new Map<string, { day: string; siteTons: number; carrierTons: number; byPilot: Record<string, number>; other: number }>();
  for (const row of rows) {
    const day = bucket === 'week' ? weekStart(row.day) : row.day;
    const point = points.get(day) ?? { day, siteTons: 0, carrierTons: 0, byPilot: {}, other: 0 };
    const tons = num(row.tons);
    if (row.target === 'carrier') {
      point.carrierTons += tons;
    } else {
      point.siteTons += tons;
      const userId = row.user_id as string;
      if (highlightSet.has(userId)) {
        const key = keyOf.get(userId) ?? userId;
        point.byPilot[key] = (point.byPilot[key] ?? 0) + tons;
      } else {
        point.other += tons;
      }
    }
    points.set(day, point);
  }
  const sorted = Array.from(points.values()).sort((left, right) => left.day.localeCompare(right.day));
  // Пустые дни внутри диапазона заполняются нулями: график без дыр читается честнее.
  const filled: typeof sorted = [];
  const stepMs = (bucket === 'week' ? 7 : 1) * 86_400_000;
  for (let index = 0; index < sorted.length; index += 1) {
    filled.push(sorted[index]);
    const next = sorted[index + 1];
    if (!next) break;
    let cursor = Date.parse(`${sorted[index].day}T00:00:00Z`) + stepMs;
    const end = Date.parse(`${next.day}T00:00:00Z`);
    let guard = 0;
    while (cursor < end && guard < 400) {
      filled.push({ day: new Date(cursor).toISOString().slice(0, 10), siteTons: 0, carrierTons: 0, byPilot: {}, other: 0 });
      cursor += stepMs;
      guard += 1;
    }
  }
  return {
    bucket,
    points: filled,
    pilots: highlighted.map((userId) => {
      const key = keyOf.get(userId) ?? userId;
      return { key, label: pilotLabel(userId), tons: filled.reduce((sum, point) => sum + (point.byPilot[key] ?? 0), 0) };
    }),
    max: filled.reduce((max, point) => Math.max(max, point.siteTons + point.carrierTons), 0),
  };
}
