/**
 * Куски (шарды) дампа EDSM `systemsPopulated.json.gz` — так же, как архив
 * каталога систем раскладывается в шарды (`galaxyShards.ts`).
 *
 * Зачем: архив весит ≈0,5 ГБ, и на тонком канале сервера он идёт часами.
 * Раньше запись в базу начиналась только после последнего байта, а обрыв
 * разбора (перезапуск сайта) означал «перечитать и записать всё заново».
 * Теперь:
 *
 *   * **разбивка** читает архив один раз — прямо во время скачивания, ровно до
 *     той границы, до которой файл уже скачан без дыр (`available`), — и
 *     раскладывает населённые системы по маленьким файлам `bgs-00001.ndjson.gz`
 *     (по тысяче систем) с готовыми строками для `bgs_apply_snapshots`
 *     (станции и тела дампа сюда не попадают: от 0,5 ГБ остаются мегабайты);
 *   * **загрузка в базу** идёт по кускам, как только кусок готов; кусок —
 *     единица продолжения: после обрыва записываются только незаписанные куски
 *     той же метки импорта (`runId`), архив повторно не разбирается;
 *   * `manifest.json` рядом с кусками говорит, из какого дампа они (адрес,
 *     размер, Last-Modified/ETag), сколько записей архива уже разобрано и какие
 *     куски уже в базе.
 *
 * Файлы обычные: `zcat bgs-00001.ndjson.gz | head` показывает строки как есть.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { open as openFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { promisify } from 'node:util';
import { createGunzip, gunzip as gunzipCallback, gzip as gzipCallback } from 'node:zlib';

import { snapshotToRpcRow } from './bgs.ts';
import { parseEdsmPopulatedLine, type BgsDumpCounter, type BgsDumpStats } from './bgsDump.ts';

const gzip = promisify(gzipCallback);
const gunzip = promisify(gunzipCallback);

export const BGS_SHARD_VERSION = 1;
export const BGS_SHARD_MANIFEST = 'manifest.json';
/** Систем в куске: ≈1,5 КБ строки на систему — кусок ≈0,3 МБ в gzip. */
export const DEFAULT_BGS_SHARD_SYSTEMS = 1000;
const SHARD_FILE = /^bgs-\d{5}\.ndjson\.gz$/;
const TMP_FILE = /\.tmp-\d+$/;
/** Строка дампа длиннее — это не дамп, а что-то сломанное. */
const MAX_LINE_CHARS = 64 * 1024 * 1024;

export const BGS_SPLIT_ABORTED = 'Разбивка остановлена';

/* ── Какой дамп ────────────────────────────────────────────────────────── */

/** Дамп, которому принадлежат архив и куски: адрес, размер, валидаторы HTTP. */
export interface BgsDumpSource {
  url: string;
  etag: string | null;
  lastModified: string | null;
  total: number | null;
}

function sameDate(a: string, b: string): boolean {
  const left = Date.parse(a);
  const right = Date.parse(b);
  return Number.isFinite(left) && Number.isFinite(right) ? left === right : a.trim() === b.trim();
}

/**
 * Один и тот же дамп? Размер решает сразу; дальше ETag, без него —
 * Last-Modified (как и прежде: у статического файла EDSM они меняются вместе).
 * Без валидаторов совпадение не доказать.
 */
export function sameBgsDumpSource(a: BgsDumpSource | null | undefined, b: BgsDumpSource | null | undefined): boolean {
  if (!a || !b || a.url !== b.url) return false;
  if (a.total != null && b.total != null && a.total !== b.total) return false;
  if (a.etag && b.etag) return a.etag.replace(/^W\//i, '') === b.etag.replace(/^W\//i, '');
  if (a.lastModified && b.lastModified) return sameDate(a.lastModified, b.lastModified);
  return false;
}

function cleanSource(value: unknown): BgsDumpSource | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.url !== 'string' || !raw.url) return null;
  const total = Number(raw.total);
  return {
    url: raw.url,
    etag: typeof raw.etag === 'string' && raw.etag ? raw.etag : null,
    lastModified: typeof raw.lastModified === 'string' && raw.lastModified ? raw.lastModified : null,
    total: Number.isFinite(total) && total > 0 ? Math.round(total) : null,
  };
}

/* ── Манифест ──────────────────────────────────────────────────────────── */

export interface BgsShardEntry {
  file: string;
  systems: number;
  /** Размер файла (gzip). */
  bytes: number;
  /** Кусок записан в базу (с меткой импорта `runId`). */
  imported: boolean;
  applied: number;
  /** Системы куска, у которых наблюдение пилотов свежее дампа. */
  stale: number;
}

export interface BgsShardManifest {
  version: number;
  source: BgsDumpSource;
  /** Метка импорта (`bgs_systems.sync_run`): у продолжения та же. */
  runId: string;
  createdAt: string;
  completedAt: string | null;
  systemsPerShard: number;
  /** Записей архива (включая отброшенные), разложенных по закрытым кускам, — точка продолжения разбивки. */
  recordsRead: number;
  /** Сжатых байт архива, прочитанных к этому моменту (для процента). */
  bytesRead: number;
  systems: number;
  shards: BgsShardEntry[];
  /** Архив разобран до конца. */
  complete: boolean;
  /** Итоги разбора архива (когда `complete`). */
  stats: BgsDumpStats | null;
}

export function bgsShardFileName(index: number): string {
  return `bgs-${String(index).padStart(5, '0')}.ndjson.gz`;
}

export function bgsShardManifestPath(dir: string): string {
  return join(dir, BGS_SHARD_MANIFEST);
}

function count(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

/** Атомарная запись: обрыв посреди записи не оставляет полфайла. */
export function writeFileAtomic(path: string, data: string | Buffer): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

export function createBgsShardManifest(options: {
  source: BgsDumpSource;
  runId: string;
  systemsPerShard?: number;
  now?: number;
}): BgsShardManifest {
  return {
    version: BGS_SHARD_VERSION,
    source: { ...options.source },
    runId: options.runId,
    createdAt: new Date(options.now ?? Date.now()).toISOString(),
    completedAt: null,
    systemsPerShard: Math.max(1, Math.floor(options.systemsPerShard ?? DEFAULT_BGS_SHARD_SYSTEMS)),
    recordsRead: 0,
    bytesRead: 0,
    systems: 0,
    shards: [],
    complete: false,
    stats: null,
  };
}

/** Манифест с диска; всё, что не похоже на наш формат, — «кусков нет». */
export function readBgsShardManifest(dir: string): BgsShardManifest | null {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(bgsShardManifestPath(dir), 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!raw || raw.version !== BGS_SHARD_VERSION || !Array.isArray(raw.shards) || typeof raw.runId !== 'string' || !raw.runId) return null;
  const source = cleanSource(raw.source);
  if (!source) return null;
  const shards: BgsShardEntry[] = [];
  for (const item of raw.shards) {
    const entry = item as Record<string, unknown> | null;
    if (!entry || typeof entry.file !== 'string' || !SHARD_FILE.test(entry.file)) return null;
    shards.push({
      file: entry.file,
      systems: count(entry.systems),
      bytes: count(entry.bytes),
      imported: entry.imported === true,
      applied: count(entry.applied),
      stale: count(entry.stale),
    });
  }
  return {
    version: BGS_SHARD_VERSION,
    source,
    runId: raw.runId,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date(0).toISOString(),
    completedAt: typeof raw.completedAt === 'string' ? raw.completedAt : null,
    systemsPerShard: Math.max(1, count(raw.systemsPerShard) || DEFAULT_BGS_SHARD_SYSTEMS),
    recordsRead: count(raw.recordsRead),
    bytesRead: count(raw.bytesRead),
    systems: shards.reduce((sum, entry) => sum + entry.systems, 0),
    shards,
    complete: raw.complete === true,
    stats: raw.stats && typeof raw.stats === 'object' ? (raw.stats as BgsDumpStats) : null,
  };
}

export function writeBgsShardManifest(dir: string, manifest: BgsShardManifest): void {
  mkdirSync(dir, { recursive: true });
  writeFileAtomic(bgsShardManifestPath(dir), JSON.stringify(manifest, null, 1));
}

/** Удалить все куски и манифест. Возвращает освобождённые байты. */
export function clearBgsShards(dir: string): number {
  if (!existsSync(dir)) return 0;
  let freed = 0;
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!SHARD_FILE.test(name) && name !== BGS_SHARD_MANIFEST && !TMP_FILE.test(name)) continue;
    const path = join(dir, name);
    try {
      freed += statSync(path).size;
    } catch {
      // уже нет
    }
    rmSync(path, { force: true });
  }
  return freed;
}

export interface BgsShardsInfo {
  dir: string;
  /** Есть манифест. */
  exists: boolean;
  /** Архив разобран до конца. */
  complete: boolean;
  shards: number;
  imported: number;
  systems: number;
  importedSystems: number;
  /** Файлов кусков на диске и их объём. */
  files: number;
  bytes: number;
  source: BgsDumpSource | null;
  createdAt: string | null;
  completedAt: string | null;
}

/** Что админка показывает о кусках. */
export function bgsShardsInfo(dir: string): BgsShardsInfo {
  const manifest = readBgsShardManifest(dir);
  let files = 0;
  let bytes = 0;
  try {
    for (const name of readdirSync(dir)) {
      if (!SHARD_FILE.test(name)) continue;
      files += 1;
      bytes += statSync(join(dir, name)).size;
    }
  } catch {
    // каталога ещё нет — нули честны
  }
  const imported = manifest?.shards.filter((entry) => entry.imported) ?? [];
  return {
    dir,
    exists: Boolean(manifest),
    complete: Boolean(manifest?.complete),
    shards: manifest?.shards.length ?? 0,
    imported: imported.length,
    systems: manifest?.systems ?? 0,
    importedSystems: imported.reduce((sum, entry) => sum + entry.systems, 0),
    files,
    bytes,
    source: manifest?.source ?? null,
    createdAt: manifest?.createdAt ?? null,
    completedAt: manifest?.completedAt ?? null,
  };
}

/** Строки одного куска — готовые строки для `bgs_apply_snapshots`. */
export async function readBgsShardRows(file: string): Promise<Record<string, unknown>[]> {
  const body = await gunzip(readFileSync(file));
  const rows: Record<string, unknown>[] = [];
  for (const line of body.toString('utf8').split('\n')) {
    if (!line) continue;
    rows.push(JSON.parse(line) as Record<string, unknown>);
  }
  return rows;
}

/* ── Сигнал «появилось новое» ──────────────────────────────────────────── */

/**
 * Будильник между этапами конвейера: скачивание будит разбивку («байты
 * пришли»), разбивка — загрузку в базу («кусок готов»). Ожидание всегда
 * ограничено `timeoutMs`, поэтому пропущенный сигнал стоит максимум паузу.
 */
export class BgsPulse {
  private waiters: Array<() => void> = [];

  notify(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }

  wait(signal?: AbortSignal, timeoutMs = 1000): Promise<void> {
    return new Promise<void>((resolveWait) => {
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        resolveWait();
      };
      const timer = setTimeout(done, Math.max(1, timeoutMs));
      if (signal?.aborted) {
        done();
        return;
      }
      signal?.addEventListener('abort', done, { once: true });
      this.waiters.push(done);
    });
  }
}

/* ── Чтение архива, который ещё качается ───────────────────────────────── */

export interface GrowingFileOptions {
  /** Сколько байт от начала файла уже можно читать; `null` — файл готов целиком. */
  available: () => number | null;
  /** Подождать новых байт (или паузу). */
  wait: (signal: AbortSignal) => Promise<void>;
  signal: AbortSignal;
  chunkBytes?: number;
  /** Позиция чтения после каждого куска (сжатые байты, для процента). */
  onRead?: (position: number) => void;
  /** Ждём байты (а не читаем) — для подписи «ждёт скачивания». */
  onWaiting?: (waiting: boolean) => void;
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  return reason instanceof Error ? reason : new Error(BGS_SPLIT_ABORTED);
}

/**
 * Файл, который ещё скачивается: читается ровно до границы, за которой могут
 * быть дыры (параллельные части пишутся в заранее выделенный файл), и ждёт,
 * пока граница сдвинется. Готовый файл (`available() === null`) — до конца.
 */
export async function* readGrowingFile(path: string, options: GrowingFileOptions): AsyncGenerator<Buffer> {
  let handle: Awaited<ReturnType<typeof openFile>> | null = null;
  // Файл появляется с первым ответом сервера.
  while (!handle) {
    if (options.signal.aborted) throw abortError(options.signal);
    try {
      handle = await openFile(path, 'r');
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT' || options.available() === null) throw error;
      options.onWaiting?.(true);
      await options.wait(options.signal);
    }
  }
  try {
    const buffer = Buffer.allocUnsafe(Math.max(4096, options.chunkBytes ?? 1 << 20));
    let position = 0;
    let waiting = false;
    for (;;) {
      if (options.signal.aborted) throw abortError(options.signal);
      const limit = options.available();
      const room = limit == null ? buffer.length : Math.min(buffer.length, limit - position);
      if (room > 0) {
        const { bytesRead } = await handle.read(buffer, 0, room, position);
        if (bytesRead > 0) {
          if (waiting) {
            waiting = false;
            options.onWaiting?.(false);
          }
          position += bytesRead;
          options.onRead?.(position);
          yield Buffer.from(buffer.subarray(0, bytesRead));
          continue;
        }
        if (limit == null) return;
      }
      if (!waiting) {
        waiting = true;
        options.onWaiting?.(true);
      }
      await options.wait(options.signal);
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/* ── Разбивка архива на куски ──────────────────────────────────────────── */

export interface BgsSplitProgress {
  /** Сжатых байт архива прочитано. */
  bytesRead: number;
  /** Записей дампа разобрано в этом проходе (с начала файла). */
  records: number;
  systems: number;
  shards: number;
  /** Разбивка догнала скачивание и ждёт новых байт. */
  waiting: boolean;
}

export interface SplitBgsArchiveOptions {
  archive: string;
  dir: string;
  /** Манифест этого дампа (новый или для продолжения) — меняется на месте. */
  manifest: BgsShardManifest;
  /** Счётчик итогов: при продолжении в него попадают и уже разложенные записи. */
  counter: BgsDumpCounter;
  signal: AbortSignal;
  available: () => number | null;
  waitForBytes: (signal: AbortSignal) => Promise<void>;
  onShard?: (entry: BgsShardEntry, manifest: BgsShardManifest) => void | Promise<void>;
  onProgress?: (progress: BgsSplitProgress) => void | Promise<void>;
  progressIntervalMs?: number;
}

/**
 * Прочитать архив (можно — пока он качается) и разложить системы по кускам.
 *
 * Продолжение: gzip нельзя начать с середины, поэтому архив перечитывается с
 * начала, но записи, уже лежащие в кусках (`manifest.recordsRead`), только
 * считаются для итогов — повторно не пишутся.
 */
export async function splitBgsArchive(options: SplitBgsArchiveOptions): Promise<BgsShardManifest> {
  const { archive, dir, manifest, counter, signal } = options;
  mkdirSync(dir, { recursive: true });
  const perShard = Math.max(1, manifest.systemsPerShard);
  const skip = manifest.recordsRead;
  const progressIntervalMs = Math.max(100, options.progressIntervalMs ?? 1000);
  let seen = 0;
  let pending: string[] = [];
  let position = 0;
  let waiting = false;
  let lastProgressAt = 0;

  const snapshot = (): BgsSplitProgress => ({
    bytesRead: position,
    records: seen,
    systems: manifest.systems + pending.length,
    shards: manifest.shards.length,
    waiting,
  });
  const report = async (force = false) => {
    const at = Date.now();
    if (!force && at - lastProgressAt < progressIntervalMs) return;
    lastProgressAt = at;
    if (options.onProgress) await options.onProgress(snapshot());
  };

  const closeShard = async () => {
    if (pending.length === 0) return;
    const file = bgsShardFileName(manifest.shards.length + 1);
    const body = await gzip(Buffer.from(`${pending.join('\n')}\n`, 'utf8'), { level: 6 });
    writeFileAtomic(join(dir, file), body);
    const entry: BgsShardEntry = { file, systems: pending.length, bytes: body.length, imported: false, applied: 0, stale: 0 };
    pending = [];
    manifest.shards.push(entry);
    manifest.systems += entry.systems;
    manifest.recordsRead = seen;
    manifest.bytesRead = position;
    writeBgsShardManifest(dir, manifest);
    if (options.onShard) await options.onShard(entry, manifest);
    await report(true);
  };

  const source = Readable.from(
    readGrowingFile(archive, {
      available: options.available,
      wait: options.waitForBytes,
      signal,
      onRead: (at) => {
        position = at;
      },
      onWaiting: (value) => {
        waiting = value;
        if (value) void report(true);
      },
    }),
  );
  const gunzipStream = createGunzip();
  source.on('error', (error) => gunzipStream.destroy(error));
  source.pipe(gunzipStream);
  const onAbort = () => {
    source.destroy();
    gunzipStream.destroy(abortError(signal));
  };
  if (signal.aborted) onAbort();
  signal.addEventListener('abort', onAbort, { once: true });

  const handleLine = async (rawLine: string) => {
    const parsed = parseEdsmPopulatedLine(rawLine);
    if (parsed.kind === 'empty') return;
    seen += 1;
    counter.add(parsed);
    if (seen <= skip || parsed.kind !== 'system') return;
    pending.push(JSON.stringify(snapshotToRpcRow(parsed.snapshot)));
    if (pending.length >= perShard) await closeShard();
  };

  const decoder = new StringDecoder('utf8');
  let parts: string[] = [];
  let partsLength = 0;
  try {
    for await (const chunk of gunzipStream) {
      const text = decoder.write(chunk as Buffer);
      let start = 0;
      for (;;) {
        const newline = text.indexOf('\n', start);
        if (newline < 0) break;
        const piece = text.slice(start, newline);
        const line = parts.length ? parts.join('') + piece : piece;
        parts = [];
        partsLength = 0;
        await handleLine(line);
        start = newline + 1;
      }
      if (start < text.length) {
        const rest = text.slice(start);
        parts.push(rest);
        partsLength += rest.length;
        if (partsLength > MAX_LINE_CHARS) throw new Error('Строка дампа длиннее 64 МБ — файл не похож на дамп EDSM');
      }
      await report();
    }
    const tail = parts.join('') + decoder.end();
    if (tail.trim()) await handleLine(tail);
  } finally {
    signal.removeEventListener('abort', onAbort);
    source.destroy();
  }
  if (signal.aborted) throw abortError(signal);

  await closeShard();
  manifest.recordsRead = seen;
  manifest.bytesRead = position;
  manifest.complete = true;
  manifest.completedAt = new Date().toISOString();
  manifest.stats = JSON.parse(JSON.stringify(counter.stats)) as BgsDumpStats;
  writeBgsShardManifest(dir, manifest);
  await report(true);
  return manifest;
}
