import { getPublicSupabaseUrl } from './supabaseUrl';

/**
 * Server-only route to Kong.
 *
 * A browser must never see this value: it may be an unencrypted Docker-network
 * address such as `http://kong:8000`. Keeping it separate from the public URL
 * lets the site work even while the public Supabase subdomain has a bad TLS
 * certificate. If it is unset, legacy deployments retain their old behaviour.
 */
export function getServerSupabaseUrl(): string {
  return (process.env.SUPABASE_INTERNAL_URL?.trim() || getPublicSupabaseUrl()).replace(/\/$/, '');
}
