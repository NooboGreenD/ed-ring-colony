import { getSiteUrl } from '@/lib/siteUrl';
import { NextRequest, NextResponse } from 'next/server';
import { exchangeCode } from '@/lib/capi/oauth';
import { createServiceClient, createRouteClient } from '@/lib/supabaseServer';
import { CapiClient } from '@/lib/capi/client';
import { assessProfileBinding } from '@/lib/capi/profileBinding';

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
    const cmdrName = profile.commander?.name?.trim() || null;
    const now = new Date().toISOString();

    const { data: siteProfile, error: siteProfileError } = await svc
      .from('profiles')
      .select('cmdr_name')
      .eq('id', user.id)
      .maybeSingle();
    if (siteProfileError) throw new Error(`Не удалось проверить профиль сайта: ${siteProfileError.message}`);

    const binding = assessProfileBinding(siteProfile?.cmdr_name, cmdrName);
    // Заполняем только пустой профиль. Сохранённый ник — пользовательское
    // значение, CAPI не должен молча переименовать публичное досье.
    if (binding.status === 'linked' && cmdrName) {
      const { error } = await svc.from('profiles').update({ cmdr_name: cmdrName }).eq('id', user.id);
      if (error) throw new Error(`Не удалось привязать имя CMDR: ${error.message}`);
    }

    const { error: tokenError } = await svc.from('capi_tokens').upsert({
      user_id: user.id,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
      cmdr_name: cmdrName,
      scope: 'auth capi',
      is_active: true,
      last_synced_at: now,
    }, { onConflict: 'user_id' });
    if (tokenError) throw new Error(`Не удалось сохранить CAPI: ${tokenError.message}`);

    // Записываем профиль сразу, не заставляя пользователя вручную нажимать
    // «Синхронизировать». Дальнейший sync дополнит статистику и журнал.
    const { error: profileError } = await svc.from('capi_profiles').upsert({
      user_id: user.id,
      cmdr_name: cmdrName,
      credits: profile.credits ?? null,
      loan: profile.loan ?? null,
      cqc_rank: profile.ranks?.cqc ?? null,
      frontier_id: profile.commander?.id ?? null,
      combat_rank: profile.ranks?.combat ?? null,
      trade_rank: profile.ranks?.trade ?? null,
      explore_rank: profile.ranks?.explore ?? null,
      empire_rank: profile.ranks?.empire ?? null,
      federation_rank: profile.ranks?.federation ?? null,
      current_ship: profile.currentShip || null,
      current_system: profile.currentSystem?.name || null,
      current_station: profile.currentStation?.name || null,
      ships: profile.ships || [],
      last_updated: now,
    }, { onConflict: 'user_id' });
    if (profileError) throw new Error(`Не удалось сохранить профиль Frontier: ${profileError.message}`);

    const target = new URL('/account/capi', getSiteUrl());
    target.searchParams.set('status', 'success');
    target.searchParams.set('binding', binding.status === 'linked' ? 'linked' : binding.status);
    return NextResponse.redirect(target);
  } catch (err: any) {
    console.error('[CAPI Callback]', err);
    return NextResponse.redirect(new URL(`/account/capi?status=error&message=${encodeURIComponent(err.message)}`, getSiteUrl()));
  }
}
