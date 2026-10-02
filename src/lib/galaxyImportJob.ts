/**
 * Server-side job wrapper around `runGalaxyImport`: one import at a time,
 * resumable across restarts, with progress persisted in `galaxy_systems_meta`
 * (key `import`) so the admin tab and `/api/galaxy/stats` can show it.
 *
 * The HTTP routes return immediately — a 6 GiB download must not live inside a
 * request (nginx gives up after ~5 minutes). The work continues in the web
 * process; if the container restarts, the stored `resume_offset` picks the
 * download up with an HTTP `Range` request instead of starting over.
 */

import { existsSync, rmSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';

import { catalogIsComplete, invalidateGalaxyStatsCache, type GalaxyStats, getGalaxyStats } from './galaxySystemsDb.ts';
import {
  POINTS_UPLOAD_LIMIT,
  createPgWriter,
  createSupabaseWriter,
  describeImportBackends,
  downloadDump,
  formatBytes,
  galaxyArchivePath,
  galaxyArchivePathForVariant,
  galaxyDownloadSegments,
  galaxyImportFile,
  galaxyImportUrl,
  postgrestWriteWarning,
  runGalaxyImport,
  type GalaxyImportBackend,
  type GalaxyImportRunResult,
  type GalaxyImportSnapshot,
  type GalaxyRowWriter,
} from './galaxyImport.ts';
import { createPgCopyWriter, loadCopyFrom } from './galaxyCopyWriter.ts';
import {
  DUMP_VARIANTS,
  dumpVariantUrl,
  formatGap,
  isDumpVariant,
  planDumpDownload,
  variantCoversGap,
  variantFromUrl,
  type DumpPlan,
  type GalaxyDumpVariant,
} from './galaxyDumpVariants.ts';
import {
  galaxyImportMode,
  getShardStatus,
  manifestMatchesArchive,
  readShardManifest,
  runShardImport,
  shardsDir,
  unpackArchiveToShards,
  type GalaxyShardManifest,
  type ShardImportSnapshot,
  type UnpackProgress,
} from './galaxyShards.ts';
import {
  checkDiskSpace,
  cleanupBeforeDownload,
  cleanupGalaxyStorage,
  getGalaxyStorageStatus,
  releaseArchiveAfterImport,
  type GalaxyStorageStatus,
} from './galaxyArchiveStore.ts';
import { FRESH_MS } from './galaxyImportSchedule.ts';
import { POINTS_STORAGE_BUCKET, POINTS_STORAGE_OBJECT } from './galaxySystems.ts';
import { connectPgClient, galaxyDbUrl, isPgConnectionError, pgConnectionTarget } from './pgModule.ts';
// «timeout expired» от драйвера не отличает «имя не резолвится» от «не тот
// адрес» и от «закрытый порт». Разбираем это отдельно — см. pgReachability.ts.
import { probePgReachability, type PgReachability } from './pgReachability.ts';
import { createAdminClient } from './supabaseAdmin.ts';

/**
 * One service-role client for the whole job. `supabaseAdmin` is a proxy that
 * builds a fresh client on every property access, which an import hits
 * thousands of times (one per batch).
 */
let adminClient: SupabaseClient | null = null;
function admin(): SupabaseClient {
  if (!adminClient) adminClient = createAdminClient() as SupabaseClient;
  return adminClient;
}

export const IMPORT_STATE_KEY = 'import';

export type GalaxyImportPhase = 'idle' | 'running' | 'done' | 'failed' | 'cancelled';

export interface GalaxyImportState {
  phase: GalaxyImportPhase;
  backend: GalaxyImportBackend | null;
  source: string | null;
  started_at: string | null;
  updated_at: string | null;
  finished_at: string | null;
  /** Compressed bytes downloaded by the current pass. */
  bytes_done: number;
  bytes_total: number | null;
  /**
   * Restart point in UNCOMPRESSED dump bytes. A resumed pass re-downloads the
   * gzip (a partial deflate stream cannot be decoded) but skips every record
   * before this offset, so the hundreds of millions of upserts are not repeated.
   */
  resume_offset: number;
  processed: number;
  written: number;
  invalid: number;
  /** Records skipped by a resumed pass as already stored. */
  skipped: number;
  systems_count: number;
  points_count: number | null;
  points_bytes: number | null;
  /** Source rows per point in the uploaded cloud (null/1 = complete cloud). */
  points_stride: number | null;
  points_uploaded: boolean;
  points_error: string | null;
  error: string | null;
  /** Consecutive failed attempts of the same import (scheduler backoff). */
  attempts: number;
  /**
   * Which Spansh file this pass imports: `full` (5.9 GiB) or one of the
   * rolling deltas (`1day` … `6months`, 4–650 MiB). After the first full
   * import every refresh is a delta — see `src/lib/galaxyDumpVariants.ts`.
   */
  variant: string | null;
  /** `stream` = straight from the gzip, `shards` = from the unpacked shards. */
  mode: 'stream' | 'shards' | null;
  /** Shards already written to the database (restart point of `shards` mode). */
  shard_index: number;
  shards_total: number | null;
  /**
   * `Last-Modified` of the imported dump — the moment the catalog is current
   * as of. The next run picks its delta from this, not from the import time.
   */
  dump_generated_at: string | null;
}

export const EMPTY_IMPORT_STATE: GalaxyImportState = {
  phase: 'idle',
  backend: null,
  source: null,
  started_at: null,
  updated_at: null,
  finished_at: null,
  bytes_done: 0,
  bytes_total: null,
  resume_offset: 0,
  processed: 0,
  written: 0,
  invalid: 0,
  skipped: 0,
  systems_count: 0,
  points_count: null,
  points_bytes: null,
  points_stride: null,
  points_uploaded: false,
  points_error: null,
  error: null,
  attempts: 0,
  variant: null,
  mode: null,
  shard_index: 0,
  shards_total: null,
  dump_generated_at: null,
};

export const ARCHIVE_STATE_KEY = 'archive';

export type GalaxyArchivePhase = 'idle' | 'downloading' | 'done' | 'failed' | 'cancelled';

export interface GalaxyArchiveState {
  phase: GalaxyArchivePhase;
  source: string | null;
  path: string | null;
  bytes_done: number;
  bytes_total: number | null;
  downloaded_at: string | null;
  error: string | null;
  updated_at: string | null;
  /** Which dump this archive is (`full`, `1day`, …). */
  variant: string | null;
  /** Parallel HTTP Range connections the last attempt used. */
  segments: number | null;
  /** `Last-Modified` of the source file = when Spansh generated the dump. */
  last_modified: string | null;
}

export const EMPTY_ARCHIVE_STATE: GalaxyArchiveState = {
  phase: 'idle',
  source: null,
  path: null,
  bytes_done: 0,
  bytes_total: null,
  downloaded_at: null,
  error: null,
  updated_at: null,
  variant: null,
  segments: null,
  last_modified: null,
};

const ARCHIVE_PHASES: GalaxyArchivePhase[] = ['idle', 'downloading', 'done', 'failed', 'cancelled'];

/** Persisted JSON is untrusted input: anything missing falls back to a default. */
export function parseArchiveState(value: unknown): GalaxyArchiveState {
  const raw = (value && typeof value === 'object' ? value : {}) as Partial<Record<keyof GalaxyArchiveState, unknown>>;
  return {
    phase: ARCHIVE_PHASES.includes(raw.phase as GalaxyArchivePhase) ? (raw.phase as GalaxyArchivePhase) : 'idle',
    source: str(raw.source),
    path: str(raw.path),
    bytes_done: num(raw.bytes_done),
    bytes_total: nullableNum(raw.bytes_total),
    downloaded_at: str(raw.downloaded_at),
    error: str(raw.error),
    updated_at: str(raw.updated_at),
    variant: str(raw.variant),
    segments: nullableNum(raw.segments),
    last_modified: str(raw.last_modified),
  };
}

/** 0..100 by bytes on disk; null while the total size is unknown. */
export function archivePercent(state: GalaxyArchiveState): number | null {
  if (!state.bytes_total || state.bytes_total <= 0) return null;
  return Math.max(0, Math.min(100, (state.bytes_done / state.bytes_total) * 100));
}

interface LiveRun {
  controller: AbortController;
  /** Current writer, so Stop can cancel a query blocked inside PostgreSQL. */
  writer: GalaxyRowWriter | null;
  snapshot: GalaxyImportSnapshot | null;
  backend: GalaxyImportBackend;
  startedAt: number;
  log: string[];
}

interface LiveDownload {
  controller: AbortController;
  received: number;
  total: number | null;
  startedAt: number;
  log: string[];
}

interface LiveUnpack {
  controller: AbortController;
  progress: UnpackProgress | null;
  startedAt: number;
  log: string[];
}

const runtime = globalThis as typeof globalThis & {
  edrcGalaxyImportRun?: LiveRun | null;
  edrcGalaxyDownloadRun?: LiveDownload | null;
  edrcGalaxyUnpackRun?: LiveUnpack | null;
};

function liveRun(): LiveRun | null {
  return runtime.edrcGalaxyImportRun ?? null;
}

function liveDownload(): LiveDownload | null {
  return runtime.edrcGalaxyDownloadRun ?? null;
}

function liveUnpack(): LiveUnpack | null {
  return runtime.edrcGalaxyUnpackRun ?? null;
}

const PHASES: GalaxyImportPhase[] = ['idle', 'running', 'done', 'failed', 'cancelled'];

function num(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function nullableNum(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Persisted JSON is untrusted input: anything missing falls back to a default. */
export function parseImportState(value: unknown): GalaxyImportState {
  const raw = (value && typeof value === 'object' ? value : {}) as Partial<Record<keyof GalaxyImportState, unknown>>;
  const phase = PHASES.includes(raw.phase as GalaxyImportPhase) ? (raw.phase as GalaxyImportPhase) : 'idle';
  const backend = raw.backend === 'pg' || raw.backend === 'supabase' ? raw.backend : null;
  return {
    phase,
    backend,
    source: str(raw.source),
    started_at: str(raw.started_at),
    updated_at: str(raw.updated_at),
    finished_at: str(raw.finished_at),
    bytes_done: num(raw.bytes_done),
    bytes_total: nullableNum(raw.bytes_total),
    resume_offset: num(raw.resume_offset),
    processed: num(raw.processed),
    written: num(raw.written),
    invalid: num(raw.invalid),
    skipped: num(raw.skipped),
    systems_count: num(raw.systems_count),
    points_count: nullableNum(raw.points_count),
    points_bytes: nullableNum(raw.points_bytes),
    points_stride: nullableNum(raw.points_stride),
    points_uploaded: raw.points_uploaded === true,
    points_error: str(raw.points_error),
    error: str(raw.error),
    attempts: num(raw.attempts),
    variant: str(raw.variant),
    mode: raw.mode === 'shards' || raw.mode === 'stream' ? raw.mode : null,
    shard_index: num(raw.shard_index),
    shards_total: nullableNum(raw.shards_total),
    dump_generated_at: str(raw.dump_generated_at),
  };
}

/** 0..100 by downloaded bytes; null while the total size is unknown. */
export function importPercent(state: GalaxyImportState): number | null {
  if (!state.bytes_total || state.bytes_total <= 0) return null;
  return Math.max(0, Math.min(100, (state.bytes_done / state.bytes_total) * 100));
}

async function metaValue(key: string): Promise<Record<string, unknown> | null> {
  const { data, error } = await admin()
    .from('galaxy_systems_meta')
    .select('value')
    .eq('key', key)
    .maybeSingle();
  if (error) throw new Error(`galaxy_systems_meta read failed: ${error.message}`);
  const value = (data as { value?: unknown } | null)?.value;
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

export async function readImportState(): Promise<GalaxyImportState> {
  try {
    return parseImportState(await metaValue(IMPORT_STATE_KEY));
  } catch (error) {
    console.error('[galaxy-import] state read failed:', (error as Error)?.message);
    return { ...EMPTY_IMPORT_STATE };
  }
}

async function writeImportState(patch: Partial<GalaxyImportState>): Promise<GalaxyImportState> {
  const previous = await readImportState();
  const next: GalaxyImportState = { ...previous, ...patch, updated_at: new Date().toISOString() };
  const { error } = await admin()
    .from('galaxy_systems_meta')
    .upsert({ key: IMPORT_STATE_KEY, value: next as unknown as Record<string, unknown> }, { onConflict: 'key' });
  if (error) throw new Error(`galaxy_systems_meta write failed: ${error.message}`);
  return next;
}

async function readArchiveState(): Promise<GalaxyArchiveState> {
  try {
    return parseArchiveState(await metaValue(ARCHIVE_STATE_KEY));
  } catch (error) {
    console.error('[galaxy-archive] state read failed:', (error as Error)?.message);
    return { ...EMPTY_ARCHIVE_STATE };
  }
}

async function writeArchiveState(patch: Partial<GalaxyArchiveState>): Promise<GalaxyArchiveState> {
  const previous = await readArchiveState();
  const next: GalaxyArchiveState = { ...previous, ...patch, updated_at: new Date().toISOString() };
  const { error } = await admin()
    .from('galaxy_systems_meta')
    .upsert({ key: ARCHIVE_STATE_KEY, value: next as unknown as Record<string, unknown> }, { onConflict: 'key' });
  if (error) throw new Error(`galaxy_systems_meta archive write failed: ${error.message}`);
  return next;
}

/** Persisted archive state plus the live counters of a download in this process. */
export async function getGalaxyArchiveStatus(): Promise<{
  state: GalaxyArchiveState;
  live: boolean;
  /** Persisted `downloading` with no live task: the process restarted mid-download. */
  interrupted: boolean;
  percent: number | null;
  log: string[];
}> {
  const persisted = await readArchiveState();
  const run = liveDownload();
  const state = run
    ? { ...persisted, phase: 'downloading' as GalaxyArchivePhase, bytes_done: run.received, bytes_total: run.total }
    : persisted;
  return {
    state,
    live: Boolean(run),
    interrupted: !run && persisted.phase === 'downloading',
    percent: archivePercent(state),
    log: run ? [...run.log] : [],
  };
}

/** Bytes of a file that may not exist (a resumed download already has some). */
function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * The dump archive on disk. An archive is "fresh" while its mtime is younger
 * than `freshMs` — the same window the scheduler uses for "today's catalog".
 * mtime (not the stored `downloaded_at`) is the source of truth so a dump that
 * was copied to the server by hand (docker cp / rsync) is honoured too.
 */
export function archiveIsFresh(path: string, now = Date.now(), freshMs = FRESH_MS): boolean {
  try {
    const stat = statSync(path);
    if (stat.size <= 0) return false;
    return now - stat.mtimeMs < freshMs;
  } catch {
    return false;
  }
}

/**
 * Start the archive download in the background. Resolves as soon as the run is
 * registered (or refused), never when the file is complete. The download is
 * resumable: a dropped connection keeps the bytes on disk and continues.
 */
export async function startGalaxyDownload(options: { url?: string; variant?: GalaxyDumpVariant | 'auto' } = {}): Promise<{
  started: boolean;
  reason?: string;
  state: GalaxyArchiveState;
  plan?: DumpPlan;
}> {
  if (liveDownload()) {
    return { started: false, reason: 'Скачивание уже идёт', state: await readArchiveState() };
  }
  if (liveRun()) {
    return { started: false, reason: 'Импорт уже запущен — скачивание может испортить файл, из которого он читает', state: await readArchiveState() };
  }

  // Which file to fetch: an explicit variant/URL, or the cheapest dump that
  // still covers the gap since the catalog was last refreshed.
  const plan = await planGalaxyImport();
  const variant: GalaxyDumpVariant = isDumpVariant(options.variant)
    ? options.variant
    : variantFromUrl(options.url) ?? plan.variant;
  const url = options.url?.trim() || dumpVariantUrl(variant);
  const dest = galaxyArchivePathForVariant(variant);
  const segments = galaxyDownloadSegments();

  // The dumps live on their own disk and the previous one is dead weight the
  // moment a newer one starts arriving: free it before asking for 6 GiB more.
  const pending: string[] = [];
  const note = (line: string) => pending.push(line);
  cleanupBeforeDownload({ variant, log: note });
  const space = checkDiskSpace({ variant, have: fileSize(dest) });
  if (!space.ok) {
    console.error(`[galaxy-archive] ${space.message}`);
    return { started: false, reason: space.message ?? 'Недостаточно места на диске', state: await readArchiveState(), plan };
  }

  const controller = new AbortController();
  const run: LiveDownload = { controller, received: 0, total: null, startedAt: Date.now(), log: [] };
  runtime.edrcGalaxyDownloadRun = run;

  const log = (line: string) => {
    run.log.push(line);
    if (run.log.length > 60) run.log.splice(0, run.log.length - 60);
    console.error(`[galaxy-archive] ${line}`);
  };

  const started = await writeArchiveState({
    phase: 'downloading',
    source: url,
    path: dest,
    variant,
    segments,
    error: null,
  });

  for (const line of pending) log(line);
  if (!isDumpVariant(options.variant) && !options.url) log(`Выбор дампа: ${plan.reason}`);
  log(`Скачиваю ${DUMP_VARIANTS[variant].file} (${DUMP_VARIANTS[variant].label}) в ${segments} поток(ов)`);

  void (async () => {
    try {
      const result = await downloadDump({
        url,
        dest,
        segments,
        signal: controller.signal,
        retries: Infinity,
        log,
        onProgress: (info) => {
          run.received = info.received;
          run.total = info.total;
          // Persisting every ~5 s is enough to resume after a restart.
          return writeArchiveState({
            phase: 'downloading',
            source: url,
            path: dest,
            bytes_done: info.received,
            bytes_total: info.total,
          }).then(() => undefined);
        },
      });
      const done = await writeArchiveState({
        phase: 'done',
        source: url,
        path: dest,
        variant,
        segments: result.segments,
        last_modified: result.lastModified,
        bytes_done: result.bytes,
        bytes_total: result.total,
        downloaded_at: new Date().toISOString(),
        error: null,
      });
      log(`Архив скачан: ${formatBytes(result.bytes)}`);
      return done;
    } catch (error) {
      const cancelled = controller.signal.aborted;
      const message = (error as Error)?.message || String(error);
      log(cancelled ? `Остановлено: ${message}` : `ОШИБКА: ${message}`);
      try {
        return await writeArchiveState({
          phase: cancelled ? 'cancelled' : 'failed',
          bytes_done: run.received,
          bytes_total: run.total,
          error: cancelled ? null : message,
        });
      } catch (stateError) {
        console.error('[galaxy-archive] could not persist failure state:', (stateError as Error)?.message);
        return null;
      }
    } finally {
      runtime.edrcGalaxyDownloadRun = null;
    }
  })();

  return { started: true, state: started, plan };
}

/** Stop a running archive download. Bytes already on disk stay (resume point). */
export async function cancelGalaxyDownload(): Promise<{ cancelled: boolean; state: GalaxyArchiveState }> {
  const run = liveDownload();
  if (!run) return { cancelled: false, state: await readArchiveState() };
  run.controller.abort();
  for (let i = 0; i < 40; i++) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    if (!liveDownload()) break;
  }
  return { cancelled: true, state: await readArchiveState() };
}

/**
 * Make sure the dump archive is on disk: use it if it exists (a scheduled run
 * additionally requires it to be fresh), otherwise download it first. A
 * standalone download job writing the same file wins: wait for it instead of
 * writing two streams into one file.
 */
async function ensureArchiveDownload(args: {
  url: string;
  variant: GalaxyDumpVariant;
  scheduled: boolean;
  fresh: boolean;
  signal: AbortSignal;
  log: (line: string) => void;
}): Promise<{ path: string; lastModified: string | null }> {
  const dest = galaxyArchivePathForVariant(args.variant);
  const segments = galaxyDownloadSegments();
  // A delta is only valid while it is today's file: an old `systems_1day`
  // describes a window the catalog has long since passed.
  const requireFresh = args.scheduled || args.variant !== 'full';

  if (args.fresh) {
    rmSync(dest, { force: true });
  }

  let waited = 0;
  while (liveDownload() && waited < 12 * 3600_000) {
    if (args.signal.aborted) throw new Error('Import aborted');
    await new Promise((resolveWait) => setTimeout(resolveWait, 5000));
    waited += 5000;
  }

  // A file is "the archive" only when the download that produced it finished
  // (phase done, same path). A partial file from an interrupted download is
  // resumed by the downloader below via Range — it must not be imported as if
  // it were complete.
  const archState = await readArchiveState().catch(() => ({ ...EMPTY_ARCHIVE_STATE }));
  const complete = archState.phase === 'done' && archState.path === dest;

  if (!args.fresh && complete && existsSync(dest) && (!requireFresh || archiveIsFresh(dest))) {
    const stat = statSync(dest);
    args.log(`Архив уже на диске: ${dest} (${formatBytes(stat.size)}) — импорт идёт с диска, без сети`);
    return { path: dest, lastModified: archState.last_modified };
  }

  if (complete && existsSync(dest) && requireFresh && !archiveIsFresh(dest)) {
    // The nightly update must fetch today's dump, not re-import yesterday's.
    args.log('Архив на диске старше суток — скачиваю свежий дамп');
    rmSync(dest, { force: true });
  }

  // Nothing on this disk is needed once a newer dump starts downloading.
  cleanupBeforeDownload({ variant: args.variant, log: args.log });
  const space = checkDiskSpace({ variant: args.variant, have: fileSize(dest) });
  if (!space.ok) throw new Error(space.message ?? 'Недостаточно места на диске');

  args.log(`Скачиваю дамп на диск: ${args.url} → ${dest} (${segments} поток(ов))`);
  await writeArchiveState({
    phase: 'downloading',
    source: args.url,
    path: dest,
    variant: args.variant,
    segments,
    error: null,
  }).catch((error) => {
    args.log(`Не удалось сохранить состояние: ${(error as Error).message}`);
  });

  let lastPersist = 0;
  const result = await downloadDump({
    url: args.url,
    dest,
    segments,
    signal: args.signal,
    retries: Infinity,
    log: args.log,
    onProgress: (info) => {
      const at = Date.now();
      if (at - lastPersist < 5000) return Promise.resolve();
      lastPersist = at;
      return writeArchiveState({ phase: 'downloading', bytes_done: info.received, bytes_total: info.total }).then(() => undefined);
    },
  });
  await writeArchiveState({
    phase: 'done',
    source: args.url,
    path: dest,
    variant: args.variant,
    segments: result.segments,
    last_modified: result.lastModified,
    bytes_done: result.bytes,
    bytes_total: result.total,
    downloaded_at: new Date().toISOString(),
    error: null,
  }).catch((error) => {
    args.log(`Не удалось сохранить состояние: ${(error as Error).message}`);
  });
  args.log(`Архив на диске: ${formatBytes(result.bytes)} — импорт идёт с диска`);
  return { path: dest, lastModified: result.lastModified };
}

// ───────────────── what to download next (the plan) ─────────────────

export interface GalaxyImportPlan extends DumpPlan {
  url: string;
  /** Where the archive for this variant lives on disk. */
  archive: string;
  /** Bytes of that file already on disk (0 = nothing yet). */
  archive_bytes: number;
  /** Parallel connections the download would use. */
  segments: number;
  /** Published size of the chosen file, for the time estimate. */
  approx_bytes: number;
  /** A delta must not rebuild the 36 MB point cloud from 2×10⁸ rows. */
  skip_points: boolean;
}

/**
 * Decide what the next refresh should download — the heart of the "do not
 * re-download 5.9 GiB" strategy.
 *
 * The catalog records when the dump it was built from was generated
 * (`stats.dump_generated_at`). Everything newer than that is in the deltas, so
 * a catalog that is a day behind needs 4 MiB, one that is a month behind needs
 * 88 MiB, and only an empty (or half-year-old) catalog needs the full dump.
 */
export async function planGalaxyImport(now = Date.now()): Promise<GalaxyImportPlan> {
  const stats = await getGalaxyStats().catch(() => null);
  const extra = (stats as (GalaxyStats & { dump_generated_at?: string | null }) | null) ?? null;
  const plan = planDumpDownload({
    catalogComplete: catalogIsComplete(stats),
    dataAsOf: extra?.dump_generated_at ?? null,
    importedAt: stats?.imported_at ?? null,
    now,
  });
  const url = dumpVariantUrl(plan.variant);
  const archive = galaxyArchivePathForVariant(plan.variant);
  let archiveBytes = 0;
  try {
    archiveBytes = statSync(archive).size;
  } catch {
    archiveBytes = 0;
  }
  return {
    ...plan,
    url,
    archive,
    archive_bytes: archiveBytes,
    segments: galaxyDownloadSegments(),
    approx_bytes: plan.info.approxBytes,
    skip_points: plan.variant !== 'full',
  };
}

// ───────────────── unpack: archive → shards ─────────────────

/**
 * Unpack the archive into shards in the background (admin action «Распаковать
 * архив»). Shards make a resumed import O(1) instead of "re-parse 2×10⁸ JSON
 * objects", and `follow` lets the unpack run while the archive is still
 * downloading — on a thin line the two phases overlap instead of adding up.
 */
export async function startGalaxyUnpack(options: { fresh?: boolean; follow?: boolean } = {}): Promise<{
  started: boolean;
  reason?: string;
  archive?: string;
}> {
  if (liveUnpack()) return { started: false, reason: 'Распаковка уже идёт' };
  if (liveRun()) return { started: false, reason: 'Идёт импорт — дождитесь его окончания' };

  const pinned = galaxyImportFile();
  const archive = pinned ?? galaxyArchivePathForVariant('full');
  if (!existsSync(archive)) {
    return { started: false, reason: `Архива нет на диске (${archive}) — сначала скачайте дамп` };
  }
  const downloading = Boolean(liveDownload());
  if (downloading && options.follow === false) {
    return { started: false, reason: 'Архив ещё скачивается' };
  }

  const controller = new AbortController();
  const run: LiveUnpack = { controller, progress: null, startedAt: Date.now(), log: [] };
  runtime.edrcGalaxyUnpackRun = run;
  const log = (line: string) => {
    run.log.push(line);
    if (run.log.length > 60) run.log.splice(0, run.log.length - 60);
    console.error(`[galaxy-unpack] ${line}`);
  };

  void (async () => {
    try {
      log(`Распаковываю ${archive} → ${shardsDir()}`);
      await unpackArchiveToShards({
        archive,
        dir: shardsDir(),
        source: (await readArchiveState().catch(() => null))?.source ?? archive,
        fresh: options.fresh === true,
        signal: controller.signal,
        log,
        onProgress: (progress) => {
          run.progress = progress;
        },
        // Keep reading while the downloader is still appending bytes.
        follow: options.follow === false ? undefined : () => Boolean(liveDownload()),
      });
    } catch (error) {
      log(`ОШИБКА: ${(error as Error)?.message || String(error)}`);
    } finally {
      runtime.edrcGalaxyUnpackRun = null;
    }
  })();

  return { started: true, archive };
}

export async function cancelGalaxyUnpack(): Promise<{ cancelled: boolean }> {
  const run = liveUnpack();
  if (!run) return { cancelled: false };
  run.controller.abort();
  for (let i = 0; i < 40; i++) {
    await new Promise((done) => setTimeout(done, 250));
    if (!liveUnpack()) break;
  }
  return { cancelled: true };
}

export interface GalaxyUnpackStatus {
  dir: string;
  live: boolean;
  progress: UnpackProgress | null;
  manifest: GalaxyShardManifest | null;
  files: number;
  bytes: number;
  log: string[];
}

export function getGalaxyUnpackStatus(): GalaxyUnpackStatus {
  const run = liveUnpack();
  const status = getShardStatus(shardsDir());
  return {
    dir: status.dir,
    live: Boolean(run),
    progress: run?.progress ?? null,
    manifest: status.manifest,
    files: status.files,
    bytes: status.bytes,
    log: run ? [...run.log] : [],
  };
}

export interface GalaxyImportStatus {
  state: GalaxyImportState;
  live: boolean;
  /** Persisted `running` without a live task: the process restarted mid-import. */
  interrupted: boolean;
  percent: number | null;
  log: string[];
  backends: ReturnType<typeof describeImportBackends>;
  stats: GalaxyStats | null;
  archive: Awaited<ReturnType<typeof getGalaxyArchiveStatus>> | null;
  /** Cheapest dump that would bring the catalog up to date right now. */
  plan: GalaxyImportPlan | null;
  /** Unpacked shards on disk (the fast resume path). */
  shards: GalaxyUnpackStatus | null;
  /** The data disk: free space, archives and shards currently stored on it. */
  storage: GalaxyStorageStatus | null;
}

/** Persisted state plus the live counters of a run in this process. */
export async function getGalaxyImportStatus(): Promise<GalaxyImportStatus> {
  const persisted = await readImportState();
  const run = liveRun();
  const state = run?.snapshot
    ? {
        ...persisted,
        phase: 'running' as GalaxyImportPhase,
        backend: run.backend,
        bytes_done: run.snapshot.bytesDone,
        bytes_total: run.snapshot.bytesTotal,
        resume_offset: run.snapshot.resumeOffset,
        processed: run.snapshot.processed,
        written: run.snapshot.written,
        invalid: run.snapshot.invalid,
        skipped: run.snapshot.skipped,
      }
    : persisted;
  const stats = await getGalaxyStats().catch(() => null);
  const archive = await getGalaxyArchiveStatus().catch(() => null);
  const plan = await planGalaxyImport().catch(() => null);
  let shards: GalaxyUnpackStatus | null = null;
  try {
    shards = getGalaxyUnpackStatus();
  } catch {
    shards = null;
  }
  let storage: GalaxyStorageStatus | null = null;
  try {
    storage = getGalaxyStorageStatus();
  } catch {
    storage = null;
  }
  return {
    state,
    live: Boolean(run),
    interrupted: !run && persisted.phase === 'running',
    percent: importPercent(state),
    log: run ? [...run.log] : [],
    backends: describeImportBackends(),
    stats,
    archive,
    plan,
    shards,
    storage,
  };
}

export interface StartGalaxyImportOptions {
  /** Dump URL to fetch the archive from (default: the nightly Spansh dump). */
  url?: string;
  /** Local dump file to import directly (never downloaded or replaced). */
  file?: string;
  /** Re-download the dump archive and start from the first record. */
  fresh?: boolean;
  /** Empty the table first (direct Postgres only). */
  truncate?: boolean;
  /** Do not build/upload the map point cloud. */
  skipPoints?: boolean;
  /**
   * Scheduled (not manual) run: counts a retry after a failure so the scheduler
   * can stop hammering a broken source. A manual start resets the counter. A
   * scheduled run also requires the on-disk archive to be fresh (younger than
   * FRESH_MS) or re-downloads the dump first.
   */
  scheduled?: boolean;
  /**
   * Which Spansh file to import. Default (`auto`) asks `planGalaxyImport()`
   * for the cheapest dump that still covers the gap — a day-old catalog needs
   * 4 MiB, not 5.9 GiB.
   */
  variant?: GalaxyDumpVariant | 'auto';
  /**
   * `stream` reads the gzip archive directly (the historical path);
   * `shards` unpacks it once into TSV shards and imports those, which makes a
   * resumed import O(1) instead of re-parsing 2×10⁸ JSON objects.
   * Default: shards when they already exist (or `GALAXY_IMPORT_MODE=shards`).
   */
  mode?: 'stream' | 'shards' | 'auto';
}

export interface StartGalaxyImportResult {
  started: boolean;
  reason?: string;
  resumedFrom?: number;
  /** Shards skipped as already imported (shard mode). */
  resumedShard?: number;
  variant?: GalaxyDumpVariant;
  mode?: 'stream' | 'shards';
  plan?: GalaxyImportPlan;
  state: GalaxyImportState;
}

function pickBackend(): { backend: GalaxyImportBackend; connectionString: string | null } {
  const connectionString = galaxyDbUrl();
  if (connectionString) return { backend: 'pg', connectionString };
  const described = describeImportBackends();
  if (described.supabase) return { backend: 'supabase', connectionString: null };
  throw new Error(
    'Импорт не настроен: нужен DATABASE_URL/SUPABASE_DB_URL (быстрый прямой Postgres) ' +
    'или NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (PostgREST).',
  );
}

export interface CreateWriterOptions {
  backend: GalaxyImportBackend;
  connectionString: string | null;
  truncate: boolean;
  /**
   * PostgREST credentials exist, so an unreachable direct connection can be
   * worked around instead of failing the import.
   */
  supabaseFallback: boolean;
  log?: (line: string) => void;
  /**
   * Connection attempts for the default direct-Postgres factory (tests pass 1
   * so an unreachable host does not cost the whole backoff schedule).
   */
  pgAttempts?: number;
  /** Injectable factories — the tests drive this without a database. */
  createPg?: (connectionString: string, options: { truncate: boolean; log: (line: string) => void }) => Promise<GalaxyRowWriter>;
  createSupabase?: () => Promise<GalaxyRowWriter>;
}

/**
 * Open the writer for the chosen backend, degrading to PostgREST when the
 * direct Postgres connection cannot be established at all.
 *
 * A `DATABASE_URL` pointing at a host this process cannot see (the classic
 * `getaddrinfo EAI_AGAIN db` — the `db` service of another Compose network) used
 * to fail the whole import even though the PostgREST path was configured and
 * working. The direct connection stays the preferred one; when it is dead the
 * import continues over PostgREST and says so in the log.
 */
export async function createWriterWithFallback(
  options: CreateWriterOptions,
): Promise<{ writer: GalaxyRowWriter; backend: GalaxyImportBackend }> {
  const log = options.log ?? (() => undefined);
  const createPg =
    options.createPg ??
    (async (connectionString, opts) => {
      // Быстрый путь: COPY в UNLOGGED staging + merge пачками (см.
      // galaxyCopyWriter.ts и GALAXY-IMPORT-SPEED.md). Он на порядки быстрее
      // пачечных INSERT … ON CONFLICT, поэтому выбирается по умолчанию, а
      // пачечный путь остаётся запасным: нет pg-copy-streams или GALAXY_COPY=0.
      const copyDisabled = process.env.GALAXY_COPY === '0';
      if (!copyDisabled && (await loadCopyFrom())) {
        try {
          return await createPgCopyWriter(connectionString, {
            truncate: opts.truncate,
            log: opts.log,
            attempts: options.pgAttempts,
          });
        } catch (error) {
          // Падение на подключении должно вести себя как раньше (fallback на
          // PostgREST), поэтому пробрасывается; падение самого COPY-пути —
          // повод тихо вернуться к INSERT.
          if (isPgConnectionError(error)) throw error;
          opts.log(`WARNING: COPY-путь недоступен (${(error as Error)?.message ?? error}) — пишу пачечными INSERT`);
        }
      }
      return createPgWriter(connectionString, {
        truncate: opts.truncate,
        log: opts.log,
        attempts: options.pgAttempts,
      });
    });
  const createSupabase = options.createSupabase ?? (async () => createSupabaseWriter(admin()));

  if (options.backend !== 'pg' || !options.connectionString) {
    if (options.truncate) {
      throw new Error('--truncate доступен только при прямом подключении к Postgres (DATABASE_URL/SUPABASE_DB_URL)');
    }
    return { writer: await createSupabase(), backend: 'supabase' };
  }

  try {
    return { writer: await createPg(options.connectionString, { truncate: options.truncate, log }), backend: 'pg' };
  } catch (error) {
    const detail = isPgConnectionError(error)
      ? error.failure.message
      : (error as Error)?.message || String(error);
    if (!options.supabaseFallback) throw new Error(detail);
    log(`WARNING: прямой Postgres недоступен — ${detail}`);
    // PostgREST is not "slower" for a 6 GiB dump, it is the failure the admin
    // panel reported (2.7%, statement timeout on a single row). Say what it
    // costs and how to leave the path, before hours go into it.
    for (const line of postgrestWriteWarning('unreachable', options.connectionString)) log(line);
    if (options.truncate) {
      log('WARNING: очистка таблицы пропущена — TRUNCATE доступен только при прямом подключении к Postgres');
    }
    return { writer: await createSupabase(), backend: 'supabase' };
  }
}

export interface GalaxyDbCheck {
  direct: {
    /** `DATABASE_URL`/`SUPABASE_DB_URL` is set at all. */
    configured: boolean;
    /** Host from the connection string — the thing that usually cannot be resolved. */
    host: string | null;
    ok: boolean;
    /** Diagnosis for the operator (why it failed), or what succeeded. */
    message: string;
    database: string | null;
    /**
     * Раздельный сетевой диагноз (DNS/TCP) для неудачного подключения:
     * `timeout expired` от драйвера сам по себе не отличает «имя не
     * резолвится» от «резолвится не туда» и от «порт закрыт».
     */
    network?: PgReachability | null;
  };
  postgrest: { configured: boolean };
  /** The backend the import would pick right now. */
  backend: GalaxyImportBackend | null;
}

/**
 * One-shot connection report, run inside the web process.
 *
 * The production image contains no `scripts/`, so `--check-db` on the CLI is not
 * available there — and a check from the host would not see what the container
 * sees. This is the accurate answer to «getaddrinfo EAI_AGAIN db»: one attempt,
 * a short timeout, no retries, and the same diagnosis the import itself uses.
 */
export async function checkGalaxyDbConnection(
  options: { env?: NodeJS.ProcessEnv; connectionTimeoutMillis?: number; probe?: boolean } = {},
): Promise<GalaxyDbCheck> {
  const env = options.env ?? process.env;
  const backends = describeImportBackends(env);
  const connectionString = galaxyDbUrl(env);
  const postgrest = { configured: backends.supabase };

  if (!connectionString) {
    return {
      direct: {
        configured: false,
        host: null,
        ok: false,
        message: 'DATABASE_URL/SUPABASE_DB_URL не заданы — импорт пойдёт через PostgREST',
        database: null,
      },
      postgrest,
      backend: backends.backend,
    };
  }

  const host = pgConnectionTarget(connectionString)?.host ?? null;

  // Resolve DNS and open the TCP socket before handing the URL to `pg`.
  // node-postgres applies `connectionTimeoutMillis` to the whole connection,
  // including name resolution, and therefore often turns an EAI_AGAIN for
  // `db` into the generic `timeout expired`. Showing that generic error first
  // made operators investigate firewalls even though the name did not exist
  // in the web container at all. A failed preflight is already conclusive and
  // must not be followed by a second, slower attempt through the driver.
  const network = options.probe === false ? null : await probeNetwork(connectionString, options);
  if (network && network.kind !== 'ok') {
    return {
      direct: {
        configured: true,
        host,
        ok: false,
        message: network.message,
        database: null,
        network,
      },
      postgrest,
      backend: backends.backend,
    };
  }

  try {
    const client = await connectPgClient({
      connectionString,
      attempts: 1,
      connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5_000,
    });
    try {
      const result = await client.query('SELECT current_database() AS db');
      const database = typeof result.rows[0]?.db === 'string' ? (result.rows[0].db as string) : null;
      return {
        direct: {
          configured: true,
          host,
          ok: true,
          message: `подключение работает${database ? `, база «${database}»` : ''}`,
          database,
        },
        postgrest,
        backend: backends.backend,
      };
    } finally {
      await client.end().catch(() => undefined);
    }
  } catch (error) {
    const detail = isPgConnectionError(error) ? error.failure.message : (error as Error)?.message || String(error);
    // `network === ok` is useful evidence for an auth/SSL failure, but its
    // generic "network is fine" sentence must not replace the driver's exact
    // diagnosis. The UI still receives the structured probe below.
    return {
      direct: {
        configured: true,
        host,
        ok: false,
        message: detail,
        database: null,
        network,
      },
      postgrest,
      backend: backends.backend,
    };
  }
}

/** DNS + TCP проба по адресу из строки подключения (ошибки пробы не фатальны). */
async function probeNetwork(
  connectionString: string,
  options: { connectionTimeoutMillis?: number } = {},
): Promise<PgReachability | null> {
  const target = pgConnectionTarget(connectionString);
  if (!target) return null;
  try {
    return await probePgReachability(target.host, Number(target.port || 5432), {
      timeoutMs: options.connectionTimeoutMillis ?? 4_000,
    });
  } catch {
    return null;
  }
}

async function uploadPoints(buffer: Buffer, log: (line: string) => void): Promise<{ uploaded: boolean; error: string | null }> {
  if (buffer.length > POINTS_UPLOAD_LIMIT) {
    const message = `файл точек ${formatBytes(buffer.length)} больше лимита бакета ${formatBytes(POINTS_UPLOAD_LIMIT)}`;
    log(`WARNING: ${message} — не загружен`);
    return { uploaded: false, error: message };
  }
  try {
    const { error } = await admin().storage
      .from(POINTS_STORAGE_BUCKET)
      .upload(POINTS_STORAGE_OBJECT, new Uint8Array(buffer), {
        contentType: 'application/octet-stream',
        upsert: true,
      });
    if (error) {
      log(`WARNING: загрузка файла точек не удалась: ${error.message}`);
      return { uploaded: false, error: error.message };
    }
    log(`Файл точек загружен в storage ${POINTS_STORAGE_BUCKET}/${POINTS_STORAGE_OBJECT}`);
    return { uploaded: true, error: null };
  } catch (error) {
    const message = (error as Error)?.message || 'unknown storage error';
    log(`WARNING: загрузка файла точек не удалась: ${message}`);
    return { uploaded: false, error: message };
  }
}

/**
 * Start the import in the background. Resolves as soon as the run is registered
 * (or refused), never when it finishes.
 */
export async function startGalaxyImport(options: StartGalaxyImportOptions = {}): Promise<StartGalaxyImportResult> {
  if (liveRun()) {
    return { started: false, reason: 'Импорт уже запущен', state: await readImportState() };
  }
  if (liveUnpack()) {
    return { started: false, reason: 'Идёт распаковка архива в шарды — дождитесь её окончания', state: await readImportState() };
  }

  // A pinned local file (option or GALAXY_IMPORT_FILE) must exist before the
  // job registers itself — a typo in the path is a config error, not a
  // resumable failure.
  const pinnedFile = options.file?.trim() ? resolve(options.file.trim()) : galaxyImportFile();
  if (pinnedFile && !existsSync(pinnedFile)) {
    throw new Error(`Dump file not found: ${pinnedFile}`);
  }

  // What to import: an explicit choice, the variant implied by an explicit URL
  // or file, or the cheapest dump that covers the gap (see planGalaxyImport).
  const plan = await planGalaxyImport();
  const variant: GalaxyDumpVariant = isDumpVariant(options.variant)
    ? options.variant
    : variantFromUrl(options.url) ?? (pinnedFile ? variantFromUrl(pinnedFile) ?? 'full' : plan.variant);
  const url = options.url?.trim() || dumpVariantUrl(variant);
  const isDelta = variant !== 'full';

  // Shards: the fast, O(1)-resumable path. Used when they already describe the
  // archive, or when the operator asked for the mode. A delta is 4–90 MiB —
  // unpacking it would cost more than streaming it.
  const shardDir = shardsDir();
  const manifest = readShardManifest(shardDir);
  const fullArchive = galaxyArchivePathForVariant('full');
  const shardsReady = Boolean(manifest?.complete) && manifestMatchesArchive(manifest, pinnedFile ?? fullArchive);
  const requestedMode = options.mode === 'shards' || options.mode === 'stream' ? options.mode : null;
  const mode: 'stream' | 'shards' =
    requestedMode ??
    (!isDelta && (shardsReady || galaxyImportMode() === 'shards') ? 'shards' : 'stream');

  const chosen = pickBackend();
  const connectionString = chosen.connectionString;
  // The preferred backend; `createWriterWithFallback` may downgrade it to
  // PostgREST when the direct connection turns out to be unreachable.
  let backend = chosen.backend;
  const previous = await readImportState();
  // A restart point only means something for the same file in the same mode.
  const sameRun = (previous.variant ?? 'full') === variant && (previous.mode ?? 'stream') === mode;
  const interrupted = previous.phase === 'failed' || previous.phase === 'cancelled' || previous.phase === 'running';
  const resumable = !options.fresh && sameRun && interrupted;
  const resumeFrom = resumable && mode === 'stream' ? previous.resume_offset : 0;
  const resumeShard = resumable && mode === 'shards' ? previous.shard_index : 0;
  // Deltas must not rebuild the cloud: it would mean a full table scan of
  // 2×10⁸ rows every night for a 4 MiB file. The full import refreshes it.
  const buildPoints = options.skipPoints === true ? false : options.skipPoints === false ? true : !isDelta;

  const controller = new AbortController();
  const run: LiveRun = { controller, writer: null, snapshot: null, backend, startedAt: Date.now(), log: [] };
  runtime.edrcGalaxyImportRun = run;

  const log = (line: string) => {
    run.log.push(line);
    if (run.log.length > 60) run.log.splice(0, run.log.length - 60);
    console.error(`[galaxy-import] ${line}`);
  };

  const started = await writeImportState({
    phase: 'running',
    backend,
    source: url,
    variant,
    mode,
    started_at: new Date().toISOString(),
    finished_at: null,
    error: null,
    points_error: null,
    bytes_done: 0,
    resume_offset: resumeFrom,
    shard_index: resumeShard,
    shards_total: mode === 'shards' ? manifest?.shards.length ?? null : null,
    processed: 0,
    written: 0,
    invalid: 0,
    skipped: 0,
    attempts: options.scheduled && previous.phase === 'failed' ? previous.attempts + 1 : 0,
  });

  // The catalog is current as of the generation time of the dump it was built
  // from; a delta that does not reach back that far would leave a hole.
  const statsBefore = (await getGalaxyStats().catch(() => null)) as
    | (GalaxyStats & { dump_generated_at?: string | null })
    | null;
  const previousDataAsOf = statsBefore?.dump_generated_at ?? null;

  void (async () => {
    let writer: GalaxyRowWriter | null = null;
    try {
      if (!isDumpVariant(options.variant) && !options.url && !pinnedFile) log(`Выбор дампа: ${plan.reason}`);
      log(
        `Импорт: ${DUMP_VARIANTS[variant].file} (${DUMP_VARIANTS[variant].label}), ` +
        `режим ${mode === 'shards' ? 'из шардов' : 'потоком из архива'}`,
      );
      // PostgREST is the only writer this process can build: warn about the
      // cost now, while the operator can still change the configuration. The
      // `unreachable` variant is logged by `createWriterWithFallback` itself.
      if (backend === 'supabase') {
        for (const line of postgrestWriteWarning('unconfigured', connectionString)) log(line);
      }
      const opened = await createWriterWithFallback({
        backend,
        connectionString,
        truncate: options.truncate === true,
        supabaseFallback: describeImportBackends().supabase,
        log,
      });
      writer = opened.writer;
      run.writer = writer;
      if (opened.backend !== backend) {
        // Keep the reported backend honest: the admin tab, `/api/galaxy/stats`
        // and the `imported_by` note all read it.
        backend = opened.backend;
        run.backend = opened.backend;
        await writeImportState({ backend }).catch(() => undefined);
      }
      log(
        resumeFrom > 0
          ? `Режим записи: ${backend}; продолжение — уже записанные системы (до байта ${resumeFrom.toLocaleString()} распакованного дампа) будут пропущены`
          : resumeShard > 0
            ? `Режим записи: ${backend}; продолжение с шарда ${resumeShard + 1}`
            : `Режим записи: ${backend}`,
      );

      let result: GalaxyImportRunResult;
      let generatedAt: string | null = null;
      let shardsDone = resumeShard;
      let shardsTotal: number | null = null;
      // The archive this pass read from: deleted once the rows are in the
      // database (it is a download cache, and the next refresh is a delta).
      let importedArchive: string | null = null;

      if (mode === 'shards') {
        // Shards may outlive the archive (`prune`): import them directly when
        // the manifest is complete and the archive is gone.
        const haveShards = Boolean(readShardManifest(shardDir)?.complete);
        if (!haveShards) {
          const archive = pinnedFile
            ? { path: pinnedFile, lastModified: null }
            : await ensureArchiveDownload({
                url,
                variant,
                scheduled: options.scheduled === true,
                fresh: options.fresh === true,
                signal: controller.signal,
                log,
              });
          generatedAt = archive.lastModified;
          importedArchive = archive.path;
          log('Распаковываю архив в шарды (один раз; дальше импорт и возобновление идут по шардам)');
          await unpackArchiveToShards({
            archive: archive.path,
            dir: shardDir,
            source: url,
            variant,
            fresh: options.fresh === true,
            signal: controller.signal,
            log,
          });
        } else {
          generatedAt = (await readArchiveState().catch(() => null))?.last_modified ?? null;
        }
        const shardRun = await runShardImport({
          dir: shardDir,
          writer,
          fromShard: resumeShard,
          signal: controller.signal,
          log,
          buildPoints,
          prune: process.env.GALAXY_SHARDS_PRUNE === '1',
          onProgress: (snapshot: ShardImportSnapshot) => {
            run.snapshot = {
              bytesDone: snapshot.bytesDone,
              bytesTotal: snapshot.bytesTotal,
              resumeOffset: 0,
              processed: snapshot.processed,
              written: snapshot.written,
              invalid: snapshot.invalid,
              skipped: snapshot.skipped,
              rate: snapshot.rate,
              elapsedMs: snapshot.elapsedMs,
            };
            return writeImportState({
              bytes_done: snapshot.bytesDone,
              bytes_total: snapshot.bytesTotal,
              shard_index: snapshot.shardIndex,
              shards_total: snapshot.shardsTotal,
              processed: snapshot.processed,
              written: snapshot.written,
              skipped: snapshot.skipped,
            }).then(() => undefined);
          },
        });
        result = shardRun;
        shardsDone = shardRun.shardsDone;
        shardsTotal = shardRun.shardsTotal;
      } else {
        // Resolve the dump on disk. A pinned file wins; otherwise the shared
        // archive is used (downloading it first when missing, or stale on a
        // scheduled run). The import itself then reads the local file, so a
        // dropped network connection can no longer kill it or force a re-download.
        const archive = pinnedFile
          ? { path: pinnedFile, lastModified: null }
          : await ensureArchiveDownload({
              url,
              variant,
              scheduled: options.scheduled === true,
              fresh: options.fresh === true,
              signal: controller.signal,
              log,
            });
        generatedAt = archive.lastModified;
        importedArchive = archive.path;

        result = await runGalaxyImport({
          file: archive.path,
          writer,
          resumeFrom,
          signal: controller.signal,
          log,
          buildPoints,
          onProgress: (snapshot) => {
            run.snapshot = snapshot;
            // Persisting every tick is enough to restart without losing much.
            return writeImportState({
              bytes_done: snapshot.bytesDone,
              bytes_total: snapshot.bytesTotal,
              resume_offset: snapshot.resumeOffset,
              processed: snapshot.processed,
              written: snapshot.written,
              invalid: snapshot.invalid,
              skipped: snapshot.skipped,
            }).then(() => undefined);
          },
        });
      }

      // Did this delta really reach back to where the catalog stood? If not,
      // the freshness marker must NOT advance — the next run then picks a
      // wider file instead of hiding the hole forever.
      const coverage = variantCoversGap(variant, generatedAt, previousDataAsOf);
      if (!coverage.ok) {
        log(`WARNING: ${coverage.reason} — отметка актуальности не сдвигается, следующий запуск возьмёт более широкий дамп`);
      }
      const dataAsOf = coverage.ok ? generatedAt ?? new Date().toISOString() : previousDataAsOf;

      let pointsUploaded = false;
      let pointsError: string | null = null;
      if (result.points) {
        const upload = await uploadPoints(result.points.buffer, log);
        pointsUploaded = upload.uploaded;
        pointsError = upload.error;
      }

      if (writer.analyze) {
        // 10⁸ upserts leave the planner with empty-table estimates.
        await writer.analyze().catch((error) => log(`WARNING: ANALYZE не выполнен: ${(error as Error).message}`));
      }

      await writeCatalogStats({
        systems_count: result.systemsCount,
        valid_records: result.processed,
        invalid_records: result.invalid,
        source: url,
        backend,
        variant,
        dump_generated_at: dataAsOf,
        points: result.points
          ? {
              count: result.points.count,
              bytes: result.points.buffer.length,
              uploaded: pointsUploaded,
              rows: result.points.rows,
              stride: result.points.stride,
            }
          : null,
      });

      const finalState = await writeImportState({
        phase: 'done',
        finished_at: new Date().toISOString(),
        bytes_done: result.bytesDone,
        bytes_total: result.bytesTotal,
        resume_offset: 0,
        shard_index: 0,
        shards_total: shardsTotal,
        dump_generated_at: dataAsOf,
        processed: result.processed,
        written: result.written,
        invalid: result.invalid,
        skipped: result.skipped,
        systems_count: result.systemsCount,
        points_count: result.points?.count ?? null,
        points_bytes: result.points ? result.points.buffer.length : null,
        points_stride: result.points?.stride ?? null,
        points_uploaded: pointsUploaded,
        points_error: pointsError,
        error: null,
        attempts: 0,
      });
      run.snapshot = null;
      log(
        isDelta
          ? `Обновление «${DUMP_VARIANTS[variant].label}» применено: ${result.processed.toLocaleString()} систем`
          : 'Импорт завершён',
      );
      if (shardsDone && shardsTotal) log(`Шардов импортировано: ${shardsDone}/${shardsTotal}`);

      // Rows are in Postgres now: the archive has done its job. Keeping it
      // would cost 5.9 GiB on the data disk until the next cold start, and the
      // next refresh downloads a few megabytes of delta instead.
      const released = releaseArchiveAfterImport({ path: importedArchive, log });
      if (released.kept && released.reason) {
        log(`Архив оставлен на диске (${released.reason})`);
      } else if (released.freed > 0) {
        await writeArchiveState({
          phase: 'idle',
          path: null,
          bytes_done: 0,
          bytes_total: null,
          error: null,
        }).catch(() => undefined);
      }
      return finalState;
    } catch (error) {
      const cancelled = controller.signal.aborted;
      const message = (error as Error)?.message || String(error);
      log(cancelled ? `Остановлено: ${message}` : `ОШИБКА: ${message}`);
      const snapshot = run.snapshot;
      run.snapshot = null;
      try {
        const current = await readImportState();
        return await writeImportState({
          phase: cancelled ? 'cancelled' : 'failed',
          finished_at: new Date().toISOString(),
          bytes_done: snapshot?.bytesDone ?? resumeFrom,
          bytes_total: snapshot?.bytesTotal ?? null,
          resume_offset: mode === 'shards' ? 0 : cancelled || !snapshot ? resumeFrom : snapshot.resumeOffset,
          // In shard mode the restart point is the number of shards already
          // stored; `writeImportState` has been persisting it all along.
          shard_index: mode === 'shards' ? current.shard_index : 0,
          processed: snapshot?.processed ?? 0,
          written: snapshot?.written ?? 0,
          invalid: snapshot?.invalid ?? 0,
          skipped: snapshot?.skipped ?? 0,
          error: cancelled ? null : message,
        });
      } catch (stateError) {
        console.error('[galaxy-import] could not persist failure state:', (stateError as Error)?.message);
        return null;
      }
    } finally {
      run.writer = null;
      if (writer) await writer.close().catch(() => undefined);
      runtime.edrcGalaxyImportRun = null;
    }
  })();

  return {
    started: true,
    resumedFrom: resumeFrom,
    resumedShard: resumeShard,
    variant,
    mode,
    plan,
    state: started,
  };
}

/**
 * «Освободить место» from the admin tab: delete every dump archive that is not
 * needed to continue (and the shards left over from an archive that is gone).
 * Refused while a download, unpack or import is using those files.
 */
export async function cleanupGalaxyDisk(options: { dropShards?: boolean } = {}): Promise<{
  cleaned: boolean;
  reason?: string;
  freed: number;
  removed: string[];
  storage: GalaxyStorageStatus;
}> {
  if (liveDownload() || liveUnpack() || liveRun()) {
    return {
      cleaned: false,
      reason: 'Идёт скачивание, распаковка или импорт — очистка может удалить файл из-под них',
      freed: 0,
      removed: [],
      storage: getGalaxyStorageStatus(),
    };
  }
  const pinned = galaxyImportFile();
  const log = (line: string) => console.error(`[galaxy-archive] ${line}`);
  // An unfinished import must keep the file it will continue from.
  const state = await readImportState().catch(() => ({ ...EMPTY_IMPORT_STATE }));
  const unfinished = state.phase === 'running' || state.phase === 'failed' || state.phase === 'cancelled';
  const keep = [pinned, unfinished && isDumpVariant(state.variant) ? state.variant : null];
  const result = cleanupGalaxyStorage({ keep, dropShards: options.dropShards === true, log });
  return {
    cleaned: true,
    freed: result.freed,
    removed: result.removed.map((item) => item.path),
    storage: result.storage,
  };
}

/** Stop a running import. Rows already written stay (upserts are idempotent). */
export async function cancelGalaxyImport(): Promise<{ cancelled: boolean; state: GalaxyImportState }> {
  const run = liveRun();
  if (!run) return { cancelled: false, state: await readImportState() };
  run.controller.abort();
  // AbortSignal проверяется между строками, но во время долгого INSERT/COPY
  // управление находится внутри pg. Закрываем его соединение, чтобы Postgres
  // немедленно отменил запрос и откатил текущий merge, а кнопка не ждала его
  // естественного завершения десятки минут.
  await run.writer?.cancel?.().catch(() => undefined);
  // The background task persists `cancelled`; give it a moment to do so.
  for (let i = 0; i < 40; i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (!liveRun()) break;
  }
  return { cancelled: true, state: await readImportState() };
}

/**
 * Catalog statistics the rest of the app gates on (`getGalaxyStats`). Merged, so
 * a run without points does not erase a previous successful upload.
 */
async function writeCatalogStats(input: {
  systems_count: number;
  valid_records: number;
  invalid_records: number;
  source: string;
  backend: GalaxyImportBackend;
  /** Which dump produced these numbers (`full` or a delta). */
  variant?: GalaxyDumpVariant;
  /**
   * When the imported dump was generated. This — not `imported_at` — is the
   * moment the catalog is current as of, and the next run sizes its delta
   * from it.
   */
  dump_generated_at?: string | null;
  points: { count: number; bytes: number; uploaded: boolean; rows: number; stride: number } | null;
}): Promise<void> {
  const previous = (await metaValue('stats').catch(() => null)) ?? {};
  const variant = input.variant ?? 'full';
  const value: Record<string, unknown> = {
    ...previous,
    systems_count: input.systems_count,
    valid_records: input.valid_records,
    invalid_records: input.invalid_records,
    partial: false,
    source: input.source,
    imported_at: new Date().toISOString(),
    imported_by: `web/${input.backend}`,
    dump_variant: variant,
    dump_generated_at: input.dump_generated_at ?? (previous as Record<string, unknown>).dump_generated_at ?? null,
    note:
      variant === 'full'
        ? 'Full Spansh systems dump (nightly at https://spansh.co.uk/dumps). Deltas (systems_1day…) keep it fresh.'
        : `Spansh delta ${variant} applied on top of the catalog (https://spansh.co.uk/dumps).`,
  };
  if (input.points?.uploaded) {
    value.points_uploaded = true;
    value.points_count = input.points.count;
    value.points_bytes = input.points.bytes;
    // The cloud is a uniform sample of the catalog (~2×10⁸ systems do not fit
    // the 50 MB bucket): say so, so the map layer is not read as complete.
    value.points_rows = input.points.rows;
    value.points_stride = input.points.stride;
    value.points_sampled = input.points.stride > 1;
  }
  const { error } = await admin()
    .from('galaxy_systems_meta')
    .upsert({ key: 'stats', value }, { onConflict: 'key' });
  if (error) throw new Error(`galaxy_systems_meta stats write failed: ${error.message}`);
  invalidateGalaxyStatsCache();
}
