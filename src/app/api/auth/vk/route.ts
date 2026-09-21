import { NextResponse, type NextRequest } from 'next/server';
import { createRouteClient } from '@/lib/supabaseServer';
import { createAdminClient } from '@/lib/supabaseAdmin';
import { enabledOAuthProviders } from '@/lib/oauthProviders';
import { canUnlinkVk } from '@/lib/vkId';
import { resolveVkSettings } from '@/lib/authProviders/settings';
import { findVkIdentityByUser, unlinkVkIdentity } from '@/lib/vkAccount';
import { getSiteUrl } from '@/lib/siteUrl';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };

/** Current user's VK link status. No VK tokens are stored, so nothing sensitive to leak. */
export async function GET(request: NextRequest) {
  const supabase = createRouteClient(request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'not_authenticated' }, { status: 401, headers });
  const { data } = await supabase.from('vk_identities').select('vk_user_id, display_name, avatar_url').eq('user_id', user.id).maybeSingle();
  return NextResponse.json({ enabled: (await resolveVkSettings()).enabled, linked: Boolean(data),
    vk: data ? { id: data.vk_user_id, name: data.display_name, avatar: data.avatar_url } : null,
    canUnlink: Boolean(data) && canUnlinkVk(user, enabledOAuthProviders()) }, { headers });
}

/** Unlink VK from the signed-in account; refuses to remove the last usable login. */
export async function DELETE(request: NextRequest) {
  if (request.headers.get('origin') !== getSiteUrl()) return NextResponse.json({ error: 'forbidden' }, { status: 403, headers });
  const supabase = createRouteClient(request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'not_authenticated' }, { status: 401, headers });
  try {
    const admin = createAdminClient();
    const identity = await findVkIdentityByUser(admin, user.id);
    if (!identity) return NextResponse.json({ ok: true, linked: false }, { headers });
    if (!canUnlinkVk(user, enabledOAuthProviders())) return NextResponse.json({ error: 'last_identity' }, { status: 409, headers });
    await unlinkVkIdentity(admin, user.id);
    return NextResponse.json({ ok: true, linked: false }, { headers });
  } catch {
    return NextResponse.json({ error: 'vk_failed' }, { status: 500, headers });
  }
}
