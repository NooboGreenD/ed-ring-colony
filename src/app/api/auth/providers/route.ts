import { NextResponse } from 'next/server';
import { enabledOAuthProviders } from '@/lib/oauthProviders';
import { resolveVkSettings, visibleGotrueProviders } from '@/lib/authProviders/settings';

export const dynamic = 'force-dynamic';

/** Only provider names, never OAuth client secrets or Supabase keys. */
export async function GET() {
  // Buttons = allowed by server env ∩ switched on in the admin panel (Авторизация).
  const [providers, vk] = await Promise.all([visibleGotrueProviders(enabledOAuthProviders()), resolveVkSettings()]);
  return NextResponse.json({ providers, vk: vk.enabled }, { headers: { 'Cache-Control': 'no-store' } });
}
