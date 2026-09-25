/**
 * План архитектора ↔ строка `system_plans`.
 *
 * Всё, что связано с серверным хранением и публикацией, собрано здесь и не
 * знает ни про Supabase, ни про Next: маршруты `/api/architect/plans` только
 * вызывают эти функции, поэтому маппинг проверяется тестами без базы.
 *
 * Сводные числа (`site_count`, `haul_tons`, `score`, очки тиров) считает
 * сервер движком `evaluatePlan()` при каждой записи. Клиент может прислать
 * какой угодно JSON, но в список планов системы попадут числа, посчитанные
 * заново, — подделать «оценку 999» не получится.
 */

import { CATALOGUE_VERSION } from './catalogue.ts';
import { PLAN_FORMAT_VERSION, evaluatePlan, parsePlan } from './planner.ts';
import type { ArchitectBody, ArchitectPlan } from './types.ts';

export const PLAN_TABLE = 'system_plans';

export type PlanVisibility = 'private' | 'unlisted' | 'public';

export const PLAN_VISIBILITIES: PlanVisibility[] = ['private', 'unlisted', 'public'];

export const VISIBILITY_LABELS_RU: Record<PlanVisibility, string> = {
  private: 'только я',
  unlisted: 'по ссылке',
  public: 'публичный',
};

export const VISIBILITY_HINTS_RU: Record<PlanVisibility, string> = {
  private: 'Видите только вы. В общем списке системы план не появляется.',
  unlisted: 'Открывается по прямой ссылке, в списке системы не показывается.',
  public: 'Виден всем в списке планов этой системы.',
};

export function isPlanVisibility(value: unknown): value is PlanVisibility {
  return typeof value === 'string' && (PLAN_VISIBILITIES as string[]).includes(value);
}

/** Ссылка, которой делятся планом. */
export function sharePath(planId: string): string {
  return `/architect?plan=${encodeURIComponent(planId)}`;
}

export interface PlanMetrics {
  siteCount: number;
  haulTons: number;
  score: number;
  tier2Points: number;
  tier3Points: number;
  cargoItems: number;
}

/** Сводка плана, которую хранит сервер. */
export function planMetrics(plan: ArchitectPlan, bodies: ArchitectBody[] = []): PlanMetrics {
  const evaluation = evaluatePlan(plan, bodies);
  return {
    siteCount: plan.sites.length,
    haulTons: Math.round(evaluation.haulTons),
    score: evaluation.score,
    tier2Points: evaluation.tierPoints.tier2,
    tier3Points: evaluation.tierPoints.tier3,
    cargoItems: Object.keys(evaluation.cargo).length,
  };
}

/** Строка таблицы — как её отдаёт Supabase. */
export interface StoredPlanRow {
  id: string;
  system_name: string;
  title?: string | null;
  author_id?: string | null;
  author_name?: string | null;
  visibility?: string | null;
  plan?: unknown;
  format_version?: number | null;
  catalogue_version?: number | null;
  site_count?: number | null;
  haul_tons?: number | null;
  score?: number | null;
  tier2_points?: number | null;
  tier3_points?: number | null;
  cargo_items?: number | null;
  notes?: string | null;
  published_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

/** План в том виде, в каком его видит интерфейс. */
export interface PlanView {
  id: string;
  system: string;
  title: string;
  authorId: string;
  authorName: string;
  visibility: PlanVisibility;
  siteCount: number;
  haulTons: number;
  score: number;
  tierPoints: { tier2: number; tier3: number };
  catalogueVersion: number;
  /** Каталог изменился с момента сохранения — стоимости могли уехать. */
  stale: boolean;
  notes: string;
  publishedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  own: boolean;
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function int(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Поля для `insert()`. */
export function buildPlanInsert(
  plan: ArchitectPlan,
  options: { authorId: string; authorName?: string; visibility?: PlanVisibility; title?: string; bodies?: ArchitectBody[] },
): Record<string, unknown> {
  const visibility = isPlanVisibility(options.visibility) ? options.visibility : 'private';
  const metrics = planMetrics(plan, options.bodies ?? []);
  return {
    system_name: plan.system,
    title: String(options.title ?? '').slice(0, 160),
    author_id: options.authorId,
    author_name: String(options.authorName ?? '').slice(0, 120),
    visibility,
    plan: JSON.parse(JSON.stringify(plan)),
    format_version: PLAN_FORMAT_VERSION,
    catalogue_version: CATALOGUE_VERSION,
    site_count: metrics.siteCount,
    haul_tons: metrics.haulTons,
    score: metrics.score,
    tier2_points: metrics.tier2Points,
    tier3_points: metrics.tier3Points,
    cargo_items: metrics.cargoItems,
    notes: plan.notes,
    published_at: visibility === 'private' ? null : new Date().toISOString(),
  };
}

/** Поля для `update()` — те же сводные числа считаются заново. */
export function buildPlanUpdate(
  plan: ArchitectPlan,
  options: { visibility?: PlanVisibility; title?: string; bodies?: ArchitectBody[]; previous?: StoredPlanRow | null } = {},
): Record<string, unknown> {
  const visibility = isPlanVisibility(options.visibility)
    ? options.visibility
    : isPlanVisibility(options.previous?.visibility)
      ? (options.previous!.visibility as PlanVisibility)
      : 'private';
  const metrics = planMetrics(plan, options.bodies ?? []);
  const publishedAt = visibility === 'private'
    ? null
    : str(options.previous?.published_at) || new Date().toISOString();
  return {
    system_name: plan.system,
    title: String(options.title ?? options.previous?.title ?? '').slice(0, 160),
    visibility,
    plan: JSON.parse(JSON.stringify(plan)),
    format_version: PLAN_FORMAT_VERSION,
    catalogue_version: CATALOGUE_VERSION,
    site_count: metrics.siteCount,
    haul_tons: metrics.haulTons,
    score: metrics.score,
    tier2_points: metrics.tier2Points,
    tier3_points: metrics.tier3Points,
    cargo_items: metrics.cargoItems,
    notes: plan.notes,
    published_at: publishedAt,
  };
}

/**
 * Строка → представление плана.
 *
 * `null` возвращается на мусоре и на строке с нечитаемым JSON: список планов
 * обязан показываться, даже если один из планов повреждён. Строка без поля
 * `plan` (список систем читает только сводные колонки) тоже разбирается —
 * тогда представление строится по колонкам.
 */
export function rowToView(row: StoredPlanRow | null | undefined, viewerId: string | null = null): PlanView | null {
  if (!row || typeof row !== 'object') return null;
  let storedPlan: ArchitectPlan | null = null;
  if (row.plan !== undefined) {
    const parsed = parsePlan(row.plan);
    if (!parsed.plan) return null;
    storedPlan = parsed.plan;
  }
  const catalogueVersion = int(row.catalogue_version);
  const visibility = isPlanVisibility(row.visibility) ? row.visibility : 'private';
  const authorId = str(row.author_id);
  return {
    id: str(row.id),
    system: str(row.system_name) || storedPlan?.system || '',
    title: str(row.title),
    authorId,
    authorName: str(row.author_name),
    visibility,
    siteCount: int(row.site_count) || (storedPlan?.sites.length ?? 0),
    haulTons: int(row.haul_tons),
    score: int(row.score),
    tierPoints: { tier2: int(row.tier2_points), tier3: int(row.tier3_points) },
    catalogueVersion,
    stale: catalogueVersion > 0 && catalogueVersion !== CATALOGUE_VERSION,
    notes: str(row.notes),
    publishedAt: str(row.published_at) || null,
    createdAt: str(row.created_at) || null,
    updatedAt: str(row.updated_at) || null,
    own: Boolean(viewerId) && authorId === viewerId,
  };
}

/** Строка + сам план — для открытия по ссылке. */
export function rowToStoredPlan(
  row: StoredPlanRow | null | undefined,
  viewerId: string | null = null,
): { view: PlanView; plan: ArchitectPlan; warning?: string } | null {
  if (!row || typeof row !== 'object' || row.plan === undefined) return null;
  const view = rowToView(row, viewerId);
  if (!view) return null;
  const parsed = parsePlan(row.plan);
  if (!parsed.plan) return null;
  return { view, plan: parsed.plan, warning: parsed.warning };
}
