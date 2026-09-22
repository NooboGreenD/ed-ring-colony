#!/usr/bin/env node
/**
 * Private project updater (host side).
 *
 * This is the ONLY process allowed to change what runs in production: it pulls
 * the deployment branch, optionally applies new SQL migrations and rebuilds the
 * stack through `deploy/update-project.sh`. The web container never gets git,
 * Docker or shell access — an authorised admin asks this agent over a private
 * HTTP endpoint, and everyone else just gets to see the coarse progress.
 *
 * Endpoints:
 *   GET  /health         → { ok, active }                     (no token)
 *   GET  /status[?full=1]→ sanitised progress state           (token)
 *   POST /update         → start an update                     (token)
 *   POST /abort          → SIGTERM the running update          (token)
 *
 * Configuration (environment):
 *   UPDATE_AGENT_TOKEN   Bearer token; mandatory when the port is reachable
 *                        from outside the loopback interface.
 *   UPDATE_AGENT_PORT    default 8092
 *   UPDATE_AGENT_HOST    default 127.0.0.1 (use 0.0.0.0 for Docker + token)
 *   PROJECT_DIR          git checkout to update (default /opt/ed-ring-colony/src)
 *   PROJECT_UPDATE_BRANCH / PROJECT_REPOSITORY / PROJECT_DEPLOY_MODE
 *   UPDATE_SCRIPT        default <PROJECT_DIR>/deploy/update-project.sh
 *   UPDATE_STATE_DIR     lock + state file (default <PROJECT_DIR>/../update-state)
 *   UPDATE_APPLY_MIGRATIONS  "1" (default) or "0"
 *   UPDATE_HEALTH_URL, UPDATE_TIMEOUT_MINUTES
 *
 * The agent is deliberately stateful-but-small: progress survives an agent
 * restart because it is mirrored into `$UPDATE_STATE_DIR/update-state.json`.
 */
import { timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  UPDATE_LOG_LIMIT,
  applyProgressEvent,
  emptyUpdateState,
  parseProgressLine,
  publicUpdateView,
  sanitizeLogLine,
  sanitizeUpdateState,
} from './lib/update-state.mjs';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
const MAX_BODY_BYTES = 64 * 1024;

export function updateAgentConfig(env = process.env) {
  const host = (env.UPDATE_AGENT_HOST || '127.0.0.1').trim();
  const token = (env.UPDATE_AGENT_TOKEN || '').trim();
  const projectDir = resolve((env.PROJECT_DIR || '/opt/ed-ring-colony/src').trim());
  const stateDir = resolve((env.UPDATE_STATE_DIR || join(dirname(projectDir), 'update-state')).trim());
  const portRaw = Number(env.UPDATE_AGENT_PORT || 8092);
  const port = Number.isInteger(portRaw) && portRaw > 0 && portRaw < 65_536 ? portRaw : 8092;
  return {
    host,
    port,
    token,
    // An unauthenticated updater on a routable interface would be a remote
    // code execution hole: refuse to start in that shape.
    requiresToken: !LOOPBACK.has(host),
    projectDir,
    stateDir,
    stateFile: join(stateDir, 'update-state.json'),
    logFile: join(stateDir, 'update.log'),
    script: (env.UPDATE_SCRIPT || join(projectDir, 'deploy', 'update-project.sh')).trim(),
    branch: (env.PROJECT_UPDATE_BRANCH || 'main').trim(),
    repository: (env.PROJECT_REPOSITORY || 'NooboGreenD/ed-ring-colony').trim(),
    deployMode: (env.PROJECT_DEPLOY_MODE || 'auto').trim(),
    applyMigrations: (env.UPDATE_APPLY_MIGRATIONS ?? '1').toString().trim() !== '0',
    healthUrl: (env.UPDATE_HEALTH_URL || 'http://127.0.0.1:3000/api/health').trim(),
    timeoutMs: Math.max(60_000, (Number(env.UPDATE_TIMEOUT_MINUTES) || 45) * 60_000),
  };
}

/**
 * Keeps the in-flight state, mirrors it to disk and accepts progress events.
 * Split out from the HTTP layer so the state machine is unit-testable.
 */
export function createUpdateManager(config) {
  const state = loadState(config.stateFile) ?? { ...emptyUpdateState(), state: 'idle' };
  if (!Array.isArray(state.log)) state.log = [];
  let child = null;
  let timer = null;

  function touch() {
    state.updatedAt = new Date().toISOString();
    return state;
  }

  function persist() {
    try {
      mkdirSync(dirname(config.stateFile), { recursive: true });
      const tmp = `${config.stateFile}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, ...state }));
      renameSync(tmp, config.stateFile);
    } catch {
      // A read-only state directory must not kill the update itself.
    }
  }

  function appendLog(line) {
    const clean = sanitizeLogLine(line);
    if (!clean) return;
    state.log = [...state.log, { at: new Date().toISOString(), line: clean }].slice(-UPDATE_LOG_LIMIT);
    try {
      appendFileSync(config.logFile, `${new Date().toISOString()} ${clean}\n`);
    } catch {
      // The log file is a convenience copy; the in-memory tail is enough.
    }
  }

  function finish(extra) {
    Object.assign(state, extra);
    state.finishedAt = new Date().toISOString();
    touch();
    persist();
  }

  function ingest(chunk) {
    for (const line of chunk.split('\n')) {
      if (!line.trim()) continue;
      const event = parseProgressLine(line);
      if (event) {
        // applyProgressEvent is pure: fold the new values back into the live
        // state object, then mirror it to disk.
        Object.assign(state, applyProgressEvent(state, event, new Date().toISOString()));
        persist();
        continue;
      }
      appendLog(line);
    }
  }

  function abort(code = 130) {
    if (child && !child.killed) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
    }
  }

  return {
    get state() { return state; },
    isBusy: () => state.state === 'running' || state.state === 'queued',
    status() {
      // A crashed host (state left as "running") must not block the panel
      // forever: after the timeout the state is reported as failed.
      if (state.state === 'running' && state.startedAt && !child) {
        if (Date.now() - Date.parse(state.startedAt) > config.timeoutMs) {
          finish({ state: 'failed', percent: state.percent, message: null, error: 'агент перезагружался во время обновления' });
        }
      }
      return sanitizeUpdateState(state);
    },
    start({ applyMigrations } = {}) {
      if (state.state === 'running' || state.state === 'queued') return { started: false, reason: 'already-running' };
      const nowIso = new Date().toISOString();
      Object.assign(state, emptyUpdateState(nowIso), {
        state: 'running',
        stage: 'prepare',
        percent: 0,
        message: 'запускаю deploy/update-project.sh',
        mode: config.deployMode,
        branch: config.branch,
        startedAt: nowIso,
        log: [],
      });
      touch();
      persist();
      appendLog(`update requested; project=${config.repository} branch=${config.branch} mode=${config.deployMode}`);

      let spawned;
      try {
        spawned = spawn('bash', [config.script], {
          cwd: config.projectDir,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            PROJECT_DIR: config.projectDir,
            PROJECT_UPDATE_BRANCH: config.branch,
            PROJECT_REPOSITORY: config.repository,
            PROJECT_DEPLOY_MODE: config.deployMode,
            UPDATE_STATE_DIR: config.stateDir,
            UPDATE_APPLY_MIGRATIONS: applyMigrations === false ? '0' : '1',
            UPDATE_HEALTH_URL: config.healthUrl,
          },
        });
      } catch (error) {
        finish({ state: 'failed', error: `не удалось запустить updater: ${error?.message || error}`, percent: 0 });
        return { started: false, reason: 'spawn-failed' };
      }
      child = spawned;
      spawned.stdout?.setEncoding('utf8');
      spawned.stderr?.setEncoding('utf8');
      let pending = '';
      spawned.stdout?.on('data', (data) => {
        pending += data;
        const parts = pending.split('\n');
        pending = parts.pop() ?? '';
        ingest(parts.join('\n'));
      });
      spawned.stderr?.on('data', (data) => appendLog(`! ${data}`));

      timer = setTimeout(() => {
        appendLog('timeout — принудительно останавливаю обновление');
        abort();
        finish({ state: 'aborted', error: `обновление длилось дольше ${Math.round(config.timeoutMs / 60000)} мин и остановлено` });
      }, config.timeoutMs);

      spawned.on('error', (error) => {
        if (timer) clearTimeout(timer);
        finish({ state: 'failed', error: String(error?.message || error), exitCode: null });
        child = null;
      });
      spawned.on('close', (code) => {
        if (timer) clearTimeout(timer);
        if (pending) ingest(pending);
        child = null;
        const aborted = state.state === 'aborted' || code === null;
        if (aborted) {
          finish({ state: 'aborted', exitCode: code, error: state.error || 'обновление остановлено' });
        } else if (code === 0) {
          finish({ state: 'succeeded', percent: 100, stage: 'done', exitCode: 0, error: null });
        } else {
          finish({ state: 'failed', exitCode: code, error: state.message || `updater завершился с кодом ${code}` });
        }
      });
      return { started: true };
    },
    stop() {
      if (state.state !== 'running') return false;
      finish({ state: 'aborted', error: 'обновление остановлено оператором' });
      abort();
      return true;
    },
  };
}

function loadState(file) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object') return null;
    return sanitizeUpdateState(raw);
  } catch {
    return null;
  }
}

export function tokenMatches(authorization, token) {
  if (!token?.trim() || typeof authorization !== 'string') return false;
  const supplied = /^Bearer (.+)$/i.exec(authorization)?.[1] ?? '';
  const expected = Buffer.from(token);
  const actual = Buffer.from(supplied);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function send(response, status, payload) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  return parsed && typeof parsed === 'object' ? parsed : {};
}

export function createUpdateServer({ config = updateAgentConfig(), manager = createUpdateManager(config) } = {}) {
  return createServer(async (request, response) => {
    let url;
    try {
      url = new URL(request.url || '/', 'http://update-agent');
    } catch {
      send(response, 400, { ok: false });
      return;
    }
    const authorized = config.token ? tokenMatches(request.headers.authorization, config.token) : !config.requiresToken;

    if (url.pathname === '/health') {
      send(response, 200, { ok: true, active: manager.isBusy() });
      return;
    }
    if (!authorized) {
      send(response, 401, { ok: false });
      return;
    }

    try {
      if (request.method === 'GET' && url.pathname === '/status') {
        const full = url.searchParams.get('full') === '1';
        const state = manager.status();
        send(response, 200, { ok: true, update: full ? state : { ...state, log: [] }, public: publicUpdateView(state) });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/update') {
        const body = await readJsonBody(request);
        const applyMigrations = body?.applyMigrations === undefined
          ? config.applyMigrations
          : Boolean(body.applyMigrations);
        const result = manager.start({ applyMigrations });
        if (!result.started) {
          send(response, result.reason === 'already-running' ? 409 : 503, { ok: false, reason: result.reason, update: manager.status() });
          return;
        }
        send(response, 202, { ok: true, startedAt: manager.state.startedAt, update: manager.status() });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/abort') {
        const stopped = manager.stop();
        send(response, stopped ? 202 : 409, { ok: stopped, update: manager.status() });
        return;
      }
    } catch {
      send(response, 400, { ok: false });
      return;
    }
    send(response, 404, { ok: false });
  });
}

export function startUpdateAgent(env = process.env) {
  const config = updateAgentConfig(env);
  if (config.requiresToken && !config.token) {
    console.error('update-agent: UPDATE_AGENT_TOKEN обязателен, когда UPDATE_AGENT_HOST != 127.0.0.1');
    process.exitCode = 1;
    return null;
  }
  mkdirSync(config.stateDir, { recursive: true });
  const server = createUpdateServer({ config });
  server.listen(config.port, config.host, () => {
    console.log(`update-agent listening on ${config.host}:${config.port}`);
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  startUpdateAgent();
}
