import { NextResponse } from 'next/server';
import { enabledOAuthProviders } from '@/lib/oauthProviders';
import { vkEnabled } from '@/lib/vkId';

export const dynamic = 'force-dynamic';

/** Only provider names, never OAuth client secrets or Supabase keys. */
export async function GET() {
  return NextResponse.json({ providers: enabledOAuthProviders(), vk: vkEnabled() }, { headers: { 'Cache-Control': 'no-store' } });
}
