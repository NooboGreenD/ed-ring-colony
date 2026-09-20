import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { getSiteUrl } from '@/lib/siteUrl';
import { readOAuthFlow, OAUTH_FLOW_COOKIE } from '@/lib/oauthFlow';
import { ensureUserProfile } from '@/lib/ensureProfile';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  // request.url can be http://web:3000 behind nginx. Do not use it for browser
  // redirects or send the access token to a URL constructed from Host headers.
  const origin = getSiteUrl();
  const params = new URL(request.url).searchParams;
  const flow = readOAuthFlow(request.cookies.get(OAUTH_FLOW_COOKIE)?.value);
  const destination = flow?.mode === 'link' ? '/account' : '/login';
  const staged: { name: string; value: string; options: CookieOptions }[] = [];
  const jar = new Map(request.cookies.getAll().map(cookie => [cookie.name, cookie.value]));

  function redirect(path: string, error?: string, applySession = false) {
    const url = new URL(path, origin);
    if (error) url.searchParams.set('oauth_error', error);
    else if (flow?.mode === 'link') url.searchParams.set('oauth', 'linked');
    if (flow) url.searchParams.set('provider', flow.provider);
    const response = NextResponse.redirect(url, 302);
    if (applySession) {
      for (const { name, value, options } of staged) response.cookies.set(name, value, options);
      response.cookies.delete('sb-session'); // remove the pre-SSR legacy cookie
    }
    response.cookies.delete(OAUTH_FLOW_COOKIE);
    for (const name of jar.keys()) {
      if (/-auth-token-code-verifier(?:\.\d+)?$/.test(name)) response.cookies.delete(name);
    }
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('Referrer-Policy', 'no-referrer');
    return response;
  }

  if (!flow) return redirect('/login', 'expired');
  if (params.has('error') || params.has('error_description')) {
    // Use bounded error codes, never reflect arbitrary provider descriptions,
    // tokens or email addresses into the browser URL/logs.
    const denied = params.get('error') === 'access_denied';
    const alreadyLinked = /identity_already_exists|already.*(registered|linked)/i.test(
      `${params.get('error_code')} ${params.get('error_description')}`);
    return redirect(destination, alreadyLinked ? 'identity_already_exists' : denied ? 'cancelled' : 'oauth_failed');
  }
  const code = params.get('code');
  if (!code) return redirect(destination, 'no_code');

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
      cookies: {
        getAll: () => Array.from(jar, ([name, value]) => ({ name, value })),
        setAll(items: { name: string; value: string; options: CookieOptions }[]) {
          for (const cookie of items) {
            jar.set(cookie.name, cookie.value);
            staged.push(cookie);
          }
        },
      },
    },
  );

  try {
    if (flow.mode === 'link') {
      const { data: { user }, error } = await supabase.auth.getUser();
      if (error || !user) return redirect('/login', 'not_authenticated');
      if (user.id !== flow.userId) return redirect('/account', 'account_mismatch');
    }
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (error || !data.session) return redirect(destination, 'expired');
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) return redirect(destination, 'oauth_failed');
    if (flow.mode === 'link' && (user.id !== flow.userId ||
        !user.identities?.some(identity => identity.provider === flow.provider))) {
      // Do not send a different account's session cookies to the browser.
      return redirect('/account', 'account_mismatch');
    }
    try {
      // Same authenticated client, direct DB request; no self-HTTP round trip,
      // service role write, account merge, or overwriting a CMDR nickname.
      await ensureUserProfile(supabase, user);
    } catch {
      // /account retries creation. A DB outage must not destroy a valid login.
      console.warn('[Auth Callback] Profile creation will be retried from account');
    }
    return redirect('/account', undefined, true);
  } catch {
    return redirect(destination, 'oauth_failed');
  }
}
