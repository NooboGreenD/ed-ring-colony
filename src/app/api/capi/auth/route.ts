import { NextResponse } from 'next/server';
import { buildAuthUrl } from '@/lib/capi/oauth';
import { randomBytes } from 'crypto';

export const dynamic = 'force-dynamic';

export async function GET() {
  const state = randomBytes(32).toString('base64url');
  const url = buildAuthUrl(state);

  const response = NextResponse.redirect(url);
  response.cookies.set('capi_state', state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 600,
    path: '/',
  });

  return response;
}
