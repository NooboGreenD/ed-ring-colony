'use server';

import { cookies } from 'next/headers';
import { createClient } from '@/lib/supabaseServer';
import { getSiteUrl } from '@/lib/siteUrl';
import { createOAuthFlow, OAUTH_FLOW_COOKIE, OAUTH_FLOW_TTL } from '@/lib/oauthFlow';
import { enabledOAuthProviders, isOAuthProvider, OAUTH_PROVIDERS, oauthErrorMessage,
  type OAuthMode, type OAuthProvider } from '@/lib/oauthProviders';

export async function startOAuthAction(provider: OAuthProvider, mode: OAuthMode) {
  if (!isOAuthProvider(provider) || !enabledOAuthProviders().includes(provider) || !['login', 'link'].includes(mode)) {
    return { url: null, error: 'Этот способ входа не включён на сайте.' };
  }
  const { visibleGotrueProviders } = await import('@/lib/authProviders/settings');
  if (!(await visibleGotrueProviders([provider])).includes(provider)) {
    return { url: null, error: 'Этот способ входа отключён администратором.' };
  }
  try {
    const cookieStore = await cookies();
    cookieStore.delete(OAUTH_FLOW_COOKIE);
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (mode === 'link' && !user) return { url: null, error: oauthErrorMessage('not_authenticated') };
    // An already signed-in visitor must add an identity to their current UUID,
    // never inadvertently switch to or create a second commander profile.
    const intent = user ? 'link' : 'login';
    const origin = getSiteUrl();
    const flow = createOAuthFlow(provider, intent, user?.id ?? null);
    const options = { redirectTo: `${origin}/api/auth/callback`,
      scopes: OAUTH_PROVIDERS[provider].scopes, skipBrowserRedirect: true };
    const { data, error } = intent === 'link'
      ? await supabase.auth.linkIdentity({ provider, options })
      : await supabase.auth.signInWithOAuth({ provider, options });
    if (error || !data?.url) return { url: null, error: oauthErrorMessage(error?.message ?? '', provider) };
    cookieStore.set(OAUTH_FLOW_COOKIE, flow, {
      httpOnly: true, sameSite: 'lax', secure: origin.startsWith('https:'), path: '/', maxAge: OAUTH_FLOW_TTL,
    });
    return { url: data.url, error: null };
  } catch {
    // Expected errors are returned, not thrown: production Server Actions hide
    // exception messages. Never log the OAuth URL, code, JWT or PKCE verifier.
    return { url: null, error: 'Не удалось начать авторизацию. Проверьте соединение и настройки сервера.' };
  }
}

export async function startDiscordOAuthAction(mode: OAuthMode) {
  return startOAuthAction('discord', mode);
}

/** VK ID is not a GoTrue provider: the site issues the PKCE request itself. */
export async function startVkAuthAction(mode: OAuthMode) {
  const { createVkFlow, vkAuthorizeUrl, VK_FLOW_COOKIE, VK_FLOW_TTL, vkErrorMessage } = await import('@/lib/vkId');
  const { resolveVkSettings } = await import('@/lib/authProviders/settings');
  const config = await resolveVkSettings();
  if (!config.enabled || !['login', 'link'].includes(mode)) return { url: null, error: vkErrorMessage('not_configured') };
  try {
    const cookieStore = await cookies();
    cookieStore.delete(VK_FLOW_COOKIE);
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (mode === 'link' && !user) return { url: null, error: vkErrorMessage('not_authenticated') };
    const intent = user ? 'link' : 'login';
    const origin = getSiteUrl();
    const { flow, cookie } = createVkFlow(intent, user?.id ?? null);
    cookieStore.set(VK_FLOW_COOKIE, cookie, {
      httpOnly: true, sameSite: 'lax', secure: origin.startsWith('https:'), path: '/', maxAge: VK_FLOW_TTL,
    });
    return { url: vkAuthorizeUrl(flow, config.clientId, origin), error: null };
  } catch {
    return { url: null, error: 'Не удалось начать авторизацию VK. Проверьте настройки сервера.' };
  }
}
