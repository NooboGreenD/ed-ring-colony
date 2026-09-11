const DEFAULT_BASE =
  'https://ravencolonial100-awcbdvabgze4c5cq.canadacentral-01.azurewebsites.net';

export function ravenBase(): string {
  const raw = (process.env.RAVEN_API_BASE || DEFAULT_BASE).replace(/\/+$/, '');
  return raw.replace(/\/api$/i, '');
}

/**
 * RavenColonial exposes two different kinds of cargo data:
 *
 * - `commodities` / `sumNeed` is the **current outstanding need**.
 * - `maxNeed` (or older `sumTotal`) is the original total for a project.
 *
 * It does not normally expose the original amount per commodity.  Therefore
 * resource rows which came from `commodities` deliberately use null for the
 * per-commodity delivered/required values rather than inventing a split for
 * the delivered cargo. `exact` is true only when an actual Construction Depot
 * resource list with RequiredAmount/ProvidedAmount is available (from a
 * compatible API payload or an imported journal snapshot).
 */
export interface RavenResource {
  name: string;
  key: string;
  required: number | null;
  provided: number | null;
  remaining: number;
  exact: boolean;
}

export interface RavenCargoTotals {
  /** Original amount required for the whole project/system, when Raven provides it. */
  totalRequired: number | null;
  /** Actually delivered cargo calculated from Raven's original and outstanding totals. */
  totalProvided: number | null;
  /** Current outstanding cargo. */
  totalRemaining: number;
}

export interface RavenProject extends RavenCargoTotals {
  buildId: string;
  /** Construction Depot MarketID, used to match an exact journal snapshot. */
  marketId: string | null;
  buildName: string;
  buildType: string | null;
  complete: boolean;
  progress: number;
  bodyName: string | null;
  resources: RavenResource[];
}

export interface RavenSystemV2 extends RavenCargoTotals {
  systemName: string;
  siteName: string | null;
  architectName: string | null;
  progress: number | null;
  projects: RavenProject[];
  resources: RavenResource[];
  error?: string;
}

type UnknownRecord = Record<string, unknown>;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function nonNegativeNumber(value: unknown): number | null {
  const number = finiteNumber(value);
  return number == null ? null : Math.max(0, number);
}

function firstNumber(record: UnknownRecord | null | undefined, keys: string[]): number | null {
  if (!record) return null;
  for (const key of keys) {
    const value = nonNegativeNumber(record[key]);
    if (value != null) return value;
  }
  return null;
}

function firstPositiveNumber(record: UnknownRecord | null | undefined, keys: string[]): number | null {
  if (!record) return null;
  for (const key of keys) {
    const value = nonNegativeNumber(record[key]);
    if (value != null && value > 0) return value;
  }
  return null;
}

function isRavenProjectComplete(record: UnknownRecord | null | undefined): boolean {
  if (!record) return false;
  if (record.complete === true || record.ConstructionComplete === true) return true;
  const status = typeof record.status === 'string' ? record.status.toLowerCase() : '';
  return status === 'done' || status === 'complete' || status === 'completed';
}

function normaliseCommodityKey(value: unknown, fallback: string): string {
  const raw = String(value ?? '').trim();
  const cleaned = raw
    .replace(/^\$+/, '')
    .replace(/_name;?$/i, '')
    .replace(/[\s_-]+/g, '')
    .toLowerCase();
  return cleaned || fallback;
}

function commodityDisplayName(key: string): string {
  const withoutGameToken = key.replace(/^\$+/, '').replace(/_name;?$/i, '');
  const spaced = withoutGameToken
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim();
  return spaced ? spaced.replace(/^./, (letter) => letter.toUpperCase()) : 'Unknown commodity';
}

function valuesFromCandidate(candidate: unknown): unknown[] {
  if (Array.isArray(candidate)) return candidate;
  const record = asRecord(candidate);
  return record ? Object.values(record) : [];
}

/**
 * Raven's usual project response has no per-commodity delivery history.  A
 * few compatible integrations do include a ColonisationConstructionDepot
 * payload, though, so preserve its exact RequiredAmount/ProvidedAmount data
 * when it is available.
 */
function extractExactResources(details: UnknownRecord | null): RavenResource[] {
  if (!details) return [];

  const depot = asRecord(details.colonisationConstructionDepot)
    ?? asRecord(details.ColonisationConstructionDepot);
  const candidates = [
    details.resourcesRequired,
    details.ResourcesRequired,
    details.resources,
    details.Resources,
    depot?.resourcesRequired,
    depot?.ResourcesRequired,
  ];

  const resources = new Map<string, RavenResource>();

  for (const candidate of candidates) {
    for (const value of valuesFromCandidate(candidate)) {
      const row = asRecord(value);
      if (!row) continue;

      const required = firstNumber(row, ['requiredAmount', 'RequiredAmount', 'required']);
      const provided = firstNumber(row, ['providedAmount', 'ProvidedAmount', 'provided']);
      if (required == null || provided == null) continue;

      const rawKey = row.key
        ?? row.commodity
        ?? row.commodityName
        ?? row.Commodity
        ?? row.Name
        ?? row.name;
      const key = normaliseCommodityKey(rawKey, `resource-${resources.size + 1}`);
      const rawName = row.nameLocalised
        ?? row.Name_Localised
        ?? row.name
        ?? row.Name
        ?? rawKey;
      const name = String(rawName ?? '').trim() || commodityDisplayName(key);
      const safeRequired = Math.max(0, required);
      const safeProvided = Math.min(safeRequired, Math.max(0, provided));

      // The first complete resource list is the closest representation of the
      // source response. Do not overwrite it with a less specific fallback.
      if (!resources.has(key)) {
        resources.set(key, {
          name,
          key,
          required: safeRequired,
          provided: safeProvided,
          remaining: Math.max(0, safeRequired - safeProvided),
          exact: true,
        });
      }
    }

    if (resources.size > 0) break;
  }

  return Array.from(resources.values());
}

/**
 * Convert a Raven project to resource rows.
 *
 * `commanders` is intentionally not inspected: in Raven it is a mapping of a
 * commander to assigned commodity names, not a ledger of delivered amounts.
 */
export function parseRavenProjectResources(details: unknown): RavenResource[] {
  const record = asRecord(details);
  const resources = new Map<string, RavenResource>();

  for (const resource of extractExactResources(record)) {
    resources.set(resource.key, resource);
  }

  const commodities = asRecord(record?.commodities);
  for (const [rawKey, rawRemaining] of Object.entries(commodities ?? {})) {
    const key = normaliseCommodityKey(rawKey, rawKey);
    if (resources.has(key)) continue;

    const remaining = nonNegativeNumber(rawRemaining);
    if (remaining == null) continue;

    // `commodities` is Raven's outstanding shopping list. Its value is not
    // the initial requirement, and a zero does not mean "0 / 0".
    resources.set(key, {
      name: commodityDisplayName(rawKey),
      key,
      required: null,
      provided: null,
      remaining,
      exact: false,
    });
  }

  return Array.from(resources.values()).sort((a, b) => b.remaining - a.remaining);
}

/** Derive reliable project-wide totals from Raven's maxNeed/sumNeed fields. */
export function calculateRavenProjectTotals(
  details: unknown,
  resources: RavenResource[] = [],
): RavenCargoTotals {
  const record = asRecord(details);
  const complete = isRavenProjectComplete(record);
  const exactResources = resources.length > 0 && resources.every((resource) => resource.exact);
  const resourcesRemaining = resources.reduce((sum, resource) => sum + resource.remaining, 0);
  const exactRequired = exactResources
    ? resources.reduce((sum, resource) => sum + (resource.required ?? 0), 0)
    : null;
  const exactProvided = exactResources
    ? resources.reduce((sum, resource) => sum + (resource.provided ?? 0), 0)
    : null;

  // Raven has used both names over time. `maxNeed` is the original total;
  // `sumNeed` is the amount still required right now.
  const reportedRequired = firstPositiveNumber(record, [
    'sumTotal',
    'maxNeed',
    'maxRequired',
  ]);
  const reportedRemaining = firstNumber(record, ['sumNeed', 'remainingNeed']);

  let totalRemaining = exactResources
    ? resourcesRemaining
    : (reportedRemaining ?? resourcesRemaining);
  let totalRequired = reportedRequired ?? exactRequired;

  if (totalRequired != null) {
    // A stale/malformed response should never result in a negative delivered
    // amount or a bar wider than 100%.
    totalRequired = Math.max(totalRequired, totalRemaining);
  }

  let totalProvided: number | null = totalRequired == null
    ? exactProvided
    : Math.max(0, totalRequired - totalRemaining);

  if (complete) {
    totalRemaining = 0;
    if (totalRequired != null) totalProvided = totalRequired;
  }

  return { totalRequired, totalProvided, totalRemaining };
}

function roundPercent(value: number): number {
  return Math.round(Math.min(100, Math.max(0, value)) * 100) / 100;
}

/** Compute cargo completion; explicit legacy progress is only a last fallback. */
export function calculateRavenProjectProgress(
  details: unknown,
  totals: RavenCargoTotals,
): number {
  const record = asRecord(details);
  if (isRavenProjectComplete(record)) return 100;

  if (totals.totalRequired != null && totals.totalRequired > 0 && totals.totalProvided != null) {
    return roundPercent((totals.totalProvided / totals.totalRequired) * 100);
  }

  const explicit = firstNumber(record, ['constructionProgress', 'ConstructionProgress', 'progress']);
  if (explicit != null) {
    // Journal ConstructionProgress is a fraction, while a few legacy Raven
    // responses use an already-normalised percent.
    return roundPercent(explicit <= 1 ? explicit * 100 : explicit);
  }

  return 0;
}

function mergeSystemResource(
  allResources: Map<string, RavenResource>,
  resource: RavenResource,
) {
  const existing = allResources.get(resource.key);
  if (!existing) {
    allResources.set(resource.key, { ...resource });
    return;
  }

  const exact = existing.exact
    && resource.exact
    && existing.required != null
    && existing.provided != null
    && resource.required != null
    && resource.provided != null;

  allResources.set(resource.key, {
    name: existing.name,
    key: resource.key,
    required: exact ? existing.required! + resource.required! : null,
    provided: exact ? existing.provided! + resource.provided! : null,
    remaining: existing.remaining + resource.remaining,
    exact,
  });
}

function aggregateProjectTotals(projects: RavenProject[]): RavenCargoTotals {
  if (projects.length === 0) {
    return { totalRequired: null, totalProvided: null, totalRemaining: 0 };
  }

  const allKnown = projects.every(
    (project) => project.totalRequired != null && project.totalProvided != null,
  );
  const totalRemaining = projects.reduce((sum, project) => sum + project.totalRemaining, 0);

  if (!allKnown) {
    return { totalRequired: null, totalProvided: null, totalRemaining };
  }

  return {
    totalRequired: projects.reduce((sum, project) => sum + (project.totalRequired ?? 0), 0),
    totalProvided: projects.reduce((sum, project) => sum + (project.totalProvided ?? 0), 0),
    totalRemaining,
  };
}

/** A public, non-personal snapshot of a Construction Depot journal event. */
export interface RavenDepotSnapshot {
  marketId: string | number;
  resources: unknown;
}

function enrichProjectWithDepotSnapshot(
  project: RavenProject,
  snapshot: RavenDepotSnapshot,
): RavenProject {
  // A depot snapshot tells us each original commodity requirement. Raven tells
  // us the live outstanding amount. Combining those two facts yields current,
  // per-commodity delivery amounts without estimating a proportional split.
  const depotResources = extractExactResources({ resourcesRequired: snapshot.resources });
  if (depotResources.length === 0) return project;

  // If Raven gave no commodity rows for an unfinished project, its fallback
  // site metadata does not prove that every depot item is fulfilled. Do not
  // turn a journal snapshot into a fabricated current delivery state.
  if (project.resources.length === 0 && !project.complete) {
    return project;
  }

  const currentByKey = new Map(project.resources.map((resource) => [resource.key, resource]));
  const depotKeys = new Set(depotResources.map((resource) => resource.key));
  const exactResources: RavenResource[] = [];

  for (const depotResource of depotResources) {
    const required = depotResource.required ?? 0;
    const current = currentByKey.get(depotResource.key);
    // A current Raven commodities object contains only outstanding cargo. A
    // missing depot commodity is therefore fulfilled, except when the project
    // itself is explicitly complete (which also means zero outstanding cargo).
    const remaining = project.complete ? 0 : (current?.remaining ?? 0);

    // Do not turn mismatched or stale data into a negative delivery number.
    // Keeping Raven's remaining-only row is more honest in that case.
    if (remaining > required) return project;

    exactResources.push({
      name: depotResource.name,
      key: depotResource.key,
      required,
      provided: required - remaining,
      remaining,
      exact: true,
    });
  }

  // A depot journal may predate a newly-added requirement. Keep such Raven
  // rows as remaining-only rather than claiming that the aggregate is exact.
  for (const resource of project.resources) {
    if (!depotKeys.has(resource.key)) exactResources.push(resource);
  }

  const resources = exactResources.sort((a, b) => b.remaining - a.remaining);
  const allExact = resources.length > 0 && resources.every((resource) => resource.exact);
  if (!allExact) return { ...project, resources };

  const totalRequired = resources.reduce((sum, resource) => sum + (resource.required ?? 0), 0);
  const totalProvided = resources.reduce((sum, resource) => sum + (resource.provided ?? 0), 0);
  const totalRemaining = resources.reduce((sum, resource) => sum + resource.remaining, 0);

  // Both sources should describe the same depot. If their total cargo figures
  // disagree, keep Raven's remaining-only representation instead of mixing
  // two potentially different construction phases.
  if (
    Math.abs(project.totalRemaining - totalRemaining) > 0.001
    || (project.totalRequired != null && Math.abs(project.totalRequired - totalRequired) > 0.001)
  ) {
    return project;
  }

  return {
    ...project,
    resources,
    totalRequired,
    totalProvided,
    totalRemaining,
    progress: totalRequired > 0
      ? roundPercent((totalProvided / totalRequired) * 100)
      : project.progress,
  };
}

/**
 * Add exact per-commodity values from journal Construction Depot snapshots.
 *
 * This function is intentionally pure: callers choose whether they are
 * allowed to read journal data and pass only market IDs plus resource totals.
 */
export function enrichRavenSystemWithDepotSnapshots(
  system: RavenSystemV2,
  snapshots: RavenDepotSnapshot[],
): RavenSystemV2 {
  if (snapshots.length === 0 || system.projects.length === 0) return system;

  const snapshotByMarketId = new Map<string, RavenDepotSnapshot>();
  for (const snapshot of snapshots) {
    const marketId = String(snapshot.marketId ?? '').trim();
    if (marketId && marketId !== '0' && !snapshotByMarketId.has(marketId)) {
      snapshotByMarketId.set(marketId, snapshot);
    }
  }

  let changed = false;
  const projects = system.projects.map((project) => {
    const snapshot = project.marketId ? snapshotByMarketId.get(project.marketId) : undefined;
    if (!snapshot) return project;
    const enriched = enrichProjectWithDepotSnapshot(project, snapshot);
    changed ||= enriched !== project;
    return enriched;
  });

  if (!changed) return system;

  const allResources = new Map<string, RavenResource>();
  for (const project of projects) {
    for (const resource of project.resources) mergeSystemResource(allResources, resource);
  }
  const totals = aggregateProjectTotals(projects);
  const progress = totals.totalRequired != null
    && totals.totalRequired > 0
    && totals.totalProvided != null
    ? roundPercent((totals.totalProvided / totals.totalRequired) * 100)
    : system.progress;

  return {
    ...system,
    projects,
    resources: Array.from(allResources.values()).sort((a, b) => b.remaining - a.remaining),
    progress,
    ...totals,
  };
}

/** Получить список активных проектов в системе по её ID64 */
async function fetchSystemProjects(id64: number | string): Promise<unknown[]> {
  const url = `${ravenBase()}/api/system/${id64}`;
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'ed-ring-colony/1.0' },
      cache: 'no-store',
    });
    if (!res.ok) return [];
    const data: unknown = await res.json();
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/** Получить детали проекта по buildId */
async function fetchProjectDetails(buildId: string): Promise<UnknownRecord | null> {
  const url = `${ravenBase()}/api/project/${encodeURIComponent(buildId)}`;
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'ed-ring-colony/1.0' },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return asRecord(await res.json());
  } catch {
    return null;
  }
}

function emptySystemResult(name: string, error?: string): RavenSystemV2 {
  return {
    systemName: name,
    siteName: null,
    architectName: null,
    progress: null,
    projects: [],
    resources: [],
    totalRequired: null,
    totalProvided: null,
    totalRemaining: 0,
    ...(error ? { error } : {}),
  };
}

export async function fetchRavenSystemV2(name: string): Promise<RavenSystemV2> {
  const base = ravenBase();
  const MAX_RETRIES = 2;

  // Шаг 1: Получаем базовые данные системы через v2
  let systemData: UnknownRecord | null = null;
  let v2Url = base + '/api/v2/system/' + encodeURIComponent(name);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(v2Url, {
        headers: { Accept: 'application/json', 'User-Agent': 'ed-ring-colony/1.0' },
        cache: 'no-store',
      });

      if (res.status === 404) {
        return emptySystemResult(name, 'Система не найдена в RavenColonial');
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        if (attempt < MAX_RETRIES && (res.status >= 500 || res.status === 429)) {
          await sleep(500 * (attempt + 1));
          continue;
        }
        // Для 400 с пробелами — пробуем заменить на +
        if (res.status === 400 && name.includes(' ')) {
          v2Url = base + '/api/v2/system/' + name.replace(/ /g, '+');
          continue;
        }
        return emptySystemResult(name, `HTTP ${res.status}: ${text.slice(0, 200)}`);
      }

      systemData = asRecord(await res.json());
      if (!systemData) return emptySystemResult(name, 'Некорректный ответ RavenColonial');
      break;
    } catch (error: unknown) {
      if (attempt < MAX_RETRIES) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      return emptySystemResult(
        name,
        error instanceof Error ? error.message : 'Network error',
      );
    }
  }

  if (!systemData) {
    return emptySystemResult(name, 'Max retries exceeded');
  }

  const id64 = systemData.id64;
  const architect = typeof systemData.architect === 'string' ? systemData.architect : null;
  const sites = Array.isArray(systemData.sites) ? systemData.sites : [];

  // Шаг 2: Получаем активные проекты через systemAddress
  let activeProjects: unknown[] = [];
  if (typeof id64 === 'number' || typeof id64 === 'string') {
    activeProjects = await fetchSystemProjects(id64);
  }

  // Шаг 3: Получаем детали каждого проекта
  const projectDetails: RavenProject[] = [];
  const allResources = new Map<string, RavenResource>();

  for (const rawProject of activeProjects) {
    const project = asRecord(rawProject);
    const rawBuildId = project?.buildId ?? project?.id;
    if (typeof rawBuildId !== 'string' && typeof rawBuildId !== 'number') continue;
    const buildId = String(rawBuildId);

    const details = await fetchProjectDetails(buildId);
    if (!details) continue;

    const resources = parseRavenProjectResources(details);
    const totals = calculateRavenProjectTotals(details, resources);
    const progress = calculateRavenProjectProgress(details, totals);
    const isComplete = isRavenProjectComplete(details) || progress >= 100;

    for (const resource of resources) mergeSystemResource(allResources, resource);

    const rawMarketId = details.marketId
      ?? details.MarketID
      ?? project?.marketId
      ?? project?.MarketID;

    projectDetails.push({
      buildId,
      marketId: typeof rawMarketId === 'string' || typeof rawMarketId === 'number'
        ? String(rawMarketId)
        : null,
      buildName: typeof details.buildName === 'string'
        ? details.buildName
        : typeof details.name === 'string'
          ? details.name
          : 'Unknown',
      buildType: typeof details.buildType === 'string'
        ? details.buildType
        : typeof details.type === 'string'
          ? details.type
          : null,
      complete: isComplete,
      progress,
      bodyName: typeof details.bodyName === 'string' ? details.bodyName : null,
      resources,
      ...totals,
    });
  }

  // Если активных проектов нет, но есть sites — используем sites как fallback
  if (projectDetails.length === 0 && sites.length > 0) {
    for (const rawSite of sites) {
      const site = asRecord(rawSite);
      if (!site) continue;
      const status = typeof site.status === 'string' ? site.status : 'planned';
      const isComplete = status === 'complete' || status === 'done';
      const bodyNum = finiteNumber(site.bodyNum);
      projectDetails.push({
        buildId: typeof site.id === 'string' || typeof site.id === 'number'
          ? String(site.id)
          : String(bodyNum ?? projectDetails.length + 1),
        marketId: typeof site.marketId === 'string' || typeof site.marketId === 'number'
          ? String(site.marketId)
          : typeof site.MarketID === 'string' || typeof site.MarketID === 'number'
            ? String(site.MarketID)
            : null,
        buildName: typeof site.name === 'string'
          ? site.name
          : `Site ${bodyNum ?? projectDetails.length + 1}`,
        buildType: typeof site.buildType === 'string' ? site.buildType : null,
        complete: isComplete,
        progress: isComplete ? 100 : 0,
        bodyName: bodyNum != null && bodyNum > 0 ? `${name} ${bodyNum}` : null,
        resources: [],
        totalRequired: null,
        totalProvided: null,
        totalRemaining: 0,
      });
    }
  }

  const totals = aggregateProjectTotals(projectDetails);

  // Calculate a weighted system completion from cargo totals. Averaging project
  // percentages would make a tiny construction site count as much as a large
  // starport. Retain the legacy average only if no reliable totals exist.
  let systemProgress: number | null = null;
  if (totals.totalRequired != null && totals.totalRequired > 0 && totals.totalProvided != null) {
    systemProgress = roundPercent((totals.totalProvided / totals.totalRequired) * 100);
  } else if (projectDetails.length > 0) {
    const total = projectDetails.reduce((sum, project) => sum + project.progress, 0);
    systemProgress = roundPercent(total / projectDetails.length);
  } else if (
    sites.length > 0
    && sites.every((rawSite) => {
      const site = asRecord(rawSite);
      return site?.status === 'complete' || site?.status === 'done';
    })
  ) {
    systemProgress = 100;
  }

  return {
    systemName: typeof systemData.name === 'string' ? systemData.name : name,
    siteName: projectDetails[0]?.buildName ?? (typeof systemData.name === 'string' ? systemData.name : null),
    architectName: architect,
    progress: systemProgress,
    projects: projectDetails,
    resources: Array.from(allResources.values()).sort((a, b) => b.remaining - a.remaining),
    ...totals,
  };
}

export function deriveStatusFromProgress(progress: number | null): 'planned' | 'building' | 'done' {
  if (progress == null) return 'planned';
  if (progress >= 100) return 'done';
  if (progress > 0) return 'building';
  return 'planned';
}

export type RavenSystemEnricher = (system: RavenSystemV2) => Promise<RavenSystemV2>;

export async function fetchRavenSystemProgress(
  name: string,
  enrich?: RavenSystemEnricher,
) {
  const liveData = await fetchRavenSystemV2(name);
  const data = enrich ? await enrich(liveData) : liveData;
  const status = deriveStatusFromProgress(data.progress);
  return {
    system_name: data.systemName,
    progress: data.progress,
    status,
    updated_at: new Date().toISOString(),
    data: {
      siteName: data.siteName,
      architectName: data.architectName,
      projects: data.projects,
      resources: data.resources,
      totalRequired: data.totalRequired,
      totalProvided: data.totalProvided,
      totalRemaining: data.totalRemaining,
    },
    found: data.progress != null || data.projects.length > 0,
    error: data.error,
  };
}

// Устаревший v1 метод — оставляем для совместимости
export async function fetchRavenSystem(name: string) {
  const base = ravenBase();
  const enc = encodeURIComponent(name);
  const [active, done] = await Promise.all([
    fetch(base + '/api/system/' + enc, { headers: { Accept: 'application/json' } }).then((response) => response.json().catch(() => null)),
    fetch(base + '/api/system/' + enc + '/complete', { headers: { Accept: 'application/json' } }).then((response) => response.json().catch(() => null)),
  ]);
  const list = [...(Array.isArray(active) ? active : []), ...(Array.isArray(done) ? done : [])];
  return list;
}

// Получение данных об архитекторе для профиля пилота
export async function fetchRavenColonialData(cmdrName: string): Promise<{ architectCount: number; architectSystems: string[] }> {
  try {
    const base = ravenBase();
    // Используем тот же endpoint, что и в API route: /cmdr/{name}/refs
    const res = await fetch(`${base}/api/cmdr/${encodeURIComponent(cmdrName)}/refs`, {
      headers: { Accept: 'application/json', 'User-Agent': 'ed-ring-colony/1.0' },
      next: { revalidate: 300 },
    });
    if (!res.ok) return { architectCount: 0, architectSystems: [] };
    const data: unknown = await res.json().catch(() => null);
    const projects = Array.isArray(data) ? data : [];
    // Фильтруем проекты, где этот CMDR — архитектор
    const architectProjects = projects.filter((project) => {
      const row = asRecord(project);
      return typeof row?.architectName === 'string'
        && row.architectName.toLowerCase() === cmdrName.toLowerCase();
    });
    // Считаем уникальные системы
    const uniqueSystems = new Set(
      architectProjects
        .map((project) => asRecord(project)?.systemName)
        .filter((systemName): systemName is string => typeof systemName === 'string' && Boolean(systemName)),
    );
    return {
      architectCount: uniqueSystems.size,
      architectSystems: Array.from(uniqueSystems),
    };
  } catch {
    return { architectCount: 0, architectSystems: [] };
  }
}
