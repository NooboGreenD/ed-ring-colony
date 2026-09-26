import { NextResponse } from 'next/server';
import { authFromRequest, createServiceClient } from '@/lib/supabaseServer';
import { assessProfileBinding } from '@/lib/capi/profileBinding';

export const dynamic = 'force-dynamic';

/** Возвращает данные CAPI и проверяемую привязку к `profiles.id`. */
export async function GET(req: Request) {
  const { user } = await authFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const svc = createServiceClient();
  const [{ data: profile }, { data: siteProfile }, { data: token }] = await Promise.all([
    svc.from('capi_profiles').select('*').eq('user_id', user.id).maybeSingle(),
    svc.from('profiles').select('cmdr_name').eq('id', user.id).maybeSingle(),
    svc.from('capi_tokens').select('cmdr_name,expires_at,last_synced_at,is_active').eq('user_id', user.id).maybeSingle(),
  ]);

  const binding = assessProfileBinding(siteProfile?.cmdr_name, profile?.cmdr_name ?? token?.cmdr_name);
  return NextResponse.json({
    profile,
    binding: {
      ...binding,
      userId: user.id,
      capiName: profile?.cmdr_name ?? token?.cmdr_name ?? null,
      siteName: siteProfile?.cmdr_name ?? null,
      tokenActive: token?.is_active !== false && Boolean(token),
      expiresAt: token?.expires_at ?? null,
      lastSyncedAt: token?.last_synced_at ?? profile?.last_updated ?? null,
    },
  });
}
