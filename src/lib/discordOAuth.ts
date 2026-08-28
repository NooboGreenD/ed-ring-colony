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
    return 'Redirect URL не разрешён в Supabase. Добавьте ' + (typeof location !== 'undefined' ? location.origin : '') + '/auth/callback';
  }
  return raw;
}

export async function startDiscordOAuth(supabase: SupabaseClient, mode: 'login' | 'link') {
  const options = {
    redirectTo: (typeof location !== 'undefined' ? location.origin : '') + '/auth/callback',
    scopes: 'identify email' as const,
    // Let Supabase handle the redirect — it saves PKCE verifier in cookies
    // and reads them back after Discord redirects back
    skipBrowserRedirect: false,
  };

  if (mode === 'link') {
    const { error } = await supabase.auth.linkIdentity({ provider: 'discord', options });
    if (error) return { error: oauthErrorMessage(error.message) };
    return { error: null };
  }

  const { error } = await supabase.auth.signInWithOAuth({ provider: 'discord', options });
  if (error) return { error: oauthErrorMessage(error.message) };
  return { error: null };
}
