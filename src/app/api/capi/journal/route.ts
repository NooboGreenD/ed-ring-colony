import { NextResponse } from 'next/server';
import { authFromRequest, createServiceClient } from '@/lib/supabaseServer';
import { capiSession } from '@/lib/capi/session';

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
    const session = await capiSession(svc, user.id, tokenRow);
    const journal = await session.run((client) => client.getJournal(date || undefined));

    return NextResponse.json({ events: journal.events });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
