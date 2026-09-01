const DEFAULT_BASE =
  'https://ravencolonial100-awcbdvabgze4c5cq.canadacentral-01.azurewebsites.net';

export function ravenBase(): string {
  const raw = (process.env.RAVEN_API_BASE || DEFAULT_BASE).replace(/\/+$/, '');
  return raw.replace(/\/api$/i, '');
}

export interface RavenSystemV2 {
  systemName: string;
  siteName: string | null;
  architectName: string | null;
  progress: number | null;
  projects: {
    buildId: string;
    buildName: string;
    buildType: string | null;
    complete: boolean;
    progress: number;
    bodyName: string | null;
    resources: {
      name: string;
      key: string;
      required: number;
      provided: number;
      remaining: number;
    }[];
  }[];
  resources: {
    name: string;
    key: string;
    required: number;
    provided: number;
    remaining: number;
  }[];
  error?: string;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Получить список активных проектов в системе по её ID64 */
async function fetchSystemProjects(id64: number | string): Promise<any[]> {
  const url = `${ravenBase()}/api/system/${id64}`;
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'ed-ring-colony/1.0' },
      cache: 'no-store',
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/** Получить детали проекта по buildId */
async function fetchProjectDetails(buildId: string): Promise<any | null> {
  const url = `${ravenBase()}/api/project/${encodeURIComponent(buildId)}`;
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'ed-ring-colony/1.0' },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function fetchRavenSystemV2(name: string): Promise<RavenSystemV2> {
  const base = ravenBase();
  const MAX_RETRIES = 2;

  // Шаг 1: Получаем базовые данные системы через v2
  let systemData: any = null;
  let v2Url = base + '/api/v2/system/' + encodeURIComponent(name);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(v2Url, {
        headers: { Accept: 'application/json', 'User-Agent': 'ed-ring-colony/1.0' },
        cache: 'no-store',
      });

      if (res.status === 404) {
        return { systemName: name, progress: null, error: 'Система не найдена в RavenColonial', projects: [], resources: [], siteName: null, architectName: null };
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
        return { systemName: name, progress: null, error: `HTTP ${res.status}: ${text.slice(0, 200)}`, projects: [], resources: [], siteName: null, architectName: null };
      }

      systemData = await res.json();
      break;
    } catch (e: any) {
      if (attempt < MAX_RETRIES) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      return { systemName: name, progress: null, error: e.message || 'Network error', projects: [], resources: [], siteName: null, architectName: null };
    }
  }

  if (!systemData) {
    return { systemName: name, progress: null, error: 'Max retries exceeded', projects: [], resources: [], siteName: null, architectName: null };
  }

  const id64 = systemData.id64;
  const architect = systemData.architect || null;
  const sites = Array.isArray(systemData.sites) ? systemData.sites : [];

  // Шаг 2: Получаем активные проекты через systemAddress
  let activeProjects: any[] = [];
  if (id64) {
    activeProjects = await fetchSystemProjects(id64);
  }

  // Шаг 3: Получаем детали каждого проекта
  const projectDetails: any[] = [];
  const allResources = new Map<string, { name: string; key: string; required: number; provided: number; remaining: number }>();

  for (const proj of activeProjects) {
    const buildId = proj.buildId || proj.id;
    if (!buildId) continue;

    const details = await fetchProjectDetails(buildId);
    if (!details) continue;

    const resources = Array.isArray(details.resources) ? details.resources.map((r: any) => ({
      name: r.name || r.commodity,
      key: r.key || r.name || r.commodity,
      required: r.required ?? r.needed ?? 0,
      provided: r.provided ?? r.delivered ?? 0,
      remaining: r.remaining ?? Math.max(0, (r.required ?? r.needed ?? 0) - (r.provided ?? r.delivered ?? 0)),
    })) : [];

    // Агрегируем ресурсы по системе
    for (const r of resources) {
      const existing = allResources.get(r.key);
      if (existing) {
        existing.required += r.required;
        existing.provided += r.provided;
        existing.remaining = Math.max(0, existing.required - existing.provided);
      } else {
        allResources.set(r.key, { ...r });
      }
    }

    projectDetails.push({
      buildId,
      buildName: details.buildName || details.name || 'Unknown',
      buildType: details.buildType || details.type || null,
      complete: !!(details.complete || details.status === 'done' || details.isComplete),
      progress: details.progress ?? (details.complete ? 100 : 0),
      bodyName: details.bodyName ?? null,
      resources,
    });
  }

  // Если активных проектов нет, но есть sites — используем sites как fallback
  if (projectDetails.length === 0 && sites.length > 0) {
    for (const site of sites) {
      const status = site.status || 'planned';
      const isComplete = status === 'complete' || status === 'done';
      projectDetails.push({
        buildId: site.id || String(site.bodyNum),
        buildName: site.name || 'Site ' + site.bodyNum,
        buildType: site.buildType,
        complete: isComplete,
        progress: isComplete ? 100 : 0,
        bodyName: site.bodyNum > 0 ? `${name} ${site.bodyNum}` : null,
        resources: [],
      });
    }
  }

  // Вычисляем общий прогресс системы
  let systemProgress: number | null = null;
  if (projectDetails.length > 0) {
    const total = projectDetails.reduce((s: number, p: any) => s + (p.progress ?? 0), 0);
    systemProgress = Math.round(total / projectDetails.length);
  } else if (sites.length > 0 && sites.every((s: any) => s.status === 'complete' || s.status === 'done')) {
    systemProgress = 100;
  }

  return {
    systemName: systemData.name || name,
    siteName: systemData.name || null,
    architectName: architect,
    progress: systemProgress,
    projects: projectDetails,
    resources: Array.from(allResources.values()),
  };
}

export async function fetchRavenSystemProgress(name: string) {
  const data = await fetchRavenSystemV2(name);
  return {
    system_name: data.systemName,
    progress: data.progress,
    updated_at: new Date().toISOString(),
    data: {
      siteName: data.siteName,
      architectName: data.architectName,
      projects: data.projects,
      resources: data.resources,
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
    fetch(base + '/api/system/' + enc, { headers: { Accept: 'application/json' } }).then((r) => r.json().catch(() => null)),
    fetch(base + '/api/system/' + enc + '/complete', { headers: { Accept: 'application/json' } }).then((r) => r.json().catch(() => null)),
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
    const data = await res.json().catch(() => null);
    const projects = Array.isArray(data) ? data : [];
    // Фильтруем проекты, где этот CMDR — архитектор
    const architectProjects = projects.filter(
      (p: any) => p.architectName && p.architectName.toLowerCase() === cmdrName.toLowerCase()
    );
    // Считаем уникальные системы
    const uniqueSystems = new Set(architectProjects.map((p: any) => p.systemName));
    return {
      architectCount: uniqueSystems.size,
      architectSystems: Array.from(uniqueSystems).filter(Boolean) as string[],
    };
  } catch {
    return { architectCount: 0, architectSystems: [] };
  }
}
