import { NextResponse } from 'next/server';
import { authFromRequest, createServiceClient } from '@/lib/supabaseServer';
import { InaraClient } from '@/lib/inara/client';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const { user } = await authFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const svc = createServiceClient();
  const { data: inaraProfile } = await svc
    .from('inara_profiles')
    .select('*')
    .eq('user_id', user.id)
    .single();

  if (!inaraProfile?.inara_api_key) {
    return NextResponse.json({ error: 'No Inara API key' }, { status: 404 });
  }

  try {
    const client = new InaraClient(inaraProfile.inara_api_key);
    const profile = await client.getCommanderProfile(inaraProfile.cmdr_name || '');

    if (profile) {
      await svc.from('inara_profiles').update({
        inara_cmdr_id: profile.commanderId,
        cmdr_name: profile.commanderName,
        squadron_name: profile.squadronName,
        last_synced_at: new Date().toISOString(),
      }).eq('user_id', user.id);
    }

    return NextResponse.json({ synced: true, profile });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
