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

import { invalidateGalaxyStatsCache, type GalaxyStats, getGalaxyStats } from './galaxySystemsDb.ts';
import {
  POINTS_UPLOAD_LIMIT,
  createPgWriter,
  createSupabaseWriter,
  describeImportBackends,
  downloadDumpFile,
  formatBytes,
  galaxyArchivePath,
  galaxyImportFile,
  galaxyImportUrl,
  runGalaxyImport,
  type GalaxyImportBackend,
  type GalaxyImportSnapshot,
  type GalaxyRowWriter,
} from './galaxyImport.ts';
import { FRESH_MS } from './galaxyImportSchedule.ts';
import { POINTS_STORAGE_BUCKET, POINTS_STORAGE_OBJECT } from './galaxySystems.ts';
import { galaxyDbUrl } from './pgModule.ts';
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
   * before this offset, so the ~1.3M upserts are not repeated.
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
  points_uploaded: boolean;
  points_error: string | null;
  error: string | null;
  /** Consecutive failed attempts of the same import (scheduler backoff). */
  attempts: number;
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
  points_uploaded: false,
  points_error: null,
  error: null,
  attempts: 0,
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
  };
}

/** 0..100 by bytes on disk; null while the total size is unknown. */
export function archivePercent(state: GalaxyArchiveState): number | null {
  if (!state.bytes_total || state.bytes_total <= 0) return null;
  return Math.max(0, Math.min(100, (state.bytes_done / state.bytes_total) * 100));
}

interface LiveRun {
  controller: AbortController;
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

const runtime = globalThis as typeof globalThis & {
  edrcGalaxyImportRun?: LiveRun | null;
  edrcGalaxyDownloadRun?: LiveDownload | null;
};

function liveRun(): LiveRun | null {
  return runtime.edrcGalaxyImportRun ?? null;
}

function liveDownload(): LiveDownload | null {
  return runtime.edrcGalaxyDownloadRun ?? null;
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
    points_uploaded: raw.points_uploaded === true,
    points_error: str(raw.points_error),
    error: str(raw.error),
    attempts: num(raw.attempts),
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
export async function startGalaxyDownload(options: { url?: string } = {}): Promise<{
  started: boolean;
  reason?: string;
  state: GalaxyArchiveState;
}> {
  if (liveDownload()) {
    return { started: false, reason: 'Скачивание уже идёт', state: await readArchiveState() };
  }
  if (liveRun()) {
    return { started: false, reason: 'Импорт уже запущен — скачивание может испортить файл, из которого он читает', state: await readArchiveState() };
  }

  const url = options.url?.trim() || galaxyImportUrl();
  const dest = galaxyArchivePath();

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
    error: null,
  });

  void (async () => {
    try {
      const result = await downloadDumpFile({
        url,
        dest,
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

  return { started: true, state: started };
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
  scheduled: boolean;
  fresh: boolean;
  signal: AbortSignal;
  log: (line: string) => void;
}): Promise<string> {
  const dest = galaxyArchivePath();

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

  if (!args.fresh && complete && existsSync(dest) && (!args.scheduled || archiveIsFresh(dest))) {
    const stat = statSync(dest);
    args.log(`Архив уже на диске: ${dest} (${formatBytes(stat.size)}) — импорт идёт с диска, без сети`);
    return dest;
  }

  if (complete && existsSync(dest) && args.scheduled && !archiveIsFresh(dest)) {
    // The nightly update must fetch today's dump, not re-import yesterday's.
    args.log('Архив на диске старше суток — скачиваю свежий дамп');
    rmSync(dest, { force: true });
  }

  args.log(`Скачиваю дамп на диск: ${args.url} → ${dest}`);
  await writeArchiveState({ phase: 'downloading', source: args.url, path: dest, error: null }).catch((error) => {
    args.log(`Не удалось сохранить состояние: ${(error as Error).message}`);
  });

  let lastPersist = 0;
  const result = await downloadDumpFile({
    url: args.url,
    dest,
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
    bytes_done: result.bytes,
    bytes_total: result.total,
    downloaded_at: new Date().toISOString(),
    error: null,
  }).catch((error) => {
    args.log(`Не удалось сохранить состояние: ${(error as Error).message}`);
  });
  args.log(`Архив на диске: ${formatBytes(result.bytes)} — импорт идёт с диска`);
  return dest;
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
  return {
    state,
    live: Boolean(run),
    interrupted: !run && persisted.phase === 'running',
    percent: importPercent(state),
    log: run ? [...run.log] : [],
    backends: describeImportBackends(),
    stats,
    archive,
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
}

export interface StartGalaxyImportResult {
  started: boolean;
  reason?: string;
  resumedFrom?: number;
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

async function createWriter(
  backend: GalaxyImportBackend,
  connectionString: string | null,
  truncate: boolean,
): Promise<GalaxyRowWriter> {
  if (backend === 'pg' && connectionString) {
    return createPgWriter(connectionString, { truncate });
  }
  if (truncate) {
    throw new Error('--truncate доступен только при прямом подключении к Postgres (DATABASE_URL/SUPABASE_DB_URL)');
  }
  return createSupabaseWriter(admin());
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
  const url = options.url?.trim() || galaxyImportUrl();
  const { backend, connectionString } = pickBackend();
  const previous = await readImportState();
  const resumable =
    !options.fresh &&
    previous.resume_offset > 0 &&
    (previous.phase === 'failed' || previous.phase === 'cancelled' || previous.phase === 'running');
  const resumeFrom = resumable ? previous.resume_offset : 0;

  const controller = new AbortController();
  const run: LiveRun = { controller, snapshot: null, backend, startedAt: Date.now(), log: [] };
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
    started_at: new Date().toISOString(),
    finished_at: null,
    error: null,
    points_error: null,
    bytes_done: 0,
    resume_offset: resumeFrom,
    processed: 0,
    written: 0,
    invalid: 0,
    skipped: 0,
    attempts: options.scheduled && previous.phase === 'failed' ? previous.attempts + 1 : 0,
  });

  // A pinned local file (option or GALAXY_IMPORT_FILE) must exist before the
  // job registers itself — a typo in the path is a config error, not a
  // resumable failure.
  const pinnedFile = options.file?.trim() ? resolve(options.file.trim()) : galaxyImportFile();
  if (pinnedFile && !existsSync(pinnedFile)) {
    throw new Error(`Dump file not found: ${pinnedFile}`);
  }

  void (async () => {
    let writer: GalaxyRowWriter | null = null;
    try {
      writer = await createWriter(backend, connectionString, options.truncate === true);
      log(
        resumeFrom > 0
          ? `Режим записи: ${backend}; продолжение — уже записанные системы (до байта ${resumeFrom.toLocaleString()} распакованного дампа) будут пропущены`
          : `Режим записи: ${backend}`,
      );

      // Resolve the dump on disk. A pinned file wins; otherwise the shared
      // archive is used (downloading it first when missing, or stale on a
      // scheduled run). The import itself then reads the local file, so a
      // dropped network connection can no longer kill it or force a re-download.
      const file = pinnedFile ?? (await ensureArchiveDownload({
        url,
        scheduled: options.scheduled === true,
        fresh: options.fresh === true,
        signal: controller.signal,
        log,
      }));

      const result = await runGalaxyImport({
        file,
        writer,
        resumeFrom,
        signal: controller.signal,
        log,
        buildPoints: options.skipPoints !== true,
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

      let pointsUploaded = false;
      let pointsError: string | null = null;
      if (result.points) {
        const upload = await uploadPoints(result.points.buffer, log);
        pointsUploaded = upload.uploaded;
        pointsError = upload.error;
      }

      await writeCatalogStats({
        systems_count: result.systemsCount,
        valid_records: result.processed,
        invalid_records: result.invalid,
        source: url,
        backend,
        points: result.points
          ? { count: result.points.count, bytes: result.points.buffer.length, uploaded: pointsUploaded }
          : null,
      });

      const finalState = await writeImportState({
        phase: 'done',
        finished_at: new Date().toISOString(),
        bytes_done: result.bytesDone,
        bytes_total: result.bytesTotal,
        resume_offset: 0,
        processed: result.processed,
        written: result.written,
        invalid: result.invalid,
        skipped: result.skipped,
        systems_count: result.systemsCount,
        points_count: result.points?.count ?? null,
        points_bytes: result.points ? result.points.buffer.length : null,
        points_uploaded: pointsUploaded,
        points_error: pointsError,
        error: null,
        attempts: 0,
      });
      run.snapshot = null;
      log('Импорт завершён');
      return finalState;
    } catch (error) {
      const cancelled = controller.signal.aborted;
      const message = (error as Error)?.message || String(error);
      log(cancelled ? `Остановлено: ${message}` : `ОШИБКА: ${message}`);
      const snapshot = run.snapshot;
      run.snapshot = null;
      try {
        return await writeImportState({
          phase: cancelled ? 'cancelled' : 'failed',
          finished_at: new Date().toISOString(),
          bytes_done: snapshot?.bytesDone ?? resumeFrom,
          bytes_total: snapshot?.bytesTotal ?? null,
          resume_offset: cancelled || !snapshot ? resumeFrom : snapshot.resumeOffset,
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
      if (writer) await writer.close().catch(() => undefined);
      runtime.edrcGalaxyImportRun = null;
    }
  })();

  return { started: true, resumedFrom: resumeFrom, state: started };
}

/** Stop a running import. Rows already written stay (upserts are idempotent). */
export async function cancelGalaxyImport(): Promise<{ cancelled: boolean; state: GalaxyImportState }> {
  const run = liveRun();
  if (!run) return { cancelled: false, state: await readImportState() };
  run.controller.abort();
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
  points: { count: number; bytes: number; uploaded: boolean } | null;
}): Promise<void> {
  const previous = (await metaValue('stats').catch(() => null)) ?? {};
  const value: Record<string, unknown> = {
    ...previous,
    systems_count: input.systems_count,
    valid_records: input.valid_records,
    invalid_records: input.invalid_records,
    partial: false,
    source: input.source,
    imported_at: new Date().toISOString(),
    imported_by: `web/${input.backend}`,
    note: 'Full Spansh systems dump (nightly at https://spansh.co.uk/dumps). Re-run the import to refresh.',
  };
  if (input.points?.uploaded) {
    value.points_uploaded = true;
    value.points_count = input.points.count;
    value.points_bytes = input.points.bytes;
  }
  const { error } = await admin()
    .from('galaxy_systems_meta')
    .upsert({ key: 'stats', value }, { onConflict: 'key' });
  if (error) throw new Error(`galaxy_systems_meta stats write failed: ${error.message}`);
  invalidateGalaxyStatsCache();
}
