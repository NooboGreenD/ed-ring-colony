import { getSiteUrl } from '@/lib/siteUrl';
import { NextRequest, NextResponse } from 'next/server';
import { exchangeCode } from '@/lib/capi/oauth';
import { createServiceClient, createRouteClient } from '@/lib/supabaseServer';
import { CapiClient } from '@/lib/capi/client';

export const dynamic = 'force-dynamic';

/**
 * Обмен кода Frontier на токены.
 *
 * `code_verifier` берётся из httpOnly-cookie, которую положил
 * `/api/capi/auth`: это PKCE, поэтому обмен работает без Shared Key.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const cookieHeader = req.headers.get('cookie') || '';
  const readCookie = (name: string) => cookieHeader.match(new RegExp(`${name}=([^;]+)`))?.[1];
  const cookieState = readCookie('capi_state');
  const codeVerifier = readCookie('capi_pkce');

  if (!code || !state || state !== cookieState) {
    return NextResponse.redirect(new URL('/account/capi?status=error&message=invalid_state', getSiteUrl()));
  }

  try {
    const tokens = await exchangeCode(code, { codeVerifier: codeVerifier ? decodeURIComponent(codeVerifier) : null });
    const capi = new CapiClient(tokens.access_token);
    const profile = await capi.getProfile();

    const supabase = createRouteClient(req);
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.redirect(new URL('/account/capi?status=error&message=not_logged_in', getSiteUrl()));
    }

    const svc = createServiceClient();
    const cmdrName = profile.commander?.name || null;

    await svc.from('capi_tokens').upsert({
      user_id: user.id,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
      cmdr_name: cmdrName,
      scope: 'auth capi',
      is_active: true,
      last_synced_at: new Date().toISOString(),
    }, { onConflict: 'user_id' });

    return NextResponse.redirect(new URL('/account/capi?status=success', getSiteUrl()));
  } catch (err: any) {
    console.error('[CAPI Callback]', err);
    return NextResponse.redirect(new URL(`/account/capi?status=error&message=${encodeURIComponent(err.message)}`, getSiteUrl()));
  }
}
