import { NextResponse } from 'next/server';
import { requireAdmin, errorResponse } from '@/lib/billing/auth';
import { getAuthProviderSettings, publicAuthProviderSettings, updateAuthProviderSettings } from '@/lib/authProviders/settings';
import { AUTH_PROVIDER_REGISTRY, GOTRUE_CALLBACK } from '@/lib/authProviders/registry';
import { enabledOAuthProviders } from '@/lib/oauthProviders';
import { getSiteUrl, DEFAULT_SUPABASE_URL } from '@/lib/siteUrl';
import { vkRedirectUri } from '@/lib/vkId';
import { yandexRedirectUri } from '@/lib/yandexId';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const headers = { 'Cache-Control': 'no-store' };

function envState() {
  // Presence only — never the values.
  const present = (name: string) => Boolean(process.env[name]?.trim());
  return {
    gotrueAllowed: enabledOAuthProviders(),
    emailEnabled: process.env.AUTH_EMAIL_ENABLED === 'true',
    vk: { client_id: present('VK_ID_CLIENT_ID'), client_secret: present('VK_ID_CLIENT_SECRET') },
    yandex: { client_id: present('YANDEX_ID_CLIENT_ID'), client_secret: present('YANDEX_ID_CLIENT_SECRET') },
    frontier: { client_id: present('FRONTIER_CLIENT_ID'), client_secret: present('FRONTIER_CLIENT_SECRET') },
    serviceRole: present('SUPABASE_SERVICE_ROLE_KEY'),
  };
}

export async function GET(req: Request) {
  try {
    const auth = await requireAdmin(req);
    if ('response' in auth) return auth.response;
    const settings = await getAuthProviderSettings();
    const site = getSiteUrl();
    return NextResponse.json({
      success: true,
      registry: AUTH_PROVIDER_REGISTRY,
      settings: publicAuthProviderSettings(settings),
      env: envState(),
      redirects: {
        gotrue: `${process.env.NEXT_PUBLIC_SUPABASE_URL || DEFAULT_SUPABASE_URL}${GOTRUE_CALLBACK}`,
        site: `${site}/api/auth/callback`,
        vk: vkRedirectUri(site),
        yandex: yandexRedirectUri(site),
      },
    }, { headers });
  } catch (err) { return errorResponse(err); }
}

export async function PATCH(req: Request) {
  try {
    const auth = await requireAdmin(req);
    if ('response' in auth) return auth.response;
    const body = await req.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Ожидается объект { <provider>: { enabled, client_id, client_secret, notes } }' }, { status: 400, headers });
    }
    const settings = await updateAuthProviderSettings(body);
    return NextResponse.json({ success: true, settings: publicAuthProviderSettings(settings) }, { headers });
  } catch (err) { return errorResponse(err); }
}
