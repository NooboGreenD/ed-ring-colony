import { NextResponse } from 'next/server';
import { authFromRequest, createServiceClient } from '@/lib/supabaseServer';
import { CapiClient } from '@/lib/capi/client';
import { refreshAccessToken } from '@/lib/capi/oauth';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const { user } = await authFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const url = new URL(req.url);
  const date = url.searchParams.get('date');

  const svc = createServiceClient();
  const { data: tokenRow } = await svc
    .from('capi_tokens')
    .select('*')
    .eq('user_id', user.id)
    .single();

  if (!tokenRow) return NextResponse.json({ error: 'No CAPI token' }, { status: 404 });

  try {
    let accessToken = tokenRow.access_token;
    const client = new CapiClient(accessToken);
    let journal;

    try {
      journal = await client.getJournal(date || undefined);
    } catch (e: any) {
      if (e.message === 'UNAUTHORIZED') {
        const refreshed = await refreshAccessToken(tokenRow.refresh_token);
        await svc.from('capi_tokens').update({
          access_token: refreshed.access_token,
          refresh_token: refreshed.refresh_token,
          expires_at: new Date(Date.now() + refreshed.expires_in * 1000).toISOString(),
        }).eq('user_id', user.id);
        journal = await new CapiClient(refreshed.access_token).getJournal(date || undefined);
      } else {
        throw e;
      }
    }

    return NextResponse.json({ events: journal.events });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
