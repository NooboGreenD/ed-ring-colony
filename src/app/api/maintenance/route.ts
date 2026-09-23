import { NextResponse } from 'next/server';

import { readMaintenanceCached } from '@/lib/maintenanceEdge';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Публичный признак технических работ.
 *
 * Нужен заглушке `/maintenance`: она опрашивает этот адрес и сама обновляет
 * страницу, когда копия готова. Секретов здесь нет — только факт работ,
 * причина и время начала, поэтому маршрут открыт всем (и обязан оставаться
 * доступным из-под самой заглушки: /api/* в список исключений прокси входит).
 */
export async function GET() {
  const maintenance = await readMaintenanceCached();
  return NextResponse.json(
    {
      active: maintenance?.active === true,
      reason: maintenance?.active ? maintenance.reason : null,
      startedAt: maintenance?.active ? maintenance.startedAt : null,
      expiresAt: maintenance?.active ? maintenance.expiresAt : null,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
