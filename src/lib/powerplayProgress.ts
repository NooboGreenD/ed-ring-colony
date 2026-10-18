/**
 * Ход импорта PowerPlay: этапы, проценты и журнал процесса.
 *
 * Общий модуль для трёх мест:
 *   * сервер (`powerplaySync.ts`) отмечает здесь каждый шаг импорта дампа EDSM;
 *   * админка (Игровые данные → PowerPlay) рисует по нему прогресс-бары этапов
 *     и журнал процесса;
 *   * вкладка «PowerPlay» в Atlas показывает короткую строку «сервер загружает
 *     данные EDSM: запись в базу, 64 %» — чтобы было видно, что загрузка идёт.
 *
 * Только стираемый TypeScript без зависимостей: тесты (`node --test`)
 * импортируют модуль напрямую, браузерный бандл — тоже.
 */

export const POWERPLAY_SYNC_STAGES = [
  { id: 'request', label: 'Запрос к EDSM', weight: 4 },
  { id: 'download', label: 'Скачивание дампа', weight: 36 },
  { id: 'decode', label: 'Распаковка gzip', weight: 5 },
  { id: 'parse', label: 'Разбор записей', weight: 10 },
  { id: 'write', label: 'Запись в базу', weight: 40 },
  { id: 'finish', label: 'Завершение', weight: 5 },
] as const;

export type PowerplayStageId = (typeof POWERPLAY_SYNC_STAGES)[number]['id'];
export type PowerplayStageStatus = 'pending' | 'running' | 'done' | 'skipped' | 'error';
/** Кто запустил импорт. */
export type PowerplaySyncTrigger = 'admin' | 'cron' | 'lazy' | 'manual';
export type PowerplaySyncPhase = 'running' | 'ok' | 'not_modified' | 'error' | 'cancelled';
export type PowerplayLogLevel = 'info' | 'warn' | 'error';

const STAGE_IDS = POWERPLAY_SYNC_STAGES.map((stage) => stage.id) as readonly string[];
const STAGE_STATUSES: readonly string[] = ['pending', 'running', 'done', 'skipped', 'error'];
const TRIGGERS: readonly string[] = ['admin', 'cron', 'lazy', 'manual'];
const PHASES: readonly string[] = ['running', 'ok', 'not_modified', 'error', 'cancelled'];
const LEVELS: readonly string[] = ['info', 'warn', 'error'];

export const POWERPLAY_TRIGGER_LABEL: Record<PowerplaySyncTrigger, string> = {
  admin: 'вручную из админки',
  cron: 'задача планировщика powerplay-sync',
  lazy: 'автоматически: открыли вкладку PowerPlay, а данных нет или они старше суток',
  manual: 'вручную',
};

export const POWERPLAY_PHASE_LABEL: Record<PowerplaySyncPhase, string> = {
  running: 'идёт загрузка',
  ok: 'загружено',
  not_modified: 'без изменений',
  error: 'ошибка',
  cancelled: 'остановлено',
};

/** Сколько строк журнала хранить: прогон — это 20–40 строк, хватит на несколько. */
export const POWERPLAY_LOG_LIMIT = 200;
const LOG_TEXT_LIMIT = 400;

export interface PowerplayStageProgress {
  id: PowerplayStageId;
  status: PowerplayStageStatus;
  /** Сделано: байты (скачивание, распаковка), записи (разбор), строки (запись). */
  done: number;
  /** Всего, если известно заранее. */
  total: number | null;
  /** Подпись под полосой этапа: «1,6 из 3,6 МБ», «пачка 3 из 14». */
  detail: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface PowerplaySyncSummary {
  rows?: number;
  deleted?: number;
  total?: number;
  durationMs?: number;
  error?: string;
}

export interface PowerplaySyncProgress {
  /** Идентификатор попытки (не путать с `run_id` записанного набора). */
  id: string;
  trigger: PowerplaySyncTrigger;
  force: boolean;
  phase: PowerplaySyncPhase;
  /** Этап, который идёт сейчас (или на котором прогон закончился). */
  stage: PowerplayStageId | null;
  /** Общий процент 0–100 по весам этапов. */
  percent: number;
  /** Что происходит прямо сейчас — одной строкой. */
  message: string;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  stages: PowerplayStageProgress[];
  result: PowerplaySyncSummary | null;
}

export interface PowerplayLogLine {
  at: string;
  level: PowerplayLogLevel;
  text: string;
}

/** Короткая сводка для публичного API слоя: без триггера, журнала и ошибок. */
export interface PowerplayPublicProgress {
  stage: PowerplayStageId | null;
  stageLabel: string;
  percent: number;
  message: string;
  startedAt: string | null;
}

function iso(now: number | string | Date = Date.now()): string {
  if (typeof now === 'string') return now;
  return (now instanceof Date ? now : new Date(now)).toISOString();
}

export function powerplayStageLabel(id: PowerplayStageId | null | undefined): string {
  return POWERPLAY_SYNC_STAGES.find((stage) => stage.id === id)?.label ?? '';
}

export function createPowerplayProgress(options: {
  id: string;
  trigger?: PowerplaySyncTrigger;
  force?: boolean;
  now?: number | string | Date;
}): PowerplaySyncProgress {
  const at = iso(options.now);
  return {
    id: options.id,
    trigger: options.trigger ?? 'manual',
    force: options.force === true,
    phase: 'running',
    stage: null,
    percent: 0,
    message: 'Подготовка импорта',
    startedAt: at,
    updatedAt: at,
    finishedAt: null,
    stages: POWERPLAY_SYNC_STAGES.map((stage) => ({
      id: stage.id,
      status: 'pending' as PowerplayStageStatus,
      done: 0,
      total: null,
      detail: '',
      startedAt: null,
      finishedAt: null,
    })),
    result: null,
  };
}

function stageOf(progress: PowerplaySyncProgress, id: PowerplayStageId): PowerplayStageProgress {
  const stage = progress.stages.find((item) => item.id === id);
  if (!stage) throw new Error(`неизвестный этап импорта PowerPlay: ${id}`);
  return stage;
}

/** Доля этапа 0–1: готовый и пропущенный — целиком, идущий — по счётчику. */
export function powerplayStageFraction(stage: PowerplayStageProgress): number {
  if (stage.status === 'done' || stage.status === 'skipped') return 1;
  if (stage.status === 'pending') return 0;
  if (stage.total && stage.total > 0) return Math.max(0, Math.min(1, stage.done / stage.total));
  return 0;
}

/** Общий процент по весам этапов, с одним знаком после запятой. */
export function computePowerplayPercent(progress: Pick<PowerplaySyncProgress, 'stages'>): number {
  let total = 0;
  let done = 0;
  for (const def of POWERPLAY_SYNC_STAGES) {
    total += def.weight;
    const stage = progress.stages.find((item) => item.id === def.id);
    if (stage) done += def.weight * powerplayStageFraction(stage);
  }
  return total > 0 ? Math.round((done / total) * 1000) / 10 : 0;
}

function touch(progress: PowerplaySyncProgress, now?: number | string | Date): void {
  progress.updatedAt = iso(now);
  progress.percent = computePowerplayPercent(progress);
}

function describe(stage: PowerplayStageProgress): string {
  const label = powerplayStageLabel(stage.id);
  return stage.detail ? `${label}: ${stage.detail}` : `${label}…`;
}

export function startPowerplayStage(
  progress: PowerplaySyncProgress,
  id: PowerplayStageId,
  options: { total?: number | null; detail?: string; now?: number | string | Date } = {},
): PowerplayStageProgress {
  const stage = stageOf(progress, id);
  stage.status = 'running';
  stage.done = 0;
  stage.total = options.total ?? null;
  stage.detail = options.detail ?? '';
  stage.startedAt = iso(options.now);
  stage.finishedAt = null;
  progress.stage = id;
  progress.message = describe(stage);
  touch(progress, options.now);
  return stage;
}

export function updatePowerplayStage(
  progress: PowerplaySyncProgress,
  id: PowerplayStageId,
  patch: { done?: number; total?: number | null; detail?: string; now?: number | string | Date },
): PowerplayStageProgress {
  const stage = stageOf(progress, id);
  if (typeof patch.done === 'number' && Number.isFinite(patch.done)) stage.done = Math.max(0, patch.done);
  if (patch.total !== undefined) stage.total = patch.total;
  if (typeof patch.detail === 'string') stage.detail = patch.detail;
  if (progress.stage === id) progress.message = describe(stage);
  touch(progress, patch.now);
  return stage;
}

export function finishPowerplayStage(
  progress: PowerplaySyncProgress,
  id: PowerplayStageId,
  options: { status?: 'done' | 'skipped' | 'error'; detail?: string; now?: number | string | Date } = {},
): PowerplayStageProgress {
  const stage = stageOf(progress, id);
  const status = options.status ?? 'done';
  stage.status = status;
  if (status === 'done' && stage.total != null && stage.total > 0) stage.done = Math.max(stage.done, stage.total);
  if (typeof options.detail === 'string') stage.detail = options.detail;
  stage.startedAt = stage.startedAt ?? iso(options.now);
  stage.finishedAt = iso(options.now);
  touch(progress, options.now);
  return stage;
}

/** Завершить прогон: этапы, до которых не дошли, помечаются «пропущен» (304) или остаются как есть. */
export function finishPowerplayProgress(
  progress: PowerplaySyncProgress,
  phase: Exclude<PowerplaySyncPhase, 'running'>,
  options: { message?: string; result?: PowerplaySyncSummary | null; now?: number | string | Date } = {},
): PowerplaySyncProgress {
  const at = iso(options.now);
  for (const stage of progress.stages) {
    if (stage.status === 'running') {
      stage.status = phase === 'ok' || phase === 'not_modified' ? 'done' : 'error';
      stage.finishedAt = at;
    } else if (stage.status === 'pending' && (phase === 'ok' || phase === 'not_modified')) {
      stage.status = 'skipped';
    }
  }
  progress.phase = phase;
  progress.finishedAt = at;
  progress.result = options.result ?? progress.result;
  if (options.message) progress.message = options.message;
  touch(progress, at);
  if (phase === 'ok' || phase === 'not_modified') progress.percent = 100;
  return progress;
}

/** Строка журнала с ограничением длины; журнал обрезается сверху до `limit`. */
export function pushPowerplayLog(
  log: PowerplayLogLine[],
  level: PowerplayLogLevel,
  text: string,
  options: { now?: number | string | Date; limit?: number } = {},
): PowerplayLogLine {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, LOG_TEXT_LIMIT) || '—';
  const line: PowerplayLogLine = { at: iso(options.now), level, text: clean };
  log.push(line);
  const limit = Math.max(1, options.limit ?? POWERPLAY_LOG_LIMIT);
  if (log.length > limit) log.splice(0, log.length - limit);
  return line;
}

function asIso(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

function asCount(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

/** Ход импорта из JSON (база, ответ API): всё непонятное отбрасывается. */
export function sanitizePowerplayProgress(value: unknown): PowerplaySyncProgress | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const startedAt = asIso(raw.startedAt);
  if (!startedAt || typeof raw.id !== 'string') return null;
  const byId = new Map<string, Record<string, unknown>>();
  if (Array.isArray(raw.stages)) {
    for (const item of raw.stages) {
      if (item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string') {
        byId.set((item as { id: string }).id, item as Record<string, unknown>);
      }
    }
  }
  const stages: PowerplayStageProgress[] = POWERPLAY_SYNC_STAGES.map((def) => {
    const item = byId.get(def.id) ?? {};
    const status = STAGE_STATUSES.includes(String(item.status)) ? (item.status as PowerplayStageStatus) : 'pending';
    const total = item.total == null ? null : asCount(item.total) || null;
    return {
      id: def.id,
      status,
      done: asCount(item.done),
      total,
      detail: typeof item.detail === 'string' ? item.detail.slice(0, 200) : '',
      startedAt: asIso(item.startedAt),
      finishedAt: asIso(item.finishedAt),
    };
  });
  const result = raw.result && typeof raw.result === 'object' && !Array.isArray(raw.result)
    ? raw.result as Record<string, unknown>
    : null;
  const progress: PowerplaySyncProgress = {
    id: raw.id.slice(0, 64),
    trigger: TRIGGERS.includes(String(raw.trigger)) ? (raw.trigger as PowerplaySyncTrigger) : 'manual',
    force: raw.force === true,
    phase: PHASES.includes(String(raw.phase)) ? (raw.phase as PowerplaySyncPhase) : 'error',
    stage: STAGE_IDS.includes(String(raw.stage)) ? (raw.stage as PowerplayStageId) : null,
    percent: 0,
    message: typeof raw.message === 'string' ? raw.message.slice(0, 300) : '',
    startedAt,
    updatedAt: asIso(raw.updatedAt) ?? startedAt,
    finishedAt: asIso(raw.finishedAt),
    stages,
    result: result
      ? {
          ...(result.rows != null ? { rows: asCount(result.rows) } : {}),
          ...(result.deleted != null ? { deleted: asCount(result.deleted) } : {}),
          ...(result.total != null ? { total: asCount(result.total) } : {}),
          ...(result.durationMs != null ? { durationMs: asCount(result.durationMs) } : {}),
          ...(typeof result.error === 'string' ? { error: result.error.slice(0, 500) } : {}),
        }
      : null,
  };
  // Процент считает сервер по тем же весам; если его нет — пересчитать по этапам.
  const percent = Number(raw.percent);
  progress.percent = progress.phase === 'ok' || progress.phase === 'not_modified'
    ? 100
    : Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : computePowerplayPercent(progress);
  return progress;
}

export function sanitizePowerplayLog(value: unknown, limit = POWERPLAY_LOG_LIMIT): PowerplayLogLine[] {
  if (!Array.isArray(value)) return [];
  const out: PowerplayLogLine[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    const at = asIso(raw.at);
    if (!at || typeof raw.text !== 'string') continue;
    out.push({
      at,
      level: LEVELS.includes(String(raw.level)) ? (raw.level as PowerplayLogLevel) : 'info',
      text: raw.text.slice(0, LOG_TEXT_LIMIT),
    });
  }
  return out.slice(-Math.max(1, limit));
}

/** Для вкладки Atlas: этап и процент идущего импорта, без подробностей сервера. */
export function publicPowerplayProgress(progress: PowerplaySyncProgress | null | undefined): PowerplayPublicProgress | null {
  if (!progress || progress.phase !== 'running') return null;
  return {
    stage: progress.stage,
    stageLabel: powerplayStageLabel(progress.stage),
    percent: progress.percent,
    message: progress.message.slice(0, 160),
    startedAt: progress.startedAt,
  };
}

export function sanitizePublicPowerplayProgress(value: unknown): PowerplayPublicProgress | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const percent = Number(raw.percent);
  const stage = STAGE_IDS.includes(String(raw.stage)) ? (raw.stage as PowerplayStageId) : null;
  return {
    stage,
    stageLabel: powerplayStageLabel(stage),
    percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0,
    message: typeof raw.message === 'string' ? raw.message.slice(0, 160) : '',
    startedAt: asIso(raw.startedAt),
  };
}

/* ── Подписи ────────────────────────────────────────────────────────────── */

/** «3,6 МБ» — размеры в журнале и под полосами. */
export function formatPowerplayBytes(value: number | null | undefined): string {
  const bytes = Number(value ?? 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 Б';
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const scaled = bytes / 1024 ** index;
  const digits = index === 0 || scaled >= 100 ? 0 : 1;
  return `${scaled.toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${units[index]}`;
}

export function formatPowerplayCount(value: number | null | undefined): string {
  return Math.round(Number(value ?? 0) || 0).toLocaleString('ru-RU');
}

/** «12,4 с», «2 мин 05 с». */
export function formatPowerplayDuration(ms: number | null | undefined): string {
  const value = Number(ms ?? 0);
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value < 60_000) return `${(value / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} с`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1000);
  return `${minutes} мин ${String(seconds).padStart(2, '0')} с`;
}
