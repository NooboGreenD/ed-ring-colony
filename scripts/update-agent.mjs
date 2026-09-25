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
 *   POST /backup         → start a manual database backup      (token)
 *   POST /abort          → SIGTERM the running job             (token)
 *   GET  /env            → masked env-file keys                (token)
 *   POST /env            → set/add one env key { key, value }  (token)
 *   DELETE /env?key=NAME → remove one env key                  (token)
 *   POST /env/apply      → recreate services so new keys apply (token)
 *
 * All jobs (update, backup, env apply) share ONE state machine and one
 * process slot: a database dump, a stack rebuild and an env change must never
 * overlap, and the admin panel sees which of the three is running through the
 * `kind` field.
 *
 * Env-file keys are read back MASKED (length + last 4 chars only): the raw
 * value never travels to the browser, so editing an existing key means
 * replacing it, not reading it first.
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
 *   UPDATE_HEALTH_URL, UPDATE_TIMEOUT_MINUTES (default 90: a cold image
 *        rebuild on a small VPS can legitimately take a long time)
 *   BACKUP_SCRIPT        default <PROJECT_DIR>/deploy/db-backup.sh
 *   UPDATE_BACKUP_DIR    where pg_dump writes (default /opt/ed-ring-colony/backups)
 *   UPDATE_BACKUP_KEEP   how many weekly copies to retain (default 4)
 *   BACKUP_TIMEOUT_MINUTES  default 120 (a full dump of a 10^8-row catalog is slow)
 *   ENV_FILE             the env file the panel edits (default <PROJECT_DIR>/.env.production)
 *   APPLY_ENV_SCRIPT     default <PROJECT_DIR>/deploy/apply-env.sh
 *   ENV_TIMEOUT_MINUTES  default 5 (a service recreate must be short)
 *
 * The agent is deliberately stateful-but-small: progress survives an agent
 * restart because it is mirrored into `$UPDATE_STATE_DIR/update-state.json`.
 */
import { timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { appendFileSync, chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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
    backupScript: (env.BACKUP_SCRIPT || join(projectDir, 'deploy', 'db-backup.sh')).trim(),
    backupDir: (env.UPDATE_BACKUP_DIR || '/opt/ed-ring-colony/backups').trim(),
    // Недельный ритм: четыре копии — это месяц истории и предсказуемое место
    // на диске. Больше — только явным желанием оператора.
    backupKeep: Math.min(24, Math.max(1, Number(env.UPDATE_BACKUP_KEEP) || 4)),
    backupTimeoutMs: Math.max(60_000, (Number(env.BACKUP_TIMEOUT_MINUTES) || 120) * 60_000),
    envFile: resolve((env.ENV_FILE || join(projectDir, '.env.production')).trim()),
    applyEnvScript: (env.APPLY_ENV_SCRIPT || join(projectDir, 'deploy', 'apply-env.sh')).trim(),
    envTimeoutMs: Math.max(60_000, (Number(env.ENV_TIMEOUT_MINUTES) || 5) * 60_000),
    branch: (env.PROJECT_UPDATE_BRANCH || 'main').trim(),
    repository: (env.PROJECT_REPOSITORY || 'NooboGreenD/ed-ring-colony').trim(),
    deployMode: (env.PROJECT_DEPLOY_MODE || 'auto').trim(),
    applyMigrations: (env.UPDATE_APPLY_MIGRATIONS ?? '1').toString().trim() !== '0',
    healthUrl: (env.UPDATE_HEALTH_URL || 'http://127.0.0.1:3000/api/health').trim(),
    // 45 мин не хватало: холодная сборка образа на малом VPS (npm ci при
    // смене lock-файла + тесты + next build) упирается в потолок, и апдейт
    // убивался посреди docker build. Запас 90 мин; точное значение — в
    // .env.production через UPDATE_TIMEOUT_MINUTES.
    timeoutMs: Math.max(60_000, (Number(env.UPDATE_TIMEOUT_MINUTES) || 90) * 60_000),
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
        const limit = state.kind === 'backup' ? config.backupTimeoutMs
          : state.kind === 'env' ? config.envTimeoutMs
          : config.timeoutMs;
        if (Date.now() - Date.parse(state.startedAt) > limit) {
          finish({
            state: 'failed',
            percent: state.percent,
            message: null,
            error: state.kind === 'backup'
              ? 'агент перезагружался во время резервного копирования'
              : state.kind === 'env'
                ? 'агент перезагружался во время применения ключей'
                : 'агент перезагружался во время обновления',
          });
        }
      }
      return sanitizeUpdateState(state);
    },
    start({ applyMigrations, kind = 'update', full = false, scope = 'web' } = {}) {
      if (state.state === 'running' || state.state === 'queued') return { started: false, reason: 'already-running' };
      const backup = kind === 'backup';
      const envApply = kind === 'env';
      const script = envApply ? config.applyEnvScript : backup ? config.backupScript : config.script;
      const jobLabel = envApply ? 'применение ключей' : backup ? 'резервное копирование' : 'обновление';
      const nowIso = new Date().toISOString();
      Object.assign(state, emptyUpdateState(nowIso), {
        state: 'running',
        kind,
        stage: envApply ? 'env_prepare' : 'prepare',
        // Опорный процент той же стадии из UPDATE_STAGES: панель не должна
        // видеть «stage=prepare, percent=0» до первой прогресс-строки скрипта
        // ( гонка «POST → GET» раньше времени роняла проверку «процент не
        // отстаёт от стадии»).
        percent: envApply ? 10 : 5,
        message: envApply ? 'запускаю deploy/apply-env.sh' : backup ? 'запускаю deploy/db-backup.sh' : 'запускаю deploy/update-project.sh',
        mode: envApply ? scope : backup ? (full ? 'full' : 'fast') : config.deployMode,
        branch: backup || envApply ? null : config.branch,
        startedAt: nowIso,
        log: [],
      });
      touch();
      persist();
      appendLog(envApply
        ? `env apply requested; scope=${scope} file=[файл окружения]`
        : backup
          ? `backup requested; full=${full ? '1' : '0'} dir=${config.backupDir} keep=${config.backupKeep}`
          : `update requested; project=${config.repository} branch=${config.branch} mode=${config.deployMode}`);

      let spawned;
      try {
        spawned = spawn('bash', [script], {
          cwd: config.projectDir,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            PROJECT_DIR: config.projectDir,
            UPDATE_STATE_DIR: config.stateDir,
            ...(envApply
              ? {
                  ENV_FILE: config.envFile,
                  APPLY_ENV_SCOPE: scope,
                  UPDATE_HEALTH_URL: config.healthUrl,
                  PROJECT_DEPLOY_MODE: config.deployMode,
                }
              : backup
                ? {
                    // По умолчанию каталог систем в дамп не попадает: он
                    // восстанавливается импортом дампа Spansh, а весит десятки
                    // гигабайт — окно технических работ должно быть коротким.
                    BACKUP_FULL: full ? '1' : '0',
                    UPDATE_BACKUP_DIR: config.backupDir,
                    UPDATE_BACKUP_KEEP: String(config.backupKeep),
                  }
                : {
                    PROJECT_UPDATE_BRANCH: config.branch,
                    PROJECT_REPOSITORY: config.repository,
                    PROJECT_DEPLOY_MODE: config.deployMode,
                    UPDATE_APPLY_MIGRATIONS: applyMigrations === false ? '0' : '1',
                    UPDATE_HEALTH_URL: config.healthUrl,
                  }),
          },
        });
      } catch (error) {
        finish({
          state: 'failed',
          error: `не удалось запустить ${jobLabel}: ${error?.message || error}`,
          percent: 0,
        });
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

      const timeoutMs = envApply ? config.envTimeoutMs : backup ? config.backupTimeoutMs : config.timeoutMs;
      timer = setTimeout(() => {
        appendLog(`timeout — принудительно останавливаю ${jobLabel}`);
        abort();
        finish({ state: 'aborted', error: `${jobLabel} длилось дольше ${Math.round(timeoutMs / 60000)} мин и остановлено` });
      }, timeoutMs);

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
          finish({ state: 'aborted', exitCode: code, error: state.error || `${jobLabel} остановлено` });
        } else if (code === 0) {
          finish({ state: 'succeeded', percent: 100, stage: 'done', exitCode: 0, error: null });
        } else {
          finish({ state: 'failed', exitCode: code, error: state.message || `${backup ? 'db-backup.sh' : 'updater'} завершился с кодом ${code}` });
        }
      });
      return { started: true };
    },
    stop() {
      if (state.state !== 'running') return false;
      finish({
        state: 'aborted',
        error: state.kind === 'backup' ? 'резервное копирование остановлено оператором'
          : state.kind === 'env' ? 'применение ключей остановлено оператором'
          : 'обновление остановлено оператором',
      });
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

// ── Управление ключами .env.production из панели (Админка → Мониторинг) ────
// Агент — единственный процесс, которому разрешено трогать файл окружения на
// хосте. Снаружи уходит только маска (длина + хвост): сырое значение никогда
// не доезжает до браузера, поэтому «изменить ключ» = заменить его целиком.

const ENV_KEY_RE = /^[A-Z][A-Z0-9_]{0,127}$/;
const ENV_MAX_VALUE_BYTES = 8 * 1024;

export function maskEnvValue(value) {
  const text = String(value ?? '');
  if (!text) return '·пусто·';
  const tail = text.length <= 8 ? '' : text.slice(-4);
  return `••••${tail} (${text.length})`;
}

/** name → value, последнее вхождение побеждает (семантика env-файла). */
export function parseEnvContent(content) {
  const keys = new Map();
  for (const line of String(content ?? '').split('\n')) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (match) keys.set(match[1], match[2]);
  }
  return keys;
}

export function readEnvFileState(file) {
  try {
    const keys = [...parseEnvContent(readFileSync(file, 'utf8')).entries()]
      .map(([name, value]) => ({ name, masked: maskEnvValue(value), length: String(value).length }));
    keys.sort((a, b) => a.name.localeCompare(b.name));
    return { exists: true, keys };
  } catch {
    return { exists: false, keys: [] };
  }
}

/**
 * Неприменённые миграции: имена файлов supabase/migrations/*.sql, которых нет
 * в $UPDATE_STATE_DIR/migrations.mark (отметки ставит deploy/update-project.sh
 * после успешного наката). Тот же критерий, что у скрипта обновления, — панель
 * показывает ровно то, что будет применено кнопкой. Возвращает имена файлов
 * (без каталога); любой сбой чтения — просто пустой список, не ошибка.
 */
export function listPendingMigrations(config) {
  try {
    let marked = new Set();
    try {
      marked = new Set(
        readFileSync(join(config.stateDir, 'migrations.mark'), 'utf8')
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean),
      );
    } catch {
      // Отметок ещё нет — всё дерево считается неприменённым (как в скрипте).
    }
    return readdirSync(join(config.projectDir, 'supabase', 'migrations'))
      .filter((name) => name.endsWith('.sql') && !marked.has(name))
      .sort();
  } catch {
    return [];
  }
}

/** Записать/обновить один ключ. Возвращает true, если ключа раньше не было. */
export function writeEnvKey(file, key, value) {
  let content = '';
  let existed = true;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    existed = false;
  }
  const lines = content.split('\n');
  const matches = [];
  lines.forEach((line, index) => {
    if (line.startsWith(key + '=')) matches.push(index);
  });
  existed = matches.length > 0;
  if (existed) {
    // Обновляем последнее вхождение, дубликаты убираем.
    for (const index of matches.slice(0, -1)) lines[index] = null;
    lines[matches[matches.length - 1]] = `${key}=${value}`;
  } else {
    if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
    lines.push(`${key}=${value}`);
  }
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, lines.filter((line) => line !== null).join('\n'));
  renameSync(tmp, file);
  try { chmodSync(file, 0o600); } catch { /* владельца файла может не иметься */ }
  return !existed;
}

/** Удалить все вхождения ключа. Возвращает true, если что-то удалено. */
export function deleteEnvKey(file, key) {
  const content = readFileSync(file, 'utf8');
  const lines = content.split('\n');
  const kept = lines.filter((line) => !line.startsWith(key + '='));
  if (kept.length === lines.length) return false;
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, kept.join('\n'));
  renameSync(tmp, file);
  return true;
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
        send(response, 200, {
          ok: true,
          update: full ? state : { ...state, log: [] },
          public: publicUpdateView(state),
          pendingMigrations: listPendingMigrations(config),
        });
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
      if (request.method === 'POST' && url.pathname === '/backup') {
        const body = await readJsonBody(request);
        // `full` включает в дамп каталог систем (десятки гигабайт): только по
        // явному запросу админа, по умолчанию копия делается без него.
        const result = manager.start({ kind: 'backup', full: body?.full === true });
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
      if (request.method === 'GET' && url.pathname === '/env') {
        const fileState = readEnvFileState(config.envFile);
        // Имя файла не раскрывается: админ и так знает, где .env.production.
        send(response, 200, { ok: true, configured: fileState.exists, keys: fileState.keys });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/env') {
        const body = await readJsonBody(request);
        const key = typeof body?.key === 'string' ? body.key.trim() : '';
        const value = typeof body?.value === 'string' ? body.value : null;
        if (!ENV_KEY_RE.test(key)) {
          send(response, 400, { ok: false, error: 'Имя ключа: заглавные A–Z, цифры и _ (1–128 символов)' });
          return;
        }
        if (value == null || /[\r\n]/.test(value) || Buffer.byteLength(value, 'utf8') > ENV_MAX_VALUE_BYTES) {
          send(response, 400, { ok: false, error: 'Значение: одна строка до 8 КБ без перевода строки' });
          return;
        }
        const created = writeEnvKey(config.envFile, key, value);
        send(response, created ? 201 : 200, { ok: true, key, created, masked: maskEnvValue(value), length: value.length });
        return;
      }
      if (request.method === 'DELETE' && url.pathname === '/env') {
        const key = url.searchParams.get('key') || '';
        if (!ENV_KEY_RE.test(key)) {
          send(response, 400, { ok: false, error: 'Имя ключа: заглавные A–Z, цифры и _ (1–128 символов)' });
          return;
        }
        let removed = false;
        try { removed = deleteEnvKey(config.envFile, key); } catch { removed = false; }
        if (!removed) {
          send(response, 404, { ok: false, error: 'Ключ не найден в файле окружения' });
          return;
        }
        send(response, 200, { ok: true, key, removed: true });
        return;
      }
      // Применить изменения: пересоздать сервисы, чтобы они подняли новые
      // ключи из env-файла. Тот же процессный слот, что и update/backup.
      if (request.method === 'POST' && url.pathname === '/env/apply') {
        const body = await readJsonBody(request);
        const scope = body?.scope === 'all' ? 'all' : 'web';
        const result = manager.start({ kind: 'env', scope });
        if (!result.started) {
          send(response, result.reason === 'already-running' ? 409 : 503, { ok: false, reason: result.reason, update: manager.status() });
          return;
        }
        send(response, 202, { ok: true, startedAt: manager.state.startedAt, update: manager.status() });
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
