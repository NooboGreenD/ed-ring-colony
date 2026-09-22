import { NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/billing/auth';
import { getServerMonitorSnapshot } from '@/lib/serverMonitor';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Privileged operational snapshot. All Docker access stays behind the private
 * monitor agent; this route never receives a Docker socket or returns raw
 * errors, logs, environment values, URLs, IDs, or credentials.
 */
export async function GET(request: Request) {
  try {
    const auth = await requireAdmin(request);
    if ('response' in auth) return auth.response;

    const monitor = await getServerMonitorSnapshot();
    return NextResponse.json(
      { success: true, monitor },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch {
    console.error('[monitor] unable to collect server status');
    return NextResponse.json(
      { error: 'Не удалось собрать статус сервера. Проверьте закрытые журналы приложения.' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
