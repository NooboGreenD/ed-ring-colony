#!/usr/bin/env node
/**
 * Private, read-only operations agent.
 *
 * It is the only container that receives the Docker socket. The web app talks
 * to this process over the internal Compose network with a separate token, and
 * this process exposes only a deliberately small, sanitised status document.
 * It never proxies arbitrary Docker API paths, configuration, environment
 * variables, labels, mounts, logs or container IDs.
 */
import { timingSafeEqual } from 'node:crypto';
import { readFile, statfs } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { DEFAULT_JOBS, JOBS } from './job-schedule.mjs';

const FIVE_MINUTES = 5 * 60_000;
const DEFAULT_TIMEOUT_MS = 2_500;
const SAFE_CONTAINER_ID = /^[a-f0-9]{12,64}$/i;

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function asStringList(value, fallback = []) {
  if (typeof value !== 'string') return fallback;
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function safeIso(value) {
  if (typeof value !== 'string') return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).getUTCFullYear() < 2000) return null;
  return new Date(time).toISOString();
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Parse JOBS_ENABLED with exactly the runner's missing-vs-empty semantics. */
export function enabledJobNames(value) {
  return typeof value === 'string' ? asStringList(value) : DEFAULT_JOBS;
}

function nextRunAt(job, now) {
  const slot = Math.floor((now - job.offset) / job.period);
  return new Date((slot + 1) * job.period + job.offset).toISOString();
}

/**
 * Turn the scheduler's persisted success-only state into a safe status list.
 * The runner intentionally does not persist API response bodies or failures;
 * a missing/old success is therefore a warning, not a fabricated error cause.
 */
export function schedulerSnapshot(state, configuredNames, now = Date.now()) {
  const savedJobs = state && typeof state === 'object' && !Array.isArray(state)
    && state.jobs && typeof state.jobs === 'object' && !Array.isArray(state.jobs)
    ? state.jobs
    : {};

  return configuredNames.map((name) => {
    const job = JOBS.find((item) => item.name === name);
    const saved = savedJobs[name] && typeof savedJobs[name] === 'object' ? savedJobs[name] : null;
    const lastSuccessAt = safeIso(saved?.lastSuccess);

    if (!job) {
      return {
        name,
        status: 'unknown',
        lastSuccessAt: null,
        nextRunAt: null,
        ageSeconds: null,
        everySeconds: null,
      };
    }

    const ageMs = lastSuccessAt ? Math.max(0, now - Date.parse(lastSuccessAt)) : null;
    // Allow the current calendar slot plus a little startup/network tolerance.
    const staleAfterMs = Math.max(job.period + FIVE_MINUTES, Math.round(job.period * 1.5));
    const status = !lastSuccessAt ? 'unknown' : ageMs > staleAfterMs ? 'warning' : 'healthy';
    return {
      name,
      status,
      lastSuccessAt,
      nextRunAt: nextRunAt(job, now),
      ageSeconds: ageMs == null ? null : Math.round(ageMs / 1000),
      everySeconds: Math.round(job.period / 1000),
    };
  });
}

async function schedulerStatus(env = process.env, now = Date.now()) {
  const names = enabledJobNames(env.MONITOR_JOBS_ENABLED);
  const file = env.MONITOR_JOBS_STATE_FILE?.trim();
  if (!file) {
    return { available: false, state: 'not_configured', jobs: schedulerSnapshot(null, names, now) };
  }

  try {
    const raw = JSON.parse(await readFile(file, 'utf8'));
    if (!raw || raw.version !== 1 || !raw.jobs || typeof raw.jobs !== 'object' || Array.isArray(raw.jobs)) {
      return { available: false, state: 'invalid', jobs: schedulerSnapshot(null, names, now) };
    }
    return { available: true, state: 'ready', jobs: schedulerSnapshot(raw, names, now) };
  } catch (error) {
    // Do not return file paths, parser errors, or filesystem details.
    const state = error && typeof error === 'object' && error.code === 'ENOENT' ? 'waiting_for_state' : 'unavailable';
    return { available: false, state, jobs: schedulerSnapshot(null, names, now) };
  }
}

/** A tightly-scoped Docker Engine GET. The path is always internal code. */
export function dockerGet(path, { socketPath, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolvePromise, reject) => {
    const req = httpRequest({
      socketPath: socketPath || '/var/run/docker.sock',
      path,
      method: 'GET',
      headers: { Host: 'docker' },
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.once('error', () => reject(new Error('DOCKER_RESPONSE_ERROR')));
      response.on('data', (chunk) => {
        size += chunk.length;
        // A status request never needs a huge Docker response. Stop on abuse or
        // a daemon/proxy malfunction without retaining any response content.
        if (size > 1_000_000) {
          response.destroy();
          reject(new Error('DOCKER_RESPONSE_TOO_LARGE'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error('DOCKER_HTTP_ERROR'));
          return;
        }
        resolvePromise(body);
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('DOCKER_TIMEOUT')));
    req.once('error', reject);
    req.end();
  });
}

async function dockerJson(path, options) {
  const body = await dockerGet(path, options);
  try {
    return JSON.parse(body);
  } catch {
    throw new Error('DOCKER_INVALID_JSON');
  }
}

function cpuPercent(stats) {
  const total = finiteNumber(stats?.cpu_stats?.cpu_usage?.total_usage);
  const previous = finiteNumber(stats?.precpu_stats?.cpu_usage?.total_usage);
  const system = finiteNumber(stats?.cpu_stats?.system_cpu_usage);
  const previousSystem = finiteNumber(stats?.precpu_stats?.system_cpu_usage);
  const online = finiteNumber(stats?.cpu_stats?.online_cpus)
    ?? (Array.isArray(stats?.cpu_stats?.cpu_usage?.percpu_usage) ? stats.cpu_stats.cpu_usage.percpu_usage.length : 1);
  if (total == null || previous == null || system == null || previousSystem == null || system <= previousSystem || total < previous) return null;
  return Math.round((100 * (total - previous) / (system - previousSystem) * Math.max(1, online)) * 10) / 10;
}

function metricsFromStats(stats) {
  const usage = finiteNumber(stats?.memory_stats?.usage);
  const limit = finiteNumber(stats?.memory_stats?.limit);
  if (usage == null && limit == null) return null;
  return {
    memoryBytes: usage,
    memoryLimitBytes: limit,
    cpuPercent: cpuPercent(stats),
  };
}

/** Strip Docker's rich inspect payload down to harmless operational facts. */
export function publicContainerStatus(summary, inspect = {}, stats = null) {
  const state = typeof inspect?.State?.Status === 'string'
    ? inspect.State.Status
    : (typeof summary?.State === 'string' ? summary.State : 'unknown');
  const running = inspect?.State?.Running === true || state === 'running';
  const rawHealth = inspect?.State?.Health?.Status;
  const health = ['healthy', 'unhealthy', 'starting'].includes(rawHealth) ? rawHealth : 'not_configured';
  return {
    service: typeof summary?.Labels?.['com.docker.compose.service'] === 'string'
      ? summary.Labels['com.docker.compose.service']
      : 'unknown',
    state: running ? 'running' : state === 'exited' ? 'stopped' : state,
    health,
    startedAt: safeIso(inspect?.State?.StartedAt),
    finishedAt: running ? null : safeIso(inspect?.State?.FinishedAt),
    exitCode: running ? null : finiteNumber(inspect?.State?.ExitCode),
    restartCount: finiteNumber(inspect?.RestartCount) ?? 0,
    metrics: running ? metricsFromStats(stats) : null,
  };
}

function missingContainer(service) {
  return {
    service,
    state: 'missing',
    health: 'not_configured',
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    restartCount: 0,
    metrics: null,
  };
}

function safeProjectName(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(value) ? value : null;
}

/**
 * `docker compose --project-name foo` does not reliably become an environment
 * variable inside services. Prefer the agent container's own Compose label, so
 * the monitor still follows a renamed production stack; env is a fallback for
 * unusual hostname configurations.
 */
async function ownComposeProject(options) {
  const hostname = process.env.HOSTNAME || '';
  if (!SAFE_CONTAINER_ID.test(hostname)) return null;
  try {
    const inspect = await dockerJson(`/containers/${hostname}/json`, options);
    return safeProjectName(inspect?.Config?.Labels?.['com.docker.compose.project']);
  } catch {
    return null;
  }
}

async function dockerStatus(env = process.env) {
  const expectedServices = asStringList(env.MONITOR_SERVICES, ['web', 'jobs', 'monitor-agent']);
  const configuredProject = safeProjectName(env.MONITOR_COMPOSE_PROJECT?.trim());

  const options = {
    socketPath: env.DOCKER_SOCKET_PATH?.trim() || '/var/run/docker.sock',
    timeoutMs: positiveInteger(env.MONITOR_DOCKER_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
  };

  try {
    await dockerGet('/_ping', options);
    const project = (await ownComposeProject(options)) || configuredProject;
    if (!project) return { available: false, configured: false, containers: [] };
    const filters = encodeURIComponent(JSON.stringify({ label: [`com.docker.compose.project=${project}`] }));
    const listed = await dockerJson(`/containers/json?all=1&filters=${filters}`, options);
    const summaries = Array.isArray(listed) ? listed.filter((summary) => {
      const service = summary?.Labels?.['com.docker.compose.service'];
      return typeof service === 'string' && expectedServices.includes(service) && SAFE_CONTAINER_ID.test(summary?.Id ?? '');
    }) : [];

    const containers = await Promise.all(summaries.map(async (summary) => {
      let inspect = {};
      let stats = null;
      try {
        inspect = await dockerJson(`/containers/${summary.Id}/json`, options);
        if (inspect?.State?.Running === true) {
          try { stats = await dockerJson(`/containers/${summary.Id}/stats?stream=false`, options); } catch { /* metric is optional */ }
        }
      } catch {
        // We still have the list entry. Do not turn this into an error that
        // hides the rest of the project from the operator.
      }
      return publicContainerStatus(summary, inspect, stats);
    }));

    const seen = new Set(containers.map((container) => container.service));
    for (const service of expectedServices) {
      if (!seen.has(service)) containers.push(missingContainer(service));
    }
    containers.sort((a, b) => a.service.localeCompare(b.service));
    return { available: true, configured: true, containers };
  } catch {
    // The daemon can be down while the agent itself is alive. Never echo its
    // errors: Docker may put sensitive paths or daemon details in them.
    return { available: false, configured: true, containers: [] };
  }
}

export function monitorTokenMatches(authorization, token) {
  if (!token?.trim() || typeof authorization !== 'string') return false;
  const supplied = /^Bearer (.+)$/i.exec(authorization)?.[1] ?? '';
  const expectedBuffer = Buffer.from(token);
  const suppliedBuffer = Buffer.from(supplied);
  return suppliedBuffer.length === expectedBuffer.length && timingSafeEqual(suppliedBuffer, expectedBuffer);
}

function send(response, status, payload) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(payload));
}

/**
 * Filesystem facts about the volume that holds the scheduler state (and, on a
 * self-hosted box, the same disk that stores the database). Only sizes leave
 * the agent — never paths, mount tables or inode details.
 */
export function diskFromStats(stats) {
  const blockSize = finiteNumber(stats?.bsize) ?? 4096;
  const total = finiteNumber(stats?.blocks) * blockSize;
  const free = finiteNumber(stats?.bavail) * blockSize;
  if (!Number.isFinite(total) || !Number.isFinite(free) || total <= 0) return null;
  const used = Math.max(0, total - free);
  return {
    totalBytes: Math.round(total),
    usedBytes: Math.round(used),
    availableBytes: Math.round(Math.max(0, free)),
    usedPercent: Math.round((used / total) * 1000) / 10,
  };
}

async function diskStatus(env = process.env) {
  const path = env.MONITOR_DISK_PATH?.trim() || '/monitor/jobs-state';
  try {
    const stats = await statfs(path);
    const disk = diskFromStats(stats);
    if (!disk) return { available: false };
    return { available: true, ...disk };
  } catch {
    return { available: false };
  }
}

export function createMonitorServer({ env = process.env, now = () => Date.now() } = {}) {
  return createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://monitor-agent');
    if (request.method !== 'GET') {
      send(response, 405, { ok: false });
      return;
    }
    if (url.pathname === '/health') {
      send(response, 200, { ok: true });
      return;
    }
    if (url.pathname !== '/status' || url.search || !monitorTokenMatches(request.headers.authorization, env.MONITOR_AGENT_TOKEN)) {
      send(response, url.pathname === '/status' ? 401 : 404, { ok: false });
      return;
    }

    const checkedAt = new Date(now()).toISOString();
    const [docker, scheduler, disk] = await Promise.all([
      dockerStatus(env),
      schedulerStatus(env, now()),
      diskStatus(env),
    ]);
    send(response, 200, { ok: true, checkedAt, docker, scheduler, disk });
  });
}

export function startMonitorAgent(env = process.env) {
  const port = positiveInteger(env.MONITOR_AGENT_PORT, 8080);
  const server = createMonitorServer({ env });
  server.listen(port, '0.0.0.0', () => {
    // No endpoint, project or token value in logs.
    console.log(`monitor-agent listening on ${port}`);
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  startMonitorAgent();
}
