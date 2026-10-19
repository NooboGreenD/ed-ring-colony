/**
 * Ход импорта дампа: этапы, проценты и журнал процесса — общий механизм.
 *
 * Импорты, устроенные как «Каталог систем» (архив скачивается на сервер
 * ЦЕЛИКОМ → затем разбивается на куски → затем куски пишутся в базу, шаги по
 * очереди), отмечают здесь каждый шаг:
 *   * минорные фракции — `bgsProgress.ts` (дамп `systemsPopulated.json.gz`);
 *   * PowerPlay — `powerplayProgress.ts` (дамп `powerPlay.json.gz`).
 *
 * Модуль знает только общее: этапы с весами, виды запуска (какие этапы в нём
 * есть), общий процент, «текущий» этап, журнал, разбор сохранённого хода из
 * JSON и короткую сводку для публичного API. Названия, веса, кто запускает и
 * какие поля у итога — задаёт каждый импорт сам (`createImportProgressKit`).
 *
 * Только стираемый TypeScript без зависимостей: модуль импортируют тесты
 * (`node --test`), сервер и браузер.
 */

export type ImportStageStatus = 'pending' | 'running' | 'done' | 'skipped' | 'error';
export type ImportPhase = 'running' | 'ok' | 'not_modified' | 'error' | 'cancelled';
export type ImportLogLevel = 'info' | 'warn' | 'error';
type When = number | string | Date;

/**
 * Что делает запуск импорта архивом: `full` — всё (скачать → разбить →
 * загрузить → завершить), `download` — только скачать архив на сервер,
 * `split` — только разбить архив на куски, `import` — загрузить в базу то, что
 * уже лежит на сервере, без обращения к источнику.
 */
export type ArchiveImportMode = 'full' | 'download' | 'split' | 'import';
export type ArchiveImportStageId = 'probe' | 'download' | 'split' | 'import' | 'finish';

export const ARCHIVE_IMPORT_MODE_STAGES: Readonly<Record<ArchiveImportMode, readonly ArchiveImportStageId[]>> = {
  full: ['probe', 'download', 'split', 'import', 'finish'],
  download: ['probe', 'download'],
  split: ['split'],
  import: ['split', 'import', 'finish'],
};

export const ARCHIVE_IMPORT_MODE_LABEL: Readonly<Record<ArchiveImportMode, string>> = {
  full: 'загрузка данных (скачать архив целиком → разбить на куски → записать в базу, по очереди)',
  download: 'только скачивание архива на сервер',
  split: 'только разбивка архива на куски',
  import: 'загрузка в базу того, что уже на сервере (без EDSM)',
};

export const IMPORT_PHASE_LABEL: Readonly<Record<ImportPhase, string>> = {
  running: 'идёт загрузка',
  ok: 'загружено',
  not_modified: 'без изменений',
  error: 'ошибка',
  cancelled: 'остановлено',
};

/** Ход, оставшийся в базе «идущим», а живого импорта нет — сайт перезапустился посреди работы. */
export const IMPORT_INTERRUPTED_MESSAGE =
  'Прервано перезапуском сайта — скачанное и разбитое осталось на сервере, следующий запуск продолжит с того же места';

const STAGE_STATUSES: readonly string[] = ['pending', 'running', 'done', 'skipped', 'error'];
const PHASES: readonly string[] = ['running', 'ok', 'not_modified', 'error', 'cancelled'];
const LEVELS: readonly string[] = ['info', 'warn', 'error'];
const LOG_TEXT_LIMIT = 400;

export interface ImportStageDef<S extends string = string> {
  readonly id: S;
  readonly label: string;
  /** Доля этапа в общем проценте (веса этапов импорта в сумме — 100). */
  readonly weight: number;
}

export interface ImportStageProgress<S extends string = string> {
  id: S;
  status: ImportStageStatus;
  /** Сделано: байты (скачивание, разбивка) или шаги (куски, пачки). */
  done: number;
  /** Всего, если известно заранее. */
  total: number | null;
  /** Подпись под полосой этапа: «212 из 498 МБ · 1,4 МБ/с». */
  detail: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ImportProgress<
  S extends string = string,
  M extends string = string,
  T extends string = string,
  R extends object = Record<string, unknown>,
> {
  /** Идентификатор попытки (не путать с меткой записанного набора). */
  id: string;
  trigger: T;
  force: boolean;
  mode: M;
  phase: ImportPhase;
  /** Этап, который идёт сейчас (или на котором прогон закончился). */
  stage: S | null;
  /** Общий процент 0–100 по весам этапов этого запуска. */
  percent: number;
  /** Что происходит прямо сейчас — одной строкой. */
  message: string;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  stages: ImportStageProgress<S>[];
  result: R | null;
}

export interface ImportLogLine {
  at: string;
  level: ImportLogLevel;
  text: string;
}

/** Короткая сводка для публичного API слоя: без триггера, журнала и ошибок. */
export interface ImportPublicProgress<S extends string = string, M extends string = string> {
  stage: S | null;
  stageLabel: string;
  percent: number;
  message: string;
  startedAt: string | null;
  mode?: M;
}

export interface ImportProgressConfig<S extends string, M extends string, T extends string> {
  stages: readonly ImportStageDef<S>[];
  /** Этапы каждого вида запуска; остальные сразу «не нужен» и в процент не входят. */
  modeStages: Readonly<Record<M, readonly S[]>>;
  defaultMode: M;
  triggers: readonly T[];
  defaultTrigger: T;
  /** Сколько строк журнала хранить. */
  logLimit: number;
  /** Числовые поля итога, которые переживают разбор из JSON (`error` — всегда). */
  summaryFields: readonly string[];
  /** «фракций», «PowerPlay» — в тексте ошибки о неизвестном этапе. */
  subject: string;
  interruptedMessage?: string;
  /** Этапы прежних версий сайта → нынешние: ход, сохранённый до обновления, читается по-новому. */
  legacyStages?: Readonly<Record<string, S>>;
}

function iso(now: When = Date.now()): string {
  if (typeof now === 'string') return now;
  return (now instanceof Date ? now : new Date(now)).toISOString();
}

function asIso(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

function asCount(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

/** Доля этапа 0–1: готовый и пропущенный — целиком, идущий — по счётчику. */
export function importStageFraction(stage: Pick<ImportStageProgress, 'status' | 'done' | 'total'>): number {
  if (stage.status === 'done' || stage.status === 'skipped') return 1;
  if (stage.status === 'pending') return 0;
  if (stage.total && stage.total > 0) return Math.max(0, Math.min(1, stage.done / stage.total));
  return 0;
}

/**
 * Набор функций хода импорта для одного вида данных. Все функции —
 * замыкания без `this`: их можно экспортировать под своими именами
 * (`export const startBgsStage = kit.start`).
 */
export function createImportProgressKit<S extends string, M extends string, T extends string, R extends object>(
  config: ImportProgressConfig<S, M, T>,
) {
  type Progress = ImportProgress<S, M, T, R>;
  type Stage = ImportStageProgress<S>;
  const defs = config.stages;
  const stageIds = defs.map((def) => def.id) as readonly string[];
  const modes = Object.keys(config.modeStages);
  const triggers = config.triggers as readonly string[];
  const legacy = (config.legacyStages ?? {}) as Readonly<Record<string, string>>;
  const interruptedMessage = config.interruptedMessage ?? IMPORT_INTERRUPTED_MESSAGE;
  const currentId = (value: unknown): string => {
    const id = String(value);
    return Object.prototype.hasOwnProperty.call(legacy, id) ? legacy[id] : id;
  };

  const stageLabel = (id: S | null | undefined): string => defs.find((def) => def.id === id)?.label ?? '';

  const create = (options: { id: string; trigger?: T; force?: boolean; mode?: M; now?: When }): Progress => {
    const at = iso(options.now);
    const mode = options.mode ?? config.defaultMode;
    const included = config.modeStages[mode] ?? config.modeStages[config.defaultMode];
    return {
      id: options.id,
      trigger: options.trigger ?? config.defaultTrigger,
      force: options.force === true,
      mode,
      phase: 'running',
      stage: null,
      percent: 0,
      message: 'Подготовка импорта',
      startedAt: at,
      updatedAt: at,
      finishedAt: null,
      stages: defs.map((def) => ({
        id: def.id,
        // Этапы, которых в этом запуске нет, в процент не входят.
        status: (included.includes(def.id) ? 'pending' : 'skipped') as ImportStageStatus,
        done: 0,
        total: null,
        detail: '',
        startedAt: null,
        finishedAt: null,
      })),
      result: null,
    };
  };

  const stageOf = (progress: Progress, id: S): Stage => {
    const stage = progress.stages.find((item) => item.id === id);
    if (!stage) throw new Error(`неизвестный этап импорта ${config.subject}: ${id}`);
    return stage;
  };

  /** Общий процент по весам этапов; пропущенные («не нужен») в расчёт не входят. */
  const percent = (progress: Pick<Progress, 'stages'>): number => {
    let total = 0;
    let done = 0;
    for (const def of defs) {
      const stage = progress.stages.find((item) => item.id === def.id);
      if (stage?.status === 'skipped') continue;
      total += def.weight;
      if (stage) done += def.weight * importStageFraction(stage);
    }
    return total > 0 ? Math.round((done / total) * 1000) / 10 : 0;
  };

  const describe = (stage: Stage): string => {
    const label = stageLabel(stage.id);
    return stage.detail ? `${label}: ${stage.detail}` : `${label}…`;
  };

  /** «Текущий» этап для строки состояния — первый из идущих (они идут по очереди). */
  const leadingStage = (progress: Progress): Stage | null => {
    for (const def of defs) {
      const stage = progress.stages.find((item) => item.id === def.id);
      if (stage?.status === 'running') return stage;
    }
    return null;
  };

  const touch = (progress: Progress, now?: When): void => {
    progress.updatedAt = iso(now);
    progress.percent = percent(progress);
    if (progress.phase !== 'running') return;
    const lead = leadingStage(progress);
    if (lead) {
      progress.stage = lead.id;
      progress.message = describe(lead);
    }
  };

  const start = (
    progress: Progress,
    id: S,
    options: { total?: number | null; done?: number; detail?: string; now?: When } = {},
  ): Stage => {
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
  };

  /** Этап снова «ждёт» (дамп у источника сменился — скачивание и разбивка начинаются заново). */
  const reset = (progress: Progress, id: S, now?: When): Stage => {
    const stage = stageOf(progress, id);
    if (stage.status !== 'skipped') stage.status = 'pending';
    stage.done = 0;
    stage.total = null;
    stage.detail = '';
    stage.startedAt = null;
    stage.finishedAt = null;
    touch(progress, now);
    return stage;
  };

  const update = (
    progress: Progress,
    id: S,
    patch: { done?: number; total?: number | null; detail?: string; now?: When },
  ): Stage => {
    const stage = stageOf(progress, id);
    if (typeof patch.done === 'number' && Number.isFinite(patch.done)) stage.done = Math.max(0, patch.done);
    if (patch.total !== undefined) stage.total = patch.total;
    if (typeof patch.detail === 'string') stage.detail = patch.detail;
    touch(progress, patch.now);
    return stage;
  };

  const finishStage = (
    progress: Progress,
    id: S,
    options: { status?: 'done' | 'skipped' | 'error'; detail?: string; now?: When } = {},
  ): Stage => {
    const stage = stageOf(progress, id);
    const status = options.status ?? 'done';
    stage.status = status;
    if (status === 'done' && stage.total != null && stage.total > 0) stage.done = Math.max(stage.done, stage.total);
    if (typeof options.detail === 'string') stage.detail = options.detail;
    stage.startedAt = stage.startedAt ?? iso(options.now);
    stage.finishedAt = iso(options.now);
    touch(progress, options.now);
    return stage;
  };

  /**
   * Ход, сохранённый в базе со статусом «идёт», а живого импорта в процессе нет:
   * сайт перезапустился посреди работы. Показывать его «идущим» нельзя.
   */
  const markInterrupted = (progress: Progress, now?: When): Progress => {
    if (progress.phase !== 'running') return progress;
    const copy: Progress = JSON.parse(JSON.stringify(progress));
    const at = iso(now ?? copy.updatedAt);
    for (const stage of copy.stages) {
      if (stage.status === 'running') {
        stage.status = 'error';
        stage.finishedAt = at;
      }
    }
    copy.phase = 'cancelled';
    copy.finishedAt = at;
    copy.message = interruptedMessage;
    copy.result = { ...(copy.result ?? {}), error: interruptedMessage } as R;
    return copy;
  };

  /** Завершить прогон: этапы, до которых не дошли, — «не нужен» (удача) или как есть (сбой). */
  const finish = (
    progress: Progress,
    phase: Exclude<ImportPhase, 'running'>,
    options: { message?: string; result?: R | null; now?: When } = {},
  ): Progress => {
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
  };

  /** Строка журнала с ограничением длины; журнал обрезается сверху до предела. */
  const pushLog = (
    log: ImportLogLine[],
    level: ImportLogLevel,
    text: string,
    options: { now?: When; limit?: number } = {},
  ): ImportLogLine => {
    const clean = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, LOG_TEXT_LIMIT) || '—';
    const line: ImportLogLine = { at: iso(options.now), level, text: clean };
    log.push(line);
    const limit = Math.max(1, options.limit ?? config.logLimit);
    if (log.length > limit) log.splice(0, log.length - limit);
    return line;
  };

  /** Ход импорта из JSON (база, ответ API): всё непонятное отбрасывается. */
  const sanitize = (value: unknown): Progress | null => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const raw = value as Record<string, unknown>;
    const startedAt = asIso(raw.startedAt);
    if (!startedAt || typeof raw.id !== 'string') return null;
    const byId = new Map<string, Record<string, unknown>>();
    if (Array.isArray(raw.stages)) {
      for (const item of raw.stages) {
        if (item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string') {
          byId.set(currentId((item as { id: string }).id), item as Record<string, unknown>);
        }
      }
    }
    const phase = PHASES.includes(String(raw.phase)) ? (raw.phase as ImportPhase) : 'error';
    const stages: Stage[] = defs.map((def) => {
      const item = byId.get(def.id) ?? {};
      // Этапа нет в сохранённом ходе (запись старой версии сайта): у законченного
      // запуска он «не нужен», а не «ждёт».
      const fallback: ImportStageStatus = byId.has(def.id) || phase === 'running' ? 'pending' : 'skipped';
      const status = STAGE_STATUSES.includes(String(item.status)) ? (item.status as ImportStageStatus) : fallback;
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
    let result: R | null = null;
    if (resultRaw) {
      const out: Record<string, unknown> = {};
      for (const field of config.summaryFields) {
        if (resultRaw[field] != null) out[field] = asCount(resultRaw[field]);
      }
      if (typeof resultRaw.error === 'string') out.error = resultRaw.error.slice(0, 500);
      result = out as R;
    }
    const stageId = currentId(raw.stage);
    const progress: Progress = {
      id: raw.id.slice(0, 64),
      trigger: (triggers.includes(String(raw.trigger)) ? raw.trigger : config.defaultTrigger) as T,
      force: raw.force === true,
      mode: (modes.includes(String(raw.mode)) ? raw.mode : config.defaultMode) as M,
      phase,
      stage: stageIds.includes(stageId) ? (stageId as S) : null,
      percent: 0,
      message: typeof raw.message === 'string' ? raw.message.slice(0, 300) : '',
      startedAt,
      updatedAt: asIso(raw.updatedAt) ?? startedAt,
      finishedAt: asIso(raw.finishedAt),
      stages,
      result,
    };
    // Процент считает сервер по тем же весам; если его нет — пересчитать по этапам.
    const savedPercent = Number(raw.percent);
    progress.percent = progress.phase === 'ok' || progress.phase === 'not_modified'
      ? 100
      : Number.isFinite(savedPercent) ? Math.max(0, Math.min(100, savedPercent)) : percent(progress);
    return progress;
  };

  const sanitizeLog = (value: unknown, limit = config.logLimit): ImportLogLine[] => {
    if (!Array.isArray(value)) return [];
    const out: ImportLogLine[] = [];
    for (const item of value) {
      if (!item || typeof item !== 'object') continue;
      const raw = item as Record<string, unknown>;
      const at = asIso(raw.at);
      if (!at || typeof raw.text !== 'string') continue;
      out.push({
        at,
        level: LEVELS.includes(String(raw.level)) ? (raw.level as ImportLogLevel) : 'info',
        text: raw.text.slice(0, LOG_TEXT_LIMIT),
      });
    }
    return out.slice(-Math.max(1, limit));
  };

  /** Для вкладки Atlas: этап и процент идущего импорта, без подробностей сервера. */
  const toPublic = (progress: Progress | null | undefined): ImportPublicProgress<S, M> | null => {
    if (!progress || progress.phase !== 'running') return null;
    return {
      stage: progress.stage,
      stageLabel: stageLabel(progress.stage),
      percent: progress.percent,
      message: progress.message.slice(0, 160),
      startedAt: progress.startedAt,
      mode: progress.mode,
    };
  };

  const sanitizePublic = (value: unknown): ImportPublicProgress<S, M> | null => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const raw = value as Record<string, unknown>;
    const saved = Number(raw.percent);
    const stageId = currentId(raw.stage);
    const stage = stageIds.includes(stageId) ? (stageId as S) : null;
    return {
      stage,
      stageLabel: stageLabel(stage),
      percent: Number.isFinite(saved) ? Math.max(0, Math.min(100, saved)) : 0,
      message: typeof raw.message === 'string' ? raw.message.slice(0, 160) : '',
      startedAt: asIso(raw.startedAt),
      ...(modes.includes(String(raw.mode)) ? { mode: raw.mode as M } : {}),
    };
  };

  return {
    stages: defs,
    stageLabel,
    create,
    fraction: (stage: Stage): number => importStageFraction(stage),
    percent,
    start,
    reset,
    update,
    finishStage,
    markInterrupted,
    finish,
    pushLog,
    sanitize,
    sanitizeLog,
    toPublic,
    sanitizePublic,
  };
}

/* ── Подписи ────────────────────────────────────────────────────────────── */

/** «3,6 МБ» — размеры в журнале и под полосами. */
export function formatImportBytes(value: number | null | undefined): string {
  const bytes = Number(value ?? 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 Б';
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const scaled = bytes / 1024 ** index;
  const digits = index === 0 || scaled >= 100 ? 0 : 1;
  return `${scaled.toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${units[index]}`;
}

export function formatImportCount(value: number | null | undefined): string {
  return Math.round(Number(value ?? 0) || 0).toLocaleString('ru-RU');
}

/** «12,4 с», «2 мин 05 с», «1 ч 04 мин». */
export function formatImportDuration(ms: number | null | undefined): string {
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
export function formatImportSpeed(bytesPerSecond: number | null | undefined): string {
  const value = Number(bytesPerSecond ?? 0);
  if (!Number.isFinite(value) || value <= 0) return '—';
  return `${formatImportBytes(value)}/с`;
}
