import { NextResponse } from 'next/server';
import { systemById64 } from '@/lib/galaxySystemsDb';

export const dynamic = 'force-dynamic';

/**
 * Одна система из полной таблицы Spansh по ID64.
 * GET /api/galaxy/systems/:id64
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id64: string }> }) {
  const { id64 } = await params;
  try {
    const row = await systemById64(id64);
    if (!row) return NextResponse.json({ error: 'System not found' }, { status: 404 });
    return NextResponse.json({
      id64: row.id64,
      name: row.name,
      x: row.x, y: row.y, z: row.z,
      main_star: row.main_star,
      star_type: row.star_type,
      star_giant_class: row.star_giant_class,
      needs_permit: row.needs_permit,
      distance_from_sols: row.distance_from_sols,
      distance_from_sgra: row.distance_from_sgra,
    });
  } catch (err: any) {
    console.error('[galaxy/systems/[id64]]', err?.message);
    return NextResponse.json({ error: err?.message || 'Internal error' }, { status: 500 });
  }
}
