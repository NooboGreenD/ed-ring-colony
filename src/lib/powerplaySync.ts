/**
 * Импорт систем PowerPlay из ночного дампа EDSM `powerPlay.json.gz` в
 * `powerplay_systems`.
 *
 * С web 2.24.0 импорт устроен так же, как у минорных фракций и «Каталога
 * систем» (общие механизмы — `dumpArchive.ts`, `dumpShards.ts`,
 * `dumpUpload.ts`, `importProgress.ts`), и шаги идут ПО ОЧЕРЕДИ — каждый
 * начинается, когда предыдущий закончен целиком:
 *
 *   1. probe    — HEAD к EDSM: размер, дата, ETag, поддержка Range. Тот же
 *                 дамп, что в прошлый удачный импорт (и записанный текущим
 *                 разбором), второй раз не качается — «без изменений»;
 *   2. download — архив скачивается на сервер ЦЕЛИКОМ (`data/spansh/powerplay`,
 *                 тот же диск, что у каталога): POWERPLAY_DOWNLOAD_SEGMENTS
 *                 соединений (4) берут куски файла по POWERPLAY_PIECE_KB
 *                 (256 КБ) по порядку; докачка после обрыва и перезапуска
 *                 сайта; соединение, замолчавшее на POWERPLAY_STALL_SECONDS
 *                 (15 с), переподключается сразу, а не через 70 с
 *                 `read ETIMEDOUT`. Если соединения замирают, успев передать
 *                 лишь несколько килобайт (так сеть сервера режет TCP-сессии
 *                 к зарубежным CDN — EDSM за Cloudflare), загрузка переходит
 *                 на короткие запросы меньше порога, каждый в новом
 *                 соединении (POWERPLAY_REQUEST_KB, `freshFetch.ts`);
 *   3. split    — архив разбирается (`powerplayDump.ts`: записи одной системы
 *                 собираются в строку со списком держав) и раскладывается в
 *                 куски по POWERPLAY_SHARD_SYSTEMS систем (`powerplayShards.ts`).
 *                 Проверки здравого смысла (мало систем, «усохший» дамп) —
 *                 сразу после разбивки: такой дамп таблицу не трогает;
 *   4. import   — куски пишутся в базу (`powerplayWriter.ts`: прямой Postgres,
 *                 как у каталога, или PostgREST). Кусок — единица
 *                 продолжения: после обрыва пишутся только незаписанные;
 *   5. finish   — `powerplay_finish_sync` одной транзакцией удаляет то, чего
 *                 в новом дампе нет (кроме более свежих строк пилотов), и
 *                 записывает состояние; архив и куски удаляются с диска.
 *
 * Админка умеет и по частям (`mode`): только скачать архив, только разбить
 * его на куски, загрузить в базу то, что уже на сервере (без EDSM). Архив
 * можно загрузить и с компьютера (`powerplayUpload.ts`) — для сервера,
 * которому EDSM недоступен.
 *
 * Запускают импорт задача `powerplay-sync` (`/api/cron/powerplay-sync`, раз в
 * 12 часов), ленивое обновление из `GET /api/powerplay/systems` (таблица
 * пуста, данные старше суток или записаны прежним разбором) и администратор
 * (Админка → Игровые данные → PowerPlay). Ход этапов и журнал — в памяти
 * процесса и копией в `powerplay_sync_state`: после перезапуска сайта админка
 * всё равно покажет, чем закончилась последняя загрузка.
 *
 * Битый или подозрительно маленький дамп таблицу не трогает: карта остаётся
 * со вчерашними данными, а ошибка видна в состоянии и в ответе задачи.
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import {
  adoptManualArchive,
  archiveIsComplete,
  archiveLeftovers,
  archiveMetaSource,
  dumpArchiveInfo,
  fileSize,
  freeBytes,
  readArchiveMeta,
  removeArchive,
  writeArchiveMeta,
  type DumpArchiveInfo,
} from './dumpArchive.ts';
import { readShardRows, sameDumpSource, type DumpSource } from './dumpShards.ts';
import { sharedFreshConnectionFetch } from './freshFetch.ts';
import {
  downloadDump,
  downloadedBytesOnDisk,
  galaxyArchiveDir,
  isDumpSourceChanged,
  probeDumpSource,
  segmentStatePath,
  type DumpProbe,
} from './galaxyImport.ts';
import { POWERPLAY_STATE_PLURAL, formatPowerplayDate } from './powerplay.ts';
import { POWERPLAY_PARSER_VERSION, type PowerplayDumpStats } from './powerplayDump.ts';
import {
  POWERPLAY_MODE_LABEL,
  POWERPLAY_TRIGGER_LABEL,
  createPowerplayProgress,
  finishPowerplayProgress,
  finishPowerplayStage,
  formatPowerplayBytes,
  formatPowerplayCount,
  formatPowerplayDuration,
  formatPowerplaySpeed,
  pushPowerplayLog,
  resetPowerplayStage,
  sanitizePowerplayLog,
  sanitizePowerplayProgress,
  startPowerplayStage,
  updatePowerplayStage,
  type PowerplayLogLevel,
  type PowerplayLogLine,
  type PowerplayStageId,
  type PowerplaySyncMode,
  type PowerplaySyncProgress,
  type PowerplaySyncTrigger,
} from './powerplayProgress.ts';
import {
  DEFAULT_POWERPLAY_SHARD_SYSTEMS,
  POWERPLAY_SPLIT_ABORTED,
  clearPowerplayShards,
  createPowerplayShardManifest,
  powerplayShardsInfo,
  readPowerplayShardManifest,
  splitPowerplayArchive,
  writePowerplayShardManifest,
  type PowerplayShardManifest,
  type PowerplayShardsInfo,
} from './powerplayShards.ts';
import { createPowerplayWriter, powerplayBatchSize, type PowerplayDbWriter, type PowerplayPgClient } from './powerplayWriter.ts';

export { decodePowerplayDump } from './powerplayShards.ts';
export { POWERPLAY_BATCH_SIZE, describePowerplayWriter, powerplayBatchSize, powerplayDirectDb } from './powerplayWriter.ts';

type Svc = any;

export const DEFAULT_POWERPLAY_DUMP_URL = 'https://www.edsm.net/dump/powerPlay.json.gz';
const USER_AGENT = 'ED-Ring-Colony/2 (+https://edringcolony.ru; powerplay layer)';
export const POWERPLAY_ARCHIVE_FILE = 'edsm-powerPlay.json.gz';
/** Имя файла дампа на EDSM — для подсказок «скачайте на компьютере». */
export const POWERPLAY_ARCHIVE_SOURCE_NAME = 'powerPlay.json.gz';

/** Меньше этого систем под контролем в настоящем дампе не бывает (их десятки тысяч). */
export const POWERPLAY_MIN_ROWS = 100;
/** Новый дамп меньше половины прошлого — скорее сбой источника, чем итог недели. */
export const POWERPLAY_SHRINK_GUARD = 0.5;
/** Соединений к EDSM по умолчанию: файл маленький, четырёх хватает и для коротких запросов. */
export const POWERPLAY_DEFAULT_SEGMENTS = 4;
export const POWERPLAY_MAX_SEGMENTS = 16;
/** Кусок файла, который соединение берёт за раз: 3,6 МБ — ≈15 кусков на 4 соединения. */
export const POWERPLAY_DEFAULT_PIECE_KB = 256;
/** Соединение без единого байта дольше этого обрывается и переподключается. */
export const POWERPLAY_DEFAULT_STALL_SECONDS = 15;
/** Копия хода импорта пишется в базу не чаще раза в секунду (и на каждом этапе). */
const PERSIST_EVERY_MS = 1000;
/** Запас свободного места сверх размера дампа. */
const DISK_RESERVE_BYTES = 64 * 1024 * 1024;
/** Сколько раз за запуск начинать заново, если EDSM пересобрал дамп посреди скачивания. */
const MAX_SOURCE_RESTARTS = 2;

/** Данные свежие, если источник проверяли меньше суток с запасом назад. */
export const POWERPLAY_STALE_AFTER_MS = 26 * 60 * 60 * 1000;
/** Повторная попытка после неудачи — не чаще раза в полчаса. */
export const POWERPLAY_RETRY_AFTER_MS = 30 * 60 * 1000;
/** «running» старше этого — упавший процесс, а не идущий импорт. */
const RUNNING_STALE_MS = 30 * 60 * 1000;

/**
 * Расписание задачи `powerplay-sync` (копия из scripts/job-schedule.mjs — тест
 * следит, чтобы они не разошлись): каждые 12 часов со сдвигом 5:20 UTC.
 */
export const POWERPLAY_SCHEDULE = { periodMs: 12 * 60 * 60 * 1000, offsetMs: (5 * 60 + 20) * 60 * 1000 } as const;

export const POWERPLAY_CANCEL_MESSAGE = 'Импорт остановлен администратором';

/* ── Настройки ─────────────────────────────────────────────────────────── */

export function powerplayDumpUrl(env: Record<string, string | undefined> = process.env): string {
  const raw = env.POWERPLAY_DUMP_URL?.trim();
  if (!raw) return DEFAULT_POWERPLAY_DUMP_URL;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : DEFAULT_POWERPLAY_DUMP_URL;
  } catch {
    return DEFAULT_POWERPLAY_DUMP_URL;
  }
}

/** Каталог архива: по умолчанию рядом с дампами каталога систем и фракций (отдельный диск). */
export function powerplayArchiveDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.POWERPLAY_ARCHIVE_DIR?.trim() || join(galaxyArchiveDir(env), 'powerplay');
}

export function powerplayArchivePath(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(powerplayArchiveDir(env), POWERPLAY_ARCHIVE_FILE);
}

/** Куски лежат рядом с архивом, в `shards/`. */
export function powerplayShardsDirFor(archivePath: string): string {
  return join(dirname(resolve(archivePath)), 'shards');
}

export function powerplayShardsDir(env: NodeJS.ProcessEnv = process.env): string {
  return powerplayShardsDirFor(powerplayArchivePath(env));
}

/** `POWERPLAY_ARCHIVE_KEEP=1` — не удалять архив и куски после удачного импорта. */
export function powerplayArchiveKeep(env: Record<string, string | undefined> = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env.POWERPLAY_ARCHIVE_KEEP?.trim() ?? '');
}

export function clampPowerplaySegments(value: unknown): number {
  const raw = Number(value);
  return Number.isFinite(raw) && raw >= 1 ? Math.max(1, Math.min(POWERPLAY_MAX_SEGMENTS, Math.floor(raw))) : POWERPLAY_DEFAULT_SEGMENTS;
}

/** `POWERPLAY_DOWNLOAD_SEGMENTS` — соединений к EDSM (1–16, по умолчанию 4). */
export function powerplayDownloadSegments(env: Record<string, string | undefined> = process.env): number {
  return clampPowerplaySegments(env.POWERPLAY_DOWNLOAD_SEGMENTS?.trim() || POWERPLAY_DEFAULT_SEGMENTS);
}

/** `POWERPLAY_PIECE_KB` — кусок файла на одно соединение (16–8192 КБ, по умолчанию 256). */
export function powerplayPieceBytes(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.POWERPLAY_PIECE_KB);
  const kb = Number.isFinite(raw) && raw > 0 ? Math.max(16, Math.min(8192, Math.floor(raw))) : POWERPLAY_DEFAULT_PIECE_KB;
  return kb * 1024;
}

/**
 * `POWERPLAY_STALL_SECONDS` — соединение, не получившее ни байта за это время,
 * обрывается и переподключается (3–300 с, по умолчанию 15). `0` — ждать, пока
 * сокет не закроет сама система (у Node это ~70 с `read ETIMEDOUT`).
 */
export function powerplayStallMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.POWERPLAY_STALL_SECONDS?.trim() ?? '';
  if (/^(0|off|no|false)$/i.test(raw)) return 0;
  const seconds = Number(raw);
  return (Number.isFinite(seconds) && seconds > 0 ? Math.max(3, Math.min(300, Math.floor(seconds))) : POWERPLAY_DEFAULT_STALL_SECONDS) * 1000;
}

/**
 * `POWERPLAY_REQUEST_KB` — короткие запросы для сети, которая «замораживает»
 * TCP-сессии после нескольких килобайт: `auto` (по умолчанию) — включаются
 * сами, когда соединения замирают; `off` — никогда; число 4–1024 — запросы
 * по столько КБ с самого начала.
 */
export function powerplayShortRequests(env: Record<string, string | undefined> = process.env): 'auto' | 'off' | number {
  const raw = env.POWERPLAY_REQUEST_KB?.trim().toLowerCase() ?? '';
  if (!raw || raw === 'auto') return 'auto';
  if (/^(0|off|no|false)$/.test(raw)) return 'off';
  const kb = Number(raw);
  return Number.isFinite(kb) && kb > 0 ? Math.max(4, Math.min(1024, Math.floor(kb))) * 1024 : 'auto';
}

/**
 * `POWERPLAY_FRESH_CONNECTIONS=0` — запросы к EDSM через обычный `fetch` с
 * keep-alive. По умолчанию каждый запрос идёт в новом соединении
 * (`freshFetch.ts`): иначе короткие запросы попадали бы в уже «замороженную»
 * сессию.
 */
export function powerplayFreshConnections(env: Record<string, string | undefined> = process.env): boolean {
  return !/^(0|off|no|false)$/i.test(env.POWERPLAY_FRESH_CONNECTIONS?.trim() ?? '');
}

/**
 * `POWERPLAY_MIN_ROWS` — меньше систем под контролем в дампе считается сбоем
 * источника (по умолчанию 100; ниже — только для зеркала с выборкой).
 */
export function powerplayMinRows(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.POWERPLAY_MIN_ROWS);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : POWERPLAY_MIN_ROWS;
}

/** `POWERPLAY_SHARD_SYSTEMS` — систем в куске (100–10 000, по умолчанию 2000). */
export function powerplayShardSystems(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.POWERPLAY_SHARD_SYSTEMS);
  return Number.isFinite(raw) && raw > 0 ? Math.max(100, Math.min(10_000, Math.floor(raw))) : DEFAULT_POWERPLAY_SHARD_SYSTEMS;
}

function withUserAgent(fetchImpl: typeof fetch): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1] = {}) => {
    const headers = new Headers(init?.headers ?? {});
    if (!headers.has('user-agent')) headers.set('User-Agent', USER_AGENT);
    return fetchImpl(input, { ...init, headers });
  }) as typeof fetch;
}

/** `fetch` для запросов к EDSM: свой User-Agent, по умолчанию — новое соединение на запрос. */
export function powerplayEdsmFetch(fetchImpl?: typeof fetch): typeof fetch {
  return withUserAgent(fetchImpl ?? (powerplayFreshConnections() ? sharedFreshConnectionFetch() : fetch));
}

/* ── Состояние ─────────────────────────────────────────────────────────── */

export interface PowerplaySyncState {
  status: 'idle' | 'running' | 'ok' | 'error';
  source_url: string | null;
  etag: string | null;
  last_modified: string | null;
  dump_generated_at: string | null;
  run_id: string | null;
  rows_total: number;
  stats: Record<string, unknown> | null;
  error: string | null;
  attempt_at: string | null;
  checked_at: string | null;
  synced_at: string | null;
  /** Ход последнего прогона (копия из памяти процесса; нет — миграция не применена). */
  progress: PowerplaySyncProgress | null;
  /** Журнал последних прогонов. */
  log: PowerplayLogLine[];
  /** В строке состояния есть колонки progress/log (миграция 20261018180000 применена). */
  progress_supported: boolean;
}

export interface PowerplaySyncResult {
  status: 'ok' | 'not_modified' | 'error' | 'cancelled';
  mode?: PowerplaySyncMode;
  error?: string;
  rows?: number;
  deleted?: number;
  total?: number;
  shards?: number;
  archiveBytes?: number;
  backend?: PowerplayDbWriter['backend'];
  stats?: PowerplayDumpStats;
  dumpGeneratedAt?: string | null;
  durationMs: number;
}

export interface PowerplaySyncOptions {
  fetchImpl?: typeof fetch;
  /** Импортировать, даже если дамп тот же, и принять «усохший» (ручной запуск). */
  force?: boolean;
  /** Что делать: всё (по умолчанию), только скачать, только разбить, загрузить с диска. */
  mode?: PowerplaySyncMode;
  url?: string;
  archivePath?: string;
  shardsDir?: string;
  /** Соединений к EDSM. */
  segments?: number;
  pieceBytes?: number;
  /** Файл меньше — одним соединением (вне режима кусков; тесты). */
  minSegmentedBytes?: number;
  /** Соединение без данных дольше — переподключение (по умолчанию `POWERPLAY_STALL_SECONDS`). */
  stallTimeoutMs?: number;
  /** Короткие запросы (по умолчанию `POWERPLAY_REQUEST_KB`: auto). */
  shortRequests?: 'auto' | 'off' | number;
  /** Самый короткий запрос (тесты). */
  minRequestBytes?: number;
  shardSystems?: number;
  /** Пачка записи через PostgREST. */
  batchSize?: number;
  minRows?: number;
  keepArchive?: boolean;
  /** Кто запустил: попадает в журнал и в ход импорта. */
  trigger?: PowerplaySyncTrigger;
  /** Прямой Postgres (по умолчанию `POWERPLAY_DB_DIRECT` и DATABASE_URL/SUPABASE_DB_URL). */
  directDb?: boolean;
  /** Готовый клиент Postgres (тесты: PGlite). */
  pgClient?: () => Promise<PowerplayPgClient>;
  /** Пауза между повторами скачивания (тесты). */
  sleep?: (ms: number) => Promise<void>;
}

const EMPTY_STATE: PowerplaySyncState = {
  status: 'idle',
  source_url: null,
  etag: null,
  last_modified: null,
  dump_generated_at: null,
  run_id: null,
  rows_total: 0,
  stats: null,
  error: null,
  attempt_at: null,
  checked_at: null,
  synced_at: null,
  progress: null,
  log: [],
  progress_supported: false,
};

export async function readPowerplaySyncState(svc: Svc): Promise<PowerplaySyncState> {
  const { data, error } = await svc.from('powerplay_sync_state').select('*').eq('id', 1).maybeSingle();
  if (error) throw new Error(error.message);
  return {
    ...EMPTY_STATE,
    ...(data ?? {}),
    rows_total: Number(data?.rows_total ?? 0) || 0,
    progress: sanitizePowerplayProgress(data?.progress),
    log: sanitizePowerplayLog(data?.log),
    progress_supported: Boolean(data) && Object.prototype.hasOwnProperty.call(data, 'log'),
  };
}

async function writeState(svc: Svc, patch: Partial<PowerplaySyncState>): Promise<void> {
  const { error } = await svc
    .from('powerplay_sync_state')
    .upsert({ id: 1, ...patch, updated_at: new Date().toISOString() }, { onConflict: 'id' });
  if (error) throw new Error(error.message);
}

function shortError(error: unknown): string {
  const text = error instanceof Error ? error.message : String((error as { message?: unknown } | null)?.message ?? error);
  return text.replace(/\s+/g, ' ').trim().slice(0, 500) || 'неизвестная ошибка';
}

function headerDate(value: string | null): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function count(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

/**
 * Данные записал текущий разбор дампа (`POWERPLAY_PARSER_VERSION` в
 * `stats.parser`). Импорт старым разбором приписывал спорные системы державе
 * с самым большим номером в EDSM — такие данные устарели, даже если свежие.
 */
export function powerplayParserCurrent(state: Pick<PowerplaySyncState, 'stats'>): boolean {
  const stats = state.stats && typeof state.stats === 'object' ? (state.stats as Record<string, unknown>) : null;
  return Number(stats?.parser) === POWERPLAY_PARSER_VERSION;
}

/**
 * Дамп, который сейчас в базе (заголовки последнего удачного импорта). Нет
 * данных или их записал прежний разбор — «ничего»: тот же файл EDSM нужно
 * прочитать заново.
 */
function importedSource(state: PowerplaySyncState): DumpSource | null {
  if (state.rows_total <= 0 || !state.source_url || !powerplayParserCurrent(state)) return null;
  const stats = state.stats && typeof state.stats === 'object' ? (state.stats as Record<string, unknown>) : {};
  return { url: state.source_url, etag: state.etag, lastModified: state.last_modified, total: count(stats.dump_bytes) || null };
}

/* ── Архив и куски на диске ────────────────────────────────────────────── */

export type PowerplayArchiveInfo = DumpArchiveInfo;
export type { PowerplayShardsInfo } from './powerplayShards.ts';

export function powerplayArchiveInfo(path = powerplayArchivePath()): PowerplayArchiveInfo {
  return dumpArchiveInfo(path);
}

export function powerplayShardsStatus(dir = powerplayShardsDir()): PowerplayShardsInfo {
  return powerplayShardsInfo(dir);
}

/** Что есть на сервере для работы без EDSM: архив целиком или разбитые до конца куски. */
function localDump(dest: string, shardsDir: string): DumpSource | null {
  const meta = readArchiveMeta(dest);
  if (archiveIsComplete(dest, meta)) return archiveMetaSource(meta);
  const manifest = readPowerplayShardManifest(shardsDir);
  return manifest?.complete ? manifest.source : null;
}

/* ── Один импорт за раз на процесс ─────────────────────────────────────────
 * Маршруты Next собираются отдельными бандлами, и у каждого своя копия
 * модуля, поэтому общий «уже идёт» лежит в globalThis (как замки cronAuth). */

interface LiveRun {
  progress: PowerplaySyncProgress;
  log: PowerplayLogLine[];
  controller: AbortController;
  cancelled: boolean;
  persistedAt: number;
}

export interface PowerplayRunSnapshot {
  progress: PowerplaySyncProgress;
  log: PowerplayLogLine[];
}

type SyncGlobal = typeof globalThis & {
  edrcPowerplaySync?: Promise<PowerplaySyncResult> | null;
  edrcPowerplayLayerVersion?: number;
  /** Счётчик применённых наблюдений пилотов (журналы через Helper, сайт, CAPI). */
  edrcPowerplayJournalVersion?: number;
  edrcPowerplayLive?: LiveRun | null;
  edrcPowerplayLastRun?: PowerplayRunSnapshot | null;
  /** В `powerplay_sync_state` нет колонок progress/log (миграция не применена). */
  edrcPowerplayNoProgressColumns?: boolean;
};
const shared = globalThis as SyncGlobal;

export function isPowerplaySyncRunning(): boolean {
  return Boolean(shared.edrcPowerplaySync);
}

/** Счётчик завершённых импортов: кэш слоя сбрасывается, когда он меняется. */
export function powerplayLayerGeneration(): number {
  return shared.edrcPowerplayLayerVersion ?? 0;
}

/**
 * Счётчик обновлений слоя из журналов пилотов: слой пересобирается не сразу,
 * а не чаще раза в минуту (`powerplayStore.ts`), — прыжки пилотов идут часто.
 */
export function powerplayJournalGeneration(): number {
  return shared.edrcPowerplayJournalVersion ?? 0;
}

export function bumpPowerplayJournalGeneration(): void {
  shared.edrcPowerplayJournalVersion = powerplayJournalGeneration() + 1;
}

function snapshot(run: { progress: PowerplaySyncProgress; log: PowerplayLogLine[] }): PowerplayRunSnapshot {
  // structuredClone не нужен: только JSON-данные.
  return JSON.parse(JSON.stringify({ progress: run.progress, log: run.log })) as PowerplayRunSnapshot;
}

/** Идущий сейчас импорт (копия): ход этапов и журнал. */
export function getPowerplayLiveRun(): PowerplayRunSnapshot | null {
  return shared.edrcPowerplayLive ? snapshot(shared.edrcPowerplayLive) : null;
}

/** Последний завершённый в этом процессе импорт (копия). */
export function getPowerplayLastRun(): PowerplayRunSnapshot | null {
  return shared.edrcPowerplayLastRun ? snapshot(shared.edrcPowerplayLastRun) : null;
}

/** Для тестов: забыть историю прогонов и признак «нет колонок хода импорта». */
export function resetPowerplaySyncRuntime(): void {
  shared.edrcPowerplayLastRun = null;
  shared.edrcPowerplayNoProgressColumns = false;
  if (!shared.edrcPowerplaySync) shared.edrcPowerplayLive = null;
}

/** Остановить идущий импорт. Возвращает false, если останавливать нечего. */
export function cancelPowerplaySync(reason = POWERPLAY_CANCEL_MESSAGE): boolean {
  const run = shared.edrcPowerplayLive;
  if (!run || run.cancelled) return false;
  run.cancelled = true;
  pushPowerplayLog(run.log, 'warn', `${reason} — обрываю текущий шаг`);
  run.controller.abort(new Error(reason));
  return true;
}

export function runPowerplaySync(svc: Svc, options: PowerplaySyncOptions = {}): Promise<PowerplaySyncResult> {
  if (shared.edrcPowerplaySync) return shared.edrcPowerplaySync;
  const job = syncOnce(svc, options).finally(() => {
    shared.edrcPowerplaySync = null;
  });
  shared.edrcPowerplaySync = job;
  return job;
}

/**
 * Запуск из админки: импорт идёт фоном, ответ возвращается сразу. Если импорт
 * уже идёт (задача, ленивое обновление или прошлый клик), второй не начинается.
 */
export function startPowerplaySync(svc: Svc, options: PowerplaySyncOptions = {}): { started: boolean; reason?: string } {
  if (isPowerplaySyncRunning()) return { started: false, reason: 'Импорт уже идёт — его ход виден ниже' };
  void runPowerplaySync(svc, { ...options, trigger: options.trigger ?? 'admin' }).catch(() => undefined);
  return { started: true };
}

/** Копия хода и журнала — в базу; сбой этой записи импорт не роняет. */
async function persistRun(svc: Svc, run: LiveRun, force = false): Promise<void> {
  if (shared.edrcPowerplayNoProgressColumns) return;
  const now = Date.now();
  if (!force && now - run.persistedAt < PERSIST_EVERY_MS) return;
  run.persistedAt = now;
  try {
    const { error } = await svc
      .from('powerplay_sync_state')
      .update({ progress: run.progress, log: run.log, updated_at: new Date(now).toISOString() })
      .eq('id', 1);
    if (error) throw new Error(error.message);
  } catch (error) {
    const message = shortError(error);
    if (/progress|"log"|\blog\b|column|schema cache/i.test(message)) {
      shared.edrcPowerplayNoProgressColumns = true;
      pushPowerplayLog(
        run.log,
        'warn',
        'Ход импорта и журнал не сохраняются в базе: примените миграцию 20261018180000_powerplay_sync_progress.sql — до неё они видны только до перезапуска сайта',
      );
    }
  }
}

/** Архив испорчен (gzip не разбирается или внутри не дамп): его надо удалить и скачать заново. */
class PowerplayArchiveCorrupted extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PowerplayArchiveCorrupted';
  }
}

/** Кусок на диске не читается: куски надо разбить заново. */
class PowerplayShardCorrupted extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PowerplayShardCorrupted';
  }
}

function isArchiveCorruption(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'Z_DATA_ERROR' || code === 'Z_BUF_ERROR') return true;
  return /unexpected end of file|incorrect (header|data) check|invalid (block|stored|distance|code)|не похож на|too far back|слишком большой/i.test(shortError(error));
}

function describeStats(stats: PowerplayDumpStats): string[] {
  const n = formatPowerplayCount;
  const list = (values: Record<string, number>) => Object.entries(values)
    .sort((a, b) => b[1] - a[1])
    .map(([power, value]) => `${power} ${n(value)}`)
    .join(', ');
  const lines = [
    `Разобрано записей: ${n(stats.records)} → систем под контролем: ${n(stats.kept)}`
      + ` (${POWERPLAY_STATE_PLURAL.Stronghold.toLowerCase()} ${n(stats.states.Stronghold)},`
      + ` ${POWERPLAY_STATE_PLURAL.Fortified.toLowerCase()} ${n(stats.states.Fortified)},`
      + ` ${POWERPLAY_STATE_PLURAL.Exploited.toLowerCase()} ${n(stats.states.Exploited)})`,
    'Запись дампа — «система + одна из держав в ней»: EDSM пишет по записи на каждую державу, чьи зоны накрывают систему,'
      + ' а владельца (ControllingPower) не указывает',
    `Держава в системе одна — владелец ясен: ${n(stats.sole)} · держав несколько — владелец по дампу не определён: ${n(stats.contested)}`
      + ` · записей «ещё одна держава той же системы»: ${n(stats.listings)}`,
    `Отброшено: Unoccupied (никем не контролируются) ${n(stats.skipped.unoccupied)},`
      + ` неизвестное состояние ${n(stats.skipped.unknown_state)},`
      + ` битых записей ${n(stats.skipped.invalid)},`
      + ` от более старого события ${n(stats.skipped.stale ?? 0)},`
      + ` повторов ${n(stats.skipped.duplicate)}`,
  ];
  if (Object.keys(stats.powers).length) lines.push(`Владелец по дампу (одна держава в системе): ${list(stats.powers)}`);
  if (Object.keys(stats.presence ?? {}).length) {
    lines.push(`Присутствие (в скольких системах держава есть в списке EDSM, владелец или сосед): ${list(stats.presence)}`);
  }
  if (stats.oldestObservation && stats.newestObservation) {
    lines.push(`Наблюдения пилотов: ${formatPowerplayDate(stats.oldestObservation)} – ${formatPowerplayDate(stats.newestObservation)} (EDSM хранит ~30 дней)`);
  }
  return lines;
}

async function syncOnce(svc: Svc, options: PowerplaySyncOptions): Promise<PowerplaySyncResult> {
  const started = Date.now();
  const mode: PowerplaySyncMode = options.mode ?? 'full';
  const force = options.force === true;
  const url = options.url ?? powerplayDumpUrl();
  // Пути данных на диске сервера, а не исходники: трассировка сборки (Turbopack) их не касается.
  const dest = resolve(/*turbopackIgnore: true*/ options.archivePath ?? powerplayArchivePath());
  const shardsDir = resolve(/*turbopackIgnore: true*/ options.shardsDir ?? powerplayShardsDirFor(dest));
  const fetchImpl = powerplayEdsmFetch(options.fetchImpl);
  const stallTimeoutMs = options.stallTimeoutMs ?? powerplayStallMs();
  const shortRequests = options.shortRequests ?? powerplayShortRequests();
  const minRows = options.minRows ?? powerplayMinRows();
  const segments = clampPowerplaySegments(options.segments ?? powerplayDownloadSegments());
  const pieceBytes = options.pieceBytes ?? powerplayPieceBytes();
  const shardSystems = options.shardSystems ?? powerplayShardSystems();
  const keepArchive = options.keepArchive ?? powerplayArchiveKeep();
  const trigger = options.trigger ?? 'manual';
  const touchesDb = mode === 'full' || mode === 'import';
  const online = mode === 'full' || mode === 'download';
  let previous = EMPTY_STATE;
  let written = 0;
  let writer: PowerplayDbWriter | null = null;

  // Ход импорта виден сразу: админка, нажавшая «Загрузить», читает его
  // следующим же запросом, ещё до первого ответа EDSM.
  const run: LiveRun = {
    progress: createPowerplayProgress({ id: randomUUID(), trigger, force, mode, now: started }),
    log: [],
    controller: new AbortController(),
    cancelled: false,
    persistedAt: 0,
  };
  // Журнал продолжается от прошлых прогонов этого процесса: админ видит историю.
  const history = shared.edrcPowerplayLastRun?.log ?? [];
  run.log.push(...history.slice(-120));
  shared.edrcPowerplayLive = run;

  const log = (level: PowerplayLogLevel, text: string) => {
    pushPowerplayLog(run.log, level, text);
  };
  const begin = async (stage: PowerplayStageId, init: { total?: number | null; done?: number; detail?: string } = {}) => {
    startPowerplayStage(run.progress, stage, init);
    await persistRun(svc, run, true);
  };
  const advance = async (stage: PowerplayStageId, patch: { done?: number; total?: number | null; detail?: string }) => {
    updatePowerplayStage(run.progress, stage, patch);
    await persistRun(svc, run);
  };
  const complete = (stage: PowerplayStageId, detail?: string, status: 'done' | 'skipped' = 'done') => {
    finishPowerplayStage(run.progress, stage, { detail, status });
  };
  const checkCancelled = () => {
    if (run.cancelled) throw new Error(POWERPLAY_CANCEL_MESSAGE);
  };
  const notModified = async (message: string): Promise<PowerplaySyncResult> => {
    if (touchesDb) await writeState(svc, { status: 'ok', checked_at: new Date().toISOString(), error: null });
    const durationMs = Date.now() - started;
    log('info', `${message} (${formatPowerplayCount(previous.rows_total)} систем). Готово за ${formatPowerplayDuration(durationMs)}`);
    finishPowerplayProgress(run.progress, 'not_modified', { message, result: { total: previous.rows_total, durationMs } });
    return { status: 'not_modified', mode, total: previous.rows_total, durationMs };
  };

  log('info', `Запуск импорта: ${POWERPLAY_TRIGGER_LABEL[trigger]} · ${POWERPLAY_MODE_LABEL[mode]}${force ? ' · принудительно (тот же дамп загружается заново, «усохший» принимается)' : ''}`);
  if (online) log('info', `Источник: ${url}`);

  try {
    // Состояние читаем до первой записи хода: иначе журнал этого же прогона
    // вернулся бы из базы как «история» и задвоился.
    previous = await readPowerplaySyncState(svc);
    // Процесс только что поднялся — история прошлых прогонов есть только в базе.
    if (history.length === 0 && previous.log.length > 0) run.log.unshift(...previous.log.slice(-120));
    if (touchesDb) await writeState(svc, { status: 'running', attempt_at: new Date().toISOString(), source_url: url, error: null });
    const imported = importedSource(previous);
    if (touchesDb && previous.rows_total > 0 && !powerplayParserCurrent(previous)) {
      log('info', 'Данные в базе записаны прежним разбором дампа, который приписывал спорные системы одной державе, — дамп загружается заново, даже если EDSM его не менял');
    }

    /* ── Какой дамп ── */
    const adopted = adoptManualArchive(dest, url);
    if (adopted) {
      log('info', `На сервере лежит файл архива без метки (${formatPowerplayBytes(adopted.total)}, ${dest}) — принят как положенный вручную`);
    }
    let source: DumpSource | null = null;
    let probe: DumpProbe | null = null;
    const localMeta = readArchiveMeta(dest);
    const uploaded = mode === 'full' && localMeta?.uploaded && archiveIsComplete(dest, localMeta) ? archiveMetaSource(localMeta) : null;
    if (uploaded && (force || !sameDumpSource(uploaded, imported))) {
      // Архив загружен администратором с компьютера (серверу EDSM недоступен
      // или медленен) и ещё не в базе: ради этого его и загружали.
      complete('probe', 'не нужен — архив загружен с компьютера', 'skipped');
      log('info', `Архив загружен в админке с компьютера (${localMeta?.uploadName ?? 'файл'}, ${formatPowerplayBytes(uploaded.total)}`
        + `${uploaded.lastModified ? `, файл от ${uploaded.lastModified}` : ''}) — беру его, EDSM не опрашиваю`);
      source = uploaded;
    } else if (online) {
      await begin('probe', { detail: 'HEAD-запрос к EDSM' });
      const probeStarted = Date.now();
      try {
        probe = await probeDumpSource(url, { fetchImpl, signal: run.controller.signal });
      } catch (error) {
        checkCancelled();
        const offline = mode === 'full' ? localDump(dest, shardsDir) : null;
        if (!offline || offline.url !== url) throw new Error(`EDSM не ответил: ${shortError(error)}`);
        if (!force && sameDumpSource(offline, imported)) {
          complete('probe', 'EDSM не ответил');
          return await notModified(`EDSM не ответил (${shortError(error)}), а дамп, который лежит на сервере, уже загружен в базу`);
        }
        log('warn', `EDSM не ответил (${shortError(error)}) — загружаю в базу то, что уже лежит на сервере (дамп от ${offline.lastModified ?? 'неизвестной даты'})`);
        complete('probe', 'EDSM не ответил — работаю с архивом на сервере');
        source = offline;
      }
      checkCancelled();
      if (probe) {
        log(
          'info',
          `Ответ EDSM за ${formatPowerplayDuration(Date.now() - probeStarted)}: ${probe.total ? formatPowerplayBytes(probe.total) : 'размер неизвестен'}`
            + `${probe.lastModified ? ` · дамп от ${probe.lastModified}` : ''}`
            + ` · докачка и параллельные соединения (Range): ${probe.acceptsRanges ? 'да' : 'нет'}`,
        );
        source = { url, etag: probe.etag, lastModified: probe.lastModified, total: probe.total };
        if (!force && sameDumpSource(source, imported)) {
          complete('probe', 'дамп не менялся');
          return await notModified(mode === 'download'
            ? 'Этот дамп уже загружен в базу — скачивать нечего'
            : 'Дамп не менялся с прошлой загрузки — данные актуальны');
        }
        complete('probe', `${probe.total ? formatPowerplayBytes(probe.total) : 'размер неизвестен'}${probe.lastModified ? ` · от ${probe.lastModified}` : ''}`);
      }
    } else {
      const local = localDump(dest, shardsDir);
      const meta = readArchiveMeta(dest);
      if (mode === 'split' && !archiveIsComplete(dest, meta)) {
        throw new Error(existsSync(/*turbopackIgnore: true*/ dest)
          ? 'Архив на сервере скачан не полностью — сначала докачайте его («Скачать архив»)'
          : 'На сервере нет скачанного архива — сначала «Скачать архив» или «Загрузить архив с компьютера»');
      }
      if (!local) {
        throw new Error(existsSync(/*turbopackIgnore: true*/ dest) || readPowerplayShardManifest(shardsDir)
          ? 'Архив на сервере скачан не полностью, а кусков нет — запустите «Загрузить данные» или «Скачать архив»'
          : 'На сервере нет ни архива, ни кусков — сначала «Скачать архив», «Загрузить архив с компьютера» или «Загрузить данные»');
      }
      source = local;
      log('info', `Дамп на сервере: ${local.url}${local.lastModified ? ` от ${local.lastModified}` : ''}${local.total ? `, ${formatPowerplayBytes(local.total)}` : ''}`);
      if (mode === 'import' && !force && sameDumpSource(local, imported)) {
        return await notModified('Этот дамп уже загружен в базу (принудительный запуск загрузит его снова)');
      }
    }
    if (!source) throw new Error('Не удалось определить, какой дамп загружать');
    const dump: DumpSource = source;

    /* ── Файлы на сервере должны быть от этого дампа ── */
    const meta = readArchiveMeta(dest);
    if (!sameDumpSource(archiveMetaSource(meta), dump) && (existsSync(/*turbopackIgnore: true*/ dest) || existsSync(/*turbopackIgnore: true*/ segmentStatePath(dest)) || meta)) {
      // Часть другого (вчерашнего) дампа или файл без метки: дописывать к нему
      // нельзя — начать заново.
      const freed = removeArchive(dest);
      log('info', `На сервере был архив другого дампа (${formatPowerplayBytes(freed)}) — удалён`);
    }
    let manifest: PowerplayShardManifest | null = readPowerplayShardManifest(shardsDir);
    if (manifest && (!sameDumpSource(manifest.source, dump) || !manifest.complete)) {
      const freed = clearPowerplayShards(shardsDir);
      log('info', manifest.complete
        ? `Куски другого дампа (${formatPowerplayCount(manifest.shards.length)} шт., ${formatPowerplayBytes(freed)}) удалены`
        : 'Куски, разбитые не до конца, удалены — архив разобьётся заново');
      manifest = null;
    } else if (!manifest && existsSync(/*turbopackIgnore: true*/ shardsDir)) {
      clearPowerplayShards(shardsDir);
    }
    if (manifest && touchesDb && force && sameDumpSource(dump, imported) && manifest.shards.some((entry) => entry.imported)) {
      // Принудительный повтор уже загруженного дампа: новая метка импорта, все куски заново.
      manifest.runId = randomUUID();
      for (const entry of manifest.shards) Object.assign(entry, { imported: false, applied: 0, stale: 0 });
      writePowerplayShardManifest(shardsDir, manifest);
      log('info', 'Принудительно: куски этого дампа уже были в базе — записываю их заново с новой меткой импорта');
    }

    /* ── Что делать ── */
    const ctx: { source: DumpSource; probe: DumpProbe | null; manifest: PowerplayShardManifest | null } = {
      source: dump,
      probe,
      manifest,
    };
    let archiveReady = archiveIsComplete(dest, readArchiveMeta(dest));
    const shardsReady = Boolean(ctx.manifest?.complete);
    const needDownload = online && !archiveReady && !(mode === 'full' && shardsReady);
    const needSplit = mode !== 'download' && !shardsReady;
    if (needSplit && !archiveReady && !needDownload) {
      throw new Error('Кусков нет, а архива на сервере нет — запустите «Загрузить данные»');
    }
    if (needDownload && !ctx.probe) {
      throw new Error('EDSM не ответил, а архива этого дампа на сервере нет — повторите позже или загрузите архив с компьютера');
    }

    if (online && !needDownload) {
      complete('download', archiveReady ? `уже на сервере: ${formatPowerplayBytes(fileSize(dest))}` : 'не нужно — куски уже готовы');
      log('info', archiveReady
        ? `Архив этого дампа уже на сервере (${formatPowerplayBytes(fileSize(dest))}, ${dest}) — скачивание не нужно`
        : 'Архив не нужен: этот дамп уже разбит на куски');
    }
    if (mode !== 'download' && !needSplit) {
      complete('split', `уже разбит: ${formatPowerplayCount(ctx.manifest!.shards.length)} кусков, ${formatPowerplayCount(ctx.manifest!.systems)} систем`);
      log('info', `Архив уже разбит на куски: ${formatPowerplayCount(ctx.manifest!.shards.length)} шт., ${formatPowerplayCount(ctx.manifest!.systems)} систем (${shardsDir})`);
    }

    /* ── Шаги по очереди: архив скачивается целиком → разбивается на куски → куски пишутся в базу ── */
    let downloadSeen: { stalls: number; requestBytes: number | null } = { stalls: 0, requestBytes: null };

    const downloadArchive = async (): Promise<void> => {
      const total = ctx.source.total;
      const already = downloadedBytesOnDisk(dest)?.done ?? fileSize(dest);
      const free = freeBytes(dirname(dest));
      const need = Math.max(0, (total ?? 16 * 1024 * 1024) - already) + DISK_RESERVE_BYTES;
      if (free != null && free < need) {
        throw new Error(`Недостаточно места на диске для дампа: свободно ${formatPowerplayBytes(free)}, нужно ~${formatPowerplayBytes(need)} (${dirname(dest)})`);
      }
      writeArchiveMeta(dest, { url: ctx.source.url, etag: ctx.source.etag, lastModified: ctx.source.lastModified, total, completedAt: null });
      log('info', `Скачиваю архив на сервер целиком: ${dest} — до ${segments} соединений, куски по ${formatPowerplayBytes(pieceBytes)}`
        + `${already > 0 ? `, уже скачано ${formatPowerplayBytes(already)} — докачка` : ''}`
        + (mode === 'full' ? '. Разбивка и запись в базу начнутся, когда архив будет на диске целиком' : ''));
      await begin('download', { total, done: already, detail: 'соединение' });
      const downloadStarted = Date.now();
      let firstBytes: number | null = null;
      downloadSeen = { stalls: 0, requestBytes: null };
      const result = await downloadDump({
        url: ctx.source.url,
        dest,
        segments,
        pieceBytes,
        strictSource: true,
        probe: ctx.probe ?? undefined,
        minSegmentedBytes: options.minSegmentedBytes,
        stallTimeoutMs,
        shortRequests,
        minRequestBytes: options.minRequestBytes,
        signal: run.controller.signal,
        retries: Infinity,
        maxStagnantFailures: 12,
        verify: false,
        fetchImpl,
        sleep: options.sleep,
        progressIntervalMs: 1000,
        log: (line) => log(/обрыв|не удалось|недоступн|не даёт|не ответил|заново|замолчал|замирают|замер/i.test(line) ? 'warn' : 'info', `Скачивание: ${line}`),
        onProgress: (info) => {
          downloadSeen = { stalls: info.stalls ?? 0, requestBytes: info.requestBytes ?? null };
          if (firstBytes == null) firstBytes = info.received;
          const seconds = Math.max(1, (Date.now() - downloadStarted) / 1000);
          const speed = Math.max(0, info.received - firstBytes) / seconds;
          const left = info.total && speed > 0 ? ((info.total - info.received) / speed) * 1000 : null;
          return advance('download', {
            done: info.received,
            total: info.total,
            detail: `${formatPowerplayBytes(info.received)}${info.total ? ` из ${formatPowerplayBytes(info.total)}` : ''}`
              + (info.connections ? ` · соединений: ${info.connections}` : '')
              + (info.requestBytes ? ` · запросы по ${formatPowerplayBytes(info.requestBytes)}` : '')
              + (speed > 0 ? ` · ${formatPowerplaySpeed(speed)}` : '')
              + (left != null ? ` · осталось ~${formatPowerplayDuration(left)}` : '')
              + (info.failures > 0 ? ` · обрывов: ${formatPowerplayCount(info.failures)}` : ''),
          });
        },
      });
      writeArchiveMeta(dest, {
        url: ctx.source.url,
        etag: ctx.source.etag,
        lastModified: result.lastModified ?? ctx.source.lastModified,
        total: result.bytes,
        completedAt: new Date().toISOString(),
      });
      archiveReady = true;
      const took = Date.now() - downloadStarted;
      complete('download', `${formatPowerplayBytes(result.bytes)} за ${formatPowerplayDuration(took)} · соединений: ${result.segments}`);
      log('info', `Архив скачан целиком: ${formatPowerplayBytes(result.bytes)} за ${formatPowerplayDuration(took)} (${result.segments} соедин.)`);
    };

    const splitArchive = async (): Promise<void> => {
      const fresh = createPowerplayShardManifest({ source: ctx.source, runId: randomUUID(), systemsPerShard: shardSystems });
      const totalBytes = fileSize(dest) || ctx.source.total || null;
      await begin('split', { total: totalBytes, done: 0, detail: 'читаю архив' });
      log('info', `Разбивка: читаю архив (${formatPowerplayBytes(totalBytes)}), собираю записи по системам, кусок — ${formatPowerplayCount(fresh.systemsPerShard)} систем → ${shardsDir}`);
      const splitStarted = Date.now();
      try {
        await splitPowerplayArchive({
          archive: dest,
          dir: shardsDir,
          manifest: fresh,
          signal: run.controller.signal,
          onProgress: (info) => advance('split', {
            done: info.bytesRead,
            total: totalBytes,
            detail: info.records > 0
              ? `записей ${formatPowerplayCount(info.records)} · кусков ${formatPowerplayCount(info.shards)} · систем ${formatPowerplayCount(info.systems)}`
              : `прочитано ${formatPowerplayBytes(info.bytesRead)}`,
          }),
        });
      } catch (error) {
        if (run.controller.signal.aborted || (error as Error)?.message === POWERPLAY_SPLIT_ABORTED) throw error;
        if (isArchiveCorruption(error)) throw new PowerplayArchiveCorrupted(`Архив не разбирается: ${shortError(error)}`);
        throw error;
      }
      ctx.manifest = fresh;
      complete('split', `${formatPowerplayCount(fresh.shards.length)} кусков · ${formatPowerplayCount(fresh.systems)} систем за ${formatPowerplayDuration(Date.now() - splitStarted)}`);
      log('info', `Разбивка завершена: ${formatPowerplayCount(fresh.shards.length)} кусков, ${formatPowerplayCount(fresh.systems)} систем за ${formatPowerplayDuration(Date.now() - splitStarted)}`);
      if (fresh.stats) for (const line of describeStats(fresh.stats)) log('info', line);
    };

    const importShards = async (): Promise<void> => {
      const done = ctx.manifest!;
      const db = writer!;
      const total = done.shards.length;
      const importedNow = () => done.shards.filter((entry) => entry.imported).length;
      const resumed = importedNow();
      if (resumed > 0) log('info', `Запись в базу: продолжаю — ${formatPowerplayCount(resumed)} кусков этого дампа уже в базе`);
      await begin('import', { total, done: resumed, detail: `кусок ${formatPowerplayCount(resumed)} из ${formatPowerplayCount(total)}` });
      const importStarted = Date.now();
      for (let index = 0; index < done.shards.length; index++) {
        checkCancelled();
        const entry = done.shards[index];
        if (entry.imported) continue;
        let rows: Record<string, unknown>[];
        try {
          rows = await readShardRows(join(shardsDir, entry.file));
        } catch (error) {
          throw new PowerplayShardCorrupted(`Кусок ${entry.file} не читается: ${shortError(error)}`);
        }
        const result = await db.apply(rows, done.runId);
        Object.assign(entry, { imported: true, applied: result.written, stale: Math.max(0, rows.length - result.written) });
        writePowerplayShardManifest(shardsDir, done);
        written += result.written;
        const systems = done.shards.reduce((sum, item) => sum + (item.imported ? item.systems : 0), 0);
        log('info', `Запись в базу: кусок ${index + 1} из ${formatPowerplayCount(total)} — записано ${formatPowerplayCount(systems)} из ${formatPowerplayCount(done.systems)} систем`);
        const importedShards = importedNow();
        await advance('import', {
          done: importedShards,
          total,
          detail: `кусок ${formatPowerplayCount(importedShards)} из ${formatPowerplayCount(total)} · ${formatPowerplayCount(systems)} из ${formatPowerplayCount(done.systems)} систем`,
        });
      }
      const rowsWritten = done.shards.reduce((sum, item) => sum + item.applied, 0);
      complete('import', `${formatPowerplayCount(total)} кусков · ${formatPowerplayCount(rowsWritten)} строк за ${formatPowerplayDuration(Date.now() - importStarted)}`);
    };

    // 1. Скачать архив целиком (если его нет и куски не готовы). EDSM может
    //    пересобрать дамп посреди скачивания — тогда заново со свежим дампом.
    if (needDownload && !archiveReady) {
      for (let restarts = 0; ; restarts++) {
        try {
          await downloadArchive();
          break;
        } catch (error) {
          if (run.cancelled || !isDumpSourceChanged(error) || restarts >= MAX_SOURCE_RESTARTS) {
            if (!run.cancelled && downloadSeen.stalls > 0) {
              log('warn', downloadSeen.requestBytes
                ? `Соединения с EDSM замирают даже на коротких запросах по ${formatPowerplayBytes(downloadSeen.requestBytes)} — сеть сервера (фильтрация трафика к зарубежным CDN) не даёт скачать дамп. Скачайте ${POWERPLAY_ARCHIVE_SOURCE_NAME} на компьютере и загрузите его кнопкой «Загрузить архив с компьютера» или задайте POWERPLAY_DUMP_URL на доступное серверу зеркало`
                : `Соединения с EDSM замолкали ${formatPowerplayCount(downloadSeen.stalls)} раз. Скачанное осталось на сервере — следующий запуск докачает. Если так и не пойдёт, скачайте ${POWERPLAY_ARCHIVE_SOURCE_NAME} на компьютере и загрузите кнопкой «Загрузить архив с компьютера»`);
            }
            throw error;
          }
          // Старые байты бесполезны: начать со свежим дампом.
          log('warn', `Дамп на EDSM обновился во время скачивания (${shortError(error)}) — удаляю скачанное и начинаю заново со свежим дампом`);
          removeArchive(dest);
          clearPowerplayShards(shardsDir);
          const fresh = await probeDumpSource(url, { fetchImpl, signal: run.controller.signal });
          ctx.probe = fresh;
          ctx.source = { url, etag: fresh.etag, lastModified: fresh.lastModified, total: fresh.total };
          ctx.manifest = null;
          resetPowerplayStage(run.progress, 'download');
          log('info', `Новый дамп: ${fresh.total ? formatPowerplayBytes(fresh.total) : 'размер неизвестен'}${fresh.lastModified ? ` от ${fresh.lastModified}` : ''}`);
        }
      }
    }
    checkCancelled();
    // 2. Разбить архив на куски — только когда он целиком на диске.
    if (needSplit && !ctx.manifest?.complete) await splitArchive();
    checkCancelled();

    /* ── Запуски по частям заканчиваются здесь ── */
    if (mode === 'download') {
      const bytes = fileSize(dest);
      const durationMs = Date.now() - started;
      const message = `Архив скачан на сервер: ${formatPowerplayBytes(bytes)} — «Загрузить данные» разобьёт его и запишет в базу без повторного скачивания`;
      log('info', `${message}. Готово за ${formatPowerplayDuration(durationMs)}`);
      finishPowerplayProgress(run.progress, 'ok', { message, result: { archiveBytes: bytes, durationMs } });
      return { status: 'ok', mode, archiveBytes: bytes, durationMs };
    }
    const shards = ctx.manifest!;
    if (mode === 'split') {
      const durationMs = Date.now() - started;
      const message = `Архив разбит на ${formatPowerplayCount(shards.shards.length)} кусков (${formatPowerplayCount(shards.systems)} систем) — «Загрузить куски в базу» запишет их без EDSM`;
      log('info', `${message}. Готово за ${formatPowerplayDuration(durationMs)}`);
      finishPowerplayProgress(run.progress, 'ok', { message, result: { shards: shards.shards.length, systems: shards.systems, durationMs } });
      return { status: 'ok', mode, shards: shards.shards.length, durationMs };
    }

    /* ── Защита данных: битый или «усохший» дамп таблицу не трогает ── */
    const stats = shards.stats;
    if (shards.systems < minRows) {
      throw new Error(`В дампе всего ${shards.systems} систем под контролем (записей ${stats?.records ?? shards.recordsRead}) — похоже на сбой источника, данные не тронуты`);
    }
    if (!force && previous.rows_total >= minRows * 10 && shards.systems < previous.rows_total * POWERPLAY_SHRINK_GUARD) {
      throw new Error(`Дамп подозрительно мал: ${shards.systems} систем против ${previous.rows_total} в прошлый раз — данные не тронуты (ручной запуск с force=1 примет его)`);
    }

    // 3. Записать куски в базу. Подключение к базе открывается только сейчас:
    //    простаивая всё скачивание, его мог бы закрыть сервер или пул.
    writer = await createPowerplayWriter({
      svc,
      direct: options.directDb,
      pgClient: options.pgClient,
      batchSize: options.batchSize ?? powerplayBatchSize(),
      log,
    });
    log('info', writer.backend === 'pg'
      ? `Запись в базу: ${writer.label} — кусок одним вызовом, без statement_timeout`
      : `Запись в базу: ${writer.label} — пачками по ${formatPowerplayCount(writer.batchSize)} систем (пачка, не уложившаяся в statement_timeout, делится пополам)`);
    await importShards();
    checkCancelled();

    /* ── Завершение ── */
    const db = writer;
    await begin('finish', { detail: 'удаляю системы, пропавшие из дампа' });
    const dumpGeneratedAt = headerDate(ctx.source.lastModified);
    const archiveBytes = ctx.source.total ?? fileSize(dest);
    const rows = shards.shards.reduce((sum, item) => sum + item.applied, 0);
    const summary = await db.finish(shards.runId, {
      source_url: ctx.source.url,
      etag: ctx.source.etag,
      last_modified: ctx.source.lastModified,
      dump_generated_at: dumpGeneratedAt,
      stats: { ...(stats ?? {}), dump_bytes: archiveBytes || null, shards: shards.shards.length, written: rows, backend: db.backend },
    }) as { deleted?: number; total?: number; journal?: number; sole?: number; kept?: number; unknown?: number };
    shared.edrcPowerplayLayerVersion = powerplayLayerGeneration() + 1;
    const deleted = Number(summary.deleted ?? 0);
    const total = Number(summary.total ?? shards.systems);
    complete('finish', `удалено ${formatPowerplayCount(deleted)} · всего ${formatPowerplayCount(total)}`);
    log('info', `Удалено систем, пропавших из дампа: ${formatPowerplayCount(deleted)} · всего в таблице: ${formatPowerplayCount(total)}`);
    if (summary.unknown != null) {
      log(
        Number(summary.unknown) > 0 ? 'warn' : 'info',
        `Владелец системы: по журналам (ControllingPower) ${formatPowerplayCount(Number(summary.journal ?? 0))},`
          + ` по дампу (одна держава) ${formatPowerplayCount(Number(summary.sole ?? 0))},`
          + ` сохранён из прошлых точных данных ${formatPowerplayCount(Number(summary.kept ?? 0))},`
          + ` не определён ${formatPowerplayCount(Number(summary.unknown ?? 0))}`
          + (Number(summary.unknown) > 0 ? ' — их уточнят журналы пилотов и живые данные EDDN' : ''),
      );
    } else {
      log('warn', 'База без миграции 20261021120000_powerplay_owner.sql: записаны только системы с одной державой в дампе — примените миграции');
    }
    if (!keepArchive) {
      const freed = removeArchive(dest) + clearPowerplayShards(shardsDir);
      log('info', `Архив и куски удалены с сервера — освобождено ${formatPowerplayBytes(freed)} (POWERPLAY_ARCHIVE_KEEP=1 оставляет их)`);
    } else {
      log('info', `Архив и куски оставлены на сервере (POWERPLAY_ARCHIVE_KEEP=1): ${dest}`);
    }
    const durationMs = Date.now() - started;
    log('info', `Готово за ${formatPowerplayDuration(durationMs)}: на карте ${formatPowerplayCount(total)} систем держав`);
    finishPowerplayProgress(run.progress, 'ok', {
      message: `Загружено ${formatPowerplayCount(total)} систем`,
      result: { rows, deleted, total, shards: shards.shards.length, durationMs },
    });
    return {
      status: 'ok',
      mode,
      rows,
      deleted,
      total,
      shards: shards.shards.length,
      archiveBytes: archiveBytes || undefined,
      backend: db.backend,
      stats: stats ?? undefined,
      dumpGeneratedAt,
      durationMs,
    };
  } catch (error) {
    const cancelled = run.cancelled;
    const message = cancelled ? POWERPLAY_CANCEL_MESSAGE : shortError(error);
    const durationMs = Date.now() - started;
    if (cancelled) {
      log('warn', mode === 'download'
        ? `${POWERPLAY_CANCEL_MESSAGE}: скачанная часть осталась на сервере — следующий запуск докачает архив`
        : written > 0
          ? `${POWERPLAY_CANCEL_MESSAGE}: часть систем уже обновлена, пропавшие из дампа не удалялись — следующая загрузка допишет остальные куски и доведёт таблицу до конца`
          : `${POWERPLAY_CANCEL_MESSAGE}: таблица не тронута — скачанное и разбитое осталось на сервере, следующий запуск продолжит с того же места`);
    } else {
      log('error', `Ошибка: ${message}`);
      if (error instanceof PowerplayArchiveCorrupted) {
        removeArchive(dest);
        clearPowerplayShards(shardsDir);
        log('warn', 'Архив повреждён или внутри не дамп PowerPlay — удалён с сервера вместе с кусками, следующий запуск скачает дамп заново');
      } else if (error instanceof PowerplayShardCorrupted) {
        clearPowerplayShards(shardsDir);
        log('warn', 'Кусок повреждён — куски удалены, следующий запуск разобьёт архив заново');
      }
    }
    // Часть кусков записана: слой пересоберётся с обновлёнными строками.
    if (written > 0) shared.edrcPowerplayLayerVersion = powerplayLayerGeneration() + 1;
    finishPowerplayProgress(run.progress, cancelled ? 'cancelled' : 'error', {
      message: cancelled ? POWERPLAY_CANCEL_MESSAGE : message,
      result: { error: message, durationMs },
    });
    if (touchesDb) {
      try {
        await writeState(svc, { status: 'error', error: message });
      } catch {
        // Состояние не записалось — ошибка всё равно уйдёт в ответ и в журнал.
      }
    }
    return { status: cancelled ? 'cancelled' : 'error', mode, error: message, durationMs };
  } finally {
    if (writer) await writer.close().catch(() => undefined);
    await persistRun(svc, run, true);
    shared.edrcPowerplayLastRun = snapshot(run);
    if (shared.edrcPowerplayLive === run) shared.edrcPowerplayLive = null;
  }
}

/** Удалить скачанный архив (и план докачки) и куски. Во время импорта — нельзя. */
export function cleanupPowerplayArchive(
  path = powerplayArchivePath(),
  shardsDir = powerplayShardsDirFor(path),
): { removed: boolean; freed: number; shards: number; reason?: string } {
  if (isPowerplaySyncRunning()) return { removed: false, freed: 0, shards: 0, reason: 'Идёт импорт — архив и куски нужны ему' };
  const manifest = readPowerplayShardManifest(shardsDir);
  const exists = archiveLeftovers(path) || Boolean(manifest);
  const freed = removeArchive(path) + clearPowerplayShards(shardsDir);
  return { removed: exists, freed, shards: manifest?.shards.length ?? 0 };
}

/* ── Сводка для админки ────────────────────────────────────────────────── */

export interface PowerplayPowerSummary {
  power: string;
  Stronghold: number;
  Fortified: number;
  Exploited: number;
  total: number;
  /** Откуда известен владелец этих систем (без миграции 20261021120000 — нули). */
  journal: number;
  sole: number;
  kept: number;
  /** Строки старого импорта (владелец по прежнему разбору, до перезагрузки). */
  legacy: number;
  /** Систем с неопределённым владельцем, где держава — среди претендентов. */
  contested: number;
}

export interface PowerplayUnknownSummary {
  total: number;
  Stronghold: number;
  Fortified: number;
  Exploited: number;
}

export interface PowerplayTableSummary {
  total: number;
  powers: PowerplayPowerSummary[];
  /** Системы под контролем с неопределённым владельцем. */
  unknown: PowerplayUnknownSummary;
  /** Системы по основанию: journal, sole, kept, unknown, legacy. */
  bases: Record<string, number>;
  /** Системы под контролем по источнику: edsm (дамп), helper, web (журнал/CAPI через сайт), eddn. */
  sources: Record<string, number>;
  /** Системы, которые пилоты увидели свободными после дампа (слой их не показывает). */
  vacated: number;
  oldestObservation: string | null;
  newestObservation: string | null;
  lastChange: string | null;
}

function isoOrNull(value: unknown): string | null {
  if (value == null) return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Что сейчас в таблице: по державам и состояниям (RPC `powerplay_admin_summary`). */
export async function readPowerplaySummary(svc: Svc): Promise<PowerplayTableSummary> {
  const { data, error } = await svc.rpc('powerplay_admin_summary');
  if (error) throw new Error(error.message);
  const raw = (typeof data === 'string' ? JSON.parse(data) : data ?? {}) as Record<string, unknown>;
  const powers = Array.isArray(raw.powers)
    ? raw.powers
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && typeof (item as { power?: unknown }).power === 'string')
        .map((item) => ({
          power: String(item.power),
          Stronghold: count(item.Stronghold),
          Fortified: count(item.Fortified),
          Exploited: count(item.Exploited),
          total: count(item.total),
          journal: count(item.journal),
          sole: count(item.sole),
          kept: count(item.kept),
          legacy: count(item.legacy),
          contested: count(item.contested),
        }))
    : [];
  const rawUnknown = raw.unknown && typeof raw.unknown === 'object' ? (raw.unknown as Record<string, unknown>) : {};
  const bases: Record<string, number> = {};
  if (raw.bases && typeof raw.bases === 'object' && !Array.isArray(raw.bases)) {
    for (const [basis, value] of Object.entries(raw.bases as Record<string, unknown>)) {
      if (/^[a-z]{1,16}$/.test(basis)) bases[basis] = count(value);
    }
  }
  const sources: Record<string, number> = {};
  if (raw.sources && typeof raw.sources === 'object' && !Array.isArray(raw.sources)) {
    for (const [source, value] of Object.entries(raw.sources as Record<string, unknown>)) {
      if (/^[a-z-]{1,24}$/.test(source)) sources[source] = count(value);
    }
  }
  return {
    total: count(raw.total),
    powers,
    unknown: {
      total: count(rawUnknown.total),
      Stronghold: count(rawUnknown.Stronghold),
      Fortified: count(rawUnknown.Fortified),
      Exploited: count(rawUnknown.Exploited),
    },
    bases,
    sources,
    vacated: count(raw.vacated),
    oldestObservation: isoOrNull(raw.oldest_observation),
    newestObservation: isoOrNull(raw.newest_observation),
    lastChange: isoOrNull(raw.last_change),
  };
}

/** Ближайший запуск задачи `powerplay-sync` по расписанию планировщика (UTC). */
export function nextPowerplayScheduledRun(nowMs = Date.now()): string {
  const { periodMs, offsetMs } = POWERPLAY_SCHEDULE;
  const next = Math.floor((nowMs - offsetMs) / periodMs + 1) * periodMs + offsetMs;
  return new Date(next).toISOString();
}

/* ── Ленивое обновление из API слоя ────────────────────────────────────── */

export interface PowerplayFreshness {
  /** Импорт идёт (только что запущен или уже шёл). */
  refreshing: boolean;
  /** Нужен ли импорт по возрасту данных. */
  stale: boolean;
}

function age(value: string | null, nowMs: number): number {
  const ms = value ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? nowMs - ms : Infinity;
}

/** Импорт оборвался вместе с процессом сайта (состояние «running», а живого прогона нет). */
export function powerplaySyncInterrupted(state: PowerplaySyncState): boolean {
  return !isPowerplaySyncRunning() && state.status === 'running';
}

export function powerplayNeedsRefresh(state: PowerplaySyncState, nowMs = Date.now()): { stale: boolean; allowed: boolean } {
  const stale = state.rows_total === 0
    || age(state.checked_at, nowMs) > POWERPLAY_STALE_AFTER_MS
    || !powerplayParserCurrent(state);
  const runningElsewhere = state.status === 'running' && age(state.attempt_at, nowMs) < RUNNING_STALE_MS;
  const allowed = !runningElsewhere && age(state.attempt_at, nowMs) > POWERPLAY_RETRY_AFTER_MS;
  return { stale, allowed };
}

/** Когда ленивое обновление снова попробует источник после неудачи (ISO) или null. */
export function powerplayNextLazyAttempt(state: PowerplaySyncState, nowMs = Date.now()): string | null {
  const { stale, allowed } = powerplayNeedsRefresh(state, nowMs);
  if (!stale) {
    const checked = state.checked_at ? Date.parse(state.checked_at) : NaN;
    return Number.isFinite(checked) ? new Date(checked + POWERPLAY_STALE_AFTER_MS).toISOString() : null;
  }
  if (allowed) return new Date(nowMs).toISOString();
  const attempt = state.attempt_at ? Date.parse(state.attempt_at) : NaN;
  return Number.isFinite(attempt) ? new Date(attempt + POWERPLAY_RETRY_AFTER_MS).toISOString() : null;
}

/**
 * Запустить импорт фоном, если данных нет или они устарели. Не ждёт его и не
 * бросает: слой отдаётся с тем, что есть, а клиент перезапросит позже.
 */
export function ensurePowerplayFresh(
  svc: Svc,
  state: PowerplaySyncState,
  options: PowerplaySyncOptions & { nowMs?: number } = {},
): PowerplayFreshness {
  if (isPowerplaySyncRunning()) return { refreshing: true, stale: true };
  const { stale, allowed } = powerplayNeedsRefresh(state, options.nowMs ?? Date.now());
  if (!stale) return { refreshing: false, stale: false };
  if (!allowed) return { refreshing: state.status === 'running', stale: true };
  void runPowerplaySync(svc, { ...options, trigger: options.trigger ?? 'lazy' }).catch(() => undefined);
  return { refreshing: true, stale: true };
}
