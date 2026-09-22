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

import { Readable, Transform } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { createGunzip } from 'node:zlib';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  PointsBuilder,
  POINTS_STORAGE_BUCKET,
  POINTS_STORAGE_OBJECT,
  type GalaxySystemPoint,
  type StarClass,
} from './galaxySystems.ts';
import {
  JsonArrayObjects,
  toGalaxySystemRow,
  type GalaxySystemRecord,
  type SpanshSystemObject,
} from './galaxySpanshStream.ts';
import { galaxyDbUrl, loadPg, type PgClientLike, type PgModule } from './pgModule.ts';

export const SPANSH_DUMP_URL = 'https://downloads.spansh.co.uk/systems.json.gz';

/**
 * Dump URL to import. `GALAXY_IMPORT_URL` overrides it for servers that keep a
 * local mirror (or cannot reach downloads.spansh.co.uk); the layout must stay
 * the Spansh `systems.json.gz` one.
 */
export function galaxyImportUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.GALAXY_IMPORT_URL?.trim() || SPANSH_DUMP_URL;
}
export const GALAXY_TABLE = 'galaxy_systems';
/** Bucket limit set by migration 20260924000000_galaxy_systems_finish.sql. */
export const POINTS_UPLOAD_LIMIT = 50 * 1024 * 1024;
export const GALAXY_META_TABLE = 'galaxy_systems_meta';

/** Rows per statement. 2000 × 13 columns stays far below any parameter/size cap. */
export const PG_BATCH_SIZE = 2000;
/** Rows per PostgREST upsert (the script's default for the HTTP path). */
export const SUPABASE_BATCH_SIZE = 1000;
/** Expected catalog size: the builder is allocated once, without regrowth. */
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
 * A cardinality error that somehow survives the collapse is retried on halves,
 * down to a single row, instead of aborting the whole catalog download.
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
    if (isGalaxyCardinalityViolation(error) && rows.length > 1) {
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

/**
 * Write one batch through PostgREST — the path the admin tab uses when the
 * web process has no `DATABASE_URL`.
 *
 * Same rules as {@link writeGalaxyRowsPg}: collapse duplicates before the
 * upsert (otherwise the browser-started import dies on the first repeated
 * system), then split a batch Postgres still rejects, and finally reconcile a
 * single row whose `id64` is already stored under another name.
 */
export async function writeGalaxyRowsSupabase(
  client: GalaxyWriteClient,
  rows: GalaxySystemRecord[],
): Promise<number> {
  const batch = collapseGalaxyBatch(rows);
  if (batch.length === 0) return 0;
  await upsertSupabaseChunk(client, batch);
  return batch.length;
}

async function upsertSupabaseChunk(client: GalaxyWriteClient, rows: GalaxySystemRecord[]): Promise<void> {
  const { error } = await client
    .from(GALAXY_TABLE)
    .upsert(rows as unknown as Record<string, unknown>[], { onConflict: 'name_lc' });
  if (!error) return;
  if (rows.length > 1 && (isGalaxyCardinalityViolation(error) || isGalaxyUniqueViolation(error))) {
    const middle = Math.floor(rows.length / 2);
    await upsertSupabaseChunk(client, rows.slice(0, middle));
    await upsertSupabaseChunk(client, rows.slice(middle));
    return;
  }
  if (rows.length === 1 && isGalaxyUniqueViolation(error)) {
    await reconcileGalaxyRow(client, rows[0]);
    return;
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
 */
export async function createPgWriter(
  connectionString: string,
  options: { pg?: PgModule; batchSize?: number; truncate?: boolean } = {},
): Promise<GalaxyRowWriter> {
  const pg = options.pg ?? (await loadPg());
  const batchSize = Math.max(1, options.batchSize ?? PG_BATCH_SIZE);
  // Big batches must not die on a server-wide statement_timeout, but a dead
  // database must fail in seconds instead of on the OS TCP timeout.
  const client: PgClientLike = new pg.Client({
    connectionString,
    statement_timeout: 0,
    query_timeout: 0,
    connectionTimeoutMillis: 15_000,
  });
  await client.connect();
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
      // A streaming query keeps 1.3M rows out of memory.
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
    async close() {
      rows = [];
      await client.end().catch(() => undefined);
    },
  };
}

/** PostgREST writer: works with nothing but the service-role key. */
export function createSupabaseWriter(
  client: SupabaseClient,
  options: { batchSize?: number } = {},
): GalaxyRowWriter {
  const batchSize = Math.max(1, options.batchSize ?? SUPABASE_BATCH_SIZE);
  let rows: GalaxySystemRecord[] = [];
  let written = 0;

  const flush = async (): Promise<number> => {
    if (rows.length === 0) return 0;
    const batch = rows;
    rows = [];
    // The admin tab hits this writer whenever the web process has no direct
    // Postgres URL. A repeated system name in the batch is a hard Postgres
    // error ("cannot affect row a second time"), not a conflict update.
    const count = await writeGalaxyRowsSupabase(client as unknown as GalaxyWriteClient, batch);
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

/** Point cloud straight from Postgres (used when no file/storage object exists). */
export async function readPointsFromPg(
  connectionString: string,
  options: { pg?: PgModule } = {},
): Promise<{ buffer: Buffer; count: number }> {
  const writer = await createPgWriter(connectionString, { pg: options.pg });
  try {
    return await collectPoints(writer);
  } finally {
    await writer.close();
  }
}

/** Point cloud over PostgREST, keyset-paged and verified against COUNT(*). */
export async function readPointsFromSupabase(
  client: SupabaseClient,
): Promise<{ buffer: Buffer; count: number }> {
  const writer = createSupabaseWriter(client);
  const { count: total, error } = await client
    .from(GALAXY_TABLE)
    .select('id', { count: 'exact', head: true });
  if (error) throw new Error(`count failed: ${error.message}`);
  const expected = Number(total ?? 0);
  if (expected === 0) throw new Error(`${GALAXY_TABLE} is empty`);
  const cloud = await collectPoints(writer);
  // The old chunked builder was silently truncated by the API row cap. Refuse
  // to serve a partial cloud instead: the map would look complete but lie.
  if (cloud.count < expected) {
    throw new Error(`point cloud is truncated: ${cloud.count} of ${expected} rows`);
  }
  return cloud;
}

async function collectPoints(writer: GalaxyRowWriter): Promise<{ buffer: Buffer; count: number }> {
  const builder = new PointsBuilder(POINTS_CAPACITY);
  await writer.readPoints((point) => builder.add(point));
  if (builder.size === 0) throw new Error('no rows to build the point cloud from');
  return { buffer: Buffer.from(builder.build()), count: builder.size };
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
  writer: GalaxyRowWriter;
  /**
   * Uncompressed byte offset to continue from (0 = import everything).
   *
   * The dump is gzip, so an HTTP `Range` restart would hand gunzip a stream
   * beginning mid-deflate, which cannot be decoded. A resumed pass therefore
   * re-downloads and re-decompresses the dump but SKIPS every record ending
   * before this offset — those rows are stored already, and the expensive part
   * (~1.3M upserts) is not repeated.
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
  points: { buffer: Buffer; count: number; rebuiltFromTable: boolean } | null;
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
  const bytesTotal = Number.isFinite(lengthHeader) && lengthHeader > 0 ? lengthHeader : null;

  const { stream: counterStream, counter } = byteCounter();
  const source = Readable.fromWeb(response.body as unknown as WebReadableStream);
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

  let streamed = options.buildPoints === false ? null : new PointsBuilder(POINTS_CAPACITY);
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
      if (streamed) streamed.add({ x: row.x, y: row.y, z: row.z, id64: row.id64, starType: row.star_type });
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
  if (streamed) {
    if (resumeFrom > 0 || streamed.size !== systemsCount) {
      // A resumed pass only saw the tail of the dump, and a pass that collapsed
      // duplicate names streamed more points than rows. Either way the streamed
      // cloud is not the catalog: rebuild it from the table instead.
      log('Rebuilding the point cloud from the table (resumed, duplicate or incomplete pass)');
      // Release the partial cloud before allocating the full one (~24 MB each).
      streamed = null;
      const rebuilt = new PointsBuilder(Math.max(systemsCount, 1024));
      const read = await writer.readPoints((point) => rebuilt.add(point));
      if (read !== systemsCount) {
        throw new Error(`point cloud is truncated: ${read} of ${systemsCount} rows`);
      }
      points = { buffer: Buffer.from(rebuilt.build()), count: rebuilt.size, rebuiltFromTable: true };
    } else {
      points = { buffer: Buffer.from(streamed.build()), count: streamed.size, rebuiltFromTable: false };
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
