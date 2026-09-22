import { NextResponse } from 'next/server';

import { getUpdateAgentStatus } from '@/lib/updateAgent';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Public liveness label for the top bar («System Online» / «System Update»).
 *
 * Anonymous callers get exactly two things: whether a manual update is running
 * and how far it has got. Stage names are ours, no paths, revisions, hosts,
 * container names or log lines ever leave this route — those stay on the
 * admin-only /api/admin/monitor/update endpoint.
 */
export async function GET() {
  try {
    const status = await getUpdateAgentStatus();
    const update = status.public;
    return NextResponse.json(
      {
        ok: true,
        service: 'ed-ring-colony',
        system: update.active ? 'update' : 'online',
        update,
      },
      {
        headers: {
          // Short enough to feel live, long enough to absorb a page refresh storm.
          'Cache-Control': 'public, max-age=2, stale-if-error=60',
        },
      },
    );
  } catch {
    // The label must never break the site: unknown means "online".
    return NextResponse.json(
      { ok: true, service: 'ed-ring-colony', system: 'online', update: { active: false, percent: 0 } },
      { headers: { 'Cache-Control': 'public, max-age=10, stale-if-error=60' } },
    );
  }
}
