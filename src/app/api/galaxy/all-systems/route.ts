import { NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { getGalaxyStats } from '@/lib/galaxySystemsDb';
import {
  POINTS_HEADER_SIZE,
  POINTS_MAGIC,
  POINTS_STORAGE_BUCKET,
  POINTS_STORAGE_OBJECT,
  PointsBuilder,
  parsePointsFile,
  type StarClass,
} from '@/lib/galaxySystems';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const STATIC_POINTS = path.join(process.cwd(), 'public', 'data', 'galaxy-systems-points.bin');
const STATIC_META = `${STATIC_POINTS}.meta.json`;

let memoryCache: { buffer: Buffer; etag: string } | null = null;
let building: Promise<{ buffer: Buffer; etag: string } | null> | null = null;

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

function tryLocal(): { buffer: Buffer; etag: string } | null {
  try {
    if (!fs.existsSync(STATIC_POINTS)) return null;
    const buffer = fs.readFileSync(STATIC_POINTS);
    const count = pointCount(buffer);
    if (count == null || count === 0) return null;
    const stat = fs.statSync(STATIC_POINTS);
    return { buffer, etag: `edgs-${count}-${stat.mtimeMs.toFixed(0)}` };
  } catch {
    return null;
  }
}

async function tryStorage(): Promise<{ buffer: Buffer; etag: string } | null> {
  try {
    const { supabaseAdmin } = await import('@/lib/supabaseAdmin');
    const { data, error } = await supabaseAdmin.storage
      .from(POINTS_STORAGE_BUCKET)
      .download(POINTS_STORAGE_OBJECT);
    if (error || !data) return null;
    const buffer = Buffer.from(await data.arrayBuffer());
    const count = pointCount(buffer);
    if (count == null || count === 0) return null;
    return { buffer, etag: `edgs-storage-${count}-${buffer.length}` };
  } catch {
    return null;
  }
}

function dbUrl(): string | null {
  return process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || null;
}

async function buildFromPg(): Promise<{ buffer: Buffer; etag: string } | null> {
  const url = dbUrl();
  if (!url) return null;
  // Streaming Query, not a buffered result: 1.3M rows must not sit in memory.
  // pg has no bundled types here, and *.d.ts is gitignored, so the import is
  // asserted. The specifier stays visible so the standalone tracer keeps `pg`.
  // @ts-expect-error pg ships without type declarations in this install.
  const loaded = await import('pg') as {
    Client?: new (config: { connectionString: string }) => {
      connect(): Promise<void>;
      query(query: unknown): void;
      end(): Promise<void>;
    };
    Query?: new (text: string) => {
      on(event: 'row', listener: (row: Record<string, unknown>) => void): void;
      on(event: 'error', listener: (err: Error) => void): void;
      on(event: 'end', listener: () => void): void;
    };
    default?: {
      Client: new (config: { connectionString: string }) => {
        connect(): Promise<void>;
        query(query: unknown): void;
        end(): Promise<void>;
      };
      Query: new (text: string) => {
        on(event: 'row', listener: (row: Record<string, unknown>) => void): void;
        on(event: 'error', listener: (err: Error) => void): void;
        on(event: 'end', listener: () => void): void;
      };
    };
  };
  const pg = loaded.Client && loaded.Query ? loaded : loaded.default;
  const PgClient = pg?.Client;
  const PgQuery = pg?.Query;
  if (!PgClient || !PgQuery) throw new Error('pg module is missing Client');
  const client = new PgClient({ connectionString: url });
  await client.connect();
  try {
    const builder = new PointsBuilder(1_000_000);
    await new Promise<void>((resolve, reject) => {
      const query = new PgQuery(
        'SELECT id64, x, y, z, star_type FROM galaxy_systems ORDER BY id',
      );
      query.on('row', (row) => {
        const starType = typeof row.star_type === 'string' ? row.star_type : 'unknown';
        builder.add({
          x: Number(row.x),
          y: Number(row.y),
          z: Number(row.z),
          id64: String(row.id64 ?? ''),
          starType: starType as StarClass,
        });
      });
      query.on('error', reject);
      query.on('end', () => resolve());
      client.query(query);
    });
    if (builder.size === 0) return null;
    return { buffer: Buffer.from(builder.build()), etag: `edgs-pg-${builder.size}` };
  } finally {
    await client.end().catch(() => undefined);
  }
}

function remember(file: { buffer: Buffer; etag: string }) {
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

export async function GET(req: Request) {
  const local = tryLocal();
  if (local) return respond(req, local);
  if (memoryCache) return respond(req, memoryCache);

  const stats = await getGalaxyStats().catch(() => null);
  if (stats?.points_uploaded) {
    const stored = await tryStorage();
    if (stored) {
      remember(stored);
      return respond(req, stored);
    }
  }

  if (!building) {
    building = buildFromPg()
      .catch((err: { message?: string }) => {
        console.error('[galaxy/all-systems] pg build failed:', err?.message);
        return null;
      })
      .finally(() => {
        building = null;
      });
  }
  const built = await building;
  if (built) {
    remember(built);
    return respond(req, built);
  }

  return NextResponse.json(
    {
      error: 'Файл точек не найден. Импортируйте дамп (npm run spansh:import) — полный импорт загрузит облако в storage bucket galaxy-data. Сборка напрямую из БД доступна, только если у веб-процесса задан DATABASE_URL или SUPABASE_DB_URL.',
    },
    { status: 404 },
  );
}
