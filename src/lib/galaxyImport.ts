/**
 * In-app Spansh catalog import: download → parse → `galaxy_systems` → point
 * cloud for the "all systems" galaxy-map layer.
 *
 * Why this exists next to `scripts/import-spansh-systems.mjs`: the production
 * image is a Next.js standalone build. It contains neither `scripts/` nor a
 * checkout to run them from, so a server that only has Docker could never fill
 * the table — `/api/galaxy/all-systems` answered 404 forever. This module runs
 * the very same pipeline inside the web process (streaming, no 6 GiB on disk)
 * and is driven by `/api/admin/galaxy`, `/api/cron/galaxy-import` and the
 * admin tab «Каталог систем».
 *
 * Everything here is dependency-injected (fetch, writer, clock, progress sink)
 * so `scripts/tests/galaxy-import.test.mjs` can run the whole pipeline against
 * a synthetic dump without network or database.
 */

import { createReadStream, createWriteStream, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { createGunzip } from 'node:zlib';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  PointsBuilder,
  POINTS_STORAGE_BUCKET,
  POINTS_STORAGE_OBJECT,
  galaxyPointsMax,
  type GalaxySystemPoint,
  type StarClass,
} from './galaxySystems.ts';
import {
  JsonArrayObjects,
  toGalaxySystemRow,
  type GalaxySystemRecord,
  type SpanshSystemObject,
} from './galaxySpanshStream.ts';
import {
  connectPgClient,
  galaxyDbUrl,
  loadPg,
  type PgClientLike,
  type PgModule,
} from './pgModule.ts';

export const SPANSH_DUMP_URL = 'https://downloads.spansh.co.uk/systems.json.gz';

/**
 * Dump URL to import. `GALAXY_IMPORT_URL` overrides it for servers that keep a
 * local mirror (or cannot reach downloads.spansh.co.uk); the layout must stay
 * the Spansh `systems.json.gz` one.
 */
export function galaxyImportUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.GALAXY_IMPORT_URL?.trim() || SPANSH_DUMP_URL;
}

// ─────────────────── on-disk archive (pre-download) ───────────────────
//
// The dump is ~6 GiB of gzip. Streaming it straight into the import made every
// aborted connection cost a full re-download, and a dropped socket surfaces as
// an undici `terminated` error that killed the whole job. Instead the web
// process first downloads the archive to disk (resumable HTTP Range + retries),
// and the import itself reads the local file — a resumed import re-reads the
// disk, not the network.

/** Archive directory inside the web container (`/app/data/spansh`). */
export const DEFAULT_ARCHIVE_DIR = 'data/spansh';
/** One fixed name so the admin UI, the import job and the CLI share the file. */
export const ARCHIVE_FILE_NAME = 'systems.json.gz';

export function galaxyArchiveDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.GALAXY_ARCHIVE_DIR?.trim() || DEFAULT_ARCHIVE_DIR;
}

export function galaxyArchivePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(galaxyArchiveDir(env), ARCHIVE_FILE_NAME);
}

/**
 * `GALAXY_IMPORT_FILE` pins a local dump to import directly (it is never
 * downloaded or replaced). Servers that keep their own mirror on disk set this.
 */
export function galaxyImportFile(env: NodeJS.ProcessEnv = process.env): string | null {
  const file = env.GALAXY_IMPORT_FILE?.trim();
  return file ? resolve(file) : null;
}

export interface DumpDownloadInfo {
  /** Bytes on disk after this attempt's chunk (offset + received so far). */
  received: number;
  total: number | null;
  /** The attempt continued a partial file. */
  resuming: boolean;
  /** Consecutive interrupted connections. */
  failures: number;
}

export interface DownloadDumpOptions {
  url: string;
  dest: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  log?: (line: string) => void;
  onProgress?: (info: DumpDownloadInfo) => void | Promise<void>;
  /**
   * Consecutive interrupted connections before the download gives up
   * (default 5; the in-app job passes `Infinity` and relies on
   * `maxStagnantFailures` to fail a truly dead network).
   */
  retries?: number;
  /**
   * Consecutive failures that moved no bytes at all (default 10). Bounds an
   * infinite retry loop when the network is down: a flaky line that keeps
   * advancing never trips it.
   */
  maxStagnantFailures?: number;
  sleep?: (ms: number) => Promise<void>;
  /** onProgress throttle (default 5000 ms). */
  progressIntervalMs?: number;
  /** Skip the final gzip integrity check (default false). */
  verify?: boolean;
}

/** Backoff between interrupted connections, capped at 60 s. */
const DUMP_BACKOFF_MS = [5_000, 10_000, 20_000, 30_000, 60_000];

/** Total size from a `Content-Range` header, e.g. `bytes 100-200/300` or `bytes 300-599/600`. */
export function parseContentRangeTotal(header: string | null): number | null {
  if (!header) return null;
  const match = /\/(\d+)\s*$/.exec(header);
  const total = match ? Number(match[1]) : NaN;
  return Number.isFinite(total) && total >= 0 ? total : null;
}

function safeSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** `fetch failed` hides the real reason in `.cause` (e.g. undici's `terminated`). */
function networkErrorMessage(error: unknown, fallback: string): string {
  const cause = (error as { cause?: { message?: string } } | null)?.cause;
  if (cause?.message) return cause.message;
  const message = (error as Error)?.message;
  return message && message !== 'fetch failed' ? message : fallback;
}

/**
 * Stream the dump through gunzip and discard, verifying the gzip trailer
 * (CRC32 + original size). A truncated or corrupted archive fails here
 * instead of mid-import.
 */
export async function verifyGzipFile(path: string): Promise<void> {
  await new Promise<void>((resolveCheck, reject) => {
    const source = createReadStream(path);
    const gunzip = createGunzip();
    gunzip.resume(); // bytes are discarded; the CRC check happens in the trailer
    source.on('error', (error) => {
      source.destroy();
      gunzip.destroy();
      reject(error instanceof Error ? error : new Error(String(error)));
    });
    gunzip.on('error', (error) => {
      source.destroy();
      reject(error instanceof Error ? error : new Error(String(error)));
    });
    gunzip.on('end', () => resolveCheck());
    source.pipe(gunzip);
  });
}

/**
 * Download a dump to disk with resume and retry.
 *
 * - Continues an existing partial file with `Range: bytes=<size>-`;
 * - a dropped connection (undici reports it as `terminated`), a 5xx or a short
 *   EOF only interrupts the CURRENT attempt — the bytes already on disk stay
 *   and the next attempt continues from them;
 * - an ignored `Range` (200 instead of 206) or a shrunken upstream file starts
 *   over from byte 0;
 * - a completed `.gz` file is gunzip-verified; a corrupted one is deleted and
 *   re-downloaded instead of failing the import.
 */
export async function downloadDumpFile(
  options: DownloadDumpOptions,
): Promise<{ path: string; bytes: number; total: number | null }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const log = options.log ?? (() => undefined);
  const sleep = options.sleep ?? defaultSleep;
  const retries = options.retries ?? 5;
  const maxStagnant = options.maxStagnantFailures ?? 10;
  const progressIntervalMs = Math.max(250, options.progressIntervalMs ?? 5_000);
  const dest = resolve(options.dest);

  mkdirSync(dirname(dest), { recursive: true });

  let failures = 0;
  let stagnant = 0;

  for (;;) {
    if (options.signal?.aborted) throw new Error('Download aborted');

    const offset = safeSize(dest);
    if (offset > 0) log(`Архив: продолжаю скачивание с байта ${offset.toLocaleString()}`);

    let response: Response;
    try {
      response = await fetchImpl(options.url, {
        headers: offset > 0 ? { Range: `bytes=${offset}-` } : undefined,
        signal: options.signal,
      });
    } catch (error) {
      if (options.signal?.aborted) throw new Error('Download aborted');
      const message = networkErrorMessage(error, 'fetch failed');
      failures += 1;
      stagnant += 1; // nothing arrived
      if (failures > retries || stagnant > maxStagnant) {
        throw new Error(`Скачивание не удалось после ${failures} обрыва(ов) подряд: ${message}`);
      }
      log(`Соединение не установлено (попытка ${failures}${retries < Infinity ? `/${retries}` : ''}): ${message}`);
      await sleep(DUMP_BACKOFF_MS[Math.min(failures - 1, DUMP_BACKOFF_MS.length - 1)]);
      continue;
    }

    if (response.status === 416) {
      // Range not satisfiable: the offset already covers the whole file.
      const total = parseContentRangeTotal(response.headers.get('content-range'));
      if (options.verify !== false && dest.toLowerCase().endsWith('.gz')) {
        // The file is complete (or was completed before the state was
        // persisted): prove it instead of trusting a stale size. A corrupted
        // archive is deleted and re-downloaded, like after any failed check.
        try {
          await verifyGzipFile(dest);
        } catch (error) {
          rmSync(dest, { force: true });
          const message = (error as Error)?.message || 'gzip integrity check failed';
          failures += 1;
          stagnant = failures;
          if (failures > retries || stagnant > maxStagnant) {
            throw new Error(`Архив повредился при скачивании (${message}) и повтор не помог`);
          }
          log(`Архив не прошёл проверку целостности (${message}) — удаляю и скачиваю заново`);
          await sleep(DUMP_BACKOFF_MS[Math.min(failures - 1, DUMP_BACKOFF_MS.length - 1)]);
          continue;
        }
      }
      return { path: dest, bytes: offset, total: total ?? offset };
    }

    let startOffset = offset;
    if (response.status === 206) {
      // The server honoured the Range.
    } else if (response.status === 200) {
      // The server ignored Range: the partial file is stale, start over.
      if (offset > 0) log('Сервер не поддержал Range — начинаю скачивание заново');
      startOffset = 0;
    } else if (response.status >= 500) {
      failures += 1;
      stagnant += 1; // nothing arrived
      if (failures > retries || stagnant > maxStagnant) {
        throw new Error(`Скачивание не удалось: HTTP ${response.status} ${response.statusText} (${options.url})`);
      }
      log(`HTTP ${response.status} (попытка ${failures}${retries < Infinity ? `/${retries}` : ''}) — повтор`);
      await response.body?.cancel().catch(() => undefined);
      await sleep(DUMP_BACKOFF_MS[Math.min(failures - 1, DUMP_BACKOFF_MS.length - 1)]);
      continue;
    } else {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Download failed: HTTP ${response.status} ${response.statusText} (${options.url})`);
    }

    const rangeTotal = parseContentRangeTotal(response.headers.get('content-range'));
    const lengthHeader = Number(response.headers.get('content-length'));
    let total = rangeTotal ?? (Number.isFinite(lengthHeader) && lengthHeader > 0 ? lengthHeader : null);

    if (startOffset > 0 && total != null && total < startOffset) {
      // The upstream file shrank (today's dump is smaller): the partial is stale.
      log('Файл на сервере изменился (стал меньше) — начинаю скачивание заново');
      startOffset = 0;
    }

  const reportProgress = (info: DumpDownloadInfo): Promise<void> => {
    try {
      return Promise.resolve(options.onProgress?.(info)).catch(() => undefined);
    } catch {
      // A progress sink must never kill the download itself.
      return Promise.resolve();
    }
  };

  let received = 0;
  let lastReport = 0;
  const counter = new Transform({
    transform(chunk, _encoding, done) {
      received += chunk.length;
      const at = Date.now();
      if (options.onProgress && at - lastReport >= progressIntervalMs) {
        lastReport = at;
        void reportProgress({ received: startOffset + received, total, resuming: startOffset > 0, failures });
      }
      done(null, chunk);
    },
  });
  const writeStream = createWriteStream(dest, { flags: startOffset > 0 ? 'a' : 'w' });

  try {
    if (!response.body) throw new Error('Dump response has no body');
    await pipeline(Readable.fromWeb(response.body as unknown as WebReadableStream), counter, writeStream);
    if (options.onProgress) {
      await reportProgress({ received: startOffset + received, total, resuming: startOffset > 0, failures: 0 });
    }
  } catch (error) {
      if (options.signal?.aborted) throw new Error('Download aborted');
      const message = networkErrorMessage(error, 'connection dropped');
      failures += 1;
      const size = safeSize(dest);
      // Bytes between attempts mean the line works despite the drops.
      stagnant = size > startOffset ? 0 : stagnant + 1;
      if (failures > retries || stagnant > maxStagnant) {
        throw new Error(
          `Скачивание не удалось после ${failures} обрыва(ов) подряд: ${message} ` +
            `(на диске ${size.toLocaleString()} байт — повтор продолжит с этого места)`,
        );
      }
      log(`Соединение прервано на байте ${size.toLocaleString()} (${message}) — продолжаю с этого места`);
      await sleep(DUMP_BACKOFF_MS[Math.min(failures - 1, DUMP_BACKOFF_MS.length - 1)]);
      continue;
    }

    failures = 0;
    const finalSize = safeSize(dest);
    if (total != null && finalSize !== total) {
      // Clean EOF short of the announced total: the transfer ended early.
      failures += 1;
      stagnant = finalSize > startOffset ? 0 : stagnant + 1;
      if (failures > retries || stagnant > maxStagnant) {
        throw new Error(`Скачивание не удалось: файл оборвался на ${finalSize.toLocaleString()} из ${total.toLocaleString()} байт`);
      }
      log(`Файл оборвался на ${finalSize.toLocaleString()} из ${total.toLocaleString()} байт — докачиваю`);
      await sleep(DUMP_BACKOFF_MS[Math.min(failures - 1, DUMP_BACKOFF_MS.length - 1)]);
      continue;
    }

    if (options.verify !== false && dest.toLowerCase().endsWith('.gz')) {
      try {
        await verifyGzipFile(dest);
      } catch (error) {
        rmSync(dest, { force: true });
        failures += 1;
        stagnant = failures; // the file was deleted: no usable bytes remain
        const message = (error as Error)?.message || 'gzip integrity check failed';
        if (failures > retries || stagnant > maxStagnant) {
          throw new Error(`Архив повредился при скачивании (${message}) и повтор не помог`);
        }
        log(`Архив не прошёл проверку целостности (${message}) — удаляю и скачиваю заново`);
        await sleep(DUMP_BACKOFF_MS[Math.min(failures - 1, DUMP_BACKOFF_MS.length - 1)]);
        continue;
      }
    }

    log(`Архив на диске: ${finalSize.toLocaleString()} байт`);
    return { path: dest, bytes: finalSize, total: total ?? finalSize };
  }
}
export const GALAXY_TABLE = 'galaxy_systems';
/** Bucket limit set by migration 20260924000000_galaxy_systems_finish.sql. */
export const POINTS_UPLOAD_LIMIT = 50 * 1024 * 1024;
export const GALAXY_META_TABLE = 'galaxy_systems_meta';

/** Rows per statement. 2000 × 13 columns stays far below any parameter/size cap. */
export const PG_BATCH_SIZE = 2000;
/**
 * Rows per PostgREST upsert (the script's default for the HTTP path).
 *
 * Deliberately small: Supabase cancels every PostgREST statement after a few
 * seconds (`statement_timeout`, SQLSTATE 57014), and a 1000-row upsert against
 * seven indexes — including the GIN trigram on `name_lc` — stops fitting once
 * the table grows. A batch that still times out is split in halves and retried
 * (see `upsertSupabaseChunk`), so a smaller start only costs extra round-trips,
 * never correctness.
 */
export const SUPABASE_BATCH_SIZE = 200;
/**
 * Initial builder allocation for an UNSAMPLED cloud.
 *
 * The real catalog is ~2×10⁸ systems (Spansh `systems.json.gz`, 5.9 GiB), so an
 * unsampled cloud is never allocated: `galaxyPointsMax()` caps it and the
 * builder samples. This value only sizes the first allocation.
 */
export const POINTS_CAPACITY = 1_400_000;
export type GalaxyImportBackend = 'pg' | 'supabase';

// ────────────────────────── row writers ──────────────────────────

export interface GalaxyRowWriter {
  readonly backend: GalaxyImportBackend;
  /** Rows handed to the database so far (flushed batches only). */
  readonly written: number;
  add(row: GalaxySystemRecord): Promise<void>;
  flush(): Promise<number>;
  /** Authoritative row count of `galaxy_systems`. */
  countRows(): Promise<number>;
  /** Read the whole table back as map points, `ORDER BY id`. */
  readPoints(onPoint: (point: GalaxySystemPoint) => void): Promise<number>;
  /** Refresh planner statistics after a bulk load (direct Postgres only). */
  analyze?(): Promise<void>;
  close(): Promise<void>;
}

export function pgLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return `'${String(value).replace(/'/g, "''")}'`;
}

export const GALAXY_ROW_COLUMNS = [
  'id64', 'name', 'name_lc', 'x', 'y', 'z', 'main_star', 'star_type',
  'star_giant_class', 'needs_permit', 'distance_from_sols', 'distance_from_sgra', 'updated_at',
] as const;

/**
 * Later dump row replaces the one already chosen when timestamps tie or are
 * missing. A parsed `updated_at` wins only when both sides have one and they
 * differ — that is the fresher catalog snapshot.
 */
export function galaxyRowSupersedes(candidate: GalaxySystemRecord, incumbent: GalaxySystemRecord): boolean {
  const next = Date.parse(candidate.updated_at ?? '');
  const prev = Date.parse(incumbent.updated_at ?? '');
  if (Number.isFinite(next) && Number.isFinite(prev) && next !== prev) return next > prev;
  return true;
}

/**
 * One `INSERT … ON CONFLICT DO UPDATE` cannot touch the same row twice.
 * Postgres raises `ON CONFLICT DO UPDATE command cannot affect row a second
 * time` (21000) when a batch contains two `name_lc` values, and the second
 * unique index (`id64`) then fails the statement with 23505 if those rows
 * differ only by name. The Spansh dump does contain such repeats (renames,
 * whitespace/case variants that collapse under `normalizeSystemName`).
 *
 * Keep one row per `name_lc` and one per `id64`. Order of the survivors follows
 * the first time their name was seen, so two builds of the same batch match.
 */
export function collapseGalaxyBatch(rows: GalaxySystemRecord[]): GalaxySystemRecord[] {
  if (rows.length < 2) return rows.slice();

  const byName = new Map<string, GalaxySystemRecord>();
  for (const row of rows) {
    const prev = byName.get(row.name_lc);
    if (!prev || galaxyRowSupersedes(row, prev)) byName.set(row.name_lc, row);
  }

  const byId = new Map<string, GalaxySystemRecord>();
  const dropped = new Set<string>();
  for (const row of byName.values()) {
    const prev = byId.get(row.id64);
    if (!prev) {
      byId.set(row.id64, row);
      continue;
    }
    if (galaxyRowSupersedes(row, prev)) {
      dropped.add(prev.name_lc);
      byId.set(row.id64, row);
    } else {
      dropped.add(row.name_lc);
    }
  }

  const out: GalaxySystemRecord[] = [];
  const emitted = new Set<string>();
  for (const row of rows) {
    if (dropped.has(row.name_lc) || emitted.has(row.name_lc)) continue;
    const kept = byName.get(row.name_lc);
    if (!kept || byId.get(kept.id64) !== kept) continue;
    out.push(kept);
    emitted.add(kept.name_lc);
  }
  return out;
}

interface DbErrorLike {
  code?: string;
  message?: string;
}

function asDbError(error: unknown): DbErrorLike {
  if (error && typeof error === 'object') {
    const record = error as { code?: unknown; message?: unknown };
    return {
      code: typeof record.code === 'string' ? record.code : undefined,
      message: typeof record.message === 'string' ? record.message : String(error),
    };
  }
  return { message: String(error) };
}

/** Postgres 21000: the same conflict key appears twice in one upsert. */
export function isGalaxyCardinalityViolation(error: unknown): boolean {
  const failure = asDbError(error);
  return failure.code === '21000' || /cannot affect row a second time/i.test(failure.message || '');
}

/** Postgres 23505: the other unique index (`id64` or `name_lc`) already holds the value. */
export function isGalaxyUniqueViolation(error: unknown): boolean {
  const failure = asDbError(error);
  return failure.code === '23505' || /duplicate key value violates unique constraint/i.test(failure.message || '');
}

/**
 * Postgres 57014: the statement ran into `statement_timeout`
 * («canceling statement due to statement timeout»).
 *
 * Supabase caps every PostgREST statement at a few seconds, so on a large
 * catalog a full batch periodically does not fit. This is transient: the same
 * rows in smaller chunks go through — see `deliveryImport.ts`, which retries
 * the same failure by halving the batch.
 */
export function isGalaxyStatementTimeout(error: unknown): boolean {
  const failure = asDbError(error);
  if (failure.code === '57014') return true;
  return /canceling statement due to statement timeout|statement timeout/i.test(failure.message || '');
}

/** `INSERT … ON CONFLICT (name_lc) DO UPDATE` for a whole batch (no parameters). */
export function pgInsertSql(rows: GalaxySystemRecord[]): string {
  const batch = collapseGalaxyBatch(rows);
  if (batch.length === 0) throw new Error('pgInsertSql: empty batch');
  const values = batch
    .map((row) => `(${GALAXY_ROW_COLUMNS.map((column) => pgLiteral(row[column])).join(',')})`)
    .join(',');
  return (
    `INSERT INTO ${GALAXY_TABLE} (${GALAXY_ROW_COLUMNS.join(',')}) VALUES ${values} ` +
    `ON CONFLICT (name_lc) DO UPDATE SET ` +
    GALAXY_ROW_COLUMNS.filter((column) => column !== 'name_lc')
      .map((column) => `${column} = EXCLUDED.${column}`)
      .join(', ')
  );
}

/**
 * Remove stored rows that would block this batch on either unique index.
 * Run inside the same transaction as the following insert: a resumed import
 * skips records it believes are already stored, so a delete must not commit
 * unless the replacement insert commits too.
 */
export function pgDeleteConflictsSql(rows: GalaxySystemRecord[]): string {
  const batch = collapseGalaxyBatch(rows);
  if (batch.length === 0) throw new Error('pgDeleteConflictsSql: empty batch');
  const names = batch.map((row) => pgLiteral(row.name_lc)).join(',');
  const ids = batch.map((row) => pgLiteral(row.id64)).join(',');
  return `DELETE FROM ${GALAXY_TABLE} WHERE name_lc IN (${names}) OR id64 IN (${ids})`;
}

async function rollbackQuietly(query: (sql: string) => Promise<unknown>): Promise<void> {
  try {
    await query('ROLLBACK');
  } catch {
    // The connection may already be dead. The original error is the one to surface.
  }
}

/**
 * Write one batch through a direct Postgres connection.
 *
 * Duplicate keys inside the batch are collapsed first (that is the admin-panel
 * failure: PostgREST and this SQL both raise 21000). A unique violation against
 * a row already stored under the other key is reconciled in a transaction.
 * A cardinality error that somehow survives the collapse — or a statement the
 * server cancelled on `statement_timeout` — is retried on halves, down to a
 * single row, instead of aborting the whole catalog download.
 */
export async function writeGalaxyRowsPg(
  query: (sql: string) => Promise<unknown>,
  rows: GalaxySystemRecord[],
): Promise<number> {
  const batch = collapseGalaxyBatch(rows);
  if (batch.length === 0) return 0;
  await insertPgChunk(query, batch);
  return batch.length;
}

async function insertPgChunk(
  query: (sql: string) => Promise<unknown>,
  rows: GalaxySystemRecord[],
): Promise<void> {
  try {
    await query(pgInsertSql(rows));
    return;
  } catch (error) {
    // The direct writer sets `statement_timeout: 0`, but a server-side setting
    // (or a pooler in front of Postgres) can still cancel a huge statement —
    // halve it like the transient Supabase failure instead of dying on it.
    if (
      rows.length > 1 &&
      (isGalaxyCardinalityViolation(error) || isGalaxyStatementTimeout(error))
    ) {
      const middle = Math.floor(rows.length / 2);
      await insertPgChunk(query, rows.slice(0, middle));
      await insertPgChunk(query, rows.slice(middle));
      return;
    }
    if (!isGalaxyUniqueViolation(error)) throw error;
  }

  await query('BEGIN');
  try {
    await query(pgDeleteConflictsSql(rows));
    await query(pgInsertSql(rows));
    await query('COMMIT');
  } catch (error) {
    await rollbackQuietly(query);
    throw error;
  }
}

interface ConflictRow {
  id: number;
  id64: string;
  name: string;
  name_lc: string;
}

interface GalaxyWriteError {
  message: string;
  code?: string;
}

/**
 * The slice of a Supabase client the catalog writer uses. Kept narrow so the
 * CLI script and the tests can stand in for PostgREST without the SDK.
 */
export interface GalaxyWriteClient {
  from(table: string): {
    upsert(
      values: unknown,
      options: { onConflict: string },
    ): PromiseLike<{ error: GalaxyWriteError | null }>;
    select(columns: string): {
      eq(column: string, value: string): {
        maybeSingle(): PromiseLike<{ data: ConflictRow | null; error: GalaxyWriteError | null }>;
      };
    };
    update(values: unknown): {
      eq(column: string, value: number | string): PromiseLike<{ error: GalaxyWriteError | null }>;
    };
    delete(): {
      eq(column: string, value: number | string): PromiseLike<{ error: GalaxyWriteError | null }>;
    };
  };
}

function upsertFailure(error: GalaxyWriteError, row?: GalaxySystemRecord): Error {
  const where = row ? ` (${row.name_lc} / ${row.id64})` : '';
  return new Error(`supabase upsert failed: ${error.message}${where}`);
}

export interface GalaxySupabaseWriteOptions {
  /**
   * How many times a single-row batch cancelled by `statement_timeout` is
   * retried with backoff before the import fails (default 3). Multi-row
   * batches are halved instead, so this only bounds the last-resort loop.
   */
  timeoutRetries?: number;
  /** Injectable sleep for the retry backoff (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
}

/** Single-row statement-timeout retries after the first failure. */
export const SUPABASE_TIMEOUT_RETRIES = 3;
/** Backoff between those retries; a loaded database needs seconds, not ms. */
const SUPABASE_TIMEOUT_BACKOFF_MS = [1000, 2000, 4000];

const defaultSleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Write one batch through PostgREST — the path the admin tab uses when the
 * web process has no `DATABASE_URL`.
 *
 * Same rules as {@link writeGalaxyRowsPg}: collapse duplicates before the
 * upsert (otherwise the browser-started import dies on the first repeated
 * system), then split a batch Postgres still rejects, and finally reconcile a
 * single row whose `id64` is already stored under another name.
 *
 * A batch cancelled by `statement_timeout` (SQLSTATE 57014 — Supabase gives
 * every PostgREST statement only a few seconds) is halved and retried like a
 * rejected one; a lone row that still does not fit is retried with backoff.
 * Without this the admin-panel import died on the first slow upsert with
 * «supabase upsert failed: canceling statement due to statement timeout».
 */
export async function writeGalaxyRowsSupabase(
  client: GalaxyWriteClient,
  rows: GalaxySystemRecord[],
  options: GalaxySupabaseWriteOptions = {},
): Promise<number> {
  const batch = collapseGalaxyBatch(rows);
  if (batch.length === 0) return 0;
  await upsertSupabaseChunk(client, batch, options, 0);
  return batch.length;
}

async function upsertSupabaseChunk(
  client: GalaxyWriteClient,
  rows: GalaxySystemRecord[],
  options: GalaxySupabaseWriteOptions,
  attempt: number,
): Promise<void> {
  const { error } = await client
    .from(GALAXY_TABLE)
    .upsert(rows as unknown as Record<string, unknown>[], { onConflict: 'name_lc' });
  if (!error) return;
  if (
    rows.length > 1 &&
    (isGalaxyCardinalityViolation(error) || isGalaxyUniqueViolation(error) || isGalaxyStatementTimeout(error))
  ) {
    const middle = Math.floor(rows.length / 2);
    await upsertSupabaseChunk(client, rows.slice(0, middle), options, 0);
    await upsertSupabaseChunk(client, rows.slice(middle), options, 0);
    return;
  }
  if (rows.length === 1 && isGalaxyUniqueViolation(error)) {
    await reconcileGalaxyRow(client, rows[0]);
    return;
  }
  if (isGalaxyStatementTimeout(error)) {
    const retries = Math.max(0, Math.floor(options.timeoutRetries ?? SUPABASE_TIMEOUT_RETRIES));
    if (attempt < retries) {
      const backoff = SUPABASE_TIMEOUT_BACKOFF_MS[Math.min(attempt, SUPABASE_TIMEOUT_BACKOFF_MS.length - 1)];
      console.error(
        `[galaxy-import] statement timeout on ${rows.length} row(s), retry ${attempt + 1}/${retries} after ${backoff} ms`,
      );
      await (options.sleep ?? defaultSleep)(backoff);
      await upsertSupabaseChunk(client, rows, options, attempt + 1);
      return;
    }
  }
  throw upsertFailure(error, rows.length === 1 ? rows[0] : undefined);
}

/**
 * A single row lost the upsert because the other unique index already holds
 * `id64` or `name_lc`. Update the id64 row in place (it is the physical
 * system) after moving a stale name occupant out of the way. The name occupant
 * is restored if that update fails, so a resumed import — which will not
 * rewrite records it already skipped — does not lose the only copy.
 */
async function reconcileGalaxyRow(client: GalaxyWriteClient, row: GalaxySystemRecord): Promise<void> {
  const table = () => client.from(GALAXY_TABLE);
  const byId = await table().select('id,id64,name,name_lc').eq('id64', row.id64).maybeSingle();
  if (byId.error) throw upsertFailure(byId.error, row);
  const byName = await table().select('id,id64,name,name_lc').eq('name_lc', row.name_lc).maybeSingle();
  if (byName.error) throw upsertFailure(byName.error, row);

  const idRow = byId.data;
  const nameRow = byName.data;
  const nameIsOther = Boolean(nameRow && (!idRow || nameRow.id !== idRow.id));

  if (nameIsOther && nameRow) {
    const tombstone = `__edrc_replaced_${nameRow.id}__`;
    const renamed = await table().update({ name: tombstone, name_lc: tombstone }).eq('id', nameRow.id);
    if (renamed.error) throw upsertFailure(renamed.error, row);
  }

  try {
    if (idRow) {
      const updated = await table().update(row).eq('id', idRow.id);
      if (updated.error) throw upsertFailure(updated.error, row);
    } else {
      const inserted = await table().upsert([row], { onConflict: 'name_lc' });
      if (inserted.error) throw upsertFailure(inserted.error, row);
    }
  } catch (error) {
    if (nameIsOther && nameRow) {
      await table().update({ name: nameRow.name, name_lc: nameRow.name_lc }).eq('id', nameRow.id);
    }
    throw error;
  }

  if (nameIsOther && nameRow) {
    const removed = await table().delete().eq('id', nameRow.id);
    if (removed.error) {
      // The canonical row already has the new data. A leftover tombstone must
      // not fail the import; the next full pass does not look it up by name.
      console.error(`[galaxy-import] could not delete replaced row ${nameRow.id}: ${removed.error.message}`);
    }
  }
}

function starTypeOf(value: unknown): StarClass {
  return typeof value === 'string' && value ? (value as StarClass) : 'unknown';
}

/**
 * Direct Postgres writer: the fast path when the web process knows
 * `DATABASE_URL`/`SUPABASE_DB_URL` (self-hosted Supabase on the same machine).
 *
 * The connection itself goes through `connectPgClient`: a Docker DNS hiccup
 * (`getaddrinfo EAI_AGAIN …`) or a database still starting up is retried, and a
 * permanent failure surfaces as an actionable sentence instead of a bare errno.
 */
export async function createPgWriter(
  connectionString: string,
  options: {
    pg?: PgModule;
    batchSize?: number;
    truncate?: boolean;
    /** Connection attempts (default: see `PG_CONNECT_BACKOFF_MS`). */
    attempts?: number;
    /** Injectable sleep for tests. */
    sleep?: (ms: number) => Promise<void>;
    /** Where retry lines go (the import log). */
    log?: (line: string) => void;
  } = {},
): Promise<GalaxyRowWriter> {
  const pg = options.pg ?? (await loadPg());
  const batchSize = Math.max(1, options.batchSize ?? PG_BATCH_SIZE);
  // Big batches must not die on a server-wide statement_timeout, but a dead
  // database must fail in seconds instead of on the OS TCP timeout.
  const client: PgClientLike = await connectPgClient({
    connectionString,
    pg,
    statementTimeoutMs: 0,
    queryTimeoutMs: 0,
    connectionTimeoutMillis: 15_000,
    attempts: options.attempts,
    sleep: options.sleep,
    log: options.log,
  });
  // A bulk import must not fsync WAL on every commit: the job is resumable and
  // idempotent, so losing the last few commits to a crash costs nothing, while
  // synchronous_commit costs a disk flush per batch (~2× the whole import).
  await client.query('SET synchronous_commit = OFF').catch(() => undefined);
  let rows: GalaxySystemRecord[] = [];
  let written = 0;

  if (options.truncate) {
    await client.query(`TRUNCATE ${GALAXY_TABLE} RESTART IDENTITY`);
  }

  const streamQuery = (sql: string, onRow: (row: Record<string, unknown>) => void): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const query = new pg.Query(sql);
      query.on('row', onRow);
      query.on('error', reject);
      query.on('end', () => resolve());
      // A streaming query keeps 10⁸ rows out of memory.
      void client.query(query as never);
    });

  const flush = async (): Promise<number> => {
    if (rows.length === 0) return 0;
    const batch = rows;
    rows = [];
    const count = await writeGalaxyRowsPg((sql) => client.query(sql), batch);
    written += count;
    return count;
  };

  return {
    backend: 'pg',
    get written() {
      return written;
    },
    async add(row) {
      rows.push(row);
      if (rows.length >= batchSize) await flush();
    },
    flush,
    async countRows() {
      const result = await client.query(`SELECT COUNT(*)::bigint AS n FROM ${GALAXY_TABLE}`);
      return Number(result.rows[0]?.n ?? 0);
    },
    async readPoints(onPoint) {
      let count = 0;
      await streamQuery(`SELECT id64, x, y, z, star_type FROM ${GALAXY_TABLE} ORDER BY id`, (row) => {
        count++;
        onPoint({
          x: Number(row.x),
          y: Number(row.y),
          z: Number(row.z),
          id64: String(row.id64 ?? ''),
          starType: starTypeOf(row.star_type),
        });
      });
      return count;
    },
    async analyze() {
      // After 10⁸ upserts the planner's row estimates are stale: without this
      // the atlas cube/KNN queries keep choosing the plan of an empty table.
      await client.query(`ANALYZE ${GALAXY_TABLE}`);
    },
    async close() {
      rows = [];
      await client.end().catch(() => undefined);
    },
  };
}

/** PostgREST writer: works with nothing but the service-role key. */
export function createSupabaseWriter(
  client: SupabaseClient,
  options: { batchSize?: number } & GalaxySupabaseWriteOptions = {},
): GalaxyRowWriter {
  const batchSize = Math.max(1, options.batchSize ?? SUPABASE_BATCH_SIZE);
  const writeOptions: GalaxySupabaseWriteOptions = { timeoutRetries: options.timeoutRetries, sleep: options.sleep };
  let rows: GalaxySystemRecord[] = [];
  let written = 0;

  const flush = async (): Promise<number> => {
    if (rows.length === 0) return 0;
    const batch = rows;
    rows = [];
    // The admin tab hits this writer whenever the web process has no direct
    // Postgres URL. A repeated system name in the batch is a hard Postgres
    // error ("cannot affect row a second time"), not a conflict update — and a
    // slow batch is cancelled by `statement_timeout`, hence the halve-and-retry
    // inside `writeGalaxyRowsSupabase`.
    const count = await writeGalaxyRowsSupabase(client as unknown as GalaxyWriteClient, batch, writeOptions);
    written += count;
    return count;
  };

  return {
    backend: 'supabase',
    get written() {
      return written;
    },
    async add(row) {
      rows.push(row);
      if (rows.length >= batchSize) await flush();
    },
    flush,
    async countRows() {
      const { count, error } = await client
        .from(GALAXY_TABLE)
        .select('id', { count: 'exact', head: true });
      if (error) throw new Error(`count failed: ${error.message}`);
      return Number(count ?? written);
    },
    async readPoints(onPoint) {
      let count = 0;
      let lastId = 0;
      let pageSize = 5000;
      for (;;) {
        const { data, error } = await client
          .from(GALAXY_TABLE)
          .select('id,id64,x,y,z,star_type')
          .gt('id', lastId)
          .order('id', { ascending: true })
          .limit(pageSize);
        if (error) throw new Error(`points page after id ${lastId} failed: ${error.message}`);
        const pageRows = (data ?? []) as Array<{ id: number; id64: string; x: number; y: number; z: number; star_type: string | null }>;
        if (pageRows.length === 0) break;
        for (const row of pageRows) {
          count++;
          onPoint({
            x: Number(row.x),
            y: Number(row.y),
            z: Number(row.z),
            id64: String(row.id64 ?? ''),
            starType: starTypeOf(row.star_type),
          });
        }
        lastId = Number(pageRows[pageRows.length - 1].id);
        if (pageRows.length < pageSize) {
          // PostgREST may cap rows per response (db-max-rows): keep that page
          // size instead of mistaking the cap for the end of the table.
          pageSize = pageRows.length;
        }
      }
      return count;
    },
    async close() {
      rows = [];
    },
  };
}

export interface PointCloud {
  buffer: Buffer;
  /** Points in the file. */
  count: number;
  /** Table rows the cloud was built from. */
  rows: number;
  /** Source rows per stored point (1 = the cloud is complete). */
  stride: number;
}

/** Point cloud straight from Postgres (used when no file/storage object exists). */
export async function readPointsFromPg(
  connectionString: string,
  options: { pg?: PgModule; maxPoints?: number } = {},
): Promise<PointCloud> {
  const writer = await createPgWriter(connectionString, { pg: options.pg });
  try {
    return await collectPoints(writer, options.maxPoints ?? galaxyPointsMax());
  } finally {
    await writer.close();
  }
}

/** Point cloud over PostgREST, keyset-paged and verified against COUNT(*). */
export async function readPointsFromSupabase(
  client: SupabaseClient,
  options: { maxPoints?: number } = {},
): Promise<PointCloud> {
  const writer = createSupabaseWriter(client);
  const { count: total, error } = await client
    .from(GALAXY_TABLE)
    .select('id', { count: 'exact', head: true });
  if (error) throw new Error(`count failed: ${error.message}`);
  const expected = Number(total ?? 0);
  if (expected === 0) throw new Error(`${GALAXY_TABLE} is empty`);
  const cloud = await collectPoints(writer, options.maxPoints ?? galaxyPointsMax());
  // The old chunked builder was silently truncated by the API row cap. Refuse
  // to serve a partial cloud instead: the map would look complete but lie.
  // Sampling is fine — every row was still read, only some were kept.
  if (cloud.rows < expected) {
    throw new Error(`point cloud is truncated: ${cloud.rows} of ${expected} rows`);
  }
  return cloud;
}

async function collectPoints(writer: GalaxyRowWriter, maxPoints: number): Promise<PointCloud> {
  const builder = new PointsBuilder(POINTS_CAPACITY, maxPoints);
  const rows = await writer.readPoints((point) => builder.add(point));
  if (builder.size === 0) throw new Error('no rows to build the point cloud from');
  return { buffer: Buffer.from(builder.build()), count: builder.size, rows, stride: builder.sampleStride };
}

// ────────────────────────── the pipeline ──────────────────────────

export interface GalaxyImportSnapshot {
  /** Compressed bytes downloaded in this pass. */
  bytesDone: number;
  /** Total compressed size, when the server sent Content-Length. */
  bytesTotal: number | null;
  /**
   * Restart point in UNCOMPRESSED bytes: records that ended before it are
   * already in the table and are skipped by the next pass.
   */
  resumeOffset: number;
  processed: number;
  written: number;
  invalid: number;
  /** Records skipped by a resumed pass because they were already stored. */
  skipped: number;
  /** Rows per second since the run started. */
  rate: number;
  elapsedMs: number;
}

export interface GalaxyImportRunOptions {
  url?: string;
  /**
   * Local dump file (`.gz` or `.json`) to import from disk instead of
   * downloading. The resume point still applies: a resumed pass re-reads the
   * file and skips the records before it — from disk, not the network.
   */
  file?: string;
  writer: GalaxyRowWriter;
  /**
   * Uncompressed byte offset to continue from (0 = import everything).
   *
   * The dump is gzip, so an HTTP `Range` restart would hand gunzip a stream
   * beginning mid-deflate, which cannot be decoded. A resumed pass therefore
   * re-downloads and re-decompresses the dump but SKIPS every record ending
   * before this offset — those rows are stored already, and the expensive part
   * (hundreds of millions of upserts) is not repeated.
   */
  resumeFrom?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  log?: (line: string) => void;
  now?: () => number;
  onProgress?: (snapshot: GalaxyImportSnapshot) => void | Promise<void>;
  progressIntervalMs?: number;
  /** Build the map point cloud while streaming (default true). */
  buildPoints?: boolean;
  /** Cloud size cap (default `galaxyPointsMax()`; 0 = one point per system). */
  maxPoints?: number;
}

export interface GalaxyImportRunResult {
  processed: number;
  invalid: number;
  skipped: number;
  written: number;
  /** Rows in the table after the run (authoritative). */
  systemsCount: number;
  bytesDone: number;
  bytesTotal: number | null;
  resumedFrom: number;
  durationMs: number;
  points: {
    buffer: Buffer;
    count: number;
    /** Table rows the cloud was built from. */
    rows: number;
    /** Source rows per stored point (1 = complete cloud). */
    stride: number;
    rebuiltFromTable: boolean;
  } | null;
}

/** Counts compressed bytes as they are fed to the gunzip stream. */
function byteCounter(): { stream: Transform; counter: { fed: number } } {
  const counter = { fed: 0 };
  const stream = new Transform({
    transform(chunk, _encoding, done) {
      counter.fed += chunk.length;
      done(null, chunk);
    },
  });
  return { stream, counter };
}

/**
 * Run one import pass. The promise resolves when the dump is exhausted; the
 * caller (job/route) decides what to do with the point cloud.
 */
export async function runGalaxyImport(options: GalaxyImportRunOptions): Promise<GalaxyImportRunResult> {
  const log = options.log ?? (() => undefined);
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = options.url ?? galaxyImportUrl();
  const progressIntervalMs = Math.max(1000, options.progressIntervalMs ?? 10_000);
  const startedAt = now();
  const resumeFrom = Math.max(0, Math.floor(options.resumeFrom ?? 0));
  const file = options.file ? resolve(options.file) : null;

  let source: Readable;
  let bytesTotal: number | null;
  if (file) {
    if (!existsSync(file)) throw new Error(`Dump file not found: ${file}`);
    const stat = statSync(file);
    if (stat.size === 0) throw new Error(`Dump file is empty: ${file}`);
    bytesTotal = stat.size;
    source = createReadStream(file);
    log(
      resumeFrom > 0
        ? `Importing from local file ${file} (continuing: records before byte ${resumeFrom.toLocaleString()} of the decompressed dump are stored already)`
        : `Importing from local file ${file} (${formatBytes(stat.size)})`,
    );
  } else {
    log(
      resumeFrom > 0
        ? `Downloading ${url} (continuing: records before byte ${resumeFrom.toLocaleString()} of the decompressed dump are stored already)`
        : `Downloading ${url}`,
    );
    const response = await fetchImpl(url, { signal: options.signal });
    if (!response.ok) {
      throw new Error(`Download failed: HTTP ${response.status} ${response.statusText} (${url})`);
    }
    if (!response.body) throw new Error('Dump response has no body');
    const lengthHeader = Number(response.headers.get('content-length'));
    bytesTotal = Number.isFinite(lengthHeader) && lengthHeader > 0 ? lengthHeader : null;
    source = Readable.fromWeb(response.body as unknown as WebReadableStream);
  }

  const { stream: counterStream, counter } = byteCounter();
  const gunzip = createGunzip();
  const objects = new JsonArrayObjects();
  // `.pipe()` swallows upstream errors (the iterator would hang while gunzip
  // emits an unhandled 'error'), so every stage is wired to tear the whole
  // chain down — including on abort, which must release the connection.
  const teardown = (error?: Error) => {
    for (const stream of [source, counterStream, gunzip, objects]) {
      if (error) stream.destroy(error);
      else stream.destroy();
    }
  };
  for (const stream of [source, counterStream, gunzip]) {
    stream.on('error', (error: Error) => teardown(error));
  }
  const onAbort = () => teardown(new Error('Import aborted'));
  options.signal?.addEventListener('abort', onAbort, { once: true });
  source.pipe(counterStream).pipe(gunzip).pipe(objects);

  // The cloud streams alongside the import and is sampled on the fly, so a
  // 2×10⁸-row catalog never allocates more than `maxPoints` points.
  const maxPoints = Math.max(0, options.maxPoints ?? galaxyPointsMax());
  let streamed = options.buildPoints === false ? null : new PointsBuilder(POINTS_CAPACITY, maxPoints);
  // Rows the streamed cloud saw: with sampling this is not `streamed.size`, and
  // it is what tells a full clean pass from a resumed or duplicate-collapsing one.
  let pointsSeen = 0;
  const writer = options.writer;
  let processed = 0;
  let invalid = 0;
  let skipped = 0;
  let lastProgressAt = 0;
  let lastWrittenSeen = writer.written;
  let resumeOffset = resumeFrom;

  const snapshot = (): GalaxyImportSnapshot => ({
    bytesDone: counter.fed,
    bytesTotal,
    resumeOffset,
    processed,
    written: writer.written,
    invalid,
    skipped,
    rate: processed / Math.max(1, (now() - startedAt) / 1000),
    elapsedMs: now() - startedAt,
  });

  try {
    for await (const object of objects as AsyncIterable<SpanshSystemObject>) {
      // Resumed pass: skip what is stored already. This is lossless because the
      // restart point only ever advances to the chunk a FLUSHED record completed
      // in — every record of an earlier chunk was written before it, and records
      // sharing the chunk are simply written again (upserts are idempotent).
      if (resumeFrom > 0 && (object.__streamOffset ?? 0) < resumeFrom) {
        skipped++;
        continue;
      }
      const row = toGalaxySystemRow(object);
      if (!row) {
        invalid++;
        continue;
      }
      processed++;
      await writer.add(row);
      if (streamed) {
        streamed.add({ x: row.x, y: row.y, z: row.z, id64: row.id64, starType: row.star_type });
        pointsSeen++;
      }
      if (writer.written > lastWrittenSeen) {
        lastWrittenSeen = writer.written;
        resumeOffset = object.__streamOffset ?? resumeOffset;
      }
      const at = now();
      if (at - lastProgressAt >= progressIntervalMs) {
        lastProgressAt = at;
        const progress = snapshot();
        log(
          `  ${progress.processed.toLocaleString()} systems, ${progress.written.toLocaleString()} written` +
          `${progress.skipped ? `, ${progress.skipped.toLocaleString()} skipped` : ''} ` +
          `(${progress.rate.toFixed(0)}/s, ${formatBytes(progress.bytesDone)}${progress.bytesTotal ? ` / ${formatBytes(progress.bytesTotal)}` : ''})`,
        );
        if (options.onProgress) await options.onProgress(progress);
      }
    }
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
    teardown();
  }

  await writer.flush();
  const systemsCount = await writer.countRows();

  let points: GalaxyImportRunResult['points'] = null;
  if (options.buildPoints !== false) {
    if (streamed && resumeFrom === 0 && pointsSeen === systemsCount) {
      points = {
        buffer: Buffer.from(streamed.build()),
        count: streamed.size,
        rows: pointsSeen,
        stride: streamed.sampleStride,
        rebuiltFromTable: false,
      };
    } else {
      // A resumed pass only saw the tail of the dump, and a pass that collapsed
      // duplicate names streamed more points than the table holds. Either way
      // the streamed sample is not the catalog: rebuild it from the table.
      if (streamed) {
        log('Rebuilding the point cloud from the table (resumed, duplicate or incomplete pass)');
        // Release the partial cloud before allocating the full one.
        streamed = null;
      } else {
        log(
          `Облако точек строится из таблицы: каталог ${systemsCount.toLocaleString()} систем, ` +
          `в облако идёт равномерная выборка (лимит ${maxPoints.toLocaleString()} точек)`,
        );
      }
      const rebuilt = new PointsBuilder(Math.max(systemsCount, 1024), maxPoints);
      const read = await writer.readPoints((point) => rebuilt.add(point));
      if (read !== systemsCount) {
        throw new Error(`point cloud is truncated: ${read} of ${systemsCount} rows`);
      }
      if (rebuilt.sampled) {
        log(`Облако точек: ${rebuilt.size.toLocaleString()} точек, каждая ${rebuilt.sampleStride}-я система`);
      }
      points = {
        buffer: Buffer.from(rebuilt.build()),
        count: rebuilt.size,
        rows: read,
        stride: rebuilt.sampleStride,
        rebuiltFromTable: true,
      };
    }
  }

  const durationMs = now() - startedAt;
  // On a full pass the table is exactly this dump, so parsed-minus-rows is the
  // number of repeated names/id64s that were collapsed instead of failing the upsert.
  const collapsed = resumeFrom === 0 ? Math.max(0, processed - systemsCount) : 0;
  log(
    `Import pass done in ${(durationMs / 1000).toFixed(1)} s: ${processed.toLocaleString()} parsed, ` +
    `${skipped.toLocaleString()} skipped, ${invalid} invalid, ${systemsCount.toLocaleString()} rows in the table` +
    (collapsed ? ` (${collapsed.toLocaleString()} duplicate names collapsed)` : ''),
  );
  return {
    processed,
    invalid,
    skipped,
    written: writer.written,
    systemsCount,
    bytesDone: counter.fed,
    bytesTotal,
    resumedFrom: resumeFrom,
    durationMs,
    points,
  };
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 Б';
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** index;
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

/** Which writer this process can build, and why (surfaced in the admin UI). */
export function describeImportBackends(env: NodeJS.ProcessEnv = process.env): {
  backend: GalaxyImportBackend | null;
  dbUrl: boolean;
  supabase: boolean;
} {
  const dbUrl = Boolean(galaxyDbUrl(env));
  // `supabaseAdmin` is built from exactly these two variables — anything else
  // would promise a backend that throws on first use.
  const supabase = Boolean(env.NEXT_PUBLIC_SUPABASE_URL?.trim() && env.SUPABASE_SERVICE_ROLE_KEY?.trim());
  return { backend: dbUrl ? 'pg' : supabase ? 'supabase' : null, dbUrl, supabase };
}

export { POINTS_STORAGE_BUCKET, POINTS_STORAGE_OBJECT };
