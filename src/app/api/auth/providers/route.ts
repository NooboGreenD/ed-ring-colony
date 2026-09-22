import { NextResponse } from 'next/server';
import { enabledOAuthProviders } from '@/lib/oauthProviders';
import { resolveVkSettings, resolveYandexSettings, visibleGotrueProviders } from '@/lib/authProviders/settings';

export const dynamic = 'force-dynamic';

/** Only provider names, never OAuth client secrets or Supabase keys. */
export async function GET() {
  // Buttons = allowed by server env ∩ switched on in the admin panel (Авторизация).
  const [providers, vk, yandex] = await Promise.all([visibleGotrueProviders(enabledOAuthProviders()), resolveVkSettings(), resolveYandexSettings()]);
  return NextResponse.json({ providers, vk: vk.enabled, yandex: yandex.enabled }, { headers: { 'Cache-Control': 'no-store' } });
}
