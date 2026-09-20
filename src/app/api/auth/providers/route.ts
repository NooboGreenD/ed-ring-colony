import { NextResponse } from 'next/server';
import { enabledOAuthProviders } from '@/lib/oauthProviders';

export const dynamic = 'force-dynamic';

/** Only provider names, never OAuth client secrets or Supabase keys. */
export async function GET() {
  return NextResponse.json({ providers: enabledOAuthProviders() }, { headers: { 'Cache-Control': 'no-store' } });
}
