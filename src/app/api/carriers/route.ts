import { NextResponse } from 'next/server';
import { authFromRequest, createServiceClient } from '@/lib/supabaseServer';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const { user } = await authFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const { squadron_id, carrier_name, carrier_id, callsign, is_public } = body;

  if (!squadron_id || !carrier_name || !carrier_id) {
    return NextResponse.json({ error: 'Missing fields' }, { status: 400 });
  }

  const svc = createServiceClient();
  const { data: member } = await svc
    .from('squadron_members')
    .select('*')
    .eq('squadron_id', squadron_id)
    .eq('user_id', user.id)
    .single();

  if (!member) {
    return NextResponse.json({ error: 'Not a squadron member' }, { status: 403 });
  }

  const { data, error } = await svc.from('squadron_carriers').insert({
    squadron_id,
    owner_id: user.id,
    carrier_name,
    carrier_id,
    callsign: callsign || null,
    is_public: is_public ?? true,
  }).select().single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ carrier: data });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const squadronId = url.searchParams.get('squadron_id');

  if (!squadronId) {
    return NextResponse.json({ error: 'squadron_id required' }, { status: 400 });
  }

  const svc = createServiceClient();
  const { data, error } = await svc
    .from('squadron_carriers')
    .select('*')
    .eq('squadron_id', squadronId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ carriers: data });
}
