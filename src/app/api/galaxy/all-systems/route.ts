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
import {
  POINTS_UPLOAD_LIMIT,
  readPointsFromPg,
  readPointsFromSupabase,
} from '@/lib/galaxyImport';
import { galaxyDbUrl } from '@/lib/pgModule';

export const dynamic = 'force-dynamic';
// A cold PostgREST build of ~1.3M rows can take minutes; nginx gives up at 310 s.
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

function tryLocal(): PointsFile | null {
  try {
    if (!fs.existsSync(STATIC_POINTS)) return null;
    const buffer = fs.readFileSync(STATIC_POINTS);
    const count = pointCount(buffer);
    if (count == null || count === 0) return null;
    const stat = fs.statSync(STATIC_POINTS);
    return { buffer, count, etag: `edgs-${count}-${stat.mtimeMs.toFixed(0)}` };
  } catch {
    return null;
  }
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
 * Postgres first (fast, streaming), PostgREST second (works with nothing but the
 * service-role key — the case the production container is usually in).
 */
async function buildFromDatabase(): Promise<PointsFile | null> {
  const connectionString = galaxyDbUrl();
  if (connectionString) {
    try {
      const built = await readPointsFromPg(connectionString);
      return { buffer: built.buffer, count: built.count, etag: `edgs-pg-${built.count}` };
    } catch (err) {
      console.error('[galaxy/all-systems] pg build failed:', (err as Error)?.message);
    }
  }
  try {
    const { createAdminClient } = await import('@/lib/supabaseAdmin');
    // One client for the whole paged read, not one per page.
    const built = await readPointsFromSupabase(createAdminClient());
    return { buffer: built.buffer, count: built.count, etag: `edgs-db-${built.count}` };
  } catch (err) {
    console.error('[galaxy/all-systems] supabase build failed:', (err as Error)?.message);
    return null;
  }
}

function remember(file: PointsFile) {
  memoryCache = file;
  try {
    fs.mkdirSync(path.dirname(STATIC_POINTS), { recursive: true });
    fs.writeFileSync(STATIC_POINTS, file.buffer);
    const count = pointCount(file.buffer);
    fs.writeFileSync(STATIC_META, JSON.stringify({
      format: 'edgs-v1',
      count,
      imported_at: new Date().toISOString(),
      source: 'served',
      bytes: file.buffer.length,
    }, null, 2));
  } catch {
    // read-only image — the in-memory copy still serves this process
  }
}

/**
 * Publish a freshly built cloud so the next cold start is a download instead of
 * a multi-minute table scan. Only a complete catalog is published: a partial
 * one must not be mistaken for the full cloud by other processes.
 */
function publish(file: PointsFile, stats: GalaxyStats | null) {
  const complete = stats ? file.count >= Math.max(stats.systems_count, 1_000_000) : file.count >= 1_000_000;
  if (!complete || file.buffer.length > POINTS_UPLOAD_LIMIT) return;
  void (async () => {
    try {
      const { supabaseAdmin } = await import('@/lib/supabaseAdmin');
      const { error } = await supabaseAdmin.storage
        .from(POINTS_STORAGE_BUCKET)
        .upload(POINTS_STORAGE_OBJECT, new Uint8Array(file.buffer), {
          contentType: 'application/octet-stream',
          upsert: true,
        });
      if (error) {
        console.error('[galaxy/all-systems] storage publish failed:', error.message);
        return;
      }
      await markPointsUploaded({ count: file.count, bytes: file.buffer.length });
    } catch (err) {
      console.error('[galaxy/all-systems] storage publish failed:', (err as Error)?.message);
    }
  })();
}

function respond(req: Request, file: { buffer: Buffer; etag: string }) {
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

function shorterThanUpload(file: PointsFile, uploadedCount: number | null | undefined): boolean {
  if (uploadedCount != null && uploadedCount > file.count) return true;
  // A leftover --limit file must not hide the full cloud once storage has one.
  return uploadedCount == null && file.count < 1_000_000;
}

export async function GET(req: Request) {
  const local = tryLocal();
  const stats = await getGalaxyStats().catch(() => null);
  const uploadedCount = stats?.points_uploaded ? (stats.points_count ?? null) : null;
  const localIsStale = !!local && stats?.points_uploaded === true && shorterThanUpload(local, uploadedCount);
  const memoryIsStale = !!memoryCache && stats?.points_uploaded === true && shorterThanUpload(memoryCache, uploadedCount);

  if (local && !localIsStale) return respond(req, local);
  if (memoryCache && !memoryIsStale) return respond(req, memoryCache);

  if (stats?.points_uploaded) {
    const stored = await tryStorage();
    if (stored && (!local || stored.count >= local.count)) {
      remember(stored);
      return respond(req, stored);
    }
  }

  if (local) return respond(req, local);
  if (memoryCache) return respond(req, memoryCache);

  if (!building) {
    building = buildFromDatabase().finally(() => {
      building = null;
    });
  }
  const built = await building;
  if (built) {
    remember(built);
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
        'Запустите импорт дампа Spansh — Админка → «Каталог систем», POST /api/cron/galaxy-import ' +
        '(секрет CRON_SECRET) или npm run spansh:import на машине с доступом к downloads.spansh.co.uk.',
      catalog: {
        systems_count: stats?.systems_count ?? 0,
        imported_at: stats?.imported_at ?? null,
        points_uploaded: stats?.points_uploaded === true,
        direct_db: Boolean(galaxyDbUrl()),
      },
    },
    { status: 503, headers: { 'cache-control': 'no-store', 'retry-after': '300' } },
  );
}
