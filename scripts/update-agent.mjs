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
 *   POST /update         → start an update
 *                         body: { applyMigrations?, backup?, runTests?,
 *                                 migrationsOnly? }           (token)
 *   POST /backup         → start a manual database backup      (token)
 *   POST /abort          → SIGTERM the running job               (token)
 *   POST /restart        → exit so the supervisor restarts the
 *                         agent with the code from the checkout  (token)
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
 *   UPDATE_HEALTH_URL, UPDATE_TIMEOUT_MINUTES — лимит длительного обновления;
 *        по умолчанию БЕЗ ограничения (сборка не убивается по времени):
 *        0/off/unlimited или вовсе не задан — лимита нет; положительное
 *        число — вернуть ограничение в минутах. Сломавшийся «running» без
 *        процесса (рестарт хоста) разблокируется сам через 6 часов либо
 *        кнопкой «Остановить».
 *   BACKUP_SCRIPT        default <PROJECT_DIR>/deploy/db-backup.sh
 *   UPDATE_BACKUP_DIR    where pg_dump writes (default /opt/ed-ring-colony/backups)
 *   UPDATE_BACKUP_KEEP   how many weekly copies to retain (default 4)
 *   BACKUP_TIMEOUT_MINUTES  default 120 (a full dump of a 10^8-row catalog is slow)
 *   ENV_FILE             the env file the panel edits (default <PROJECT_DIR>/.env.production)
 *   APPLY_ENV_SCRIPT     default <PROJECT_DIR>/deploy/apply-env.sh
 *   ENV_TIMEOUT_MINUTES  default 5 (a service recreate must be short)
 *   UPDATE_AGENT_SELF_RESTART  "1" by default; "0" disables only the
 *                        automatic restart after an update. POST /restart
 *                        remains available to an administrator.
 *   UPDATE_AGENT_RESTART_DELAY_SECONDS  default 12 (range 1–120)
 *
 * The agent is deliberately stateful-but-small: progress survives an agent
 * restart because it is mirrored into `$UPDATE_STATE_DIR/update-state.json`.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { appendFileSync, chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  UPDATE_AGENT_PROTOCOL,
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

/**
 * «Залипший» running БЕЗ процесса (агент/хост перезагрузились посреди
 * сборки) должен разблокировать панель сам, даже когда лимит сборки снят:
 * 6 часов — с запасом больше любой реальной холодной сборки.
 */
const STALE_RUNNING_LIMIT_MS = 6 * 60 * 60 * 1000;

/**
 * Лимит обновления в минутах → миллисекунды. Пусто / 0 / off / unlimited →
 * null — лимита нет, скрипт сборки не останавливается по времени («45 минут
 * билда» отменены); положительное число → действующее ограничение.
 */
export function parseUpdateTimeoutMs(raw) {
  const text = String(raw ?? '').trim().toLowerCase();
  if (!text) return null;
  if (text === '0' || text === '-1' || text === 'off' || text === 'none' || text === 'unlimited' || text === 'false') return null;
  const minutes = Number(text);
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  return Math.max(60_000, Math.round(minutes) * 60_000);
}

/** Короткий отпечаток файла (или null, если файла нет). */
function fileRevision(file) {
  try {
    return createHash('sha1').update(readFileSync(file)).digest('hex').slice(0, 12);
  } catch {
    return null;
  }
}

/** Путь к файлу, из которого реально запущен этот модуль. */
function runningEntry() {
  try {
    return fileURLToPath(import.meta.url);
  } catch {
    return '';
  }
}

// Отпечатки фиксируются ПРИ СТАРТЕ процесса. Если агент запущен прямо из
// смонтированного клона, `git merge` заменяет файл по тому же пути: повторное
// чтение пути после обновления показало бы уже новый файл и ложно заявило,
// что старый загруженный в память код актуален.
const STARTED_ENTRY = runningEntry();
const STARTED_REVISION = STARTED_ENTRY ? fileRevision(STARTED_ENTRY) : null;
const STARTED_SHARED_REVISION = STARTED_ENTRY
  ? fileRevision(join(dirname(STARTED_ENTRY), 'lib', 'update-state.mjs'))
  : null;

/**
 * Свежесть самого агента.
 *
 * Обновление намеренно НЕ пересоздаёт контейнер `update-agent`: он выполняет
 * скрипт обновления, и пересоздание убило бы прогон на середине. Но образ
 * агента при этом остаётся старым — а вместе с ним и код, который читает
 * флажки панели. Ровно поэтому «без бэкапа», «без тестов» и «только миграции»
 * могли ничего не менять: старый агент просто не передавал их скрипту.
 *
 * Здесь агент честно сравнивает исполняемый файл с копией из клона и
 * отдаёт результат панели: та покажет предупреждение и кнопку перезапуска,
 * а после успешного обновления агент перезапускается сам.
 */
export function agentSourceInfo(config, extra = {}) {
  const entry = STARTED_ENTRY;
  const repoEntry = join(config.projectDir, 'scripts', 'update-agent.mjs');
  const repoShared = join(config.projectDir, 'scripts', 'lib', 'update-state.mjs');
  const runningRevision = STARTED_REVISION;
  const runningSharedRevision = STARTED_SHARED_REVISION;
  const repoRevision = fileRevision(repoEntry);
  const repoSharedRevision = fileRevision(repoShared);
  const fromRepo = Boolean(entry) && resolve(entry) === resolve(repoEntry);
  // Клон может быть неполным (нет scripts/) — тогда сравнивать не с чем и
  // «устаревшим» агент не считается: иначе панель пугала бы зря. Сравниваем
  // с отпечатками старта, а не перечитываем исполняемый путь после git merge.
  const stale = Boolean(
    (runningRevision && repoRevision && runningRevision !== repoRevision)
    || (runningSharedRevision && repoSharedRevision && runningSharedRevision !== repoSharedRevision),
  );
  let migrationsOnlySupported = true;
  try {
    migrationsOnlySupported = readFileSync(config.script, 'utf8').includes('UPDATE_MIGRATIONS_ONLY');
  } catch {
    migrationsOnlySupported = true;
  }
  return {
    protocol: UPDATE_AGENT_PROTOCOL,
    stale,
    fromRepo,
    revision: runningRevision,
    repoRevision,
    sharedRevision: runningSharedRevision,
    repoSharedRevision,
    migrationsOnlySupported,
    // Ручной POST /restart доступен независимо от настройки автоматического
    // перезапуска. UPDATE_AGENT_SELF_RESTART=0 должен отключать только
    // автоматический выход после обновления, а не кнопку администратора.
    canRestart: true,
    autoRestart: config.selfRestart,
    ...extra,
  };
}

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
    // Лимита сборки по умолчанию НЕТ: холодная сборка на малом VPS занимает
    // десятки минут и не должна убиваться по времени. Ограничение — только
    // явное: UPDATE_TIMEOUT_MINUTES=<число> в .env.production (старое
    // «45» там стоит — удалите строку или поставьте 0).
    timeoutMs: parseUpdateTimeoutMs(env.UPDATE_TIMEOUT_MINUTES),
    // Перезапуск агента после обновления: процесс просто завершается, а его
    // поднимает супервизор (Docker `restart: unless-stopped` или systemd
    // `Restart=always`). Так агент подхватывает собственный новый код —
    // без этого он навсегда остаётся тем, каким был при первой сборке.
    // UPDATE_AGENT_SELF_RESTART=0 отключает только автоматическое поведение;
    // явный POST /restart из админки остаётся доступен.
    selfRestart: (env.UPDATE_AGENT_SELF_RESTART ?? '1').toString().trim() !== '0',
    /** Пауза перед перезапуском: панель успевает забрать финальный статус. */
    selfRestartDelayMs: Math.min(120_000, Math.max(1_000, (Number(env.UPDATE_AGENT_RESTART_DELAY_SECONDS) || 12) * 1_000)),
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
  /**
   * Последние строки stderr текущего прогона. Причина падения почти всегда
   * именно здесь (`npm test` с упавшим тестом, `no space left on device`,
   * недоступный registry), а раньше в панель уезжала просто подпись стадии.
   */
  let errorTail = [];
  const startedAt = new Date().toISOString();
  let restartTimer = null;

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

  /** Строка из stderr, которая больше всего похожа на причину сбоя. */
  function errorFromTail() {
    if (!errorTail.length) return null;
    const meaningful = /(error|ошибк|failed|fatal|cannot|not found|no space|denied|refused|killed|exit code|unauthorized|timeout)/i;
    const picked = [...errorTail].reverse().find((line) => meaningful.test(line));
    return sanitizeLogLine(picked ?? errorTail[errorTail.length - 1]);
  }

  /**
   * Завершить агент с задержкой, чтобы Docker/systemd подняли его с новым
   * кодом (контейнер запускает файл из смонтированного клона).
   *
   * UPDATE_AGENT_SELF_RESTART управляет только автоматическим перезапуском
   * после обновления. Явная команда администратора (`manual: true`) должна
   * работать и при значении 0 — именно для этого в панели есть кнопка.
   */
  function scheduleRestart(reason, { manual = false } = {}) {
    if ((!manual && !config.selfRestart) || restartTimer) return false;
    appendLog(`перезапускаю update-agent: ${reason}`);
    restartTimer = setTimeout(() => {
      // Никогда не бросаем прогон на середине: если к этому моменту снова
      // что-то запущено, перезапуск просто отменяется.
      if (child) { restartTimer = null; return; }
      persist();
      process.exit(0);
    }, config.selfRestartDelayMs);
    restartTimer.unref?.();
    return true;
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
    /** Когда поднялся сам процесс агента (не задача). */
    get startedAt() { return startedAt; },
    isBusy: () => state.state === 'running' || state.state === 'queued',
    status() {
      // A crashed host (state left as "running") must not block the panel
      // forever: after the limit the state is reported as failed. The build
      // itself may have NO limit (timeoutMs = null) — then the generic
      // 6-hour stale threshold applies; «abort» frees the panel earlier.
      if (state.state === 'running' && state.startedAt && !child) {
        const limit = state.kind === 'backup' ? config.backupTimeoutMs
          : state.kind === 'env' ? config.envTimeoutMs
          : config.timeoutMs ?? STALE_RUNNING_LIMIT_MS;
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
    start({ applyMigrations, backup = true, runTests = true, migrationsOnly = false, kind = 'update', full = false, scope = 'web' } = {}) {
      if (state.state === 'running' || state.state === 'queued') return { started: false, reason: 'already-running' };
      const isBackup = kind === 'backup';
      const envApply = kind === 'env';
      const script = envApply ? config.applyEnvScript : isBackup ? config.backupScript : config.script;
      const jobLabel = envApply ? 'применение ключей' : isBackup ? 'резервное копирование' : 'обновление';
      // «Только миграции» без поддержки в скрипте — это молчаливая полная
      // пересборка прода вместо обещанного наката миграций. Такой прогон не
      // запускается вовсе: админ получит честную причину и починит клон.
      if (migrationsOnly && !agentSourceInfo(config).migrationsOnlySupported) {
        return { started: false, reason: 'migrations-only-unsupported' };
      }
      errorTail = [];
      // «Только миграции» — тот же kind=update, но отдельный режим: панель по
      // mode=migrations рисует свои стадии и подписи, а скрипт завершается до сборки.
      const updateMode = migrationsOnly ? 'migrations' : config.deployMode;
      const flag = (value) => (value === false ? '0' : '1');
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
        message: envApply ? 'запускаю deploy/apply-env.sh' : isBackup ? 'запускаю deploy/db-backup.sh' : 'запускаю deploy/update-project.sh',
        mode: envApply ? scope : isBackup ? (full ? 'full' : 'fast') : updateMode,
        branch: isBackup || envApply ? null : config.branch,
        startedAt: nowIso,
        log: [],
      });
      touch();
      persist();
      appendLog(envApply
        ? `env apply requested; scope=${scope} file=[файл окружения]`
        : isBackup
          ? `backup requested; full=${full ? '1' : '0'} dir=${config.backupDir} keep=${config.backupKeep}`
          : `update requested; project=${config.repository} branch=${config.branch} mode=${updateMode} tests=${flag(runTests)} backup=${flag(backup)} migrations=${flag(applyMigrations)} only=${migrationsOnly ? '1' : '0'}`);

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
              : isBackup
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
                    // Флажки приходят из панели на каждый запуск: бэкап БД,
                    // тесты в сборке и режим «только миграции».
                    UPDATE_APPLY_MIGRATIONS: flag(applyMigrations),
                    UPDATE_BACKUP_BEFORE: flag(backup),
                    UPDATE_RUN_TESTS: flag(runTests),
                    UPDATE_MIGRATIONS_ONLY: migrationsOnly ? '1' : '0',
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
      spawned.stderr?.on('data', (data) => {
        appendLog(`! ${data}`);
        // Хвост stderr — единственное место, где остаётся настоящая причина
        // падения сборки (упавший тест, кончившееся место, недоступный
        // registry). Держим последние строки, чтобы показать их админу.
        for (const line of String(data).split('\n')) {
          const clean = sanitizeLogLine(line);
          if (clean) errorTail = [...errorTail, clean].slice(-12);
        }
      });

      // Лимит времени: у сборки по умолчанию его НЕТ (config.timeoutMs =
      // null) — длинный билд не убивается по часам; у бэкапа и применения
      // ключей лимиты остаются, они никогда не бывают долгими.
      const timeoutMs = envApply ? config.envTimeoutMs : isBackup ? config.backupTimeoutMs : config.timeoutMs;
      if (timeoutMs) {
        timer = setTimeout(() => {
          appendLog(`timeout — принудительно останавливаю ${jobLabel}`);
          abort();
          finish({ state: 'aborted', error: `${jobLabel} длилось дольше ${Math.round(timeoutMs / 60000)} мин и остановлено` });
        }, timeoutMs);
      }

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
          // Обновление принесло новый код и самому агенту: перезапускаемся,
          // иначе следующий прогон снова пойдёт по старым правилам (именно
          // из-за этого флажки панели могли «не влиять» на сборку).
          if (!isBackup && !envApply && agentSourceInfo(config).stale) {
            scheduleRestart('в клоне лежит более новая версия агента');
          }
        } else {
          // Причина сбоя: сначала явное сообщение об ошибке от скрипта
          // (`::edrc::{"error": …}`), затем хвост stderr и только потом —
          // безликое «завершился с кодом N». Подпись текущей стадии
          // («Пересобираю docker-образы…») ошибкой больше не считается.
          const reason = state.error || errorFromTail();
          const label = isBackup ? 'db-backup.sh' : envApply ? 'apply-env.sh' : 'update-project.sh';
          finish({
            state: 'failed',
            exitCode: code,
            message: null,
            error: reason
              ? `${reason} (${label}, код ${code})`
              : `${label} завершился с кодом ${code} — подробности в журнале ниже`,
          });
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
    /**
     * Явно завершить процесс по команде администратора. Эта операция не
     * зависит от UPDATE_AGENT_SELF_RESTART: флаг запрещает только автоматику.
     */
    restart(reason = 'запрос оператора') {
      if (state.state === 'running') return false;
      return scheduleRestart(reason, { manual: true });
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
          // Свежесть самого агента: панель предупредит, если он старее клона
          // (тогда флажки прогона могут игнорироваться), и предложит перезапуск.
          agent: agentSourceInfo(config, { startedAt: manager.startedAt ?? null }),
        });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/update') {
        const body = await readJsonBody(request);
        // Флажки панели: бэкап БД, тесты, режим «только миграции». Режим
        // «только миграции» по определению применяет миграции — флаг не
        // может быть там выключен даже кривым запросом.
        const migrationsOnly = body?.migrationsOnly === true;
        const applyMigrations = migrationsOnly
          ? true
          : body?.applyMigrations === undefined
            ? config.applyMigrations
            : Boolean(body.applyMigrations);
        const backup = body?.backup === undefined ? true : Boolean(body.backup);
        const runTests = body?.runTests === undefined ? true : Boolean(body.runTests);
        const result = manager.start({ applyMigrations, backup, runTests, migrationsOnly });
        if (!result.started) {
          const reasons = {
            'already-running': 'Агент уже занят — дождитесь окончания текущей задачи',
            'migrations-only-unsupported': 'deploy/update-project.sh в клоне не умеет режим «только миграции» — обновите исходники обычной кнопкой',
          };
          send(response, result.reason === 'already-running' ? 409 : 503, {
            ok: false,
            reason: result.reason,
            error: reasons[result.reason] ?? null,
            update: manager.status(),
          });
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
      /**
       * Перезапуск агента из панели.
       *
       * Обновление не пересоздаёт контейнер апдейтера (он же выполняет
       * обновление), поэтому агент остаётся на коде той сборки, в которой его
       * впервые подняли, и новые флажки панели до скрипта не доезжают.
       * Кнопка «Перезапустить агент» завершает процесс — супервизор поднимает
       * его заново уже с кодом из клона.
       */
      if (request.method === 'POST' && url.pathname === '/restart') {
        if (manager.isBusy()) {
          send(response, 409, { ok: false, error: 'Сейчас идёт задача — перезапуск прервал бы её' });
          return;
        }
        const scheduled = manager.restart('запрос из панели администратора');
        send(response, scheduled ? 202 : 409, {
          ok: scheduled,
          error: scheduled ? null : 'Перезапуск update-agent уже запланирован',
          agent: agentSourceInfo(config, { startedAt: manager.startedAt ?? null }),
        });
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
