import { NextRequest, NextResponse } from 'next/server';
import { buildAuthUrl, createPkcePair, frontierRedirectUri, normalizeAudience } from '@/lib/capi/oauth';
import { authFromRequest } from '@/lib/supabaseServer';
import { getSiteUrl } from '@/lib/siteUrl';
import {
  CAPI_FLOW_TTL_SECONDS,
  CAPI_LINK_COOKIE,
  CAPI_PKCE_COOKIE,
  CAPI_STATE_COOKIE,
  buildCapiRedirect,
  createOauthState,
  signLinkState,
} from '@/lib/capi/linkState';

export const dynamic = 'force-dynamic';

/**
 * Старт авторизации Frontier.
 *
 * Поток — PKCE, поэтому `FRONTIER_CLIENT_SECRET` (Shared Key от FDEV) не
 * нужен: верификатор кладётся в httpOnly-cookie и предъявляется при обмене
 * кода на токен в `/api/capi/callback`.
 *
 * Что здесь изменилось по сравнению с прежней версией и почему:
 *
 *   • пилот опознаётся ЗДЕСЬ, пока запрос идёт с нашего же сайта и сессия
 *     точно доступна. Раньше это делал только колбэк — переход с домена
 *     Frontier, — и если cookie сессии не доезжала, все этапы «проходили»,
 *     а привязки не появлялось;
 *   • UUID пилота уезжает в подписанной cookie `capi_link`: колбэк
 *     использует её, если сессия почему-то не читается;
 *   • cookies живут 30 минут вместо 10: вход у Frontier с подтверждением по
 *     почте в 10 минут укладывается не всегда;
 *   • `?platform=steam|epic|xbox|psn|frontier` выбирает `audience`, иначе
 *     пилоту со Steam не предложат нужный способ входа.
 */
export async function GET(req: NextRequest) {
  const site = getSiteUrl();

  const { user } = await authFromRequest(req);
  if (!user) {
    // Привязывать некому: честно говорим об этом вместо «успешного» круга
    // по страницам Frontier, который ничего не сохранит.
    return NextResponse.redirect(
      buildCapiRedirect(site, { status: 'error', reason: 'not_logged_in' }),
    );
  }

  const redirectUri = frontierRedirectUri();
  if (!redirectUri) {
    return NextResponse.redirect(
      buildCapiRedirect(site, {
        status: 'error',
        reason: 'redirect_uri_missing',
        detail: 'Задайте FRONTIER_REDIRECT_URI или корректный NEXT_PUBLIC_SITE_URL',
      }),
    );
  }

  const audience = normalizeAudience(
    req.nextUrl.searchParams.get('platform') ?? req.nextUrl.searchParams.get('audience'),
  );
  const state = createOauthState();
  const pkce = createPkcePair();

  let url: string;
  try {
    url = buildAuthUrl(state, { codeChallenge: pkce.challenge, redirectUri, audience });
  } catch (err) {
    return NextResponse.redirect(
      buildCapiRedirect(site, {
        status: 'error',
        reason: 'redirect_uri_missing',
        detail: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  const secure = new URL(site).protocol === 'https:';
  const cookieOptions = {
    httpOnly: true,
    secure,
    // lax — обязательное условие: колбэк приходит переходом с домена
    // Frontier, и при strict cookie бы не отправились вовсе.
    sameSite: 'lax' as const,
    maxAge: CAPI_FLOW_TTL_SECONDS,
    path: '/',
  };

  const response = NextResponse.redirect(url);
  response.cookies.set(CAPI_STATE_COOKIE, state, cookieOptions);
  // Верификатор — одноразовый секрет этого потока: только cookie, никогда не
  // в URL и не в localStorage.
  response.cookies.set(CAPI_PKCE_COOKIE, pkce.verifier, cookieOptions);

  const linkState = signLinkState(user.id);
  if (linkState) response.cookies.set(CAPI_LINK_COOKIE, linkState, cookieOptions);

  return response;
}
