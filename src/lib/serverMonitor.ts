import type {
  MonitorAgent,
  MonitorContainer,
  MonitorContainerMetrics,
  MonitorDatabase,
  MonitorDocker,
  MonitorJob,
  MonitorLevel,
  MonitorProject,
  MonitorScheduler,
  ServerMonitorSnapshot,
} from '@/types/monitor';

const DATABASE_TIMEOUT_MS = 4_000;
const AGENT_TIMEOUT_MS = 3_000;
const GITHUB_CACHE_MS = 5 * 60_000;
const DEFAULT_REPOSITORY = 'NooboGreenD/ed-ring-colony';
const DEFAULT_BRANCH = 'main';

interface CachedUpstream {
  expiresAt: number;
  checkedAt: string;
  sha: string | null;
}

let upstreamCache: CachedUpstream | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validIso(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function positiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function safeSha(value: string | undefined): string | null {
  const sha = value?.trim();
  return sha && /^[a-f0-9]{7,64}$/i.test(sha) ? sha.toLowerCase() : null;
}

function safeIdentifier(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed && /^[A-Za-z0-9._/-]{1,120}$/.test(trimmed) ? trimmed : fallback;
}

function safeRepository(value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed) ? trimmed : DEFAULT_REPOSITORY;
}

function configuredMonitorAgent(): { configured: boolean; url: URL | null; token: string | null } {
  const token = process.env.MONITOR_AGENT_TOKEN?.trim() || null;
  const rawUrl = process.env.MONITOR_AGENT_URL?.trim();
  if (!token || !rawUrl) return { configured: false, url: null, token: null };

  try {
    const url = new URL(rawUrl);
    // The agent is an internal Compose service. Do not forward the private
    // token to an arbitrary URL or a path supplied by a loose environment var.
    if (url.protocol !== 'http:' || url.hostname !== 'monitor-agent' || url.username || url.password || (url.pathname !== '/' && url.pathname !== '')) {
      return { configured: false, url: null, token: null };
    }
    return { configured: true, url, token };
  } catch {
    return { configured: false, url: null, token: null };
  }
}

async function probeDatabase(): Promise<MonitorDatabase> {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!base || !serviceKey) return { status: 'unknown', configured: false, latencyMs: null };

  try {
    const origin = new URL(base);
    if (!['http:', 'https:'].includes(origin.protocol)) throw new Error('Invalid URL');
    const probe = new URL('/rest/v1/profiles', origin);
    probe.searchParams.set('select', 'id');
    probe.searchParams.set('limit', '1');

    const started = Date.now();
    const response = await fetch(probe, {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        Accept: 'application/json',
      },
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(DATABASE_TIMEOUT_MS),
    });
    // We intentionally do not read a row: the probe must never handle PII.
    void response.body?.cancel().catch(() => undefined);
    return {
      status: response.ok ? 'healthy' : 'critical',
      configured: true,
      latencyMs: Date.now() - started,
    };
  } catch {
    // Do not expose network/SQL/auth errors from an operations endpoint.
    return { status: 'critical', configured: true, latencyMs: null };
  }
}

function sanitizeMetrics(value: unknown): MonitorContainerMetrics | null {
  if (!isRecord(value)) return null;
  return {
    memoryBytes: positiveNumber(value.memoryBytes),
    memoryLimitBytes: positiveNumber(value.memoryLimitBytes),
    cpuPercent: positiveNumber(value.cpuPercent),
  };
}

function sanitizeContainer(value: unknown): MonitorContainer | null {
  if (!isRecord(value)) return null;
  const service = typeof value.service === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(value.service)
    ? value.service
    : null;
  if (!service) return null;
  const state = typeof value.state === 'string' && /^[a-z_ -]{1,32}$/i.test(value.state) ? value.state : 'unknown';
  const health = value.health === 'healthy' || value.health === 'unhealthy' || value.health === 'starting'
    ? value.health
    : 'not_configured';
  return {
    service,
    state,
    health,
    startedAt: validIso(value.startedAt),
    finishedAt: validIso(value.finishedAt),
    exitCode: positiveNumber(value.exitCode),
    restartCount: positiveNumber(value.restartCount) ?? 0,
    metrics: sanitizeMetrics(value.metrics),
  };
}

function sanitizeJob(value: unknown): MonitorJob | null {
  if (!isRecord(value) || typeof value.name !== 'string' || !/^[a-z0-9-]{1,64}$/i.test(value.name)) return null;
  const status = value.status === 'healthy' || value.status === 'warning' ? value.status : 'unknown';
  return {
    name: value.name,
    status,
    lastSuccessAt: validIso(value.lastSuccessAt),
    nextRunAt: validIso(value.nextRunAt),
    ageSeconds: positiveNumber(value.ageSeconds),
    everySeconds: positiveNumber(value.everySeconds),
  };
}

function emptyDocker(configured: boolean): MonitorDocker {
  return { configured, available: false, containers: [] };
}

function emptyScheduler(): MonitorScheduler {
  return { available: false, state: 'unavailable', jobs: [] };
}

async function probeMonitorAgent(): Promise<{ agent: MonitorAgent; docker: MonitorDocker; scheduler: MonitorScheduler }> {
  const config = configuredMonitorAgent();
  if (!config.configured || !config.url || !config.token) {
    return { agent: { configured: false, connected: false }, docker: emptyDocker(false), scheduler: emptyScheduler() };
  }

  try {
    const target = new URL('/status', config.url);
    const response = await fetch(target, {
      headers: { Authorization: `Bearer ${config.token}`, Accept: 'application/json' },
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(AGENT_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error('Agent unavailable');
    const payload: unknown = await response.json();
    if (!isRecord(payload) || payload.ok !== true) throw new Error('Invalid agent response');

    const rawDocker = isRecord(payload.docker) ? payload.docker : {};
    const rawScheduler = isRecord(payload.scheduler) ? payload.scheduler : {};
    const containers = Array.isArray(rawDocker.containers)
      ? rawDocker.containers.map(sanitizeContainer).filter((item): item is MonitorContainer => item !== null)
      : [];
    const jobs = Array.isArray(rawScheduler.jobs)
      ? rawScheduler.jobs.map(sanitizeJob).filter((item): item is MonitorJob => item !== null)
      : [];
    const schedulerState = rawScheduler.state;
    const state: MonitorScheduler['state'] = schedulerState === 'ready' || schedulerState === 'waiting_for_state'
      || schedulerState === 'not_configured' || schedulerState === 'invalid' || schedulerState === 'unavailable'
      ? schedulerState
      : 'unavailable';

    return {
      agent: { configured: true, connected: true },
      docker: {
        configured: rawDocker.configured === true,
        available: rawDocker.available === true,
        containers,
      },
      scheduler: {
        available: rawScheduler.available === true,
        state,
        jobs,
      },
    };
  } catch {
    // An agent failure must not hide the app/database/project checks.
    return { agent: { configured: true, connected: false }, docker: emptyDocker(true), scheduler: emptyScheduler() };
  }
}

async function upstreamHead(repository: string, branch: string): Promise<{ sha: string | null; checkedAt: string }> {
  const now = Date.now();
  if (upstreamCache && upstreamCache.expiresAt > now) {
    return { sha: upstreamCache.sha, checkedAt: upstreamCache.checkedAt };
  }

  const checkedAt = new Date(now).toISOString();
  let sha: string | null = null;
  try {
    const [owner = '', repo = ''] = repository.split('/');
    const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(branch)}`;
    const response = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'ed-ring-colony-operations-dashboard',
      },
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(AGENT_TIMEOUT_MS),
    });
    if (response.ok) {
      const body: unknown = await response.json();
      sha = isRecord(body) && typeof body.sha === 'string' ? safeSha(body.sha) : null;
    }
  } catch {
    // An optional remote update check must never change app health.
  }
  upstreamCache = { expiresAt: now + GITHUB_CACHE_MS, checkedAt, sha };
  return { sha, checkedAt };
}

async function projectStatus(): Promise<MonitorProject> {
  const currentSha = safeSha(process.env.APP_GIT_SHA);
  const currentRef = safeIdentifier(process.env.APP_GIT_REF, 'unknown');
  const builtAt = validIso(process.env.APP_BUILD_TIME);
  const repository = safeRepository(process.env.PROJECT_REPOSITORY);
  const branch = safeIdentifier(process.env.PROJECT_UPDATE_BRANCH, DEFAULT_BRANCH);
  const upstream = await upstreamHead(repository, branch);
  const sameRevision = !!currentSha && !!upstream.sha && upstream.sha.startsWith(currentSha);

  return {
    currentSha,
    currentRef: currentRef === 'unknown' ? null : currentRef,
    builtAt,
    upstreamBranch: branch,
    upstreamSha: upstream.sha,
    upstreamCheckedAt: upstream.checkedAt,
    updateStatus: !currentSha || !upstream.sha ? 'unknown' : sameRevision ? 'current' : 'different',
  };
}

function overallLevel(database: MonitorDatabase, agent: MonitorAgent, docker: MonitorDocker, scheduler: MonitorScheduler): MonitorLevel {
  if (database.status === 'critical') return 'critical';
  if (agent.connected && !docker.available) return 'critical';
  if (agent.connected && docker.available && docker.containers.some((container) =>
    container.state === 'missing' || container.state === 'stopped' || container.health === 'unhealthy')) return 'critical';
  if (database.status !== 'healthy') return 'warning';
  if (!agent.configured || !agent.connected || !docker.available || !scheduler.available) return 'warning';
  if (docker.containers.some((container) => container.health === 'starting' || container.restartCount > 3)) return 'warning';
  if (scheduler.jobs.some((job) => job.status !== 'healthy')) return 'warning';
  return 'healthy';
}

/** Collect a credential-free operational snapshot for an already-authorised admin. */
export async function getServerMonitorSnapshot(): Promise<ServerMonitorSnapshot> {
  const now = Date.now();
  const startedAt = new Date(now - process.uptime() * 1000).toISOString();
  const memory = process.memoryUsage();
  const [database, agentResult, project] = await Promise.all([probeDatabase(), probeMonitorAgent(), projectStatus()]);
  const application = {
    status: 'healthy' as const,
    uptimeSeconds: Math.floor(process.uptime()),
    startedAt,
    nodeVersion: process.version,
    memory: { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed },
  };

  return {
    checkedAt: new Date(now).toISOString(),
    overall: overallLevel(database, agentResult.agent, agentResult.docker, agentResult.scheduler),
    application,
    database,
    agent: agentResult.agent,
    docker: agentResult.docker,
    scheduler: agentResult.scheduler,
    project,
  };
}
