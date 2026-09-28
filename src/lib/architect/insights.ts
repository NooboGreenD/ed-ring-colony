/**
 * Инфографика плана: числа, из которых интерфейс рисует полосы и графики.
 *
 * Расчёт вынесен из компонентов специально — так одни и те же цифры видят и
 * сводка, и тесты, а React-компонент остаётся разметкой. Ничего нового здесь
 * не выдумывается: всё выводится из `PlanEvaluation` и плана.
 *
 * Модуль чистый: проверяется тестами (`scripts/tests/architect-insights.test.mjs`).
 */

import { ECONOMY_LABELS_RU } from './catalogue.ts';
import { commodityLabel, getInstallation, predictSurfaceSlots, siteCargo } from './planner.ts';
import { normalizeBodyKey } from './bodyNames.ts';
import type {
  ArchitectBody,
  ArchitectPlan,
  PlanEvaluation,
  PlannedSiteStatus,
  SystemEconomy,
  SystemEffectKey,
} from './types.ts';

export interface Share {
  key: string;
  label: string;
  value: number;
  /** Доля от общего, 0..100. */
  percent: number;
}

/**
 * Топ товаров плана с долями. Остальные сворачиваются в одну строку «прочее»,
 * чтобы полоса всегда складывалась в 100 %.
 */
export function cargoShares(evaluation: PlanEvaluation, limit = 8): { items: Share[]; total: number } {
  const entries = Object.entries(evaluation.cargo)
    .map(([key, tons]) => ({ key, label: commodityLabel(key), value: tons }))
    .sort((left, right) => right.value - left.value || left.label.localeCompare(right.label, 'ru'));
  const total = entries.reduce((sum, entry) => sum + entry.value, 0);
  if (total <= 0) return { items: [], total: 0 };

  const head = entries.slice(0, limit);
  const restValue = entries.slice(limit).reduce((sum, entry) => sum + entry.value, 0);
  const items: Share[] = head.map((entry) => ({
    key: entry.key,
    label: entry.label,
    value: entry.value,
    percent: Math.round((entry.value / total) * 1000) / 10,
  }));
  if (restValue > 0) {
    items.push({
      key: '__rest__',
      label: `прочее (${entries.length - head.length})`,
      value: restValue,
      percent: Math.round((restValue / total) * 1000) / 10,
    });
  }
  return { items, total };
}

/** Доли экономик системы по числу построек. */
export function economyShares(evaluation: PlanEvaluation): Share[] {
  const entries = (Object.entries(evaluation.economies) as [SystemEconomy, number][])
    .filter(([economy, count]) => economy !== 'none' && count > 0);
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  if (total === 0) return [];
  return entries
    .sort((left, right) => right[1] - left[1])
    .map(([economy, count]) => ({
      key: economy,
      label: ECONOMY_LABELS_RU[economy] ?? economy,
      value: count,
      percent: Math.round((count / total) * 1000) / 10,
    }));
}

export interface StatusBreakdown {
  status: PlannedSiteStatus;
  label: string;
  count: number;
  tons: number;
  percent: number;
}

const STATUS_LABELS: Record<PlannedSiteStatus, string> = {
  plan: 'в плане',
  building: 'строится',
  complete: 'готово',
};

/**
 * Разбивка плана по стадиям — она же показывает, какая часть тоннажа уже
 * закрыта (по статусам, которые проставил архитектор или перенос факта).
 */
export function statusBreakdown(plan: ArchitectPlan): StatusBreakdown[] {
  const buckets: Record<PlannedSiteStatus, { count: number; tons: number }> = {
    plan: { count: 0, tons: 0 },
    building: { count: 0, tons: 0 },
    complete: { count: 0, tons: 0 },
  };
  for (const site of plan.sites) {
    const installation = getInstallation(site.installationId);
    if (!installation) continue;
    const tons = siteCargo(site)?.haulTons ?? installation.haulTons;
    buckets[site.status].count += 1;
    buckets[site.status].tons += tons;
  }
  const total = plan.sites.length || 1;
  return (Object.keys(buckets) as PlannedSiteStatus[]).map((status) => ({
    status,
    label: STATUS_LABELS[status],
    count: buckets[status].count,
    tons: buckets[status].tons,
    percent: Math.round((buckets[status].count / total) * 1000) / 10,
  }));
}

export interface EffectBar {
  key: SystemEffectKey;
  label: string;
  value: number;
  /** Доля от самого большого по модулю эффекта, 0..100 — длина полосы. */
  magnitude: number;
  positive: boolean;
}

const EFFECT_LABELS: Record<SystemEffectKey, string> = {
  pop: 'население',
  mpop: 'предел населения',
  sec: 'безопасность',
  wealth: 'богатство',
  tech: 'технологии',
  sol: 'уровень жизни',
  dev: 'развитие',
};

/** Эффекты системы в виде полос: длина — доля от максимального по модулю. */
export function effectBars(evaluation: PlanEvaluation): EffectBar[] {
  const keys = Object.keys(EFFECT_LABELS) as SystemEffectKey[];
  const max = keys.reduce((peak, key) => Math.max(peak, Math.abs(evaluation.effects[key] ?? 0)), 0);
  return keys.map((key) => {
    const value = evaluation.effects[key] ?? 0;
    return {
      key,
      label: EFFECT_LABELS[key],
      value,
      magnitude: max > 0 ? Math.round((Math.abs(value) / max) * 100) : 0,
      positive: value >= 0,
    };
  });
}

export interface TierBudget {
  tier: 2 | 3;
  free: number;
  spent: number;
  given: number;
  /** Насколько израсходован бюджет, 0..100 (>100 — перерасход). */
  usedPercent: number;
  /** В какой момент плана бюджет уходил в минус (номер шага) или null. */
  firstDeficitStep: number | null;
  /** Самое низкое значение баланса за всю стройку. */
  lowest: number;
}

/** Бюджеты очков T2/T3 с «просадками» по ходу стройки. */
export function tierBudgets(evaluation: PlanEvaluation): TierBudget[] {
  return ([2, 3] as const).map((tier) => {
    const key = tier === 2 ? 'tier2' : 'tier3';
    const afterKey = tier === 2 ? 'tier2After' : 'tier3After';
    const given = evaluation.tierGiven[key];
    const spent = evaluation.tierSpent[key];
    const deficitStep = evaluation.timeline.find((step) => step[afterKey] < 0);
    const lowest = evaluation.timeline.reduce(
      (min, step) => Math.min(min, step[afterKey]),
      evaluation.timeline.length > 0 ? 0 : evaluation.tierPoints[key],
    );
    return {
      tier,
      free: evaluation.tierPoints[key],
      spent,
      given,
      usedPercent: given > 0 ? Math.round((spent / given) * 100) : spent > 0 ? 100 : 0,
      firstDeficitStep: deficitStep ? deficitStep.index : null,
      lowest,
    };
  });
}

export interface BodyLoad {
  name: string;
  kind: ArchitectBody['kind'];
  used: number;
  limit: number;
  orbital: number;
  /** Занятость наземных слотов, 0..100. */
  percent: number;
  distanceLs: number;
}

/** Загрузка тел: наземные слоты и число орбитальных построек. */
export function bodyLoads(plan: ArchitectPlan, bodies: ArchitectBody[]): BodyLoad[] {
  const surface = new Map<string, number>();
  const orbital = new Map<string, number>();
  for (const site of plan.sites) {
    const installation = getInstallation(site.installationId);
    if (!installation) continue;
    const key = normalizeBodyKey(site.bodyName);
    const target = installation.location === 'surface' ? surface : orbital;
    target.set(key, (target.get(key) ?? 0) + 1);
  }
  return bodies
    .map((body) => {
      const key = normalizeBodyKey(body.name);
      const used = surface.get(key) ?? 0;
      const limit = predictSurfaceSlots(body);
      return {
        name: body.name,
        kind: body.kind,
        used,
        limit,
        orbital: orbital.get(key) ?? 0,
        percent: limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0,
        distanceLs: body.distanceLs,
      };
    })
    .filter((entry) => entry.used > 0 || entry.orbital > 0 || entry.limit > 0);
}

/**
 * Число рейсов под заданную вместимость трюма. Ноль вместимости — ноль
 * рейсов, а не деление на ноль.
 */
export function haulTrips(tons: number, capacity: number): number {
  if (!Number.isFinite(tons) || tons <= 0) return 0;
  if (!Number.isFinite(capacity) || capacity <= 0) return 0;
  return Math.ceil(tons / capacity);
}

export interface PlanPulse {
  sites: number;
  bodiesUsed: number;
  tons: number;
  score: number;
  errors: number;
  warnings: number;
  trips: { capacity: number; trips: number }[];
}

/** Короткая сводка «пульса» плана для верхней полосы KPI. */
export function planPulse(plan: ArchitectPlan, evaluation: PlanEvaluation): PlanPulse {
  const bodies = new Set(plan.sites.map((site) => normalizeBodyKey(site.bodyName)).filter(Boolean));
  return {
    sites: plan.sites.length,
    bodiesUsed: bodies.size,
    tons: evaluation.haulTons,
    score: evaluation.score,
    errors: evaluation.issues.filter((issue) => issue.level === 'error').length,
    warnings: evaluation.issues.filter((issue) => issue.level === 'warning').length,
    trips: [400, 784, 25_000].map((capacity) => ({ capacity, trips: haulTrips(evaluation.haulTons, capacity) })),
  };
}
