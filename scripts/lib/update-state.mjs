/**
 * Shared state machine for the manual project update (Админка → Мониторинг →
 * «Обновление проекта»).
 *
 * The updater runs outside the web container (it is the only process that may
 * touch git, Docker and systemd), talks to the site over a private HTTP agent
 * and reports progress with one machine-readable line per stage:
 *
 *     ::edrc::{"stage":"build","percent":55,"message":"Пересобираю web"}
 *
 * Both the agent and the Next.js API import this module so the browser never
 * sees anything but the sanitised projection of that state.
 */

export const UPDATE_PROTOCOL = '::edrc::';

export const UPDATE_STAGES = [
  { id: 'prepare', label: 'Проверка блокировок и репозитория', percent: 5 },
  { id: 'fetch', label: 'Синхронизация с GitHub', percent: 15 },
  // Проценты обязаны совпадать с `report`-строками deploy/update-project.sh:
  // они же служат запасным значением, если скрипт прислал стадию без percent.
  { id: 'compare', label: 'Сверка ревизий и перемотка исходников', percent: 25 },
  { id: 'backup', label: 'Резервная копия базы', percent: 45 },
  { id: 'migrate', label: 'Миграции базы данных', percent: 55 },
  { id: 'build', label: 'Сборка новой версии', percent: 70 },
  { id: 'switch', label: 'Переключение контейнеров/сервиса', percent: 85 },
  { id: 'verify', label: 'Проверка доступности сайта', percent: 95 },
  { id: 'done', label: 'Готово', percent: 100 },
];

const STAGE_BY_ID = new Map(UPDATE_STAGES.map((stage) => [stage.id, stage]));

export const UPDATE_LOG_LIMIT = 160;
export const UPDATE_LOG_LINE_LIMIT = 280;

const SECRETISH = /(token|secret|password|passwd|api[_-]?key|service_role|authorization|bearer)/i;
const ANSI = /\u001B\[[0-9;]*[A-Za-z]/g;

function clampNumber(value, min, max, fallback = null) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function shortText(value, limit) {
  if (typeof value !== 'string') return null;
  const text = value.replace(ANSI, '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/**
 * A single log line, stripped of control codes, secrets and length.
 *
 * Две дорожки сокрытия: явные `ключ=значение` с «секретными» именами и
 * любые URL вида scheme://user:password@host — вывод psql/pg_dump/docker
 * любит их печатать целиком, а панель показывает журнал даже после того,
 * как админ закрыл вкладку.
 */
export function sanitizeLogLine(line) {
  const raw = String(line ?? '').replace(ANSI, '').replace(/\s+$/, '');
  if (!raw.trim()) return null;
  const text = raw.replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/[^:/.\s@]+:)[^@\s]+(@)/g, '$1***$2');
  if (text !== raw && !SECRETISH.test(text)) return text.slice(0, UPDATE_LOG_LINE_LIMIT);
  if (SECRETISH.test(text)) {
    const redacted = text.replace(/([A-Za-z0-9_.-]*(?:token|secret|password|passwd|api[_-]?key|service_role|authorization|bearer)[A-Za-z0-9_.-]*)\s*[=:]\s*\S+/gi, '$1=***');
    if (redacted !== text) return redacted.slice(0, UPDATE_LOG_LINE_LIMIT);
    // A line that merely mentions a secret-ish word without an assignment is
    // still noise-safe to show, but never an obvious key/value pair.
    if (/^[^:]*[=:]\s*[A-Za-z0-9+/_-]{16,}/.test(text)) return '[скрыта строка с похожим на секрет значением]';
  }
  // Absolute paths are useful to the operator, but never expose the env file.
  if (/\.env\.(production|local)/.test(text) && /[/\\]\.env\./.test(text)) {
    return text.replace(/(\S*)[/\\]\.env\.(production|local)/gi, '[файл окружения]').slice(0, UPDATE_LOG_LINE_LIMIT);
  }
  return text.slice(0, UPDATE_LOG_LINE_LIMIT);
}

/** Reads the `::edrc::{json}` progress channel out of raw script output. */
export function parseProgressLine(line) {
  const text = String(line ?? '');
  const index = text.indexOf(UPDATE_PROTOCOL);
  if (index < 0) return null;
  try {
    const parsed = JSON.parse(text.slice(index + UPDATE_PROTOCOL.length));
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

function stageLabel(id) {
  const stage = STAGE_BY_ID.get(id);
  return stage ? stage.label : null;
}

/**
 * Normalises whatever the updater produced into a fixed, small shape. Unknown
 * keys are dropped on purpose: the browser must never receive a raw object
 * from the host filesystem.
 */
export function sanitizeUpdateState(input) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const state = typeof raw.state === 'string' && /^[a-z_]{1,24}$/.test(raw.state) ? raw.state : 'idle';
  const stage = typeof raw.stage === 'string' && /^[a-z_]{1,24}$/.test(raw.stage) ? raw.stage : null;
  const known = stage ? STAGE_BY_ID.get(stage) : null;
  const percent = clampNumber(raw.percent, 0, 100, known ? known.percent : 0);
  const log = Array.isArray(raw.log)
    ? raw.log
      .slice(-UPDATE_LOG_LIMIT)
      .map((entry) => ({
        at: typeof entry?.at === 'string' ? entry.at : null,
        line: sanitizeLogLine(entry?.line ?? entry),
      }))
      .filter((entry) => entry.line)
    : [];

  const isoOrNull = (value) => {
    if (typeof value !== 'string') return null;
    const time = Date.parse(value);
    return Number.isFinite(time) ? new Date(time).toISOString() : null;
  };
  const shaOrNull = (value) => {
    const text = typeof value === 'string' ? value.trim() : '';
    return /^[a-f0-9]{7,40}$/i.test(text) ? text.toLowerCase() : null;
  };

  return {
    state,
    active: state === 'running' || state === 'queued',
    stage,
    stageLabel: stageLabel(stage),
    percent: state === 'succeeded' ? 100 : percent,
    message: shortText(raw.message, 200),
    startedAt: isoOrNull(raw.startedAt),
    updatedAt: isoOrNull(raw.updatedAt),
    finishedAt: isoOrNull(raw.finishedAt),
    exitCode: clampNumber(raw.exitCode, 0, 255, null),
    mode: typeof raw.mode === 'string' && /^[a-z-]{1,24}$/.test(raw.mode) ? raw.mode : null,
    branch: typeof raw.branch === 'string' && /^[A-Za-z0-9._/-]{1,120}$/.test(raw.branch) ? raw.branch : null,
    fromSha: shaOrNull(raw.fromSha),
    toSha: shaOrNull(raw.toSha),
    migrationsApplied: clampNumber(raw.migrationsApplied, 0, 10_000, 0),
    error: state === 'failed' || state === 'aborted' ? shortText(raw.error, 200) : null,
    log,
  };
}

/**
 * What the public `/api/status` may reveal to an anonymous visitor: enough to
 * swap «System Online» for «System Update», nothing about the server itself.
 */
export function publicUpdateView(update) {
  const state = sanitizeUpdateState(update);
  const active = state.active;
  return {
    active,
    state: active || state.state === 'failed' ? state.state : 'idle',
    stage: active ? state.stage : null,
    stageLabel: active ? state.stageLabel || state.message : null,
    percent: active ? state.percent : 0,
    startedAt: active ? state.startedAt : null,
    updatedAt: active ? state.updatedAt : null,
  };
}

/** Folds a parsed `::edrc::` progress event into the current state object. */
export function applyProgressEvent(state, event, nowIso) {
  const base = state && typeof state === 'object' ? { ...state } : {};
  const previous = clampNumber(base.percent, 0, 100, 0);
  // Прогресс идёт только вперёд: откат назад (или перескок на 15% ради
  // служебного шага) в шапке сайта выглядит как сбой, а не как этап.
  const forward = (candidate) => Math.max(previous, clampNumber(candidate, 0, 100, previous));
  if (event?.stage) {
    base.stage = String(event.stage).slice(0, 24).replace(/[^a-z_]/gi, '');
    const known = STAGE_BY_ID.get(base.stage);
    // Процент двигают только известные стадии: неизвестная строка не должна
    // ни «перематывать» шкалу, ни показывать ей несуществующий этап.
    if (known) base.percent = forward(event.percent != null ? event.percent : known.percent);
  } else if (event?.percent != null) {
    base.percent = forward(event.percent);
  }
  if (typeof event?.message === 'string') base.message = sanitizeLogLine(event.message);
  if (typeof event?.mode === 'string') base.mode = event.mode;
  if (typeof event?.branch === 'string') base.branch = event.branch;
  if (typeof event?.fromSha === 'string') base.fromSha = event.fromSha;
  if (typeof event?.toSha === 'string') base.toSha = event.toSha;
  if (event?.migrationsApplied != null) base.migrationsApplied = event.migrationsApplied;
  base.state = 'running';
  base.updatedAt = nowIso;
  return base;
}

export function emptyUpdateState(nowIso = new Date().toISOString()) {
  return {
    state: 'idle',
    active: false,
    stage: null,
    stageLabel: null,
    percent: 0,
    message: null,
    startedAt: null,
    updatedAt: nowIso,
    finishedAt: null,
    exitCode: null,
    mode: null,
    branch: null,
    fromSha: null,
    toSha: null,
    migrationsApplied: 0,
    error: null,
    log: [],
  };
}
