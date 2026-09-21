import { NextResponse } from 'next/server';
import { getSiteUrl } from '@/lib/siteUrl';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Keep legacy links working without rendering any browser Supabase client:
// its automatic URL detection could consume the PKCE code before our signed
// callback checks the flow and the existing account UUID.
export function GET(request: Request) {
  const target = new URL('/api/auth/callback', getSiteUrl());
  target.search = new URL(request.url).search;
  const response = NextResponse.redirect(target, 303);
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}
