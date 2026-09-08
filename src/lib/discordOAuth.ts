import type { SupabaseClient } from '@supabase/supabase-js';

export function oauthErrorMessage(raw: string) {
  const m = raw.toLowerCase();
  if (m.includes('manual linking') || m.includes('linking identities')) {
    return 'В Supabase выключена привязка провайдеров: Authentication → Providers → включите Manual linking.';
  }
  if (m.includes('already been registered') || m.includes('already exists') || m.includes('identity is already')) {
    return 'Этот Discord уже привязан к другому аккаунту.';
  }
  if (m.includes('unsupported provider') || m.includes('provider is not enabled')) {
    return 'Провайдер Discord не включён в Authentication → Providers.';
  }
  if (m.includes('redirect')) {
    return 'Redirect URL не разрешён в Supabase. Добавьте ' + (typeof location !== 'undefined' ? location.origin : '') + '/api/auth/callback';
  }
  return raw;
}

function getBaseUrl() {
  if (typeof location !== 'undefined') {
    return location.origin;
  }
  if (typeof process !== 'undefined' && process.env?.NEXT_PUBLIC_SITE_URL) {
    return process.env.NEXT_PUBLIC_SITE_URL;
  }
  return 'https://ed-ring-colony.vercel.app';
}

export async function startDiscordOAuth(supabase: SupabaseClient, mode: 'login' | 'link') {
  // Server route handles the OAuth callback and sets cookies for our domain
  const redirectTo = `${getBaseUrl()}/api/auth/callback`;
  const options = {
    redirectTo,
    scopes: 'identify email' as const,
    skipBrowserRedirect: true,
  };

  console.log('[DiscordOAuth] mode:', mode, 'redirectTo:', redirectTo);

  if (mode === 'link') {
    const { data, error } = await supabase.auth.linkIdentity({ provider: 'discord', options });
    if (error) {
      console.error('[DiscordOAuth] linkIdentity error:', error.message);
      return { error: oauthErrorMessage(error.message), url: null };
    }
    if (data?.url) {
      console.log('[DiscordOAuth] linkIdentity URL:', data.url);
      return { error: null, url: data.url };
    }
    return { error: 'Не получен URL для привязки Discord.', url: null };
  }

  const { data, error } = await supabase.auth.signInWithOAuth({ provider: 'discord', options });
  if (error) {
    console.error('[DiscordOAuth] signInWithOAuth error:', error.message);
    return { error: oauthErrorMessage(error.message), url: null };
  }
  if (data?.url) {
    console.log('[DiscordOAuth] signInWithOAuth URL:', data.url);
    return { error: null, url: data.url };
  }
  return { error: 'Не получен URL для входа через Discord.', url: null };
}
