/**
 * Прогресс систем проекта и проекта целиком. Чистые функции.
 *
 * Источники (маршрут получает их одной SQL-функцией
 * `architect_project_progress_sources`):
 *   * кэш Raven Colonial `system_progress` — площадки системы и остаток
 *     каждого товара на момент последнего опроса Raven;
 *   * журнальное состояние стройплощадок `colonisation_sites` — точные
 *     «нужно/привезено» на момент последней стыковки пилота с площадкой;
 *   * план архитектора `system_plans` — сколько площадок и тонн задумано.
 *
 * Свежесть решает, кому верить: журнал новее кэша Raven — берём числа
 * журнала; иначе остаток Raven, а «нужно» — из журнала (это уже делает
 * `enrichRavenSystemWithDepotSnapshots`). Площадки, которых Raven не знает,
 * добавляются из журнала.
 *
 * Прогресс системы:
 *   * есть план — тоннаж плана: у сопоставленной площадки берутся её
 *     фактические «нужно/привезено», у остальных — тоннаж каталога, умноженный
 *     на готовность (завершена — 1, в стройке — её процент, не начата — 0);
 *     площадки вне плана добавляются своим фактическим тоннажем;
 *   * плана нет — сумма «привезено» / сумма «нужно» по площадкам.
 * Прогресс проекта — те же тонны, сложенные по всем системам.
 */

import { commodityLabel, evaluatePlan, parsePlan } from './planner.ts';
import { matchProgress, type ActualSite } from './progress.ts';
import type { ArchitectPlan } from './types.ts';
import {
  enrichRavenSystemWithDepotSnapshots,
  type RavenProject,
  type RavenResource,
  type RavenSystemV2,
} from '../ravenColonial.ts';

// ── Входные строки ─────────────────────────────────────────────────────────

export interface RavenCacheRow {
  system_key?: string;
  system_name: string;
  progress?: unknown;
  updated_at?: string | null;
  data?: unknown;
}

export interface DepotRow {
  system_key?: string;
  market_id: string | number;
  system_name?: string;
  construction_name?: string | null;
  construction_progress?: unknown;
  resources_total?: unknown;
  event_timestamp?: string | null;
}

export interface PlanRow {
  id: string;
  system_name?: string;
  title?: string;
  author_id?: string | null;
  author_name?: string;
  visibility?: string;
  site_count?: number;
  haul_tons?: number;
  catalogue_version?: number;
  updated_at?: string | null;
  plan?: unknown;
}

export interface ProgressSources {
  raven: RavenCacheRow[];
  depots: DepotRow[];
  plans: PlanRow[];
}

// ── Результат ──────────────────────────────────────────────────────────────

export interface SiteCommodity {
  key: string;
  label: string;
  required: number | null;
  provided: number | null;
  remaining: number;
}

export interface ProjectSite {
  /** buildId Raven или `m:<MarketID>` для площадки только из журнала. */
  key: string;
  marketId: string | null;
  name: string;
  buildType: string | null;
  body: string | null;
  complete: boolean;
  /** 0–100; null — неизвестно. */
  progress: number | null;
  required: number | null;
  provided: number | null;
  remaining: number | null;
  source: 'raven' | 'journal' | 'both';
  updatedAt: string | null;
  commodities: SiteCommodity[];
  /** Запись плана, с которой сопоставлена площадка. */
  planSiteId: string | null;
}

export interface PlanSiteState {
  siteId: string;
  name: string;
  body: string;
  tons: number;
  status: 'complete' | 'building' | 'planned';
  progress: number | null;
  siteKey: string | null;
}

export type SystemStatus = 'unknown' | 'planned' | 'building' | 'done';

export interface SystemProgressView {
  systemId: string;
  systemName: string;
  status: SystemStatus;
  /** Прогресс системы 0–100; null — данных нет. */
  progress: number | null;
  basis: 'plan' | 'sites' | 'none';
  doneTons: number;
  totalTons: number;
  required: number | null;
  provided: number | null;
  remaining: number | null;
  sites: ProjectSite[];
  sitesComplete: number;
  sitesActive: number;
  plan: {
    id: string;
    title: string;
    siteCount: number;
    haulTons: number;
    matched: number;
    complete: number;
    sites: PlanSiteState[];
    error?: string;
  } | null;
  /** Что ещё нужно привезти (активные площадки), по убыванию. */
  needs: SiteCommodity[];
  ravenUpdatedAt: string | null;
  journalUpdatedAt: string | null;
  architectName: string | null;
}

export interface ProjectProgressSummary {
  progress: number | null;
  doneTons: number;
  totalTons: number;
  systems: number;
  systemsDone: number;
  systemsBuilding: number;
  systemsPlanned: number;
  systemsUnknown: number;
  sites: number;
  sitesComplete: number;
  sitesActive: number;
  plannedSites: number;
  plannedTons: number;
  required: number | null;
  provided: number | null;
  remaining: number | null;
  needs: SiteCommodity[];
  updatedAt: string | null;
}

export interface ProjectProgressView {
  systems: SystemProgressView[];
  summary: ProjectProgressSummary;
}

// ── Помощники ──────────────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function finite(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function time(value: unknown): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

function isoOrNull(value: unknown): string | null {
  const ms = time(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function clampPercent(value: number | null): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return round2(Math.min(100, Math.max(0, value)));
}

function marketKey(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  return raw && raw !== '0' && /^\d+$/.test(raw) ? raw : null;
}

/** Тот же ключ товара, что у Raven и журнала: `$steel_name;` → `steel`. */
export function resourceKey(value: unknown): string {
  return String(value ?? '')
    .trim()
    .replace(/^\$+/, '')
    .replace(/_name;?$/i, '')
    .replace(/[\s_-]+/g, '')
    .toLowerCase();
}

function resourceLabel(key: string, fallback: unknown): string {
  const known = commodityLabel(key);
  if (known && known.toLowerCase() !== key) return known;
  const text = String(fallback ?? '').trim();
  return text || known || key;
}

/** Самая свежая строка кэша Raven среди вариантов написания имени. */
export function pickRavenRow(rows: RavenCacheRow[]): RavenCacheRow | null {
  let best: RavenCacheRow | null = null;
  for (const row of rows) {
    if (!best || time(row.updated_at) > time(best.updated_at)) best = row;
  }
  return best;
}

function ravenProjectsOf(data: unknown): RavenProject[] {
  const record = asRecord(data);
  const list = Array.isArray(record?.projects) ? (record!.projects as unknown[]) : [];
  const projects: RavenProject[] = [];
  list.forEach((entry, index) => {
    const project = asRecord(entry);
    if (!project) return;
    const resources: RavenResource[] = (Array.isArray(project.resources) ? project.resources : [])
      .map((item) => asRecord(item))
      .filter((item): item is Record<string, unknown> => item !== null)
      .map((item) => ({
        name: String(item.name ?? item.key ?? ''),
        key: resourceKey(item.key ?? item.name),
        required: finite(item.required),
        provided: finite(item.provided),
        remaining: Math.max(0, finite(item.remaining) ?? 0),
        exact: item.exact === true,
      }))
      .filter((item) => item.key);
    const complete = project.complete === true;
    projects.push({
      buildId: String(project.buildId ?? project.marketId ?? `raven-${index}`),
      marketId: marketKey(project.marketId),
      buildName: typeof project.buildName === 'string' && project.buildName.trim() ? project.buildName.trim() : 'Стройплощадка',
      buildType: typeof project.buildType === 'string' ? project.buildType : null,
      complete,
      progress: complete ? 100 : Math.min(100, Math.max(0, finite(project.progress) ?? 0)),
      bodyName: typeof project.bodyName === 'string' ? project.bodyName : null,
      resources,
      totalRequired: finite(project.totalRequired),
      totalProvided: finite(project.totalProvided),
      totalRemaining: Math.max(0, finite(project.totalRemaining) ?? 0),
    });
  });
  return projects;
}

function depotCommodities(depot: DepotRow): SiteCommodity[] {
  const rows = Array.isArray(depot.resources_total) ? depot.resources_total : [];
  const result = new Map<string, SiteCommodity>();
  for (const entry of rows) {
    const row = asRecord(entry);
    if (!row) continue;
    const key = resourceKey(row.Name ?? row.name);
    const required = finite(row.RequiredAmount ?? row.requiredAmount ?? row.required);
    const provided = finite(row.ProvidedAmount ?? row.providedAmount ?? row.provided);
    if (!key || required == null) continue;
    const safeRequired = Math.max(0, required);
    const safeProvided = Math.min(safeRequired, Math.max(0, provided ?? 0));
    const current = result.get(key);
    if (current) {
      current.required = (current.required ?? 0) + safeRequired;
      current.provided = (current.provided ?? 0) + safeProvided;
      current.remaining += safeRequired - safeProvided;
    } else {
      result.set(key, {
        key,
        label: resourceLabel(key, row.Name_Localised ?? row.nameLocalised),
        required: safeRequired,
        provided: safeProvided,
        remaining: safeRequired - safeProvided,
      });
    }
  }
  return Array.from(result.values()).sort((left, right) => right.remaining - left.remaining);
}

function siteFromDepot(
  depot: DepotRow,
  meta: { key?: string; name?: string; buildType?: string | null; body?: string | null; complete?: boolean; source: ProjectSite['source'] },
): ProjectSite {
  const marketId = marketKey(depot.market_id);
  const commodities = depotCommodities(depot);
  const required = commodities.length ? commodities.reduce((sum, item) => sum + (item.required ?? 0), 0) : null;
  const provided = commodities.length ? commodities.reduce((sum, item) => sum + (item.provided ?? 0), 0) : null;
  const journalProgress = finite(depot.construction_progress);
  const cargoProgress = required != null && required > 0 && provided != null ? (provided / required) * 100 : null;
  const complete = meta.complete === true
    || (journalProgress != null && journalProgress >= 100)
    || (required != null && required > 0 && provided != null && provided >= required);
  const progress = complete ? 100 : clampPercent(cargoProgress ?? journalProgress);
  return {
    key: meta.key ?? `m:${marketId ?? depot.market_id}`,
    marketId,
    name: meta.name || cleanDepotName(depot.construction_name) || `Площадка ${marketId ?? ''}`.trim(),
    buildType: meta.buildType ?? null,
    body: meta.body ?? null,
    complete,
    progress,
    required,
    provided,
    remaining: required != null && provided != null ? Math.max(0, required - provided) : null,
    source: meta.source,
    updatedAt: isoOrNull(depot.event_timestamp),
    commodities: complete ? commodities.map((item) => ({ ...item, remaining: 0 })) : commodities,
    planSiteId: null,
  };
}

/** `$EXT_PANEL_ColonisationShip; Name` и т. п. — оставляем человеческую часть. */
export function cleanDepotName(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  return raw.replace(/\$[A-Za-z0-9_]+;?\s*:?\s*/g, '').replace(/\s+/g, ' ').trim() || raw;
}

function siteFromRaven(project: RavenProject, updatedAt: string | null, source: ProjectSite['source']): ProjectSite {
  const commodities: SiteCommodity[] = project.resources.map((resource) => ({
    key: resource.key,
    label: resourceLabel(resource.key, resource.name),
    required: resource.required,
    provided: resource.provided,
    remaining: project.complete ? 0 : Math.max(0, resource.remaining),
  }));
  const required = project.totalRequired;
  const provided = project.totalProvided;
  const remaining = project.complete ? 0 : project.totalRemaining;
  return {
    key: project.buildId,
    marketId: project.marketId,
    name: project.buildName,
    buildType: project.buildType,
    body: project.bodyName,
    complete: project.complete,
    progress: project.complete ? 100 : clampPercent(
      required != null && required > 0 && provided != null ? (provided / required) * 100 : project.progress,
    ),
    required,
    provided,
    remaining,
    source,
    updatedAt,
    commodities: commodities.sort((left, right) => right.remaining - left.remaining),
    planSiteId: null,
  };
}

function enrichWithDepot(project: RavenProject, depot: DepotRow): RavenProject {
  const system: RavenSystemV2 = {
    systemName: '',
    siteName: null,
    architectName: null,
    progress: null,
    projects: [project],
    resources: [],
    totalRequired: null,
    totalProvided: null,
    totalRemaining: project.totalRemaining,
  };
  const enriched = enrichRavenSystemWithDepotSnapshots(system, [{
    marketId: String(depot.market_id),
    resources: depot.resources_total,
  }]);
  return enriched.projects[0] ?? project;
}

/** Площадки системы: Raven + журнал, по MarketID, свежие числа побеждают. */
export function mergeSites(raven: RavenCacheRow | null, depots: DepotRow[]): ProjectSite[] {
  const ravenAt = time(raven?.updated_at);
  const ravenIso = isoOrNull(raven?.updated_at);
  const depotByMarket = new Map<string, DepotRow>();
  for (const depot of depots) {
    const id = marketKey(depot.market_id);
    if (!id) continue;
    const current = depotByMarket.get(id);
    if (!current || time(depot.event_timestamp) > time(current.event_timestamp)) depotByMarket.set(id, depot);
  }

  const used = new Set<string>();
  const sites: ProjectSite[] = [];
  for (const project of ravenProjectsOf(raven?.data)) {
    const depot = project.marketId ? depotByMarket.get(project.marketId) : undefined;
    if (depot && project.marketId) used.add(project.marketId);
    if (depot && time(depot.event_timestamp) > ravenAt) {
      sites.push(siteFromDepot(depot, {
        key: project.buildId,
        name: project.buildName,
        buildType: project.buildType,
        body: project.bodyName,
        complete: project.complete,
        source: 'both',
      }));
    } else {
      sites.push(siteFromRaven(depot ? enrichWithDepot(project, depot) : project, ravenIso, depot ? 'both' : 'raven'));
    }
  }
  for (const [id, depot] of depotByMarket) {
    if (!used.has(id)) sites.push(siteFromDepot(depot, { source: 'journal' }));
  }
  return sites.sort((left, right) => (
    Number(left.complete) - Number(right.complete)
    || (right.remaining ?? -1) - (left.remaining ?? -1)
    || left.name.localeCompare(right.name, 'ru')
  ));
}

function addNeeds(target: Map<string, SiteCommodity>, items: SiteCommodity[]): void {
  for (const item of items) {
    if (item.remaining <= 0) continue;
    const current = target.get(item.key);
    if (current) {
      current.remaining += item.remaining;
      current.required = current.required != null && item.required != null ? current.required + item.required : current.required ?? item.required;
      current.provided = current.provided != null && item.provided != null ? current.provided + item.provided : current.provided ?? item.provided;
    } else {
      target.set(item.key, { ...item });
    }
  }
}

function sortedNeeds(map: Map<string, SiteCommodity>, limit?: number): SiteCommodity[] {
  const list = Array.from(map.values()).sort((left, right) => right.remaining - left.remaining || left.label.localeCompare(right.label, 'ru'));
  return limit ? list.slice(0, limit) : list;
}

function toActual(site: ProjectSite): ActualSite {
  return {
    buildId: site.key,
    name: site.name,
    buildType: site.buildType,
    bodyName: site.body,
    progress: site.progress ?? 0,
    complete: site.complete,
    totalRequired: site.required,
    totalProvided: site.provided,
    totalRemaining: site.remaining,
  };
}

/**
 * Сопоставление плана и площадок: сперва по связи `ravenBuildId`, которую
 * ставит планировщик, затем обычным `matchProgress` (тип + тело).
 */
function matchPlan(plan: ArchitectPlan, sites: ProjectSite[]): Map<string, ProjectSite> {
  const byKey = new Map(sites.map((site) => [site.key, site]));
  const matched = new Map<string, ProjectSite>();
  const usedSites = new Set<string>();
  for (const planned of plan.sites) {
    const linked = planned.ravenBuildId ? byKey.get(planned.ravenBuildId) : undefined;
    if (linked && !usedSites.has(linked.key)) {
      matched.set(planned.id, linked);
      usedSites.add(linked.key);
    }
  }
  const restPlan = { ...plan, sites: plan.sites.filter((planned) => !matched.has(planned.id)) };
  const restSites = sites.filter((site) => !usedSites.has(site.key));
  if (restPlan.sites.length && restSites.length) {
    const report = matchProgress(restPlan, restSites.map(toActual));
    for (const entry of report.sites) {
      if (!entry.actual) continue;
      const site = byKey.get(entry.actual.buildId);
      if (site) matched.set(entry.siteId, site);
    }
  }
  return matched;
}

export interface SystemInput {
  systemId: string;
  systemName: string;
  raven: RavenCacheRow | null;
  depots: DepotRow[];
  plan: PlanRow | null;
}

export function buildSystemProgress(input: SystemInput): SystemProgressView {
  const sites = mergeSites(input.raven, input.depots);
  const sitesComplete = sites.filter((site) => site.complete).length;
  const sitesActive = sites.length - sitesComplete;

  let required: number | null = null;
  let provided: number | null = null;
  for (const site of sites) {
    if (site.required != null) required = (required ?? 0) + site.required;
    if (site.provided != null) provided = (provided ?? 0) + site.provided;
  }

  const needsMap = new Map<string, SiteCommodity>();
  for (const site of sites) if (!site.complete) addNeeds(needsMap, site.commodities);

  let doneTons = 0;
  let totalTons = 0;
  let basis: SystemProgressView['basis'] = 'none';
  let planView: SystemProgressView['plan'] = null;
  let planPending = 0;

  if (input.plan) {
    const parsed = input.plan.plan == null ? { plan: null as ArchitectPlan | null } : parsePlan(input.plan.plan);
    const plan = parsed.plan;
    planView = {
      id: input.plan.id,
      title: String(input.plan.title ?? ''),
      siteCount: Number(input.plan.site_count ?? 0) || 0,
      haulTons: Number(input.plan.haul_tons ?? 0) || 0,
      matched: 0,
      complete: 0,
      sites: [],
      ...(plan ? {} : { error: 'error' in parsed && parsed.error ? String(parsed.error) : 'План не прочитан' }),
    };
    if (plan && plan.sites.length) {
      let tonsBySite = new Map<string, { tons: number; name: string }>();
      try {
        const evaluation = evaluatePlan(plan);
        tonsBySite = new Map(evaluation.timeline.map((step) => [step.siteId, { tons: step.tons, name: step.nameRu }]));
      } catch {
        // План со сломанной записью всё равно показываем — без тоннажа.
      }
      const matched = matchPlan(plan, sites);
      const matchedKeys = new Set<string>();
      for (const planned of plan.sites) {
        const site = matched.get(planned.id) ?? null;
        if (site) {
          matchedKeys.add(site.key);
          site.planSiteId = planned.id;
        }
        const catalogueTons = tonsBySite.get(planned.id)?.tons ?? 0;
        const complete = site?.complete === true || planned.status === 'complete';
        const sitePercent = site?.progress ?? null;
        const status: PlanSiteState['status'] = complete ? 'complete' : site || planned.status === 'building' ? 'building' : 'planned';
        if (site && site.required != null && site.required > 0) {
          totalTons += site.required;
          doneTons += complete ? site.required : Math.min(site.required, site.provided ?? 0);
        } else {
          totalTons += catalogueTons;
          doneTons += complete ? catalogueTons : catalogueTons * ((sitePercent ?? 0) / 100);
        }
        if (!complete && !site) planPending += 1;
        planView.sites.push({
          siteId: planned.id,
          name: tonsBySite.get(planned.id)?.name ?? planned.installationId,
          body: planned.bodyName,
          tons: site?.required ?? catalogueTons,
          status,
          progress: complete ? 100 : sitePercent,
          siteKey: site?.key ?? null,
        });
      }
      planView.matched = matchedKeys.size;
      planView.complete = planView.sites.filter((entry) => entry.status === 'complete').length;
      // Площадки вне плана — своим фактическим тоннажем.
      for (const site of sites) {
        if (matchedKeys.has(site.key) || site.required == null || site.required <= 0) continue;
        totalTons += site.required;
        doneTons += site.complete ? site.required : Math.min(site.required, site.provided ?? 0);
      }
      if (totalTons > 0) basis = 'plan';
    }
  }

  if (basis === 'none') {
    doneTons = 0;
    totalTons = 0;
    for (const site of sites) {
      if (site.required == null || site.required <= 0) continue;
      totalTons += site.required;
      doneTons += site.complete ? site.required : Math.min(site.required, site.provided ?? 0);
    }
    if (totalTons > 0) basis = 'sites';
  }

  let progress: number | null = totalTons > 0 ? clampPercent((doneTons / totalTons) * 100) : null;
  if (progress == null && sites.length) {
    const known = sites.map((site) => site.progress).filter((value): value is number => value != null);
    if (known.length) progress = clampPercent(known.reduce((sum, value) => sum + value, 0) / known.length);
  }

  let status: SystemStatus;
  if (!sites.length) status = planView ? 'planned' : 'unknown';
  else if (sitesActive === 0 && planPending === 0) status = 'done';
  else status = 'building';
  if (status === 'done') progress = 100;

  const journalTimes = input.depots.map((depot) => time(depot.event_timestamp)).filter(Number.isFinite);
  const ravenData = asRecord(input.raven?.data);
  return {
    systemId: input.systemId,
    systemName: input.systemName,
    status,
    progress,
    basis,
    doneTons: Math.round(doneTons),
    totalTons: Math.round(totalTons),
    required,
    provided,
    remaining: required != null && provided != null ? Math.max(0, required - provided) : null,
    sites,
    sitesComplete,
    sitesActive,
    plan: planView,
    needs: sortedNeeds(needsMap),
    ravenUpdatedAt: isoOrNull(input.raven?.updated_at),
    journalUpdatedAt: journalTimes.length ? new Date(Math.max(...journalTimes)).toISOString() : null,
    architectName: typeof ravenData?.architectName === 'string' ? ravenData.architectName : null,
  };
}

export function summarizeProject(systems: SystemProgressView[]): ProjectProgressSummary {
  let doneTons = 0;
  let totalTons = 0;
  let required: number | null = null;
  let provided: number | null = null;
  let plannedSites = 0;
  let plannedTons = 0;
  let updated = Number.NEGATIVE_INFINITY;
  const needs = new Map<string, SiteCommodity>();
  for (const system of systems) {
    doneTons += system.doneTons;
    totalTons += system.totalTons;
    if (system.required != null) required = (required ?? 0) + system.required;
    if (system.provided != null) provided = (provided ?? 0) + system.provided;
    if (system.plan) {
      plannedSites += system.plan.siteCount || system.plan.sites.length;
      plannedTons += system.plan.haulTons;
    }
    addNeeds(needs, system.needs);
    updated = Math.max(updated, time(system.ravenUpdatedAt), time(system.journalUpdatedAt));
  }
  const count = (status: SystemStatus) => systems.filter((system) => system.status === status).length;
  return {
    progress: totalTons > 0 ? clampPercent((doneTons / totalTons) * 100) : (systems.length && count('done') === systems.length ? 100 : null),
    doneTons,
    totalTons,
    systems: systems.length,
    systemsDone: count('done'),
    systemsBuilding: count('building'),
    systemsPlanned: count('planned'),
    systemsUnknown: count('unknown'),
    sites: systems.reduce((sum, system) => sum + system.sites.length, 0),
    sitesComplete: systems.reduce((sum, system) => sum + system.sitesComplete, 0),
    sitesActive: systems.reduce((sum, system) => sum + system.sitesActive, 0),
    plannedSites,
    plannedTons,
    required,
    provided,
    remaining: required != null && provided != null ? Math.max(0, required - provided) : null,
    needs: sortedNeeds(needs, 24),
    updatedAt: Number.isFinite(updated) ? new Date(updated).toISOString() : null,
  };
}

/**
 * Прогресс всего проекта из источников одной SQL-функции.
 * `systems` — системы проекта (id, имя, ссылка на план).
 */
export function buildProjectProgress(
  systems: Array<{ id: string; name: string; planId: string | null }>,
  sources: ProgressSources,
): ProjectProgressView {
  const key = (value: unknown) => String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
  const ravenByKey = new Map<string, RavenCacheRow[]>();
  for (const row of sources.raven ?? []) {
    const rowKey = key(row.system_key ?? row.system_name);
    if (!ravenByKey.has(rowKey)) ravenByKey.set(rowKey, []);
    ravenByKey.get(rowKey)!.push(row);
  }
  const depotsByKey = new Map<string, DepotRow[]>();
  for (const row of sources.depots ?? []) {
    const rowKey = key(row.system_key ?? row.system_name);
    if (!depotsByKey.has(rowKey)) depotsByKey.set(rowKey, []);
    depotsByKey.get(rowKey)!.push(row);
  }
  const plansById = new Map((sources.plans ?? []).map((plan) => [String(plan.id), plan]));
  const views = systems.map((system) => buildSystemProgress({
    systemId: system.id,
    systemName: system.name,
    raven: pickRavenRow(ravenByKey.get(key(system.name)) ?? []),
    depots: depotsByKey.get(key(system.name)) ?? [],
    plan: system.planId ? plansById.get(system.planId) ?? null : null,
  }));
  return { systems: views, summary: summarizeProject(views) };
}

/** Площадки проекта по MarketID — для подписей в лидерборде. */
export function siteDirectory(progress: ProjectProgressView): Map<string, { name: string; systemName: string; buildType: string | null }> {
  const result = new Map<string, { name: string; systemName: string; buildType: string | null }>();
  for (const system of progress.systems) {
    for (const site of system.sites) {
      if (site.marketId && !result.has(site.marketId)) {
        result.set(site.marketId, { name: site.name, systemName: system.systemName, buildType: site.buildType });
      }
    }
  }
  return result;
}

/** Системы, чей кэш Raven старше `maxAgeMs` (или отсутствует), — кандидаты на обновление. */
export function staleSystems(
  systems: Array<{ id: string; name: string }>,
  progress: ProjectProgressView,
  now: number,
  maxAgeMs: number,
): Array<{ id: string; name: string }> {
  const byId = new Map(progress.systems.map((system) => [system.systemId, system]));
  return systems
    .map((system) => ({ system, at: time(byId.get(system.id)?.ravenUpdatedAt) }))
    .filter((entry) => !Number.isFinite(entry.at) || now - entry.at > maxAgeMs)
    .sort((left, right) => left.at - right.at)
    .map((entry) => entry.system);
}
