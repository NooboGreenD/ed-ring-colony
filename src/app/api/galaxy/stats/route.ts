import { NextResponse } from 'next/server';
import { getGalaxyStats } from '@/lib/galaxySystemsDb';

export const dynamic = 'force-dynamic';

/**
 * Статус загрузки полной таблицы систем Spansh (для UI: счётчики, лейблы,
 * gate «экспериментальный слой всех систем»).
 * GET /api/galaxy/stats
 */
export async function GET() {
  const stats = await getGalaxyStats().catch(() => null);
  const ready = !!stats && stats.systems_count > 0;
  return NextResponse.json({
    ready,
    systems_count: ready ? stats!.systems_count : 0,
    imported_at: ready ? stats!.imported_at : null,
    source: ready ? stats!.source : null,
  });
}
