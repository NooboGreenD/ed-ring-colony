/**
 * Unpack the Spansh archive once into small, self-describing shards — then
 * import from the shards instead of from the 6 GiB gzip.
 *
 * Why: a gzip stream cannot be decoded from the middle. Every resumed import
 * therefore re-read and re-parsed the whole archive from byte 0 just to skip
 * the records it had already written — ~2×10⁸ JSON objects of pure CPU before
 * the first new row, repeated after every restart. And a dump that takes days
 * to arrive is useless until the last byte lands.
 *
 * The shard pipeline fixes both:
 *
 *  - **unpack** reads the archive ONCE (optionally while it is still being
 *    downloaded — `follow`), parses every record into the final
 *    `galaxy_systems` row and writes it as gzipped TSV, `rowsPerShard` rows per
 *    file, with a `manifest.json` describing the result;
 *  - **import** walks the shards in order. A shard is the unit of progress, so
 *    resuming costs O(1): skip the files already applied, open the next one.
 *    Parsing TSV is several times cheaper than JSON, and `prune` can delete
 *    each shard right after it is written to the database, so the disk never
 *    needs archive + shards at once;
 *  - shards are ordinary files: they can be copied to the server one by one
 *    (rsync/scp over a thin line resumes per file), mirrored, or produced on a
 *    fast machine and shipped — all without re-downloading the archive.
 *
 * The shard format is deliberately boring (tab-separated, `\N` for NULL, the
 * same column order as `GALAXY_ROW_COLUMNS`) so it stays readable by `zcat`
 * and loadable by `COPY` if anyone ever wants to bypass this code.
 */

import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { open as openFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { createInterface } from 'node:readline';
import { createGunzip, createGzip } from 'node:zlib';

import {
  GALAXY_ROW_COLUMNS,
  POINTS_CAPACITY,
  finalizePointCloud,
  formatBytes,
  galaxyArchiveDir,
  type GalaxyImportRunResult,
  type GalaxyRowWriter,
} from './galaxyImport.ts';
import { JsonArrayObjects, toGalaxySystemRow, type GalaxySystemRecord, type SpanshSystemObject } from './galaxySpanshStream.ts';
import { PointsBuilder, galaxyPointsMax, type StarClass } from './galaxySystems.ts';
import { variantFromUrl, type GalaxyDumpVariant } from './galaxyDumpVariants.ts';

export const SHARD_MANIFEST = 'manifest.json';
export const SHARD_VERSION = 1;
/** ~2M rows ≈ 35 MiB gzipped: ~100 shards for the full catalog. */
export const DEFAULT_ROWS_PER_SHARD = 2_000_000;

export function shardsDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.GALAXY_SHARDS_DIR?.trim();
  return explicit ? resolve(explicit) : resolve(join(galaxyArchiveDir(env), 'shards'));
}

/** `shards` mode on by default? `GALAXY_IMPORT_MODE=shards|stream` decides. */
export function galaxyImportMode(env: NodeJS.ProcessEnv = process.env): 'shards' | 'stream' {
  return env.GALAXY_IMPORT_MODE?.trim().toLowerCase() === 'shards' ? 'shards' : 'stream';
}

export interface GalaxyShardEntry {
  file: string;
  rows: number;
  /** Compressed size on disk. */
  bytes: number;
  /** True once the importer has written this shard to the database. */
  imported?: boolean;
}

export interface GalaxyShardManifest {
  version: number;
  /** Where the archive came from (URL or path) — for the admin panel. */
  source: string | null;
  variant: GalaxyDumpVariant | null;
  /** Size/mtime of the archive the shards were produced from. */
  archive_bytes: number;
  archive_mtime: string | null;
  created_at: string;
  completed_at: string | null;
  rows_per_shard: number;
  /** Records read from the dump (valid + invalid) — the unpack resume point. */
  records_read: number;
  rows: number;
  invalid: number;
  shards: GalaxyShardEntry[];
  /** The archive was unpacked to its last record. */
  complete: boolean;
}

// ───────────────────────── row codec ─────────────────────────

function escapeField(value: string): string {
  let out = '';
  for (const ch of value) {
    if (ch === '\\') out += '\\\\';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else out += ch;
  }
  return out;
}

function unescapeField(value: string): string {
  if (!value.includes('\\')) return value;
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = value[++i];
    if (next === 't') out += '\t';
    else if (next === 'n') out += '\n';
    else if (next === 'r') out += '\r';
    else if (next === '\\') out += '\\';
    else out += next ?? '';
  }
  return out;
}

const NULL_FIELD = '\\N';

function encodeValue(value: unknown): string {
  if (value === null || value === undefined) return NULL_FIELD;
  if (typeof value === 'boolean') return value ? 't' : 'f';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : NULL_FIELD;
  return escapeField(String(value));
}

/** One `galaxy_systems` row → one TSV line (no trailing newline). */
export function encodeShardRow(row: GalaxySystemRecord): string {
  return GALAXY_ROW_COLUMNS.map((column) => encodeValue(row[column as keyof GalaxySystemRecord])).join('\t');
}

/** TSV line → row; `null` for a line this build cannot read (never throws). */
export function decodeShardRow(line: string): GalaxySystemRecord | null {
  if (!line) return null;
  const parts = line.split('\t');
  if (parts.length !== GALAXY_ROW_COLUMNS.length) return null;
  const [id64, name, nameLc, x, y, z, mainStar, starType, giantClass, needsPermit, distSol, distSgrA, updatedAt] = parts;
  const num = (value: string): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : NaN;
  };
  const cx = num(x);
  const cy = num(y);
  const cz = num(z);
  if (!id64 || id64 === NULL_FIELD || !name || Number.isNaN(cx) || Number.isNaN(cy) || Number.isNaN(cz)) return null;
  return {
    id64,
    name: unescapeField(name),
    name_lc: unescapeField(nameLc),
    x: cx,
    y: cy,
    z: cz,
    main_star: mainStar === NULL_FIELD ? null : unescapeField(mainStar),
    star_type: (starType === NULL_FIELD ? 'unknown' : starType) as StarClass,
    star_giant_class: (giantClass === NULL_FIELD ? null : giantClass) as GalaxySystemRecord['star_giant_class'],
    needs_permit: needsPermit === NULL_FIELD ? null : needsPermit === 't',
    distance_from_sols: num(distSol),
    distance_from_sgra: num(distSgrA),
    updated_at: updatedAt === NULL_FIELD ? null : unescapeField(updatedAt),
  };
}

export function shardFileName(index: number): string {
  return `shard-${String(index).padStart(5, '0')}.tsv.gz`;
}

// ───────────────────────── manifest ─────────────────────────

export function manifestPath(dir: string): string {
  return join(dir, SHARD_MANIFEST);
}

export function readShardManifest(dir: string): GalaxyShardManifest | null {
  try {
    const raw = JSON.parse(readFileSync(manifestPath(dir), 'utf8')) as GalaxyShardManifest;
    if (!raw || raw.version !== SHARD_VERSION || !Array.isArray(raw.shards)) return null;
    return raw;
  } catch {
    return null;
  }
}

export function writeShardManifest(dir: string, manifest: GalaxyShardManifest): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(manifestPath(dir), JSON.stringify(manifest, null, 1));
}

/** Do the shards on disk describe this archive (same bytes, same mtime)? */
export function manifestMatchesArchive(manifest: GalaxyShardManifest | null, archive: string): boolean {
  if (!manifest) return false;
  try {
    const stat = statSync(archive);
    return manifest.archive_bytes === stat.size && manifest.archive_mtime === new Date(stat.mtimeMs).toISOString();
  } catch {
    // No archive on disk: shards that were brought over by hand still count,
    // as long as the unpack finished.
    return manifest.complete;
  }
}

/** Remove every shard file and the manifest (a fresh unpack starts clean). */
export function clearShards(dir: string): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    if (entry === SHARD_MANIFEST || /^shard-\d+\.tsv\.gz$/.test(entry)) {
      rmSync(join(dir, entry), { force: true });
    }
  }
}

// ──────────────────── archive → shards ────────────────────

/**
 * A read stream that does not end at EOF while the file is still being
 * written. This is what lets the unpack run DURING the download: the dump that
 * takes days to arrive is parsed as it lands, and when the last byte is
 * written the shards are already (almost) complete.
 */
export function createGrowingReadStream(
  path: string,
  options: { isGrowing: () => boolean; pollMs?: number; signal?: AbortSignal },
): Readable {
  const pollMs = Math.max(100, options.pollMs ?? 2_000);
  async function* chunks(): AsyncGenerator<Buffer> {
    const handle = await openFile(path, 'r');
    try {
      const buffer = Buffer.allocUnsafe(1 << 20);
      let position = 0;
      for (;;) {
        if (options.signal?.aborted) throw new Error('Unpack aborted');
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        if (bytesRead > 0) {
          position += bytesRead;
          yield Buffer.from(buffer.subarray(0, bytesRead));
          continue;
        }
        if (!options.isGrowing()) return;
        await new Promise((done) => setTimeout(done, pollMs));
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
  }
  return Readable.from(chunks());
}

export interface UnpackProgress {
  recordsRead: number;
  rows: number;
  invalid: number;
  shards: number;
  bytesRead: number;
  /** Compressed archive size, when known. */
  bytesTotal: number | null;
  elapsedMs: number;
}

export interface UnpackShardsOptions {
  archive: string;
  dir?: string;
  rowsPerShard?: number;
  source?: string | null;
  variant?: GalaxyDumpVariant | null;
  signal?: AbortSignal;
  log?: (line: string) => void;
  now?: () => number;
  onProgress?: (progress: UnpackProgress) => void | Promise<void>;
  progressIntervalMs?: number;
  /**
   * Keep reading while this returns true even after EOF — the archive is still
   * downloading. Unpack and download then run at the same time.
   */
  follow?: () => boolean;
  /** Start over instead of continuing an interrupted unpack. */
  fresh?: boolean;
}

/**
 * Read the archive once and write normalized, gzipped TSV shards.
 *
 * Resumable: an interrupted unpack re-reads the gzip (there is no way around
 * that) but only re-PARSES the records it already emitted — they are counted,
 * not written — and appends new shards after the ones the manifest knows.
 */
export async function unpackArchiveToShards(options: UnpackShardsOptions): Promise<GalaxyShardManifest> {
  const archive = resolve(options.archive);
  if (!existsSync(archive)) throw new Error(`Dump file not found: ${archive}`);
  const dir = resolve(options.dir ?? shardsDir());
  const log = options.log ?? (() => undefined);
  const now = options.now ?? Date.now;
  const progressIntervalMs = Math.max(1_000, options.progressIntervalMs ?? 10_000);
  const rowsPerShard = Math.max(1, Math.floor(options.rowsPerShard ?? DEFAULT_ROWS_PER_SHARD));
  const startedAt = now();

  mkdirSync(dir, { recursive: true });
  const stat = statSync(archive);
  const archiveMtime = new Date(stat.mtimeMs).toISOString();

  let manifest = options.fresh ? null : readShardManifest(dir);
  // Shards of a different archive (yesterday's dump, a delta) are useless.
  if (manifest && (manifest.archive_bytes > stat.size || manifest.archive_mtime !== archiveMtime)) {
    log('Шарды на диске относятся к другому архиву — распаковываю заново');
    manifest = null;
  }
  if (manifest?.complete) {
    log(`Архив уже распакован: ${manifest.shards.length} шардов, ${manifest.rows.toLocaleString()} систем`);
    return manifest;
  }
  if (!manifest) {
    clearShards(dir);
    manifest = {
      version: SHARD_VERSION,
      source: options.source ?? archive,
      variant: options.variant ?? variantFromUrl(options.source ?? archive),
      archive_bytes: stat.size,
      archive_mtime: archiveMtime,
      created_at: new Date().toISOString(),
      completed_at: null,
      rows_per_shard: rowsPerShard,
      records_read: 0,
      rows: 0,
      invalid: 0,
      shards: [],
      complete: false,
    };
    writeShardManifest(dir, manifest);
  }

  const skipRecords = manifest.records_read;
  if (skipRecords > 0) {
    log(`Продолжаю распаковку: ${skipRecords.toLocaleString()} записей уже в шардах, перечитываю архив до этой точки`);
  }

  const source = options.follow
    ? createGrowingReadStream(archive, { isGrowing: options.follow, signal: options.signal })
    : createReadStream(archive);
  const gunzip = createGunzip();
  const objects = new JsonArrayObjects();
  const teardown = (error?: Error) => {
    for (const stream of [source, gunzip, objects]) {
      if (error) stream.destroy(error);
      else stream.destroy();
    }
  };
  for (const stream of [source, gunzip]) stream.on('error', (error: Error) => teardown(error));
  const onAbort = () => teardown(new Error('Unpack aborted'));
  options.signal?.addEventListener('abort', onAbort, { once: true });
  source.pipe(gunzip).pipe(objects);

  let recordsRead = 0;
  let rows = manifest.rows;
  let invalid = manifest.invalid;
  let lastProgressAt = 0;

  let shardRows = 0;
  let shardStream: ReturnType<typeof createWriteStream> | null = null;
  let gzipStream: ReturnType<typeof createGzip> | null = null;
  let shardFile = '';

  const openShard = () => {
    shardFile = shardFileName(manifest.shards.length + 1);
    gzipStream = createGzip({ level: 4 });
    shardStream = createWriteStream(join(dir, shardFile));
    gzipStream.pipe(shardStream);
    shardRows = 0;
  };

  const closeShard = async () => {
    if (!gzipStream || !shardStream) return;
    const gz = gzipStream;
    const file = shardStream;
    gzipStream = null;
    shardStream = null;
    await new Promise<void>((done, fail) => {
      file.on('finish', () => done());
      file.on('error', fail);
      gz.end();
    });
    const bytes = statSync(join(dir, shardFile)).size;
    manifest.shards.push({ file: shardFile, rows: shardRows, bytes });
    manifest.records_read = skipRecords + recordsRead;
    manifest.rows = rows;
    manifest.invalid = invalid;
    writeShardManifest(dir, manifest);
    log(`Шард ${shardFile}: ${shardRows.toLocaleString()} систем, ${formatBytes(bytes)}`);
  };

  const writeLine = async (line: string) => {
    if (!gzipStream) openShard();
    const gz = gzipStream!;
    if (!gz.write(`${line}\n`)) {
      await new Promise<void>((done) => gz.once('drain', () => done()));
    }
    shardRows++;
    if (shardRows >= rowsPerShard) await closeShard();
  };

  try {
    for await (const object of objects as AsyncIterable<SpanshSystemObject>) {
      recordsRead++;
      // Records already in a shard are counted, not rewritten: the manifest is
      // the only resume point we have for a gzip stream.
      if (recordsRead <= skipRecords) continue;
      const row = toGalaxySystemRow(object);
      if (!row) {
        invalid++;
        continue;
      }
      rows++;
      await writeLine(encodeShardRow(row));

      const at = now();
      if (at - lastProgressAt >= progressIntervalMs) {
        lastProgressAt = at;
        const progress: UnpackProgress = {
          recordsRead: skipRecords + recordsRead,
          rows,
          invalid,
          shards: manifest.shards.length,
          bytesRead: objects.streamOffset,
          bytesTotal: null,
          elapsedMs: at - startedAt,
        };
        log(
          `  распаковано ${rows.toLocaleString()} систем в ${manifest.shards.length} шард(ов) ` +
          `(${((rows / Math.max(1, (at - startedAt) / 1000)) | 0).toLocaleString()}/с)`,
        );
        if (options.onProgress) await options.onProgress(progress);
      }
    }
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
    teardown();
  }

  await closeShard();
  manifest.records_read = skipRecords + recordsRead;
  manifest.rows = rows;
  manifest.invalid = invalid;
  manifest.complete = true;
  manifest.completed_at = new Date().toISOString();
  writeShardManifest(dir, manifest);
  log(
    `Распаковка завершена за ${((now() - startedAt) / 1000).toFixed(1)} с: ` +
    `${rows.toLocaleString()} систем, ${manifest.shards.length} шардов, ${invalid} нечитаемых записей`,
  );
  return manifest;
}

// ──────────────────── shards → database ────────────────────

/** Rows of one shard, streamed line by line. */
export async function* readShardRecords(file: string): AsyncGenerator<GalaxySystemRecord> {
  const stream = createReadStream(file).pipe(createGunzip());
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line) continue;
      const row = decodeShardRow(line);
      if (row) yield row;
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}

export interface ShardImportSnapshot {
  /** Shards fully written to the database (the resume point). */
  shardIndex: number;
  shardsTotal: number;
  bytesDone: number;
  bytesTotal: number;
  processed: number;
  written: number;
  invalid: number;
  skipped: number;
  rate: number;
  elapsedMs: number;
}

export interface ShardImportOptions {
  dir?: string;
  writer: GalaxyRowWriter;
  /** Shards already imported (resume): skip this many files. */
  fromShard?: number;
  signal?: AbortSignal;
  log?: (line: string) => void;
  now?: () => number;
  onProgress?: (snapshot: ShardImportSnapshot) => void | Promise<void>;
  progressIntervalMs?: number;
  buildPoints?: boolean;
  maxPoints?: number;
  /** Delete each shard once it is in the database (archive + shards = 12 GiB otherwise). */
  prune?: boolean;
}

export interface ShardImportResult extends GalaxyImportRunResult {
  shardsDone: number;
  shardsTotal: number;
}

/**
 * Import the shards of one archive in order. Each finished shard is a durable
 * restart point: the writer is flushed, the manifest is updated and a crash
 * costs at most one shard instead of the whole dump.
 */
export async function runShardImport(options: ShardImportOptions): Promise<ShardImportResult> {
  const dir = resolve(options.dir ?? shardsDir());
  const log = options.log ?? (() => undefined);
  const now = options.now ?? Date.now;
  const progressIntervalMs = Math.max(1_000, options.progressIntervalMs ?? 10_000);
  const startedAt = now();
  const writer = options.writer;

  const manifest = readShardManifest(dir);
  if (!manifest) throw new Error(`Шарды не найдены: ${manifestPath(dir)} (сначала распакуйте архив)`);
  if (!manifest.complete) {
    log('WARNING: распаковка архива ещё не завершена — импортирую готовые шарды, остальные подхватит следующий запуск');
  }

  const shards = manifest.shards;
  const fromShard = Math.max(0, Math.min(Math.floor(options.fromShard ?? 0), shards.length));
  const bytesTotal = shards.reduce((sum, shard) => sum + shard.bytes, 0);
  let bytesDone = shards.slice(0, fromShard).reduce((sum, shard) => sum + shard.bytes, 0);

  if (fromShard > 0) {
    log(`Продолжаю импорт с шарда ${fromShard + 1} из ${shards.length} (предыдущие уже в базе)`);
  }

  const maxPoints = Math.max(0, options.maxPoints ?? galaxyPointsMax());
  const streamed = options.buildPoints === false ? null : new PointsBuilder(POINTS_CAPACITY, maxPoints);
  let pointsSeen = 0;
  let processed = 0;
  let skipped = shards.slice(0, fromShard).reduce((sum, shard) => sum + shard.rows, 0);
  let lastProgressAt = 0;
  let shardsDone = fromShard;

  const snapshot = (): ShardImportSnapshot => ({
    shardIndex: shardsDone,
    shardsTotal: shards.length,
    bytesDone,
    bytesTotal,
    processed,
    written: writer.written,
    invalid: 0,
    skipped,
    rate: processed / Math.max(1, (now() - startedAt) / 1000),
    elapsedMs: now() - startedAt,
  });

  for (let index = fromShard; index < shards.length; index++) {
    const shard = shards[index];
    const file = join(dir, shard.file);
    if (!existsSync(file)) {
      throw new Error(`Шард ${shard.file} отсутствует на диске — распакуйте архив заново (кнопка «Распаковать архив»)`);
    }
    for await (const row of readShardRecords(file)) {
      if (options.signal?.aborted) throw new Error('Import aborted');
      processed++;
      await writer.add(row);
      if (streamed) {
        streamed.add({ x: row.x, y: row.y, z: row.z, id64: row.id64, starType: row.star_type });
        pointsSeen++;
      }
      const at = now();
      if (at - lastProgressAt >= progressIntervalMs) {
        lastProgressAt = at;
        const progress = snapshot();
        log(
          `  шард ${index + 1}/${shards.length}: ${progress.processed.toLocaleString()} систем, ` +
          `${progress.written.toLocaleString()} записано (${progress.rate.toFixed(0)}/с)`,
        );
        if (options.onProgress) await options.onProgress(progress);
      }
    }

    // A shard counts as imported only after the writer actually handed every
    // row to the database — a deferred row is not stored yet.
    await writer.flush();
    if (writer.deferred === 0) {
      shardsDone = index + 1;
      bytesDone += shard.bytes;
      shard.imported = true;
      writeShardManifest(dir, manifest);
      if (options.prune) {
        rmSync(file, { force: true });
        log(`Шард ${shard.file} импортирован и удалён с диска`);
      }
      if (options.onProgress) await options.onProgress(snapshot());
    }
  }

  await writer.flush();
  await writer.retryDeferred();
  const systemsCount = await writer.countRows();

  const points =
    options.buildPoints === false
      ? null
      : await finalizePointCloud({
          writer,
          streamed,
          pointsSeen,
          systemsCount,
          maxPoints,
          // Only a run that started at the first shard of a complete unpack
          // saw the whole catalog.
          complete: fromShard === 0 && manifest.complete,
          log,
        });

  const durationMs = now() - startedAt;
  log(
    `Импорт из шардов завершён за ${(durationMs / 1000).toFixed(1)} с: ${processed.toLocaleString()} систем, ` +
    `${shardsDone}/${shards.length} шардов, ${systemsCount.toLocaleString()} строк в таблице`,
  );

  return {
    processed,
    invalid: 0,
    skipped,
    written: writer.written,
    systemsCount,
    bytesDone,
    bytesTotal,
    resumedFrom: fromShard,
    durationMs,
    points,
    shardsDone,
    shardsTotal: shards.length,
  };
}

export interface ShardStatus {
  dir: string;
  manifest: GalaxyShardManifest | null;
  /** Shards present on disk right now. */
  files: number;
  bytes: number;
}

/** What the admin panel shows about the unpacked shards. */
export function getShardStatus(dir = shardsDir()): ShardStatus {
  const manifest = readShardManifest(dir);
  let files = 0;
  let bytes = 0;
  try {
    for (const entry of readdirSync(dir)) {
      if (!/^shard-\d+\.tsv\.gz$/.test(entry)) continue;
      files++;
      bytes += statSync(join(dir, entry)).size;
    }
  } catch {
    // No directory yet: zeroes are the honest answer.
  }
  return { dir, manifest, files, bytes };
}
