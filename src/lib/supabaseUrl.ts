import { DEFAULT_SUPABASE_URL } from './siteUrl';

/**
 * Name of the browser session cookie. It deliberately does not depend on the
 * Supabase host: the browser can use the same session when the public gateway
 * is served under the site origin and the server talks to Kong directly.
 */
export const SUPABASE_AUTH_COOKIE_NAME = 'sb-edrc-auth-token';

/**
 * Browser-visible Supabase origin. In the normal setup this is the public
 * Supabase subdomain; in the TLS-resilient setup it is
 * `https://edringcolony.ru/api/supabase` and is proxied by Next to Kong.
 */
export function getPublicSupabaseUrl(): string {
  return (process.env.NEXT_PUBLIC_SUPABASE_URL || DEFAULT_SUPABASE_URL).replace(/\/$/, '');
}

/** Keep SSR browser/server clients on one cookie name across proxy modes. */
export function supabaseCookieOptions() {
  return { name: SUPABASE_AUTH_COOKIE_NAME };
}
