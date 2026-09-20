import type { SupabaseClient } from '@supabase/supabase-js';
import { startDiscordOAuthAction } from '@/app/login/actions';

export { oauthErrorMessage } from './oauthProviders';

/** Compatibility entry point: use the same signed, server-side PKCE flow everywhere. */
export async function startDiscordOAuth(_supabase: SupabaseClient, mode: 'login' | 'link') {
  return startDiscordOAuthAction(mode);
}
