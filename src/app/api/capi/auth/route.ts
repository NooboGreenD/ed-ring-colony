import { NextResponse } from 'next/server';
import { buildAuthUrl, createPkcePair } from '@/lib/capi/oauth';
import { randomBytes } from 'crypto';

export const dynamic = 'force-dynamic';

/**
 * Старт авторизации Frontier.
 *
 * Поток — PKCE, поэтому `FRONTIER_CLIENT_SECRET` (Shared Key от FDEV) не
 * нужен: верификатор кладётся в httpOnly-cookie и предъявляется при обмене
 * кода на токен в `/api/capi/callback`.
 */
export async function GET() {
  const state = randomBytes(32).toString('base64url');
  const pkce = createPkcePair();
  const url = buildAuthUrl(state, { codeChallenge: pkce.challenge });

  const secure = process.env.NODE_ENV === 'production';
  const response = NextResponse.redirect(url);
  response.cookies.set('capi_state', state, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    maxAge: 600,
    path: '/',
  });
  // Верификатор — одноразовый секрет этого потока: только cookie, никогда не
  // в URL и не в localStorage.
  response.cookies.set('capi_pkce', pkce.verifier, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    maxAge: 600,
    path: '/',
  });

  return response;
}
