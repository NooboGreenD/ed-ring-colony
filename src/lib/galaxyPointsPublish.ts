/**
 * Publishing the galaxy point cloud, separately from building it.
 *
 * Two facts drove this file:
 *
 *  - the cloud is big (tens of megabytes) and the bucket is a network service:
 *    a `503 Service Unavailable` from Storage (the container restarting, Kong
 *    shedding load, a proxy in between) says nothing about the cloud itself.
 *    Before this module a single such answer threw away minutes of reading the
 *    catalog and the map stayed without points, because `points_uploaded` never
 *    got set and every later cold start rebuilt the cloud from scratch;
 *  - the web container already has a big writable disk: the Spansh data
 *    directory (`GALAXY_ARCHIVE_DIR`, a bind mount on its own volume in
 *    docker-compose). A file there costs nothing, survives container
 *    rebuilds, and is what `/api/galaxy/all-systems` serves first.
 *
 * So: write the file to the data disk, then publish to Storage with retries and
 * a backoff, and report which of the two worked. Storage stays the canonical
 * copy (it is what other processes and a rebuilt container read); the disk copy
 * is the reason a Storage hiccup is no longer a failed build.
 */

import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  POINTS_BYTES_PER_POINT,
  POINTS_HEADER_SIZE,
  POINTS_MAGIC,
  POINTS_STORAGE_BUCKET,
  POINTS_STORAGE_OBJECT,
} from './galaxySystems.ts';

/** File name of the cloud in the local cache directory (same object as in Storage). */
export const POINTS_FILE_NAME = POINTS_STORAGE_OBJECT;
/** Sidecar with the build numbers, so a file on disk is more than bytes. */
export const POINTS_META_SUFFIX = '.meta.json';

export type PointsTarget = 'storage' | 'disk' | 'none';

export interface PointsPublishResult {
  /** Where the cloud ended up. `none` = nowhere (both paths failed). */
  target: PointsTarget;
  uploaded: boolean;
  /** Local cache path when the file was written there. */
  path: string | null;
  bytes: number;
  /** Storage attempts (1 = it worked at once). */
  attempts: number;
  /** Last failure, if any — kept for the admin log, not swallowed. */
  error: string | null;
}

// ─────────────────────────── local cache ───────────────────────────

/** Default cache directory: the Spansh data disk, which is mounted writable. */
export function pointsCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.GALAXY_POINTS_DIR?.trim();
  if (explicit) return resolve(explicit);
  const archive = env.GALAXY_ARCHIVE_DIR?.trim() || 'data/spansh';
  return resolve(join(archive, 'points'));
}

export function pointsCachePath(dir: string = pointsCacheDir()): string {
  return join(dir, POINTS_FILE_NAME);
}

/** True when the bytes start with a sane `edgs-v1` header (used to accept a file). */
export function looksLikePointsFile(buffer: Buffer): boolean {
  if (buffer.length < POINTS_HEADER_SIZE + 29) return false;
  if (buffer.subarray(0, 4).toString('ascii') !== POINTS_MAGIC) return false;
  const count = buffer.readUInt32LE(8);
  return count > 0 && POINTS_HEADER_SIZE + count * POINTS_BYTES_PER_POINT <= buffer.length;
}

export function writePointsCache(buffer: Buffer, dir: string = pointsCacheDir(), meta?: Record<string, unknown>): string {
  mkdirSync(dir, { recursive: true });
  const file = pointsCachePath(dir);
  // Temporary file + rename: a reader must never see half a cloud, and the
  // half that survives a crash is the previous one.
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, buffer);
  renameSync(tmp, file);
  try {
    writeFileSync(`${file}${POINTS_META_SUFFIX}`, JSON.stringify({
      format: 'edgs-v1',
      bytes: buffer.length,
      written_at: new Date().toISOString(),
      ...meta,
    }, null, 2));
  } catch {
    // The sidecar is diagnostics only; the cloud itself is what matters.
  }
  return file;
}

/** Cached cloud from disk, or null when absent/unreadable/too small to be real. */
export function readPointsCache(dir: string = pointsCacheDir()): { buffer: Buffer; file: string; mtimeMs: number } | null {
  const file = pointsCachePath(dir);
  try {
    if (!existsSync(file)) return null;
    const buffer = readFileSync(file);
    if (!looksLikePointsFile(buffer)) return null;
    return { buffer, file, mtimeMs: statSync(file).mtimeMs };
  } catch {
    return null;
  }
}

/**
 * What the cache holds, without reading the file: a 60 MB cloud is read by the
 * map, not by a status endpoint that polls every few seconds. `count` comes
 * from the 12-byte header.
 */
export function pointsCacheInfo(
  dir: string = pointsCacheDir(),
): { path: string; bytes: number; mtimeMs: number; count: number; valid: boolean } | null {
  const file = pointsCachePath(dir);
  let handle: number | null = null;
  try {
    if (!existsSync(file)) return null;
    handle = openSync(file, 'r');
    const head = Buffer.alloc(POINTS_HEADER_SIZE);
    if (readSync(handle, head, 0, POINTS_HEADER_SIZE, 0) < POINTS_HEADER_SIZE) return null;
    if (head.subarray(0, 4).toString('ascii') !== POINTS_MAGIC) return null;
    const count = head.readUInt32LE(8);
    const stat = fstatSync(handle);
    return {
      path: file,
      bytes: stat.size,
      mtimeMs: stat.mtimeMs,
      count,
      // A truncated write (crash mid-rename is impossible, but a full disk is
      // not) must not be presented as a usable cloud.
      valid: stat.size >= POINTS_HEADER_SIZE + count * POINTS_BYTES_PER_POINT,
    };
  } catch {
    return null;
  } finally {
    if (handle != null) closeSync(handle);
  }
}

export function dropPointsCache(dir: string = pointsCacheDir()): void {
  try {
    rmSync(pointsCachePath(dir), { force: true });
    rmSync(`${pointsCachePath(dir)}${POINTS_META_SUFFIX}`, { force: true });
  } catch {
    // Nothing to clean.
  }
}

// ─────────────────────────── storage upload ───────────────────────────

/** HTTP answers worth another try: the service was busy, not the file wrong. */
const TRANSIENT_STATUS = new Set(['408', '425', '429', '500', '502', '503', '504', '507', '509']);
const TRANSIENT_MESSAGE =
  /service unavailable|bad gateway|gateway time-?out|too many requests|temporarily unavailable|network error|failed to fetch|fetch failed|socket hang up|timeout|timed out|EAI_AGAIN|ENOTFOUND|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|premature close/i;
/** A rejected body size will never succeed on a retry: say so instead. */
const PERMANENT_MESSAGE = /size exceeds|too large|exceeds maximum|payload too large|413/;

interface StorageErrorLike {
  message?: string;
  statusCode?: string | number;
  error?: unknown;
  originalError?: { message?: string; code?: string; cause?: { message?: string } } | null;
}

function errorText(error: StorageErrorLike | Error | null | undefined): string {
  if (!error) return '';
  const own = (error as StorageErrorLike).message;
  const inner = (error as StorageErrorLike).originalError?.message;
  const cause = (error as StorageErrorLike).originalError?.cause?.message;
  return [own, inner, cause].filter(Boolean).join(' · ') || String(error);
}

export function storageErrorInfo(error: unknown): { message: string; status: string | null; transient: boolean; permanent: boolean } {
  const like = (error ?? {}) as StorageErrorLike;
  const message = errorText(like);
  const rawStatus = like.statusCode != null ? String(like.statusCode) : null;
  // Supabase answers a rejected body size without a code in the error object,
  // but the sentence is unmistakable; treat the text as a second source.
  const status = rawStatus ?? (/HTTP (4|5)\d\d/.exec(message)?.[0]?.replace('HTTP ', '') ?? null);
  const permanent = PERMANENT_MESSAGE.test(message);
  const transient = !permanent && ((status != null && TRANSIENT_STATUS.has(status)) || TRANSIENT_MESSAGE.test(message));
  return { message, status, transient, permanent };
}

export interface PointsUploadOptions {
  admin: SupabaseClient;
  log?: (line: string) => void;
  /** Tries beyond the first one (default 2 = three attempts). */
  retries?: number;
  /** First pause in ms; doubles every attempt (default 2000). */
  backoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
  bucket?: string;
  object?: string;
  /** Refuse an upload that the bucket cannot accept (see `pointsFileLimit`). */
  limitBytes?: number | null;
}

const wait = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/**
 * `upload` with the retries a big blob over a flaky internal network needs.
 *
 * Supabase Storage answers a PUT with the body already consumed, so a retry is
 * a plain repeat: `upsert: true` makes it idempotent, and the file is
 * content-addressed by nothing — but writing the same bytes twice is the same
 * file. Never retried: a body the bucket refuses on size (a permanent 413).
 */
export async function uploadPointsToStorage(
  buffer: Buffer,
  options: PointsUploadOptions,
): Promise<{ uploaded: boolean; attempts: number; error: string | null }> {
  const log = options.log ?? (() => undefined);
  const sleep = options.sleep ?? wait;
  const bucket = options.bucket ?? POINTS_STORAGE_BUCKET;
  const object = options.object ?? POINTS_STORAGE_OBJECT;
  const retries = Math.max(0, Math.min(6, Math.floor(options.retries ?? 2)));
  const backoffMs = Math.max(0, options.backoffMs ?? 2_000);

  if (options.limitBytes != null && options.limitBytes > 0 && buffer.length > options.limitBytes) {
    const message = `файл точек ${formatMegabytes(buffer.length)} больше лимита бакета ${formatMegabytes(options.limitBytes)}`;
    log(`WARNING: ${message} — не загружен`);
    return { uploaded: false, attempts: 0, error: message };
  }

  let lastError: string | null = null;
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      const { error } = await options.admin.storage
        .from(bucket)
        .upload(object, new Uint8Array(buffer), {
          contentType: 'application/octet-stream',
          upsert: true,
        });
      if (!error) {
        if (attempt > 1) log(`файл точек загружен в storage со ${attempt}-й попытки`);
        log(`Файл точек загружен в storage ${bucket}/${object}`);
        return { uploaded: true, attempts: attempt, error: null };
      }
      const info = storageErrorInfo(error);
      lastError = info.status ? `${info.message} (HTTP ${info.status})` : info.message;
      if (!info.transient) {
        log(`WARNING: загрузка файла точек не удалась: ${lastError}`);
        return { uploaded: false, attempts: attempt, error: lastError };
      }
      log(attempt <= retries
        ? `storage ответил ${info.status ?? 'ошибкой'} (${info.message}) — повторяю загрузку через ${Math.round(backoffMs * 2 ** (attempt - 1) / 1000)} с`
        : `storage ответил ${info.status ?? 'ошибкой'} и повторений больше нет: ${info.message}`);
    } catch (error) {
      const info = storageErrorInfo(error);
      lastError = info.message || 'unknown storage error';
      if (!info.transient) {
        log(`WARNING: загрузка файла точек не удалась: ${lastError}`);
        return { uploaded: false, attempts: attempt, error: lastError };
      }
      log(attempt <= retries
        ? `загрузка прервана (${lastError}) — повторяю`
        : `загрузка прервана (${lastError}) — повторений больше нет`);
    }
    if (attempt <= retries) await sleep(backoffMs * 2 ** (attempt - 1));
  }
  log(`WARNING: загрузка файла точек не удалась: ${lastError ?? 'неизвестная ошибка'}`);
  return { uploaded: false, attempts: retries + 1, error: lastError };
}

/**
 * Put one cloud where the map can find it: the data disk first (cheap, always
 * possible), Storage second (canonical, needs the service to be alive).
 */
export async function publishPointCloud(
  buffer: Buffer,
  options: PointsUploadOptions & { cacheDir?: string; meta?: Record<string, unknown>; skipStorage?: boolean },
): Promise<PointsPublishResult> {
  const log = options.log ?? (() => undefined);
  let path: string | null = null;
  try {
    path = writePointsCache(buffer, options.cacheDir, options.meta);
    log(`облако записано в локальный кэш: ${path}`);
  } catch (error) {
    const message = (error as Error)?.message ?? String(error);
    log(`WARNING: локальный кэш недоступен (${message}) — остаётся только storage`);
  }

  if (options.skipStorage) {
    return { target: path ? 'disk' : 'none', uploaded: false, path, bytes: buffer.length, attempts: 0, error: 'загрузка в storage пропущена' };
  }

  const upload = await uploadPointsToStorage(buffer, options);
  if (upload.uploaded) {
    return { target: 'storage', uploaded: true, path, bytes: buffer.length, attempts: upload.attempts, error: null };
  }
  return {
    target: path ? 'disk' : 'none',
    uploaded: false,
    path,
    bytes: buffer.length,
    attempts: upload.attempts,
    error: upload.error,
  };
}

function formatMegabytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 МБ';
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}
