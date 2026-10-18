/**
 * Ход импорта минорных фракций из дампа EDSM: этапы, проценты и журнал.
 *
 * Общий модуль для трёх мест:
 *   * сервер (`bgsSync.ts`) отмечает здесь каждый шаг импорта;
 *   * админка (Игровые данные → Фракции) рисует по нему прогресс-бары этапов
 *     и журнал процесса;
 *   * вкладка «Фракции» в Atlas показывает короткую строку «сервер загружает
 *     данные EDSM: скачивание дампа, 37 %».
 *
 * Устроен так же, как ход импорта PowerPlay (`powerplayProgress.ts`), но с
 * другими этапами: дамп большой (≈0,5 ГБ), поэтому он сначала скачивается на
 * диск с докачкой, а разбор и запись идут одним потоком.
 *
 * Только стираемый TypeScript без зависимостей: модуль импортируют тесты,
 * сервер и браузер.
 */

export const BGS_SYNC_STAGES = [
  { id: 'probe', label: 'Запрос к EDSM', weight: 3 },
  { id: 'download', label: 'Скачивание дампа на диск', weight: 57 },
  { id: 'import', label: 'Разбор и запись в базу', weight: 35 },
  { id: 'finish', label: 'Завершение', weight: 5 },
] as const;

export type BgsStageId = (typeof BGS_SYNC_STAGES)[number]['id'];
export type BgsStageStatus = 'pending' | 'running' | 'done' | 'skipped' | 'error';
export type BgsSyncTrigger = 'admin' | 'cron' | 'manual';
export type BgsSyncPhase = 'running' | 'ok' | 'not_modified' | 'error' | 'cancelled';
export type BgsLogLevel = 'info' | 'warn' | 'error';

const STAGE_IDS = BGS_SYNC_STAGES.map((stage) => stage.id) as readonly string[];
const STAGE_STATUSES: readonly string[] = ['pending', 'running', 'done', 'skipped', 'error'];
const TRIGGERS: readonly string[] = ['admin', 'cron', 'manual'];
const PHASES: readonly string[] = ['running', 'ok', 'not_modified', 'error', 'cancelled'];
const LEVELS: readonly string[] = ['info', 'warn', 'error'];

export const BGS_TRIGGER_LABEL: Record<BgsSyncTrigger, string> = {
  admin: 'вручную из админки',
  cron: 'задача планировщика factions-sync',
  manual: 'вручную',
};

export const BGS_PHASE_LABEL: Record<BgsSyncPhase, string> = {
  running: 'идёт загрузка',
  ok: 'загружено',
  not_modified: 'без изменений',
  error: 'ошибка',
  cancelled: 'остановлено',
};

export const BGS_LOG_LIMIT = 250;
const LOG_TEXT_LIMIT = 400;

export interface BgsStageProgress {
  id: BgsStageId;
  status: BgsStageStatus;
  /** Сделано: байты (скачивание, разбор по сжатому файлу) или шаги. */
  done: number;
  total: number | null;
  /** Подпись под полосой этапа: «212 из 498 МБ · 1,4 МБ/с». */
  detail: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface BgsSyncSummary {
  systems?: number;
  factions?: number;
  presence?: number;
  applied?: number;
  stale?: number;
  deletedSystems?: number;
  durationMs?: number;
  error?: string;
}

export interface BgsSyncProgress {
  id: string;
  trigger: BgsSyncTrigger;
  force: boolean;
  phase: BgsSyncPhase;
  stage: BgsStageId | null;
  /** Общий процент 0–100 по весам этапов. */
  percent: number;
  message: string;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  stages: BgsStageProgress[];
  result: BgsSyncSummary | null;
}

export interface BgsLogLine {
  at: string;
  level: BgsLogLevel;
  text: string;
}

/** Короткая сводка для публичного API слоя. */
export interface BgsPublicProgress {
  stage: BgsStageId | null;
  stageLabel: string;
  percent: number;
  message: string;
  startedAt: string | null;
}

function iso(now: number | string | Date = Date.now()): string {
  if (typeof now === 'string') return now;
  return (now instanceof Date ? now : new Date(now)).toISOString();
}

export function bgsStageLabel(id: BgsStageId | null | undefined): string {
  return BGS_SYNC_STAGES.find((stage) => stage.id === id)?.label ?? '';
}

export function createBgsProgress(options: {
  id: string;
  trigger?: BgsSyncTrigger;
  force?: boolean;
  now?: number | string | Date;
}): BgsSyncProgress {
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
    stages: BGS_SYNC_STAGES.map((stage) => ({
      id: stage.id,
      status: 'pending' as BgsStageStatus,
      done: 0,
      total: null,
      detail: '',
      startedAt: null,
      finishedAt: null,
    })),
    result: null,
  };
}

function stageOf(progress: BgsSyncProgress, id: BgsStageId): BgsStageProgress {
  const stage = progress.stages.find((item) => item.id === id);
  if (!stage) throw new Error(`неизвестный этап импорта фракций: ${id}`);
  return stage;
}

export function bgsStageFraction(stage: BgsStageProgress): number {
  if (stage.status === 'done' || stage.status === 'skipped') return 1;
  if (stage.status === 'pending') return 0;
  if (stage.total && stage.total > 0) return Math.max(0, Math.min(1, stage.done / stage.total));
  return 0;
}

export function computeBgsPercent(progress: Pick<BgsSyncProgress, 'stages'>): number {
  let total = 0;
  let done = 0;
  for (const def of BGS_SYNC_STAGES) {
    total += def.weight;
    const stage = progress.stages.find((item) => item.id === def.id);
    if (stage) done += def.weight * bgsStageFraction(stage);
  }
  return total > 0 ? Math.round((done / total) * 1000) / 10 : 0;
}

function touch(progress: BgsSyncProgress, now?: number | string | Date): void {
  progress.updatedAt = iso(now);
  progress.percent = computeBgsPercent(progress);
}

function describe(stage: BgsStageProgress): string {
  const label = bgsStageLabel(stage.id);
  return stage.detail ? `${label}: ${stage.detail}` : `${label}…`;
}

export function startBgsStage(
  progress: BgsSyncProgress,
  id: BgsStageId,
  options: { total?: number | null; done?: number; detail?: string; now?: number | string | Date } = {},
): BgsStageProgress {
  const stage = stageOf(progress, id);
  stage.status = 'running';
  stage.done = Math.max(0, options.done ?? 0);
  stage.total = options.total ?? null;
  stage.detail = options.detail ?? '';
  stage.startedAt = iso(options.now);
  stage.finishedAt = null;
  progress.stage = id;
  progress.message = describe(stage);
  touch(progress, options.now);
  return stage;
}

export function updateBgsStage(
  progress: BgsSyncProgress,
  id: BgsStageId,
  patch: { done?: number; total?: number | null; detail?: string; now?: number | string | Date },
): BgsStageProgress {
  const stage = stageOf(progress, id);
  if (typeof patch.done === 'number' && Number.isFinite(patch.done)) stage.done = Math.max(0, patch.done);
  if (patch.total !== undefined) stage.total = patch.total;
  if (typeof patch.detail === 'string') stage.detail = patch.detail;
  if (progress.stage === id) progress.message = describe(stage);
  touch(progress, patch.now);
  return stage;
}

export function finishBgsStage(
  progress: BgsSyncProgress,
  id: BgsStageId,
  options: { status?: 'done' | 'skipped' | 'error'; detail?: string; now?: number | string | Date } = {},
): BgsStageProgress {
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

export function finishBgsProgress(
  progress: BgsSyncProgress,
  phase: Exclude<BgsSyncPhase, 'running'>,
  options: { message?: string; result?: BgsSyncSummary | null; now?: number | string | Date } = {},
): BgsSyncProgress {
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

export function pushBgsLog(
  log: BgsLogLine[],
  level: BgsLogLevel,
  text: string,
  options: { now?: number | string | Date; limit?: number } = {},
): BgsLogLine {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, LOG_TEXT_LIMIT) || '—';
  const line: BgsLogLine = { at: iso(options.now), level, text: clean };
  log.push(line);
  const limit = Math.max(1, options.limit ?? BGS_LOG_LIMIT);
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

const SUMMARY_FIELDS = ['systems', 'factions', 'presence', 'applied', 'stale', 'deletedSystems', 'durationMs'] as const;

/** Ход импорта из JSON (база, ответ API): всё непонятное отбрасывается. */
export function sanitizeBgsProgress(value: unknown): BgsSyncProgress | null {
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
  const stages: BgsStageProgress[] = BGS_SYNC_STAGES.map((def) => {
    const item = byId.get(def.id) ?? {};
    const status = STAGE_STATUSES.includes(String(item.status)) ? (item.status as BgsStageStatus) : 'pending';
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
  const resultRaw = raw.result && typeof raw.result === 'object' && !Array.isArray(raw.result)
    ? raw.result as Record<string, unknown>
    : null;
  let result: BgsSyncSummary | null = null;
  if (resultRaw) {
    result = {};
    for (const field of SUMMARY_FIELDS) {
      if (resultRaw[field] != null) result[field] = asCount(resultRaw[field]);
    }
    if (typeof resultRaw.error === 'string') result.error = resultRaw.error.slice(0, 500);
  }
  const progress: BgsSyncProgress = {
    id: raw.id.slice(0, 64),
    trigger: TRIGGERS.includes(String(raw.trigger)) ? (raw.trigger as BgsSyncTrigger) : 'manual',
    force: raw.force === true,
    phase: PHASES.includes(String(raw.phase)) ? (raw.phase as BgsSyncPhase) : 'error',
    stage: STAGE_IDS.includes(String(raw.stage)) ? (raw.stage as BgsStageId) : null,
    percent: 0,
    message: typeof raw.message === 'string' ? raw.message.slice(0, 300) : '',
    startedAt,
    updatedAt: asIso(raw.updatedAt) ?? startedAt,
    finishedAt: asIso(raw.finishedAt),
    stages,
    result,
  };
  const percent = Number(raw.percent);
  progress.percent = progress.phase === 'ok' || progress.phase === 'not_modified'
    ? 100
    : Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : computeBgsPercent(progress);
  return progress;
}

export function sanitizeBgsLog(value: unknown, limit = BGS_LOG_LIMIT): BgsLogLine[] {
  if (!Array.isArray(value)) return [];
  const out: BgsLogLine[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    const at = asIso(raw.at);
    if (!at || typeof raw.text !== 'string') continue;
    out.push({
      at,
      level: LEVELS.includes(String(raw.level)) ? (raw.level as BgsLogLevel) : 'info',
      text: raw.text.slice(0, LOG_TEXT_LIMIT),
    });
  }
  return out.slice(-Math.max(1, limit));
}

export function publicBgsProgress(progress: BgsSyncProgress | null | undefined): BgsPublicProgress | null {
  if (!progress || progress.phase !== 'running') return null;
  return {
    stage: progress.stage,
    stageLabel: bgsStageLabel(progress.stage),
    percent: progress.percent,
    message: progress.message.slice(0, 160),
    startedAt: progress.startedAt,
  };
}

/* ── Подписи ────────────────────────────────────────────────────────────── */

export function formatBgsBytes(value: number | null | undefined): string {
  const bytes = Number(value ?? 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 Б';
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const scaled = bytes / 1024 ** index;
  const digits = index === 0 || scaled >= 100 ? 0 : 1;
  return `${scaled.toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${units[index]}`;
}

export function formatBgsCount(value: number | null | undefined): string {
  return Math.round(Number(value ?? 0) || 0).toLocaleString('ru-RU');
}

/** «12,4 с», «2 мин 05 с», «1 ч 04 мин». */
export function formatBgsDuration(ms: number | null | undefined): string {
  const value = Number(ms ?? 0);
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value < 60_000) return `${(value / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} с`;
  if (value < 3_600_000) {
    const minutes = Math.floor(value / 60_000);
    const seconds = Math.round((value % 60_000) / 1000);
    return `${minutes} мин ${String(seconds).padStart(2, '0')} с`;
  }
  const hours = Math.floor(value / 3_600_000);
  const minutes = Math.round((value % 3_600_000) / 60_000);
  return `${hours} ч ${String(minutes).padStart(2, '0')} мин`;
}

/** «1,4 МБ/с». */
export function formatBgsSpeed(bytesPerSecond: number | null | undefined): string {
  const value = Number(bytesPerSecond ?? 0);
  if (!Number.isFinite(value) || value <= 0) return '—';
  return `${formatBgsBytes(value)}/с`;
}
