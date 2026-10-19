/**
 * Ход импорта минорных фракций из дампа EDSM: этапы, проценты и журнал.
 *
 * Общий модуль для трёх мест:
 *   * сервер (`bgsSync.ts`) отмечает здесь каждый шаг импорта;
 *   * админка (Игровые данные → Фракции) рисует по нему прогресс-бары этапов
 *     и журнал процесса;
 *   * вкладка «Фракции» в Atlas показывает короткую строку «сервер загружает
 *     данные EDSM: скачивание архива, 37 %».
 *
 * Механизм общий с PowerPlay (`importProgress.ts`): конвейер, как у каталога
 * систем, — архив (≈0,5 ГБ) скачивается на сервер целиком в несколько
 * соединений, затем разбивается на куски по тысяче систем, затем куски
 * пишутся в базу. Этапы идут по очереди; «текущий» — идущий.
 *
 * Запуск бывает не только полным: админка умеет отдельно скачать архив,
 * разбить его на куски и загрузить куски в базу (`mode`). Этапы, которых нет
 * в запуске, сразу помечаются «не нужен» и в процент не входят.
 *
 * Только стираемый TypeScript без зависимостей: модуль импортируют тесты,
 * сервер и браузер.
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

export const BGS_SYNC_STAGES = [
  { id: 'probe', label: 'Запрос к EDSM', weight: 2 },
  { id: 'download', label: 'Скачивание архива на сервер', weight: 55 },
  { id: 'split', label: 'Разбивка на куски', weight: 8 },
  { id: 'import', label: 'Загрузка кусков в базу', weight: 30 },
  { id: 'finish', label: 'Завершение', weight: 5 },
] as const;

export type BgsStageId = (typeof BGS_SYNC_STAGES)[number]['id'];
export type BgsStageStatus = ImportStageStatus;
export type BgsSyncTrigger = 'admin' | 'cron' | 'manual';
export type BgsSyncPhase = ImportPhase;
export type BgsLogLevel = ImportLogLevel;
/**
 * Что делает запуск: `full` — всё (скачать → разбить → загрузить → завершить),
 * `download` — только скачать архив на сервер, `split` — только разбить архив
 * на куски, `import` — загрузить в базу то, что уже лежит на сервере, без
 * обращения к EDSM.
 */
export type BgsSyncMode = ArchiveImportMode;

/** Этапы каждого вида запуска. */
export const BGS_MODE_STAGES: Readonly<Record<BgsSyncMode, readonly BgsStageId[]>> = ARCHIVE_IMPORT_MODE_STAGES;

export const BGS_MODE_LABEL: Readonly<Record<BgsSyncMode, string>> = ARCHIVE_IMPORT_MODE_LABEL;

export const BGS_TRIGGER_LABEL: Record<BgsSyncTrigger, string> = {
  admin: 'вручную из админки',
  cron: 'задача планировщика factions-sync',
  manual: 'вручную',
};

export const BGS_PHASE_LABEL: Readonly<Record<BgsSyncPhase, string>> = IMPORT_PHASE_LABEL;

export const BGS_LOG_LIMIT = 250;

export type BgsStageProgress = ImportStageProgress<BgsStageId>;

export interface BgsSyncSummary {
  systems?: number;
  factions?: number;
  presence?: number;
  applied?: number;
  stale?: number;
  deletedSystems?: number;
  durationMs?: number;
  /** Скачано / лежит на сервере (запуск «только скачать»). */
  archiveBytes?: number;
  /** Кусков (запуски «разбить» и «загрузить»). */
  shards?: number;
  error?: string;
}

export type BgsSyncProgress = ImportProgress<BgsStageId, BgsSyncMode, BgsSyncTrigger, BgsSyncSummary>;
export type BgsLogLine = ImportLogLine;
/** Короткая сводка для публичного API слоя. */
export type BgsPublicProgress = ImportPublicProgress<BgsStageId, BgsSyncMode>;

const kit = createImportProgressKit<BgsStageId, BgsSyncMode, BgsSyncTrigger, BgsSyncSummary>({
  stages: BGS_SYNC_STAGES,
  modeStages: BGS_MODE_STAGES,
  defaultMode: 'full',
  triggers: ['admin', 'cron', 'manual'],
  defaultTrigger: 'manual',
  logLimit: BGS_LOG_LIMIT,
  summaryFields: ['systems', 'factions', 'presence', 'applied', 'stale', 'deletedSystems', 'durationMs', 'archiveBytes', 'shards'],
  subject: 'фракций',
});

export const bgsStageLabel = kit.stageLabel;
export const createBgsProgress = kit.create;
export const bgsStageFraction = kit.fraction;
/** Общий процент по весам этапов; пропущенные («не нужен») в расчёт не входят. */
export const computeBgsPercent = kit.percent;
export const startBgsStage = kit.start;
/** Этап снова «ждёт» (дамп на EDSM сменился — скачивание и разбивка начинаются заново). */
export const resetBgsStage = kit.reset;
export const updateBgsStage = kit.update;
export const finishBgsStage = kit.finishStage;
/**
 * Ход, сохранённый в базе со статусом «идёт», а живого импорта в процессе нет:
 * сайт перезапустился посреди работы. Показывать его «идущим» нельзя.
 */
export const markBgsInterrupted = kit.markInterrupted;
export const finishBgsProgress = kit.finish;
export const pushBgsLog = kit.pushLog;
/** Ход импорта из JSON (база, ответ API): всё непонятное отбрасывается. */
export const sanitizeBgsProgress = kit.sanitize;
export const sanitizeBgsLog = kit.sanitizeLog;
export const publicBgsProgress = kit.toPublic;

/* ── Подписи ────────────────────────────────────────────────────────────── */

export const formatBgsBytes = formatImportBytes;
export const formatBgsCount = formatImportCount;
/** «12,4 с», «2 мин 05 с», «1 ч 04 мин». */
export const formatBgsDuration = formatImportDuration;
/** «1,4 МБ/с». */
export const formatBgsSpeed = formatImportSpeed;
