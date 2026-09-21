import { NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { getGalaxyStats } from '@/lib/galaxySystemsDb';
import {
  PointsBuilder,
  type StarClass,
} from '@/lib/galaxySystems';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const STATIC_POINTS = path.join(process.cwd(), 'public', 'data', 'galaxy-systems-points.bin');
const STATIC_META = `${STATIC_POINTS}.meta.json`;

interface DbRow {
  id: number;
  id64: string;
  x: number;
  y: number;
  z: number;
  star_type: StarClass;
}

/**
 * Экспериментальный слой «все системы» на карте галактики.
 *
 * Отдаёт бинарный файл точек (формат edgs-v1, см. src/lib/galaxySystems.ts):
 * позиции + класс звезды + id64 для каждой из ~1.3M систем.
 *
 * Стратегия: если импорт уже сгенерировал статику в public/data — отдаём её
 * (мгновенно). Иначе (например, импорт шёл через supabase-js без точки на
 * файловой системе web-контейнера) собираем файл из БД на лету по ORDER BY id
 * и кэшируем на диске, чтобы повторные запросы были дешёвыми.
 */

function tryStaticFile(): { buffer: Buffer; etag: string } | null {
  try {
    if (!fs.existsSync(STATIC_POINTS) || !fs.existsSync(STATIC_META)) return null;
    const meta = JSON.parse(fs.readFileSync(STATIC_META, 'utf8')) as { count?: number; imported_at?: string };
    const stat = fs.statSync(STATIC_POINTS);
    if (typeof meta.count !== 'number' || meta.count === 0) return null;
    return {
      buffer: fs.readFileSync(STATIC_POINTS),
      etag: `edgs-${meta.count}-${stat.mtimeMs.toFixed(0)}`,
    };
  } catch {
    return null;
  }
}

async function buildFromDb(expectedCount: number): Promise<{ buffer: ArrayBuffer; count: number }> {
  const { supabaseAdmin } = await import('@/lib/supabaseAdmin');
  const builder = new PointsBuilder(Math.max(expectedCount, 1_000_000));
  const CHUNK = 100_000;
  for (let from = 0; from < expectedCount; from += CHUNK) {
    const to = Math.min(from + CHUNK, expectedCount) - 1;
    const { data, error } = await supabaseAdmin
      .from('galaxy_systems')
      .select('id,id64,x,y,z,star_type')
      .order('id', { ascending: true })
      .range(from, to);
    if (error) throw new Error(`points build failed: ${error.message}`);
    for (const row of (data || []) as DbRow[]) {
      builder.add({ x: row.x, y: row.y, z: row.z, id64: row.id64, starType: row.star_type });
    }
  }
  return { buffer: builder.build(), count: builder.size };
}

export async function GET(req: Request) {
  const stats = await getGalaxyStats().catch(() => null);
  if (!stats || stats.systems_count === 0) {
    return NextResponse.json(
      { error: 'Galaxy systems are not imported yet. Run: npm run spansh:import' },
      { status: 404 },
    );
  }

  const ifNoneMatch = req.headers.get('if-none-match');
  const headers = { 'content-type': 'application/octet-stream' };

  const staticFile = tryStaticFile();
  if (staticFile) {
    if (ifNoneMatch === staticFile.etag) {
      return new NextResponse(null, { status: 304, headers: { ...headers, etag: staticFile.etag } });
    }
    return new NextResponse(new Uint8Array(staticFile.buffer), {
      status: 200,
      headers: {
        ...headers,
        etag: staticFile.etag,
        'cache-control': 'public, max-age=3600',
      },
    });
  }

  try {
    const { buffer, count } = await buildFromDb(stats.systems_count);
    // Persist for the next cold start / other replicas in this container.
    try {
      fs.mkdirSync(path.dirname(STATIC_POINTS), { recursive: true });
      fs.writeFileSync(STATIC_POINTS, Buffer.from(buffer));
      fs.writeFileSync(
        path.resolve(STATIC_META),
        JSON.stringify({ format: 'edgs-v1', count, imported_at: new Date().toISOString(), source: 'built-from-db', bytes: buffer.byteLength }, null, 2),
      );
    } catch {
      // read-only FS — ignore, we still serve from memory
    }
    const etag = `edgs-${count}-${stats.imported_at || 'db'}`;
    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        ...headers,
        etag,
        'cache-control': 'public, max-age=3600',
      },
    });
  } catch (err: any) {
    console.error('[galaxy/all-systems] build failed:', err?.message);
    return NextResponse.json({ error: 'Failed to build points file from DB' }, { status: 500 });
  }
}
