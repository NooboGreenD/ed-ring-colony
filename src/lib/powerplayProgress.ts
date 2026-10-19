/**
 * Ход импорта PowerPlay: этапы, проценты и журнал процесса.
 *
 * Общий модуль для трёх мест:
 *   * сервер (`powerplaySync.ts`) отмечает здесь каждый шаг импорта дампа EDSM;
 *   * админка (Игровые данные → PowerPlay) рисует по нему прогресс-бары этапов
 *     и журнал процесса;
 *   * вкладка «PowerPlay» в Atlas показывает короткую строку «сервер загружает
 *     данные EDSM: загрузка кусков в базу, 64 %» — чтобы было видно, что
 *     загрузка идёт.
 *
 * С web 2.24.0 импорт устроен так же, как у минорных фракций и «Каталога
 * систем», и механизм хода у них общий (`importProgress.ts`): архив
 * скачивается на сервер ЦЕЛИКОМ → затем разбивается на куски → затем куски
 * пишутся в базу, шаги по очереди. Запуск бывает и по частям (`mode`):
 * только скачать, только разбить, загрузить в базу то, что уже на сервере.
 *
 * Только стираемый TypeScript без зависимостей: тесты (`node --test`)
 * импортируют модуль напрямую, браузерный бандл — тоже.
 */

import {
  ARCHIVE_IMPORT_MODE_LABEL,
  ARCHIVE_IMPORT_MODE_STAGES,
  IMPORT_PHASE_LABEL,
  createImportProgressKit,
  formatImportBytes,
  formatImportCount,
  formatImportDuration,
  formatImportSpeed,
  type ArchiveImportMode,
  type ImportLogLevel,
  type ImportLogLine,
  type ImportPhase,
  type ImportProgress,
  type ImportPublicProgress,
  type ImportStageProgress,
  type ImportStageStatus,
} from './importProgress.ts';

export const POWERPLAY_SYNC_STAGES = [
  { id: 'probe', label: 'Запрос к EDSM', weight: 4 },
  { id: 'download', label: 'Скачивание архива на сервер', weight: 46 },
  { id: 'split', label: 'Разбивка на куски', weight: 10 },
  { id: 'import', label: 'Загрузка кусков в базу', weight: 35 },
  { id: 'finish', label: 'Завершение', weight: 5 },
] as const;

export type PowerplayStageId = (typeof POWERPLAY_SYNC_STAGES)[number]['id'];
export type PowerplayStageStatus = ImportStageStatus;
/** Кто запустил импорт. */
export type PowerplaySyncTrigger = 'admin' | 'cron' | 'lazy' | 'manual';
export type PowerplaySyncPhase = ImportPhase;
export type PowerplayLogLevel = ImportLogLevel;
/**
 * Что делает запуск: `full` — всё (скачать архив → разбить → загрузить →
 * завершить), `download` — только скачать архив на сервер, `split` — только
 * разбить его на куски, `import` — загрузить в базу то, что уже лежит на
 * сервере (архив или куски), без обращения к EDSM.
 */
export type PowerplaySyncMode = ArchiveImportMode;

/** Этапы каждого вида запуска. */
export const POWERPLAY_MODE_STAGES: Readonly<Record<PowerplaySyncMode, readonly PowerplayStageId[]>> = ARCHIVE_IMPORT_MODE_STAGES;

export const POWERPLAY_MODE_LABEL: Readonly<Record<PowerplaySyncMode, string>> = ARCHIVE_IMPORT_MODE_LABEL;

export const POWERPLAY_TRIGGER_LABEL: Record<PowerplaySyncTrigger, string> = {
  admin: 'вручную из админки',
  cron: 'задача планировщика powerplay-sync',
  lazy: 'автоматически: открыли вкладку PowerPlay, а данных нет или они старше суток',
  manual: 'вручную',
};

export const POWERPLAY_PHASE_LABEL: Readonly<Record<PowerplaySyncPhase, string>> = IMPORT_PHASE_LABEL;

/** Сколько строк журнала хранить: прогон — это 20–40 строк, хватит на несколько. */
export const POWERPLAY_LOG_LIMIT = 200;

/**
 * Этапы до web 2.24.0 (один запрос и разбор в памяти) → нынешние: ход,
 * сохранённый прежней версией сайта, показывается по-новому.
 */
const LEGACY_STAGES = { request: 'probe', parse: 'split', write: 'import' } as const;

export type PowerplayStageProgress = ImportStageProgress<PowerplayStageId>;

export interface PowerplaySyncSummary {
  /** Записано строк в базу. */
  rows?: number;
  deleted?: number;
  /** Систем на карте после импорта. */
  total?: number;
  durationMs?: number;
  /** Скачано / лежит на сервере (запуск «только скачать»). */
  archiveBytes?: number;
  /** Кусков (запуски «разбить» и «загрузить»). */
  shards?: number;
  /** Систем в кусках (запуск «разбить»). */
  systems?: number;
  error?: string;
}

export type PowerplaySyncProgress = ImportProgress<PowerplayStageId, PowerplaySyncMode, PowerplaySyncTrigger, PowerplaySyncSummary>;
export type PowerplayLogLine = ImportLogLine;
/** Короткая сводка для публичного API слоя: без триггера, журнала и ошибок. */
export type PowerplayPublicProgress = ImportPublicProgress<PowerplayStageId, PowerplaySyncMode>;

const kit = createImportProgressKit<PowerplayStageId, PowerplaySyncMode, PowerplaySyncTrigger, PowerplaySyncSummary>({
  stages: POWERPLAY_SYNC_STAGES,
  modeStages: POWERPLAY_MODE_STAGES,
  defaultMode: 'full',
  triggers: ['admin', 'cron', 'lazy', 'manual'],
  defaultTrigger: 'manual',
  logLimit: POWERPLAY_LOG_LIMIT,
  summaryFields: ['rows', 'deleted', 'total', 'durationMs', 'archiveBytes', 'shards', 'systems'],
  subject: 'PowerPlay',
  legacyStages: LEGACY_STAGES,
});

export const powerplayStageLabel = kit.stageLabel;
export const createPowerplayProgress = kit.create;
/** Доля этапа 0–1: готовый и пропущенный — целиком, идущий — по счётчику. */
export const powerplayStageFraction = kit.fraction;
/** Общий процент по весам этапов, с одним знаком после запятой; «не нужен» не входит. */
export const computePowerplayPercent = kit.percent;
export const startPowerplayStage = kit.start;
/** Этап снова «ждёт» (дамп на EDSM сменился посреди скачивания). */
export const resetPowerplayStage = kit.reset;
export const updatePowerplayStage = kit.update;
export const finishPowerplayStage = kit.finishStage;
/** Ход «идёт» из базы, а живого импорта нет — прерван перезапуском сайта. */
export const markPowerplayInterrupted = kit.markInterrupted;
/** Завершить прогон: этапы, до которых не дошли, помечаются «не нужен» (удача) или остаются как есть. */
export const finishPowerplayProgress = kit.finish;
/** Строка журнала с ограничением длины; журнал обрезается сверху до `limit`. */
export const pushPowerplayLog = kit.pushLog;
/** Ход импорта из JSON (база, ответ API): всё непонятное отбрасывается. */
export const sanitizePowerplayProgress = kit.sanitize;
export const sanitizePowerplayLog = kit.sanitizeLog;
/** Для вкладки Atlas: этап и процент идущего импорта, без подробностей сервера. */
export const publicPowerplayProgress = kit.toPublic;
export const sanitizePublicPowerplayProgress = kit.sanitizePublic;

/* ── Подписи ────────────────────────────────────────────────────────────── */

/** «3,6 МБ» — размеры в журнале и под полосами. */
export const formatPowerplayBytes = formatImportBytes;
export const formatPowerplayCount = formatImportCount;
/** «12,4 с», «2 мин 05 с», «1 ч 04 мин». */
export const formatPowerplayDuration = formatImportDuration;
/** «1,4 МБ/с». */
export const formatPowerplaySpeed = formatImportSpeed;
