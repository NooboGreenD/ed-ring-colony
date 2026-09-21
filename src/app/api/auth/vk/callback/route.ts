import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { getSiteUrl } from '@/lib/siteUrl';
import { ensureUserProfile } from '@/lib/ensureProfile';
import { createAdminClient } from '@/lib/supabaseAdmin';
import { exchangeVkCode, fetchVkUserInfo, readVkFlow, vkConfig, VK_FLOW_COOKIE, VK_PROVIDER, VkAuthError } from '@/lib/vkId';
import { linkVkIdentity, resolveVkLogin, sessionTokenHash } from '@/lib/vkAccount';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const origin = getSiteUrl();
  const params = new URL(request.url).searchParams;
  const flow = readVkFlow(request.cookies.get(VK_FLOW_COOKIE)?.value);
  const destination = flow?.mode === 'link' ? '/account' : '/login';
  const staged: { name: string; value: string; options: CookieOptions }[] = [];
  const jar = new Map(request.cookies.getAll().map(cookie => [cookie.name, cookie.value]));

  function redirect(path: string, error?: string, applySession = false) {
    const url = new URL(path, origin);
    if (error) url.searchParams.set('oauth_error', error);
    else if (flow?.mode === 'link') url.searchParams.set('oauth', 'linked');
    url.searchParams.set('provider', VK_PROVIDER);
    const response = NextResponse.redirect(url, 302);
    if (applySession) {
      for (const { name, value, options } of staged) response.cookies.set(name, value, options);
      response.cookies.delete('sb-session');
    }
    response.cookies.delete(VK_FLOW_COOKIE);
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('Referrer-Policy', 'no-referrer');
    return response;
  }

  const config = vkConfig();
  if (!config.enabled) return redirect('/login', 'not_configured');
  if (!flow) return redirect('/login', 'expired');
  if (params.has('error')) return redirect(destination, params.get('error') === 'access_denied' ? 'cancelled' : 'vk_failed');
  const code = params.get('code');
  const deviceId = params.get('device_id');
  const state = params.get('state');
  if (!code || !deviceId) return redirect(destination, 'no_code');
  if (!state || state !== flow.state) return redirect(destination, 'state_mismatch');

  const supabase = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll: () => Array.from(jar, ([name, value]) => ({ name, value })),
      setAll(items: typeof staged) { for (const cookie of items) { jar.set(cookie.name, cookie.value); staged.push(cookie); } },
    },
  });

  try {
    const admin = createAdminClient();
    const token = await exchangeVkCode({ code, deviceId, state, flow, clientId: config.clientId,
      clientSecret: config.clientSecret || undefined, origin });
    const info = await fetchVkUserInfo(token.accessToken, config.clientId);
    if (token.userId && token.userId !== info.user_id) return redirect(destination, 'vk_failed');

    if (flow.mode === 'link') {
      const { data: { user }, error } = await supabase.auth.getUser();
      if (error || !user) return redirect('/login', 'not_authenticated');
      if (user.id !== flow.userId) return redirect('/account', 'account_mismatch');
      await linkVkIdentity(admin, user.id, info);
      return redirect('/account');
    }

    const { user: account } = await resolveVkLogin(admin, info, origin);
    if (!account.email) return redirect('/login', 'session_failed');
    const hash = await sessionTokenHash(admin, account.email);
    const { data, error } = await supabase.auth.verifyOtp({ type: 'magiclink', token_hash: hash });
    if (error || !data.session || data.session.user.id !== account.id) return redirect('/login', 'session_failed');
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user || user.id !== account.id) return redirect('/login', 'session_failed');
    try { await ensureUserProfile(supabase, user); }
    catch { console.warn('[VK Callback] Profile creation will be retried from account'); }
    return redirect('/account', undefined, true);
  } catch (error) {
    const code = error instanceof VkAuthError ? error.code : 'vk_failed';
    if (!(error instanceof VkAuthError) || code === 'db_failed') console.error('[VK Callback]', error instanceof Error ? error.message : error);
    return redirect(destination, code === 'db_failed' ? 'vk_failed' : code);
  }
}
