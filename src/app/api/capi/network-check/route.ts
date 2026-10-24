import { NextResponse } from 'next/server';
import { authFromRequest } from '@/lib/supabaseServer';
import { probeCapiNetwork } from '@/lib/capi/networkProbe';

export const dynamic = 'force-dynamic';
export const maxDuration = 10;

/**
 * Check DNS and HTTPS egress from the website server to Frontier's CAPI hosts.
 * The request is authenticated and intentionally sends no user's CAPI token.
 */
export async function GET(req: Request) {
  const { user } = await authFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const result = await probeCapiNetwork();
  return NextResponse.json({
    scope: 'server-to-frontier; no commander token was sent',
    ...result,
  }, {
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  });
}
