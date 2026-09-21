import { NextResponse } from 'next/server';
import { findSystemByName } from '@/lib/galaxySystemsDb';

export const dynamic = 'force-dynamic';

/**
 * One catalog system by name.
 * GET /api/galaxy/systems/by-name?name=Sol
 */
export async function GET(req: Request) {
  const name = new URL(req.url).searchParams.get('name') || '';
  if (!name.trim()) return NextResponse.json({ error: 'name required' }, { status: 400 });
  try {
    const row = await findSystemByName(name);
    if (!row) return NextResponse.json({ error: 'System not found' }, { status: 404 });
    return NextResponse.json({
      id64: row.id64,
      name: row.name,
      x: row.x,
      y: row.y,
      z: row.z,
      main_star: row.main_star,
      star_type: row.star_type,
      star_giant_class: row.star_giant_class,
      needs_permit: row.needs_permit,
      distance_from_sols: row.distance_from_sols,
      distance_from_sgra: row.distance_from_sgra,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal error';
    console.error('[galaxy/systems/by-name]', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
