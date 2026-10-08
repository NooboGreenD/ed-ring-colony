import { NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';

import { getGalaxyStats, markPointsUploaded, type GalaxyStats } from '@/lib/galaxySystemsDb';
import {
  POINTS_HEADER_SIZE,
  POINTS_MAGIC,
  POINTS_STORAGE_BUCKET,
  POINTS_STORAGE_OBJECT,
  parsePointsFile,
} from '@/lib/galaxySystems';
import { readPointsFromPg, readPointsFromSupabase } from '@/lib/galaxyImport';
import { galaxyDbUrl } from '@/lib/pgModule';
import { resolvePointsBudget } from '@/lib/galaxyImportJob';
import { pointsCacheDir, pointsCachePath, uploadPointsToStorage } from '@/lib/galaxyPointsPublish';

export const dynamic = 'force-dynamic';
// A cold PostgREST build over 10⁸ rows can take minutes; nginx gives up at 310 s.
export const maxDuration = 300;

const STATIC_POINTS = path.join(process.cwd(), 'public', 'data', 'galaxy-systems-points.bin');
const STATIC_META = `${STATIC_POINTS}.meta.json`;

type PointsFile = { buffer: Buffer; etag: string; count: number };

let memoryCache: PointsFile | null = null;
let building: Promise<PointsFile | null> | null = null;

function asArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

function pointCount(buffer: Buffer): number | null {
  if (buffer.length < POINTS_HEADER_SIZE + 29) return null;
  if (buffer.subarray(0, 4).toString('ascii') !== POINTS_MAGIC) return null;
  try {
    return parsePointsFile(asArrayBuffer(buffer)).count;
  } catch {
    return null;
  }
}

/**
 * A file already on disk, validated by its header — never by its name alone.
 * `mtimeMs` is only a tie-breaker between two clouds with the same count.
 */
function fileAt(file: string): Candidate | null {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return null;
    const buffer = fs.readFileSync(file);
    const count = pointCount(buffer);
    if (count == null || count === 0) return null;
    return {
      buffer,
      count,
      mtimeMs: stat.mtimeMs,
      etag: `edgs-${count}-${stat.mtimeMs.toFixed(0)}-${buffer.length}`,
    };
  } catch {
    return null;
  }
}

type Candidate = PointsFile & { mtimeMs: number };

/**
 * Files on disk: the one baked into the image (`public/data`, produced by
 * `npm run spansh:import`) and the one the importer writes to the data disk
 * (`GALAXY_POINTS_DIR`). The bigger cloud wins — a stale image file must not
 * hide a fresh catalog, and a fresh partial `--limit` file must not hide the
 * complete one.
 */
function tryLocal(): Candidate | null {
  const list = [fileAt(STATIC_POINTS), fileAt(pointsCachePath())].filter(
    (item): item is Candidate => !!item,
  );
  if (!list.length) return null;
  list.sort((a, b) => (b.count - a.count) || (b.mtimeMs - a.mtimeMs));
  return list[0];
}

async function tryStorage(): Promise<PointsFile | null> {
  try {
    const { supabaseAdmin } = await import('@/lib/supabaseAdmin');
    const { data, error } = await supabaseAdmin.storage
      .from(POINTS_STORAGE_BUCKET)
      .download(POINTS_STORAGE_OBJECT);
    if (error || !data) return null;
    const buffer = Buffer.from(await data.arrayBuffer());
    const count = pointCount(buffer);
    if (count == null || count === 0) return null;
    return { buffer, count, etag: `edgs-storage-${count}-${buffer.length}` };
  } catch {
    return null;
  }
}

/**
 * Build the cloud from `galaxy_systems` when nothing prebuilt exists: direct
 * Postgres first (fast, streaming, and it can sample the table), PostgREST
 * second (works with nothing but the service-role key — the case a production
 * container is usually in).
 *
 * The size follows the same budget as the import (`resolvePointsBudget`), so a
 * cloud built here is not a smaller galaxy than the built-in one.
 */
async function buildFromDatabase(): Promise<PointsFile | null> {
  const connectionString = galaxyDbUrl();
  let options: { maxPoints: number; budgetBytes: number } | Record<string, never> = {};
  try {
    const budget = await resolvePointsBudget();
    options = { maxPoints: budget.maxPoints, budgetBytes: budget.budgetBytes };
  } catch {
    // No budget info (no DB at all): the built-in default still applies.
  }
  if (connectionString) {
    try {
      const built = await readPointsFromPg(connectionString, options);
      return { buffer: built.buffer, count: built.count, etag: `edgs-pg-${built.count}` };
    } catch (err) {
      console.error('[galaxy/all-systems] pg build failed:', (err as Error)?.message);
    }
  }
  try {
    const { createAdminClient } = await import('@/lib/supabaseAdmin');
    // One client for the whole paged read, not one per page.
    const built = await readPointsFromSupabase(createAdminClient(), options);
    return { buffer: built.buffer, count: built.count, etag: `edgs-db-${built.count}` };
  } catch (err) {
    console.error('[galaxy/all-systems] supabase build failed:', (err as Error)?.message);
    return null;
  }
}

/**
 * Keep what we served: the data disk first (it survives a restart and is what
 * the admin panel publishes from), the image's `public/data` second (dev
 * installs without a writable mount). `public/data` is the only location the
 * static `/_next/static` style path can be served from by the web server.
 */
function remember(file: PointsFile, source: 'cache' | 'storage' | 'build') {
  memoryCache = file;
  const meta = {
    format: 'edgs-v1',
    count: file.count,
    bytes: file.buffer.length,
    imported_at: new Date().toISOString(),
    source,
  };
  const body = JSON.stringify(meta, null, 2);
  const target = pointsCachePath();
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, file.buffer);
    fs.renameSync(tmp, target);
    fs.writeFileSync(`${target}.meta.json`, body);
    return;
  } catch {
    // the data disk is not writable — fall through to the image directory
  }
  try {
    fs.mkdirSync(path.dirname(STATIC_POINTS), { recursive: true });
    fs.writeFileSync(STATIC_POINTS, file.buffer);
    fs.writeFileSync(STATIC_META, body);
  } catch {
    // read-only image: the in-memory copy still serves this process
  }
}

/**
 * Publish a freshly built cloud to Storage so the next cold start is a download
 * instead of a multi-minute table scan. Only a complete catalog is published: a
 * partial one (`--limit`, a filtered import) must not be mistaken for the full
 * cloud by other processes. Failures are logged and ignored — the file is
 * already in the cache directory, so the cloud is not lost.
 */
function publish(file: PointsFile, stats: GalaxyStats | null) {
  const known = Math.max(stats?.systems_count ?? 0, 1_000_000);
  if (file.count < known) return;
  void (async () => {
    try {
      const { createAdminClient } = await import('@/lib/supabaseAdmin');
      const budget = await resolvePointsBudget().catch(() => null);
      const result = await uploadPointsToStorage(file.buffer, {
        admin: createAdminClient(),
        limitBytes: budget?.budgetBytes,
        log: (line: string) => console.log(`[galaxy-points] ${line}`),
      });
      if (result.uploaded) {
        await markPointsUploaded({ count: file.count, bytes: file.buffer.length }).catch(() => undefined);
      }
    } catch (err) {
      console.error('[galaxy/all-systems] storage publish failed:', (err as Error)?.message);
    }
  })();
}

function respond(req: Request, file: PointsFile) {
  const headers = {
    'content-type': 'application/octet-stream',
    etag: file.etag,
    'cache-control': 'public, max-age=3600',
  };
  if (req.headers.get('if-none-match') === file.etag) {
    return new NextResponse(null, { status: 304, headers });
  }
  return new NextResponse(new Uint8Array(file.buffer), { status: 200, headers });
}

/**
 * Is a file on disk older / smaller than what Storage is known to hold?
 * Otherwise a leftover `--limit` file would hide the full cloud forever.
 */
function shorterThanUpload(file: PointsFile, uploadedCount: number | null): boolean {
  if (uploadedCount != null && uploadedCount > file.count) return true;
  return uploadedCount == null && file.count < 1_000_000;
}

export async function GET(req: Request) {
  const local = tryLocal();
  const stats = await getGalaxyStats().catch(() => null);
  // The catalog knows whether a file was published (Storage marker) — if it
  // does and the local file is shorter than the published one, fetch Storage.
  const published = stats?.points_uploaded === true || stats?.points_published?.uploaded === true;
  // `points_count` always describes the file Storage holds, whichever writer
  // published it (the import job or this route).
  const uploadedCount = published ? (stats?.points_count ?? null) : null;

  if (memoryCache && (!published || !shorterThanUpload(memoryCache, uploadedCount))) {
    return respond(req, memoryCache);
  }
  if (local && (!published || !shorterThanUpload(local, uploadedCount))) {
    return respond(req, local);
  }

  if (published) {
    const stored = await tryStorage();
    if (stored && (!local || stored.count >= local.count)) {
      remember(stored, 'storage');
      return respond(req, stored);
    }
  }

  // Nothing better exists — a stale local file still beats "no map".
  if (local) return respond(req, local);
  if (memoryCache) return respond(req, memoryCache);

  // Collapse concurrent cold starts into one build.
  if (!building) {
    building = buildFromDatabase().finally(() => {
      building = null;
    });
  }
  const built = await building;
  if (built) {
    remember(built, 'build');
    publish(built, stats);
    return respond(req, built);
  }

  // The route exists; the catalog simply has nothing to serve yet. 503 (not 404)
  // keeps "no data" distinguishable from "no such endpoint" in logs and in the
  // browser console, and tells proxies the answer may change soon.
  return NextResponse.json(
    {
      error: 'Каталог всех систем пуст: файл точек не найден ни локально, ни в storage, ни в galaxy_systems.',
      hint:
        'Запустите импорт дампа Spansh — Админка → «Каталог систем» (или POST /api/cron/galaxy-import ' +
        'с секретом CRON_SECRET); на машине с доступом к downloads.spansh.co.uk — npm run spansh:import.',
      catalog: {
        systems_count: stats?.systems_count ?? 0,
        imported_at: stats?.imported_at ?? null,
        points_uploaded: stats?.points_uploaded === true,
        points_published: stats?.points_published ?? null,
        points_dir: pointsCacheDir(),
        direct_db: Boolean(galaxyDbUrl()),
      },
    },
    { status: 503, headers: { 'cache-control': 'no-store', 'retry-after': '300' } },
  );
}
