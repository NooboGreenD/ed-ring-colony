import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const MAX_RETRIES = 3;
async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchEdsmSearch(query: string, attempt = 1): Promise<any[]> {
  const params = new URLSearchParams();
  params.append('systemName', query);
  params.append('showCoordinates', '1');
  params.append('showId', '1');
  try {
    const res = await fetch('https://www.edsm.net/api-v1/systems?' + params.toString(), {
      headers: { Accept: 'application/json' },
      next: { revalidate: 86400 },
    });
    if (!res.ok) throw new Error(`EDSM HTTP ${res.status}`);
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch (err: any) {
    if (attempt < MAX_RETRIES) { await sleep(1000 * attempt); return fetchEdsmSearch(query, attempt + 1); }
    throw err;
  }
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const query = url.searchParams.get('q')?.trim();
    if (!query || query.length < 2) {
      return NextResponse.json({ error: 'Query must be at least 2 characters' }, { status: 400 });
    }
    const systems = await fetchEdsmSearch(query);
    const mapped = systems.map((s: any) => ({
      id: s.id,
      name: s.name,
      coords: s.coords ? { x: s.coords.x, y: s.coords.y, z: s.coords.z } : null,
      distance: s.distance,
      bodyCount: s.bodyCount,
      requirePermit: s.requirePermit,
      permitName: s.permitName,
      isMainStar: s.isMainStar,
    }));
    return NextResponse.json({ systems: mapped, count: mapped.length });
  } catch (err: any) {
    console.error('[EDSM Search] Error:', err);
    return NextResponse.json({ error: err.message || 'Internal error' }, { status: 500 });
  }
}
