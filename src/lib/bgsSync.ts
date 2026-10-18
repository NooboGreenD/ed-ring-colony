/**
 * Импорт минорных фракций из ночного дампа EDSM `systemsPopulated.json.gz`.
 *
 * Дамп большой (≈0,5 ГБ gzip, несколько ГБ JSON — почти всё станции и тела),
 * а канал сервера к EDSM тонкий. Поэтому конвейер такой же, как у каталога
 * систем — архив скачивается на сервер, разбивается там на куски, куски
 * загружаются в базу, — только этапы идут ОДНОВРЕМЕННО:
 *
 *   1. probe    — HEAD к EDSM: размер, дата, поддержка Range. Тот же дамп,
 *                 что в прошлый удачный импорт, второй раз не качается;
 *   2. download — архив на сервер (`data/spansh/factions`, тот же диск, что у
 *                 каталога систем). FACTIONS_DOWNLOAD_SEGMENTS соединений (8)
 *                 берут куски файла по FACTIONS_PIECE_MB (8 МБ) по порядку,
 *                 поэтому начало файла готово почти сразу, а скорость — сумма
 *                 соединений. Докачка после обрыва и перезапуска сайта; дамп,
 *                 пересобранный EDSM посреди скачивания, со старым не
 *                 склеивается — скачивание начинается заново;
 *   3. split    — по мере скачивания архив разбирается (`bgsDump.ts`) и
 *                 раскладывается в куски по FACTIONS_SHARD_SYSTEMS систем
 *                 (`bgsShards.ts`): от 0,5 ГБ остаются мегабайты;
 *   4. import   — готовые куски сразу пишутся в базу (`bgsWriter.ts`: прямой
 *                 Postgres, как у каталога, или PostgREST). Кусок — единица
 *                 продолжения: после обрыва пишутся только незаписанные;
 *   5. finish   — удалить системы, пропавшие из дампа (если пилоты не
 *                 присылали их последние 30 дней), пересчитать фракции,
 *                 записать состояние; архив и куски удаляются с диска.
 *
 * Админка умеет и по частям (`mode`): только скачать архив, только разбить
 * его на куски, загрузить в базу то, что уже на сервере (без EDSM).
 *
 * Правило слияния в базе — «свежее наблюдение побеждает»: данные пилота из
 * Colonial Helper новее дампа не затираются.
 *
 * Запускают импорт администратор (Админка → Игровые данные → Фракции,
 * `/api/admin/factions`) и задача `factions-sync` (раз в сутки проверяет,
 * не пора ли обновить; первый импорт — решение администратора). Ход этапов и
 * журнал — в памяти процесса и копией в `bgs_sync_state`.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, statfsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { BgsDumpCounter, type BgsDumpStats } from './bgsDump.ts';
import {
  BGS_MODE_LABEL,
  BGS_TRIGGER_LABEL,
  createBgsProgress,
  finishBgsProgress,
  finishBgsStage,
  formatBgsBytes,
  formatBgsCount,
  formatBgsDuration,
  formatBgsSpeed,
  pushBgsLog,
  resetBgsStage,
  sanitizeBgsLog,
  sanitizeBgsProgress,
  startBgsStage,
  updateBgsStage,
  type BgsLogLevel,
  type BgsLogLine,
  type BgsStageId,
  type BgsSyncMode,
  type BgsSyncProgress,
  type BgsSyncTrigger,
} from './bgsProgress.ts';
import {
  BgsPulse,
  BGS_SPLIT_ABORTED,
  DEFAULT_BGS_SHARD_SYSTEMS,
  bgsShardsInfo,
  clearBgsShards,
  createBgsShardManifest,
  readBgsShardManifest,
  readBgsShardRows,
  sameBgsDumpSource,
  splitBgsArchive,
  writeBgsShardManifest,
  writeFileAtomic,
  type BgsDumpSource,
  type BgsShardManifest,
  type BgsShardsInfo,
} from './bgsShards.ts';
import {
  bgsBatchSize,
  createBgsWriter,
  createPostgrestBgsWriter,
  type BgsDbWriter,
  type BgsPgClient,
} from './bgsWriter.ts';
import {
  contiguousBytesOnDisk,
  downloadDump,
  downloadedBytesOnDisk,
  galaxyArchiveDir,
  isDumpSourceChanged,
  probeDumpSource,
  segmentStatePath,
  type DumpProbe,
} from './galaxyImport.ts';

export { bgsBatchSize, bgsDirectDb, describeBgsWriter, isStatementTimeout, recountAllFactions } from './bgsWriter.ts';
export type { BgsShardsInfo } from './bgsShards.ts';

type Svc = any;

export const DEFAULT_BGS_DUMP_URL = 'https://www.edsm.net/dump/systemsPopulated.json.gz';
const USER_AGENT = 'ED-Ring-Colony/2 (+https://edringcolony.ru; minor factions layer)';
export const BGS_ARCHIVE_FILE = 'edsm-systemsPopulated.json.gz';
const META_SUFFIX = '.meta.json';

/** Населённых систем в настоящем дампе десятки тысяч. */
export const BGS_MIN_SYSTEMS = 1000;
/** Новый дамп меньше половины прошлого — скорее сбой источника. */
export const BGS_SHRINK_GUARD = 0.5;
/** Пропавшие из дампа системы живут, пока пилоты присылали их не позже этого. */
export const BGS_KEEP_DAYS = 30;
/** Задача `factions-sync` обновляет данные, если прошлый импорт старше этого. */
export const BGS_DEFAULT_REFRESH_DAYS = 7;
/**
 * Соединений к EDSM по умолчанию. Канал сервера режет скорость одного
 * соединения (у Spansh — ~10 КБ/с на поток), поэтому их больше, чем у каталога.
 */
export const BGS_DEFAULT_SEGMENTS = 8;
export const BGS_MAX_SEGMENTS = 16;
/** Кусок файла, который соединение берёт за раз. */
export const BGS_DEFAULT_PIECE_MB = 8;
/** «running» без живого прогона и старше этого — оборванный импорт. */
const RUNNING_STALE_MS = 6 * 60 * 60 * 1000;
const PERSIST_EVERY_MS = 1000;
/** Запас свободного места сверх размера дампа. */
const DISK_RESERVE_BYTES = 256 * 1024 * 1024;
/** Сколько раз за запуск начинать заново, если EDSM пересобрал дамп посреди скачивания. */
const MAX_SOURCE_RESTARTS = 2;

/**
 * Расписание задачи `factions-sync` (копия из scripts/job-schedule.mjs — тест
 * следит, чтобы они не разошлись): раз в сутки в 07:10 UTC, после того как
 * EDSM выложил свежие дампы.
 */
export const BGS_SCHEDULE = { periodMs: 24 * 60 * 60 * 1000, offsetMs: (7 * 60 + 10) * 60 * 1000 } as const;

export const BGS_CANCEL_MESSAGE = 'Импорт остановлен администратором';

/* ── Настройки ─────────────────────────────────────────────────────────── */

export function bgsDumpUrl(env: Record<string, string | undefined> = process.env): string {
  const raw = env.FACTIONS_DUMP_URL?.trim();
  if (!raw) return DEFAULT_BGS_DUMP_URL;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : DEFAULT_BGS_DUMP_URL;
  } catch {
    return DEFAULT_BGS_DUMP_URL;
  }
}

/** Каталог архива: по умолчанию рядом с дампами каталога систем (отдельный диск). */
export function bgsArchiveDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.FACTIONS_ARCHIVE_DIR?.trim() || join(galaxyArchiveDir(env), 'factions');
}

export function bgsArchivePath(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(bgsArchiveDir(env), BGS_ARCHIVE_FILE);
}

/** Куски лежат рядом с архивом, в `shards/`. */
export function bgsShardsDirFor(archivePath: string): string {
  return join(dirname(resolve(archivePath)), 'shards');
}

export function bgsShardsDir(env: NodeJS.ProcessEnv = process.env): string {
  return bgsShardsDirFor(bgsArchivePath(env));
}

/** `FACTIONS_ARCHIVE_KEEP=1` — не удалять архив и куски после удачного импорта. */
export function bgsArchiveKeep(env: Record<string, string | undefined> = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env.FACTIONS_ARCHIVE_KEEP?.trim() ?? '');
}

/** `FACTIONS_MIN_SYSTEMS` — меньше систем в дампе считается сбоем источника (для зеркал с выборкой). */
export function bgsMinSystems(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.FACTIONS_MIN_SYSTEMS);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : BGS_MIN_SYSTEMS;
}

export function bgsRefreshDays(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.FACTIONS_REFRESH_DAYS);
  return Number.isFinite(raw) && raw > 0 ? Math.max(1, Math.min(60, Math.floor(raw))) : BGS_DEFAULT_REFRESH_DAYS;
}

export function clampBgsSegments(value: unknown): number {
  const raw = Number(value);
  return Number.isFinite(raw) && raw >= 1 ? Math.max(1, Math.min(BGS_MAX_SEGMENTS, Math.floor(raw))) : BGS_DEFAULT_SEGMENTS;
}

/** `FACTIONS_DOWNLOAD_SEGMENTS` — соединений к EDSM (1–16, по умолчанию 8). */
export function bgsDownloadSegments(env: Record<string, string | undefined> = process.env): number {
  return clampBgsSegments(env.FACTIONS_DOWNLOAD_SEGMENTS?.trim() || BGS_DEFAULT_SEGMENTS);
}

/** `FACTIONS_PIECE_MB` — кусок файла на одно соединение (1–64 МБ, по умолчанию 8). */
export function bgsPieceBytes(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.FACTIONS_PIECE_MB);
  const mb = Number.isFinite(raw) && raw > 0 ? Math.max(1, Math.min(64, Math.floor(raw))) : BGS_DEFAULT_PIECE_MB;
  return mb * 1024 * 1024;
}

/** `FACTIONS_SHARD_SYSTEMS` — систем в куске (100–10 000, по умолчанию 1000). */
export function bgsShardSystems(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.FACTIONS_SHARD_SYSTEMS);
  return Number.isFinite(raw) && raw > 0 ? Math.max(100, Math.min(10_000, Math.floor(raw))) : DEFAULT_BGS_SHARD_SYSTEMS;
}

/* ── Состояние ─────────────────────────────────────────────────────────── */

export interface BgsSyncState {
  status: 'idle' | 'running' | 'ok' | 'error';
  source_url: string | null;
  etag: string | null;
  last_modified: string | null;
  dump_generated_at: string | null;
  dump_bytes: number | null;
  run_id: string | null;
  systems_total: number;
  factions_total: number;
  presence_total: number;
  stats: Record<string, unknown> | null;
  error: string | null;
  attempt_at: string | null;
  checked_at: string | null;
  synced_at: string | null;
  progress: BgsSyncProgress | null;
  log: BgsLogLine[];
}

const EMPTY_STATE: BgsSyncState = {
  status: 'idle',
  source_url: null,
  etag: null,
  last_modified: null,
  dump_generated_at: null,
  dump_bytes: null,
  run_id: null,
  systems_total: 0,
  factions_total: 0,
  presence_total: 0,
  stats: null,
  error: null,
  attempt_at: null,
  checked_at: null,
  synced_at: null,
  progress: null,
  log: [],
};

function count(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

export async function readBgsSyncState(svc: Svc): Promise<BgsSyncState> {
  const { data, error } = await svc.from('bgs_sync_state').select('*').eq('id', 1).maybeSingle();
  if (error) throw new Error(error.message);
  return {
    ...EMPTY_STATE,
    ...(data ?? {}),
    dump_bytes: data?.dump_bytes == null ? null : count(data.dump_bytes),
    systems_total: count(data?.systems_total),
    factions_total: count(data?.factions_total),
    presence_total: count(data?.presence_total),
    progress: sanitizeBgsProgress(data?.progress),
    log: sanitizeBgsLog(data?.log),
  };
}

async function writeState(svc: Svc, patch: Partial<BgsSyncState>): Promise<void> {
  const { error } = await svc
    .from('bgs_sync_state')
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

/** Дамп, который сейчас в базе (заголовки последнего удачного импорта). */
function importedSource(state: BgsSyncState): BgsDumpSource | null {
  if (state.systems_total <= 0 || !state.source_url) return null;
  return { url: state.source_url, etag: state.etag, lastModified: state.last_modified, total: state.dump_bytes };
}

/* ── Архив на диске ────────────────────────────────────────────────────── */

/**
 * Метка архива рядом с файлом: какой дамп качается (пишется в начале
 * скачивания) и скачан ли он целиком (`completedAt`). Без неё нельзя понять,
 * чья недокачанная часть лежит на диске: дописать к ней хвост другого дампа —
 * значит получить битый gzip.
 */
interface ArchiveMeta {
  url: string;
  etag: string | null;
  lastModified: string | null;
  total: number | null;
  completedAt: string | null;
}

function readArchiveMeta(dest: string): ArchiveMeta | null {
  try {
    const raw = JSON.parse(readFileSync(`${dest}${META_SUFFIX}`, 'utf8')) as Partial<ArchiveMeta>;
    if (!raw || typeof raw.url !== 'string') return null;
    return {
      url: raw.url,
      etag: typeof raw.etag === 'string' ? raw.etag : null,
      lastModified: typeof raw.lastModified === 'string' ? raw.lastModified : null,
      total: typeof raw.total === 'number' && raw.total > 0 ? raw.total : null,
      completedAt: typeof raw.completedAt === 'string' && raw.completedAt ? raw.completedAt : null,
    };
  } catch {
    return null;
  }
}

function writeArchiveMeta(dest: string, meta: ArchiveMeta): void {
  try {
    mkdirSync(dirname(dest), { recursive: true });
    writeFileAtomic(`${dest}${META_SUFFIX}`, JSON.stringify(meta, null, 1));
  } catch {
    // Без метки архив просто скачается заново в следующий раз.
  }
}

function metaSource(meta: ArchiveMeta | null): BgsDumpSource | null {
  return meta ? { url: meta.url, etag: meta.etag, lastModified: meta.lastModified, total: meta.total } : null;
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** Архив скачан целиком: есть метка с `completedAt`, размер сходится, плана докачки нет. */
function archiveIsComplete(dest: string, meta: ArchiveMeta | null): boolean {
  return Boolean(meta?.completedAt && existsSync(dest) && !existsSync(segmentStatePath(dest)) && meta.total === fileSize(dest));
}

function removeArchive(dest: string): number {
  const partial = downloadedBytesOnDisk(dest);
  const bytes = partial ? partial.done : fileSize(dest);
  for (const path of [dest, segmentStatePath(dest), `${dest}${META_SUFFIX}`]) rmSync(path, { force: true });
  return bytes;
}

function freeBytes(dir: string): number | null {
  try {
    mkdirSync(dir, { recursive: true });
    const stats = statfsSync(dir);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

export interface BgsArchiveInfo {
  path: string;
  exists: boolean;
  /** Размер файла на диске (у недокачанного параллельного — уже полный размер: файл выделен заранее). */
  bytes: number;
  /** Сколько реально скачано. */
  downloaded: number;
  /** Размер дампа на EDSM, если известен. */
  total: number | null;
  /** Скачивание не закончено — следующий запуск докачает. */
  partial: boolean;
  /** Архив скачан целиком (есть метка), дата дампа. */
  complete: boolean;
  lastModified: string | null;
  freeBytes: number | null;
}

export function bgsArchiveInfo(path = bgsArchivePath()): BgsArchiveInfo {
  const exists = existsSync(path);
  const meta = exists ? readArchiveMeta(path) : null;
  const bytes = exists ? fileSize(path) : 0;
  const plan = exists ? downloadedBytesOnDisk(path) : null;
  const complete = archiveIsComplete(path, meta);
  return {
    path,
    exists,
    bytes,
    downloaded: plan ? plan.done : bytes,
    total: plan?.total ?? meta?.total ?? (complete ? bytes : null),
    partial: Boolean(plan) || (exists && !complete),
    complete,
    lastModified: meta?.lastModified ?? null,
    freeBytes: freeBytes(dirname(path)),
  };
}

export function bgsShardsStatus(dir = bgsShardsDir()): BgsShardsInfo {
  return bgsShardsInfo(dir);
}

/* ── Один импорт за раз на процесс ─────────────────────────────────────── */

interface LiveRun {
  progress: BgsSyncProgress;
  log: BgsLogLine[];
  controller: AbortController;
  cancelled: boolean;
  persistedAt: number;
}

export interface BgsRunSnapshot {
  progress: BgsSyncProgress;
  log: BgsLogLine[];
}

type SyncGlobal = typeof globalThis & {
  edrcBgsSync?: Promise<BgsSyncResult> | null;
  edrcBgsLive?: LiveRun | null;
  edrcBgsLastRun?: BgsRunSnapshot | null;
  edrcBgsLayerGeneration?: number;
  edrcBgsJournalGeneration?: number;
};
const shared = globalThis as SyncGlobal;

export function isBgsSyncRunning(): boolean {
  return Boolean(shared.edrcBgsSync);
}

/** Счётчик завершённых импортов дампа: кэш слоя сбрасывается, когда он меняется. */
export function bgsLayerGeneration(): number {
  return shared.edrcBgsLayerGeneration ?? 0;
}

/** Счётчик пачек от пилотов, поменявших слой (новые системы, смена власти). */
export function bgsJournalGeneration(): number {
  return shared.edrcBgsJournalGeneration ?? 0;
}

export function bumpBgsJournalGeneration(): void {
  shared.edrcBgsJournalGeneration = bgsJournalGeneration() + 1;
}

function snapshot(run: { progress: BgsSyncProgress; log: BgsLogLine[] }): BgsRunSnapshot {
  return JSON.parse(JSON.stringify({ progress: run.progress, log: run.log })) as BgsRunSnapshot;
}

export function getBgsLiveRun(): BgsRunSnapshot | null {
  return shared.edrcBgsLive ? snapshot(shared.edrcBgsLive) : null;
}

export function getBgsLastRun(): BgsRunSnapshot | null {
  return shared.edrcBgsLastRun ? snapshot(shared.edrcBgsLastRun) : null;
}

/** Для тестов: забыть историю прогонов. */
export function resetBgsSyncRuntime(): void {
  shared.edrcBgsLastRun = null;
  if (!shared.edrcBgsSync) shared.edrcBgsLive = null;
}

export function cancelBgsSync(reason = BGS_CANCEL_MESSAGE): boolean {
  const run = shared.edrcBgsLive;
  if (!run || run.cancelled) return false;
  run.cancelled = true;
  pushBgsLog(run.log, 'warn', `${reason} — обрываю текущий шаг`);
  run.controller.abort(new Error(reason));
  return true;
}

export interface BgsSyncOptions {
  fetchImpl?: typeof fetch;
  /** Импортировать, даже если дамп тот же, и принять «усохший» дамп. */
  force?: boolean;
  /** Что делать: всё (по умолчанию), только скачать, только разбить, загрузить с диска. */
  mode?: BgsSyncMode;
  url?: string;
  archivePath?: string;
  shardsDir?: string;
  /** Соединений к EDSM. */
  segments?: number;
  pieceBytes?: number;
  /** Файл меньше — одним соединением (тесты; по умолчанию 64 МБ). */
  minSegmentedBytes?: number;
  shardSystems?: number;
  /** Пачка записи через PostgREST. */
  batchSize?: number;
  minSystems?: number;
  keepArchive?: boolean;
  trigger?: BgsSyncTrigger;
  /** Прямой Postgres (по умолчанию `FACTIONS_DB_DIRECT` и DATABASE_URL/SUPABASE_DB_URL). */
  directDb?: boolean;
  /** Готовый клиент Postgres (тесты: PGlite). */
  pgClient?: () => Promise<BgsPgClient>;
  /** Пауза между повторами скачивания (тесты). */
  sleep?: (ms: number) => Promise<void>;
}

export interface BgsSyncResult {
  status: 'ok' | 'not_modified' | 'error' | 'cancelled';
  mode?: BgsSyncMode;
  error?: string;
  systems?: number;
  factions?: number;
  presence?: number;
  applied?: number;
  stale?: number;
  deletedSystems?: number;
  shards?: number;
  archiveBytes?: number;
  backend?: BgsDbWriter['backend'];
  stats?: BgsDumpStats;
  dumpGeneratedAt?: string | null;
  durationMs: number;
}

export function runBgsSync(svc: Svc, options: BgsSyncOptions = {}): Promise<BgsSyncResult> {
  if (shared.edrcBgsSync) return shared.edrcBgsSync;
  const job = syncOnce(svc, options).finally(() => {
    shared.edrcBgsSync = null;
  });
  shared.edrcBgsSync = job;
  return job;
}

/** Запуск фоном: ответ возвращается сразу, ход виден в админке. */
export function startBgsSync(svc: Svc, options: BgsSyncOptions = {}): { started: boolean; reason?: string } {
  if (isBgsSyncRunning()) return { started: false, reason: 'Импорт уже идёт — его ход виден ниже' };
  void runBgsSync(svc, { ...options, trigger: options.trigger ?? 'admin' }).catch(() => undefined);
  return { started: true };
}

async function persistRun(svc: Svc, run: LiveRun, force = false): Promise<void> {
  const now = Date.now();
  if (!force && now - run.persistedAt < PERSIST_EVERY_MS) return;
  run.persistedAt = now;
  try {
    const { error } = await svc
      .from('bgs_sync_state')
      .update({ progress: run.progress, log: run.log, updated_at: new Date(now).toISOString() })
      .eq('id', 1);
    if (error) throw new Error(error.message);
  } catch {
    // Копия хода в базе — для админки после перезапуска; импорт от неё не зависит.
  }
}

function withUserAgent(fetchImpl: typeof fetch): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1] = {}) => {
    const headers = new Headers(init?.headers ?? {});
    if (!headers.has('user-agent')) headers.set('User-Agent', USER_AGENT);
    return fetchImpl(input, { ...init, headers });
  }) as typeof fetch;
}

/** Архив испорчен (gzip не разбирается): его надо удалить и скачать заново. */
class BgsArchiveCorrupted extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BgsArchiveCorrupted';
  }
}

/** Кусок на диске не читается: куски надо разбить заново. */
class BgsShardCorrupted extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BgsShardCorrupted';
  }
}

function isArchiveCorruption(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'Z_DATA_ERROR' || code === 'Z_BUF_ERROR') return true;
  return /unexpected end of file|incorrect (header|data) check|invalid (block|stored|distance|code)|не похож на дамп|too far back/i.test(shortError(error));
}

function describeStats(stats: BgsDumpStats): string[] {
  const allegiances = Object.entries(stats.allegiances).sort((a, b) => b[1] - a[1]);
  const lines = [
    `Разобрано записей: ${formatBgsCount(stats.records)} · населённых систем с фракциями: ${formatBgsCount(stats.systems)}`
      + ` · фракций: ${formatBgsCount(stats.factions)} (игроков: ${formatBgsCount(stats.playerFactions)})`
      + ` · присутствий: ${formatBgsCount(stats.presence)}`,
    `Отброшено: битых записей ${formatBgsCount(stats.skipped.invalid)}, без фракций ${formatBgsCount(stats.skipped.no_factions)}`,
  ];
  if (allegiances.length) {
    lines.push(`По принадлежности: ${allegiances.map(([name, n]) => `${name} ${formatBgsCount(n)}`).join(', ')}`);
  }
  if (stats.oldestObservation && stats.newestObservation) {
    lines.push(`Наблюдения EDSM: ${stats.oldestObservation.slice(0, 10)} – ${stats.newestObservation.slice(0, 10)}`);
  }
  return lines;
}

/** Все задачи конвейера сразу; первая ошибка останавливает остальные и уходит наверх. */
async function runTogether(tasks: Array<() => Promise<void>>, controller: AbortController): Promise<void> {
  let failure: { error: unknown } | null = null;
  await Promise.all(
    tasks.map((task) =>
      task().catch((error) => {
        if (!failure) {
          failure = { error };
          controller.abort(error instanceof Error ? error : new Error(shortError(error)));
        }
      }),
    ),
  );
  if (failure) throw (failure as { error: unknown }).error;
}

/** Что есть на сервере для работы без EDSM: архив целиком или разбитые до конца куски. */
function localDump(dest: string, shardsDir: string): BgsDumpSource | null {
  const meta = readArchiveMeta(dest);
  if (archiveIsComplete(dest, meta)) return metaSource(meta);
  const manifest = readBgsShardManifest(shardsDir);
  return manifest?.complete ? manifest.source : null;
}

async function syncOnce(svc: Svc, options: BgsSyncOptions): Promise<BgsSyncResult> {
  const started = Date.now();
  const mode: BgsSyncMode = options.mode ?? 'full';
  const force = options.force === true;
  const url = options.url ?? bgsDumpUrl();
  const dest = resolve(options.archivePath ?? bgsArchivePath());
  const shardsDir = resolve(options.shardsDir ?? bgsShardsDirFor(dest));
  const fetchImpl = withUserAgent(options.fetchImpl ?? fetch);
  const minSystems = options.minSystems ?? bgsMinSystems();
  const segments = clampBgsSegments(options.segments ?? bgsDownloadSegments());
  const pieceBytes = options.pieceBytes ?? bgsPieceBytes();
  const shardSystems = options.shardSystems ?? bgsShardSystems();
  const keepArchive = options.keepArchive ?? bgsArchiveKeep();
  const trigger = options.trigger ?? 'manual';
  const touchesDb = mode === 'full' || mode === 'import';
  const online = mode === 'full' || mode === 'download';
  let previous = EMPTY_STATE;
  let written = 0;
  let writer: BgsDbWriter | null = null;

  const run: LiveRun = {
    progress: createBgsProgress({ id: randomUUID(), trigger, force, mode, now: started }),
    log: [],
    controller: new AbortController(),
    cancelled: false,
    persistedAt: 0,
  };
  const history = shared.edrcBgsLastRun?.log ?? [];
  run.log.push(...history.slice(-150));
  shared.edrcBgsLive = run;

  const log = (level: BgsLogLevel, text: string) => {
    pushBgsLog(run.log, level, text);
  };
  const begin = async (stage: BgsStageId, init: { total?: number | null; done?: number; detail?: string } = {}) => {
    startBgsStage(run.progress, stage, init);
    await persistRun(svc, run, true);
  };
  const advance = async (stage: BgsStageId, patch: { done?: number; total?: number | null; detail?: string }) => {
    updateBgsStage(run.progress, stage, patch);
    await persistRun(svc, run);
  };
  const complete = (stage: BgsStageId, detail?: string, status: 'done' | 'skipped' = 'done') => {
    finishBgsStage(run.progress, stage, { detail, status });
  };
  const checkCancelled = () => {
    if (run.cancelled) throw new Error(BGS_CANCEL_MESSAGE);
  };
  const notModified = async (message: string): Promise<BgsSyncResult> => {
    if (touchesDb) await writeState(svc, { status: 'ok', checked_at: new Date().toISOString(), error: null });
    const durationMs = Date.now() - started;
    log('info', `${message} (${formatBgsCount(previous.systems_total)} систем в базе). Готово за ${formatBgsDuration(durationMs)}`);
    finishBgsProgress(run.progress, 'not_modified', {
      message,
      result: { systems: previous.systems_total, factions: previous.factions_total, durationMs },
    });
    return { status: 'not_modified', mode, systems: previous.systems_total, durationMs };
  };

  log('info', `Запуск: ${BGS_TRIGGER_LABEL[trigger]} · ${BGS_MODE_LABEL[mode]}${force ? ' · принудительно (тот же дамп загружается заново, «усохший» принимается)' : ''}`);
  if (online) log('info', `Источник: ${url}`);

  try {
    previous = await readBgsSyncState(svc);
    if (history.length === 0 && previous.log.length > 0) run.log.unshift(...previous.log.slice(-150));
    if (touchesDb) await writeState(svc, { status: 'running', attempt_at: new Date().toISOString(), source_url: url, error: null });
    const imported = importedSource(previous);

    /* ── Какой дамп ── */
    let source: BgsDumpSource | null = null;
    let probe: DumpProbe | null = null;
    if (online) {
      await begin('probe', { detail: 'HEAD-запрос к EDSM' });
      const probeStarted = Date.now();
      try {
        probe = await probeDumpSource(url, { fetchImpl, signal: run.controller.signal });
      } catch (error) {
        checkCancelled();
        const offline = mode === 'full' ? localDump(dest, shardsDir) : null;
        if (!offline || offline.url !== url) throw new Error(`EDSM не ответил: ${shortError(error)}`);
        if (!force && sameBgsDumpSource(offline, imported)) {
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
          `Ответ EDSM за ${formatBgsDuration(Date.now() - probeStarted)}: ${probe.total ? formatBgsBytes(probe.total) : 'размер неизвестен'}`
            + `${probe.lastModified ? ` · дамп от ${probe.lastModified}` : ''}`
            + ` · докачка и параллельные соединения (Range): ${probe.acceptsRanges ? 'да' : 'нет'}`,
        );
        source = { url, etag: probe.etag, lastModified: probe.lastModified, total: probe.total };
        if (!force && sameBgsDumpSource(source, imported)) {
          complete('probe', 'дамп не менялся');
          return await notModified(mode === 'download'
            ? 'Этот дамп уже загружен в базу — скачивать нечего'
            : 'Дамп не менялся с прошлого импорта — данные актуальны');
        }
        complete('probe', `${probe.total ? formatBgsBytes(probe.total) : 'размер неизвестен'}${probe.lastModified ? ` · от ${probe.lastModified}` : ''}`);
      }
    } else {
      const local = localDump(dest, shardsDir);
      const meta = readArchiveMeta(dest);
      const partialManifest = readBgsShardManifest(shardsDir);
      if (mode === 'split' && !archiveIsComplete(dest, meta)) {
        throw new Error(existsSync(dest)
          ? 'Архив на сервере скачан не полностью — сначала докачайте его («Скачать архив»)'
          : 'На сервере нет скачанного архива — сначала «Скачать архив»');
      }
      const chosen = local ?? (partialManifest && archiveIsComplete(dest, meta) ? metaSource(meta) : null);
      if (!chosen) {
        throw new Error(existsSync(dest) || partialManifest
          ? 'Архив на сервере скачан не полностью, а куски разбиты не до конца — запустите «Загрузить данные» или «Скачать архив»'
          : 'На сервере нет ни архива, ни кусков — сначала «Скачать архив» или «Загрузить данные»');
      }
      source = chosen;
      log('info', `Дамп на сервере: ${chosen.url}${chosen.lastModified ? ` от ${chosen.lastModified}` : ''}${chosen.total ? `, ${formatBgsBytes(chosen.total)}` : ''}`);
      if (mode === 'import' && !force && sameBgsDumpSource(chosen, imported)) {
        return await notModified('Этот дамп уже загружен в базу (принудительный запуск загрузит его снова)');
      }
    }
    if (!source) throw new Error('Не удалось определить, какой дамп загружать');
    const dump: BgsDumpSource = source;

    /* ── Файлы на сервере должны быть от этого дампа ── */
    const meta = readArchiveMeta(dest);
    if (!sameBgsDumpSource(metaSource(meta), dump) && (existsSync(dest) || existsSync(segmentStatePath(dest)) || meta)) {
      // Часть другого (вчерашнего) дампа или файл без метки: дописывать к нему
      // нельзя — начать заново.
      const freed = removeArchive(dest);
      log('info', `На сервере был архив другого дампа (${formatBgsBytes(freed)}) — удалён`);
    }
    let manifest: BgsShardManifest | null = readBgsShardManifest(shardsDir);
    if (manifest && !sameBgsDumpSource(manifest.source, dump)) {
      const freed = clearBgsShards(shardsDir);
      log('info', `Куски другого дампа (${formatBgsCount(manifest.shards.length)} шт., ${formatBgsBytes(freed)}) удалены`);
      manifest = null;
    } else if (!manifest && existsSync(shardsDir)) {
      clearBgsShards(shardsDir);
    }
    if (manifest && touchesDb && force && sameBgsDumpSource(dump, imported) && manifest.shards.some((entry) => entry.imported)) {
      // Принудительный повтор уже загруженного дампа: новая метка импорта, все куски заново.
      manifest.runId = randomUUID();
      for (const entry of manifest.shards) Object.assign(entry, { imported: false, applied: 0, stale: 0 });
      writeBgsShardManifest(shardsDir, manifest);
      log('info', 'Принудительно: куски этого дампа уже были в базе — записываю их заново с новой меткой импорта');
    }

    /* ── Что делать ── */
    const ctx: { source: BgsDumpSource; probe: DumpProbe | null; manifest: BgsShardManifest | null } = {
      source: dump,
      probe,
      manifest: manifest ?? (mode === 'download' ? null : createBgsShardManifest({ source: dump, runId: randomUUID(), systemsPerShard: shardSystems })),
    };
    let archiveReady = archiveIsComplete(dest, readArchiveMeta(dest));
    const shardsReady = Boolean(ctx.manifest?.complete);
    const needDownload = online && !archiveReady && !(mode === 'full' && shardsReady);
    const needSplit = mode !== 'download' && !shardsReady;
    const needImport = touchesDb;
    if (needSplit && !archiveReady && !needDownload) {
      throw new Error('Куски разбиты не до конца, а архива на сервере нет — запустите «Загрузить данные»');
    }
    if (needDownload && !ctx.probe) {
      throw new Error('EDSM не ответил, а архив на сервере скачан не полностью — повторите позже');
    }
    if (ctx.manifest && !manifest) writeBgsShardManifest(shardsDir, ctx.manifest);

    if (online && !needDownload) {
      complete('download', archiveReady ? `уже на сервере: ${formatBgsBytes(fileSize(dest))}` : 'не нужно — куски уже готовы');
      log('info', archiveReady
        ? `Архив этого дампа уже на сервере (${formatBgsBytes(fileSize(dest))}, ${dest}) — скачивание не нужно`
        : 'Архив не нужен: этот дамп уже разбит на куски');
    }
    if (mode !== 'download' && !needSplit) {
      complete('split', `уже разбит: ${formatBgsCount(ctx.manifest!.shards.length)} кусков, ${formatBgsCount(ctx.manifest!.systems)} систем`);
      log('info', `Архив уже разбит на куски: ${formatBgsCount(ctx.manifest!.shards.length)} шт., ${formatBgsCount(ctx.manifest!.systems)} систем (${shardsDir})`);
    }

    if (needImport) {
      writer = await createBgsWriter({
        svc,
        direct: options.directDb,
        pgClient: options.pgClient,
        batchSize: options.batchSize ?? bgsBatchSize(),
        log,
      });
      log('info', writer.backend === 'pg'
        ? `Запись в базу: ${writer.label} — кусок одним вызовом, без statement_timeout`
        : `Запись в базу: ${writer.label} — пачками по ${formatBgsCount(writer.batchSize)} систем (пачка, не уложившаяся в statement_timeout, делится пополам)`);
    }

    /* ── Конвейер: скачивание, разбивка и запись одновременно ── */
    let splitBytesRead = 0;
    const tallies = { applied: 0, stale: 0, calls: 0 };

    const runPipeline = async (): Promise<void> => {
      const pipe = new AbortController();
      const onRunAbort = () => pipe.abort(new Error(BGS_CANCEL_MESSAGE));
      if (run.controller.signal.aborted) onRunAbort();
      run.controller.signal.addEventListener('abort', onRunAbort, { once: true });
      const bytesPulse = new BgsPulse();
      const shardPulse = new BgsPulse();
      const live = {
        downloading: needDownload && !archiveReady,
        contiguous: existsSync(segmentStatePath(dest)) ? contiguousBytesOnDisk(dest) : fileSize(dest),
      };
      const tasks: Array<() => Promise<void>> = [];

      if (live.downloading) {
        tasks.push(async () => {
          const total = ctx.source.total;
          const already = downloadedBytesOnDisk(dest)?.done ?? fileSize(dest);
          const free = freeBytes(dirname(dest));
          const need = Math.max(0, (total ?? 600 * 1024 * 1024) - already) + DISK_RESERVE_BYTES;
          if (free != null && free < need) {
            throw new Error(`Недостаточно места на диске для дампа: свободно ${formatBgsBytes(free)}, нужно ~${formatBgsBytes(need)} (${dirname(dest)})`);
          }
          writeArchiveMeta(dest, { url: ctx.source.url, etag: ctx.source.etag, lastModified: ctx.source.lastModified, total, completedAt: null });
          log('info', `Скачиваю архив на сервер: ${dest} — до ${segments} соединений, куски по ${formatBgsBytes(pieceBytes)}${already > 0 ? `, уже скачано ${formatBgsBytes(already)} — докачка` : ''}`);
          await begin('download', { total, done: already, detail: 'соединение' });
          const downloadStarted = Date.now();
          let firstBytes: number | null = null;
          const result = await downloadDump({
            url: ctx.source.url,
            dest,
            segments,
            pieceBytes,
            strictSource: true,
            probe: ctx.probe ?? undefined,
            minSegmentedBytes: options.minSegmentedBytes,
            signal: pipe.signal,
            retries: Infinity,
            maxStagnantFailures: 12,
            verify: false,
            fetchImpl,
            sleep: options.sleep,
            progressIntervalMs: 1000,
            log: (line) => log(/обрыв|не удалось|недоступн|не даёт|не ответил|заново/i.test(line) ? 'warn' : 'info', `Скачивание: ${line}`),
            onProgress: (info) => {
              live.contiguous = info.contiguous ?? info.received;
              bytesPulse.notify();
              if (firstBytes == null) firstBytes = info.received;
              const seconds = Math.max(1, (Date.now() - downloadStarted) / 1000);
              const speed = Math.max(0, info.received - firstBytes) / seconds;
              const left = info.total && speed > 0 ? ((info.total - info.received) / speed) * 1000 : null;
              return advance('download', {
                done: info.received,
                total: info.total,
                detail: `${formatBgsBytes(info.received)}${info.total ? ` из ${formatBgsBytes(info.total)}` : ''}`
                  + (info.connections ? ` · соединений: ${info.connections}` : '')
                  + (speed > 0 ? ` · ${formatBgsSpeed(speed)}` : '')
                  + (left != null ? ` · осталось ~${formatBgsDuration(left)}` : '')
                  + (info.failures > 0 ? ` · обрывов: ${info.failures}` : ''),
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
          live.downloading = false;
          archiveReady = true;
          bytesPulse.notify();
          const took = Date.now() - downloadStarted;
          complete('download', `${formatBgsBytes(result.bytes)} за ${formatBgsDuration(took)} · соединений: ${result.segments}`);
          log('info', `Архив скачан: ${formatBgsBytes(result.bytes)} за ${formatBgsDuration(took)} (${result.segments} соедин.)`);
        });
      }

      if (needSplit) {
        tasks.push(async () => {
          const manifest = ctx.manifest!;
          const counter = new BgsDumpCounter();
          const totalBytes = ctx.source.total ?? (fileSize(dest) || null);
          await begin('split', { total: totalBytes, done: 0, detail: live.downloading ? 'жду первые байты архива' : 'читаю архив' });
          log('info', manifest.recordsRead > 0
            ? `Разбивка: продолжаю — ${formatBgsCount(manifest.recordsRead)} записей уже в ${formatBgsCount(manifest.shards.length)} кусках, перечитываю архив до этой точки`
            : `Разбивка: ${live.downloading ? 'читаю архив по мере скачивания' : 'читаю архив'}, кусок — ${formatBgsCount(manifest.systemsPerShard)} систем → ${shardsDir}`);
          const splitStarted = Date.now();
          try {
            await splitBgsArchive({
              archive: dest,
              dir: shardsDir,
              manifest,
              counter,
              signal: pipe.signal,
              available: () => (live.downloading ? live.contiguous : null),
              waitForBytes: (signal) => bytesPulse.wait(signal, 1000),
              onShard: (entry, current) => {
                shardPulse.notify();
                if (current.shards.length === 1 || current.shards.length % 10 === 0) {
                  log('info', `Разбивка: кусок ${current.shards.length} (${entry.file}) — ${formatBgsCount(entry.systems)} систем, ${formatBgsBytes(entry.bytes)}`);
                }
              },
              onProgress: (info) => {
                splitBytesRead = info.bytesRead;
                return advance('split', {
                  done: info.bytesRead,
                  total: totalBytes,
                  detail: `кусков ${formatBgsCount(info.shards)} · систем ${formatBgsCount(info.systems)}`
                    + ` · прочитано ${formatBgsBytes(info.bytesRead)}${totalBytes ? ` из ${formatBgsBytes(totalBytes)}` : ''}`
                    + (info.waiting ? ' · ждёт скачивания' : ''),
                });
              },
            });
          } catch (error) {
            if (pipe.signal.aborted || (error as Error)?.message === BGS_SPLIT_ABORTED) throw error;
            if (isArchiveCorruption(error)) throw new BgsArchiveCorrupted(`Архив не разбирается: ${shortError(error)}`);
            throw error;
          }
          shardPulse.notify();
          complete('split', `${formatBgsCount(manifest.shards.length)} кусков · ${formatBgsCount(manifest.systems)} систем за ${formatBgsDuration(Date.now() - splitStarted)}`);
          log('info', `Разбивка завершена: ${formatBgsCount(manifest.shards.length)} кусков, ${formatBgsCount(manifest.systems)} систем за ${formatBgsDuration(Date.now() - splitStarted)}`);
          for (const line of describeStats(counter.stats)) log('info', line);
        });
      }

      if (needImport) {
        tasks.push(async () => {
          const manifest = ctx.manifest!;
          const db = writer!;
          const estimate = (): number | null => {
            if (manifest.complete) return manifest.shards.length;
            const total = ctx.source.total ?? 0;
            if (total > 0 && splitBytesRead > 0 && manifest.shards.length > 0) {
              return Math.max(manifest.shards.length, Math.round((manifest.shards.length * total) / splitBytesRead));
            }
            return null;
          };
          const importedNow = () => manifest.shards.filter((entry) => entry.imported).length;
          const resumed = importedNow();
          if (resumed > 0) log('info', `Запись в базу: продолжаю — ${formatBgsCount(resumed)} кусков этого дампа уже в базе`);
          await begin('import', { total: estimate(), done: resumed, detail: manifest.shards.length ? 'пишу' : 'жду первый кусок' });
          const importStarted = Date.now();
          let index = 0;
          let importedHere = 0;
          for (;;) {
            if (pipe.signal.aborted) throw pipe.signal.reason instanceof Error ? pipe.signal.reason : new Error(BGS_CANCEL_MESSAGE);
            if (index >= manifest.shards.length) {
              if (manifest.complete) break;
              await shardPulse.wait(pipe.signal, 1000);
              continue;
            }
            const entry = manifest.shards[index];
            if (!entry.imported) {
              let rows: Record<string, unknown>[];
              try {
                rows = await readBgsShardRows(join(shardsDir, entry.file));
              } catch (error) {
                throw new BgsShardCorrupted(`Кусок ${entry.file} не читается: ${shortError(error)}`);
              }
              const result = await db.apply(rows, manifest.runId);
              Object.assign(entry, { imported: true, applied: result.applied, stale: result.stale });
              writeBgsShardManifest(shardsDir, manifest);
              written += rows.length;
              importedHere += 1;
              tallies.calls += result.calls;
              if (importedHere === 1 || importedHere % 10 === 0) {
                const total = estimate();
                log('info', `Запись в базу: кусок ${index + 1}${total ? ` из ${manifest.complete ? '' : '~'}${formatBgsCount(total)}` : ''} — применено ${formatBgsCount(result.applied)}, свежее у пилотов ${formatBgsCount(result.stale)}`);
              }
            }
            index += 1;
            const done = importedNow();
            const systems = manifest.shards.reduce((sum, item) => sum + (item.imported ? item.systems : 0), 0);
            const stale = manifest.shards.reduce((sum, item) => sum + item.stale, 0);
            const total = estimate();
            await advance('import', {
              done,
              total,
              detail: `кусок ${formatBgsCount(done)}${total ? ` из ${manifest.complete ? '' : '~'}${formatBgsCount(total)}` : ''}`
                + ` · систем ${formatBgsCount(systems)} · свежее у пилотов ${formatBgsCount(stale)}`,
            });
          }
          tallies.applied = manifest.shards.reduce((sum, item) => sum + item.applied, 0);
          tallies.stale = manifest.shards.reduce((sum, item) => sum + item.stale, 0);
          complete('import', `${formatBgsCount(manifest.shards.length)} кусков · ${formatBgsCount(manifest.systems)} систем за ${formatBgsDuration(Date.now() - importStarted)}`);
          log('info', `Записано в базу: ${formatBgsCount(manifest.systems)} систем из ${formatBgsCount(manifest.shards.length)} кусков`
            + `${tallies.calls ? ` (${formatBgsCount(tallies.calls)} вызовов)` : ''}, не тронуто — у пилотов свежее: ${formatBgsCount(tallies.stale)}`);
        });
      }

      try {
        await runTogether(tasks, pipe);
      } finally {
        run.controller.signal.removeEventListener('abort', onRunAbort);
      }
    };

    for (let restarts = 0; ; restarts++) {
      try {
        await runPipeline();
        break;
      } catch (error) {
        if (run.cancelled || !isDumpSourceChanged(error) || !online || restarts >= MAX_SOURCE_RESTARTS) throw error;
        // EDSM выложил новый дамп посреди скачивания: старые байты бесполезны.
        log('warn', `Дамп на EDSM обновился во время скачивания (${shortError(error)}) — удаляю скачанное и начинаю заново со свежим дампом`);
        removeArchive(dest);
        clearBgsShards(shardsDir);
        const fresh = await probeDumpSource(url, { fetchImpl, signal: run.controller.signal });
        ctx.probe = fresh;
        ctx.source = { url, etag: fresh.etag, lastModified: fresh.lastModified, total: fresh.total };
        if (ctx.manifest) {
          ctx.manifest = createBgsShardManifest({ source: ctx.source, runId: randomUUID(), systemsPerShard: shardSystems });
          writeBgsShardManifest(shardsDir, ctx.manifest);
        }
        archiveReady = false;
        splitBytesRead = 0;
        for (const stage of ['download', 'split', 'import'] as const) resetBgsStage(run.progress, stage);
        log('info', `Новый дамп: ${fresh.total ? formatBgsBytes(fresh.total) : 'размер неизвестен'}${fresh.lastModified ? ` от ${fresh.lastModified}` : ''}`);
      }
    }
    checkCancelled();

    /* ── Запуски по частям заканчиваются здесь ── */
    if (mode === 'download') {
      const bytes = fileSize(dest);
      const durationMs = Date.now() - started;
      const message = `Архив скачан на сервер: ${formatBgsBytes(bytes)} — «Загрузить данные» разобьёт его и запишет в базу без повторного скачивания`;
      log('info', `${message}. Готово за ${formatBgsDuration(durationMs)}`);
      finishBgsProgress(run.progress, 'ok', { message, result: { archiveBytes: bytes, durationMs } });
      return { status: 'ok', mode, archiveBytes: bytes, durationMs };
    }
    const manifestDone = ctx.manifest!;
    if (mode === 'split') {
      const durationMs = Date.now() - started;
      const message = `Архив разбит на ${formatBgsCount(manifestDone.shards.length)} кусков (${formatBgsCount(manifestDone.systems)} систем) — «Загрузить куски в базу» запишет их без EDSM`;
      log('info', `${message}. Готово за ${formatBgsDuration(durationMs)}`);
      finishBgsProgress(run.progress, 'ok', { message, result: { shards: manifestDone.shards.length, systems: manifestDone.systems, durationMs } });
      return { status: 'ok', mode, shards: manifestDone.shards.length, systems: manifestDone.systems, durationMs };
    }

    /* ── Проверки перед удалением пропавших систем ── */
    const stats: BgsDumpStats = manifestDone.stats ?? {
      records: manifestDone.recordsRead,
      systems: manifestDone.systems,
      skipped: { invalid: 0, no_factions: 0 },
      factions: 0,
      presence: 0,
      playerFactions: 0,
      allegiances: {},
      oldestObservation: null,
      newestObservation: null,
    };
    const applied = manifestDone.shards.reduce((sum, item) => sum + item.applied, 0);
    const stale = manifestDone.shards.reduce((sum, item) => sum + item.stale, 0);
    if (stats.systems < minSystems) {
      throw new Error(`В дампе всего ${stats.systems} населённых систем (записей ${stats.records}) — похоже на сбой источника; пропавшие системы не удалялись`);
    }
    if (!force && previous.systems_total >= minSystems && stats.systems < previous.systems_total * BGS_SHRINK_GUARD) {
      throw new Error(`Дамп подозрительно мал: ${stats.systems} систем против ${previous.systems_total} в базе — пропавшие системы не удалялись (принудительный запуск примет дамп)`);
    }

    /* ── Завершение ── */
    const db = writer!;
    const runId = manifestDone.runId;
    await begin('finish', { total: 4, done: 0, detail: 'удаляю системы, пропавшие из дампа' });
    const deletedSystems = await db.deleteMissing(runId, BGS_KEEP_DAYS);
    await advance('finish', { done: 1, detail: `удалено систем: ${formatBgsCount(deletedSystems)} · пересчитываю фракции` });
    const recounted = await db.recountAll((done) => advance('finish', {
      done: 1 + Math.min(0.95, done / Math.max(1, stats.factions)),
      detail: `пересчёт фракций: ${formatBgsCount(done)}`,
    }));
    await advance('finish', { done: 2, detail: 'удаляю фракции без систем' });
    const deletedFactions = await db.prune();
    await advance('finish', { done: 3, detail: 'записываю состояние' });
    const archiveBytes = ctx.source.total ?? fileSize(dest);
    const summary = await db.finish(runId, {
      source_url: ctx.source.url,
      etag: ctx.source.etag,
      last_modified: ctx.source.lastModified,
      dump_generated_at: headerDate(ctx.source.lastModified),
      dump_bytes: archiveBytes || null,
      stats: {
        ...stats,
        applied,
        stale,
        shards: manifestDone.shards.length,
        backend: db.backend,
        deleted_systems: deletedSystems,
        deleted_factions: deletedFactions,
      },
    });
    shared.edrcBgsLayerGeneration = bgsLayerGeneration() + 1;
    const systems = count(summary.systems);
    const factions = count(summary.factions);
    const presence = count(summary.presence);
    log('info', `Удалено систем, пропавших из дампа: ${formatBgsCount(deletedSystems)}, фракций без систем: ${formatBgsCount(deletedFactions)} · пересчитано фракций: ${formatBgsCount(recounted)}`);
    if (!keepArchive) {
      const freed = removeArchive(dest) + clearBgsShards(shardsDir);
      log('info', `Архив и куски удалены с сервера — освобождено ${formatBgsBytes(freed)} (FACTIONS_ARCHIVE_KEEP=1 оставляет их)`);
    } else {
      log('info', `Архив и куски оставлены на сервере (FACTIONS_ARCHIVE_KEEP=1): ${dest}`);
    }
    complete('finish', `в базе ${formatBgsCount(systems)} систем · ${formatBgsCount(factions)} фракций`);
    const durationMs = Date.now() - started;
    log('info', `Готово за ${formatBgsDuration(durationMs)}: на карте ${formatBgsCount(systems)} систем, ${formatBgsCount(factions)} фракций, ${formatBgsCount(presence)} присутствий`);
    finishBgsProgress(run.progress, 'ok', {
      message: `Загружено ${formatBgsCount(systems)} систем и ${formatBgsCount(factions)} фракций`,
      result: { systems, factions, presence, applied, stale, deletedSystems, shards: manifestDone.shards.length, durationMs },
    });
    return {
      status: 'ok',
      mode,
      systems,
      factions,
      presence,
      applied,
      stale,
      deletedSystems,
      shards: manifestDone.shards.length,
      backend: db.backend,
      stats,
      dumpGeneratedAt: headerDate(ctx.source.lastModified),
      durationMs,
    };
  } catch (error) {
    const cancelled = run.cancelled;
    const message = cancelled ? BGS_CANCEL_MESSAGE : shortError(error);
    const durationMs = Date.now() - started;
    if (cancelled) {
      log('warn', mode === 'download'
        ? `${BGS_CANCEL_MESSAGE}: скачанная часть осталась на сервере — следующий запуск докачает архив`
        : written > 0
          ? `${BGS_CANCEL_MESSAGE}: скачанное, разбитое и записанное осталось — следующий запуск продолжит с того же места; пропавшие из дампа системы не удалялись`
          : `${BGS_CANCEL_MESSAGE}: скачанное и разбитое осталось на сервере — следующий запуск продолжит с того же места`);
    } else {
      log('error', `Ошибка: ${message}`);
      if (error instanceof BgsArchiveCorrupted) {
        removeArchive(dest);
        clearBgsShards(shardsDir);
        log('warn', 'Архив повреждён — удалён с сервера вместе с кусками, следующий запуск скачает дамп заново');
      } else if (error instanceof BgsShardCorrupted) {
        clearBgsShards(shardsDir);
        log('warn', 'Кусок повреждён — куски удалены, следующий запуск разобьёт архив заново');
      }
    }
    if (written > 0) {
      // Новые фракции из записанных кусков должны находиться поиском и без finish.
      try {
        await (writer ?? createPostgrestBgsWriter(svc)).recountAll();
      } catch {
        // счётчики пересчитает следующий импорт
      }
      shared.edrcBgsLayerGeneration = bgsLayerGeneration() + 1;
    }
    finishBgsProgress(run.progress, cancelled ? 'cancelled' : 'error', {
      message: cancelled ? BGS_CANCEL_MESSAGE : message,
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
    shared.edrcBgsLastRun = snapshot(run);
    if (shared.edrcBgsLive === run) shared.edrcBgsLive = null;
  }
}

/** Удалить скачанный архив (и план докачки) и куски. Во время импорта — нельзя. */
export function cleanupBgsArchive(
  path = bgsArchivePath(),
  shardsDir = bgsShardsDirFor(path),
): { removed: boolean; freed: number; shards: number; reason?: string } {
  if (isBgsSyncRunning()) return { removed: false, freed: 0, shards: 0, reason: 'Идёт импорт — архив и куски нужны ему' };
  const manifest = readBgsShardManifest(shardsDir);
  const exists = existsSync(path) || existsSync(segmentStatePath(path)) || existsSync(`${path}${META_SUFFIX}`) || Boolean(manifest);
  const freed = removeArchive(path) + clearBgsShards(shardsDir);
  return { removed: exists, freed, shards: manifest?.shards.length ?? 0 };
}

/* ── Сводка для админки ────────────────────────────────────────────────── */

export interface BgsTableSummary {
  systems: number;
  factions: number;
  playerFactions: number;
  presence: number;
  allegiances: Record<string, number>;
  sources: Record<string, number>;
  oldestObservation: string | null;
  newestObservation: string | null;
  fresh7d: number;
  updates24h: number;
  applied24h: number;
  updates7d: number;
  applied7d: number;
  reporters7d: number;
  lastUpdate: string | null;
}

function isoOrNull(value: unknown): string | null {
  if (value == null) return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function countMap(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!value || typeof value !== 'object') return out;
  for (const [key, n] of Object.entries(value as Record<string, unknown>)) out[key] = count(n);
  return out;
}

export async function readBgsSummary(svc: Svc): Promise<BgsTableSummary> {
  const { data, error } = await svc.rpc('bgs_admin_summary');
  if (error) throw new Error(error.message);
  const raw = (typeof data === 'string' ? JSON.parse(data) : data ?? {}) as Record<string, unknown>;
  return {
    systems: count(raw.systems),
    factions: count(raw.factions),
    playerFactions: count(raw.player_factions),
    presence: count(raw.presence),
    allegiances: countMap(raw.allegiances),
    sources: countMap(raw.sources),
    oldestObservation: isoOrNull(raw.oldest_observation),
    newestObservation: isoOrNull(raw.newest_observation),
    fresh7d: count(raw.fresh_7d),
    updates24h: count(raw.updates_24h),
    applied24h: count(raw.applied_24h),
    updates7d: count(raw.updates_7d),
    applied7d: count(raw.applied_7d),
    reporters7d: count(raw.reporters_7d),
    lastUpdate: isoOrNull(raw.last_update),
  };
}

/** Ближайший запуск задачи `factions-sync` по расписанию планировщика (UTC). */
export function nextBgsScheduledRun(nowMs = Date.now()): string {
  const { periodMs, offsetMs } = BGS_SCHEDULE;
  const next = Math.floor((nowMs - offsetMs) / periodMs + 1) * periodMs + offsetMs;
  return new Date(next).toISOString();
}

function age(value: string | null, nowMs: number): number {
  const ms = value ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? nowMs - ms : Infinity;
}

/** Импорт оборвался вместе с процессом сайта (состояние «running», а живого прогона нет). */
export function bgsSyncInterrupted(state: BgsSyncState, nowMs = Date.now()): boolean {
  return !isBgsSyncRunning() && state.status === 'running' && age(state.attempt_at, nowMs) < 7 * 24 * 3600_000;
}

export type BgsScheduleDecision =
  | { action: 'start'; reason: 'stale' | 'interrupted' | 'forced' }
  | { action: 'skip'; reason: 'running' | 'not_initialized' | 'fresh' | 'running_elsewhere' };

/**
 * Что делать задаче `factions-sync`. Первый импорт (≈0,5 ГБ) — решение
 * администратора: задача только поддерживает данные свежими после него и
 * докачивает импорт, оборванный перезапуском сайта.
 */
export function decideBgsScheduledSync(
  state: BgsSyncState,
  options: { nowMs?: number; refreshDays?: number; force?: boolean } = {},
): BgsScheduleDecision {
  const nowMs = options.nowMs ?? Date.now();
  if (isBgsSyncRunning()) return { action: 'skip', reason: 'running' };
  if (options.force) return { action: 'start', reason: 'forced' };
  if (state.status === 'running') {
    // Свежее «running» без живого прогона в этом процессе — возможно, идёт в другом.
    return age(state.attempt_at, nowMs) < RUNNING_STALE_MS && age(state.progress?.updatedAt ?? null, nowMs) < 10 * 60_000
      ? { action: 'skip', reason: 'running_elsewhere' }
      : { action: 'start', reason: 'interrupted' };
  }
  if (!state.synced_at) return { action: 'skip', reason: 'not_initialized' };
  const refreshMs = (options.refreshDays ?? bgsRefreshDays()) * 24 * 3600_000;
  return age(state.synced_at, nowMs) >= refreshMs ? { action: 'start', reason: 'stale' } : { action: 'skip', reason: 'fresh' };
}
