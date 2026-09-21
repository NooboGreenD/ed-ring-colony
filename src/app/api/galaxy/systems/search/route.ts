import { NextResponse } from 'next/server';
import { searchSystems, getGalaxyStats } from '@/lib/galaxySystemsDb';

export const dynamic = 'force-dynamic';

/**
 * Autocomplete по полной таблице систем Spansh (galaxy_systems).
 * GET /api/galaxy/systems/search?q=Sol&limit=8
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const q = (searchParams.get('q') || '').trim();
  const limit = Math.min(Math.max(Number(searchParams.get('limit')) || 8, 1), 20);
  if (!q) return NextResponse.json({ results: [] });

  try {
    const results = await searchSystems(q, limit);
    return NextResponse.json({
      results: results.map((r) => ({
        id64: r.id64,
        name: r.name,
        x: r.x, y: r.y, z: r.z,
        main_star: r.main_star,
        star_type: r.star_type,
        distance_from_sols: r.distance_from_sols != null ? Number(r.distance_from_sols.toFixed(1)) : null,
      })),
    });
  } catch (err: any) {
    // Таблица ещё не импортирована (или DB недоступна) → пустой результат;
    // вызывающая сторона сама имеет fallback (EDSM).
    console.error('[galaxy/systems/search]', err?.message);
    return NextResponse.json({ results: [] });
  }
}

export async function HEAD() {
  const stats = await getGalaxyStats().catch(() => null);
  return new NextResponse(null, {
    status: stats && stats.systems_count > 0 ? 200 : 404,
  });
}
