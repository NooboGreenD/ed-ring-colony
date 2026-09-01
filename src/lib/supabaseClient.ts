import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export function createSupabaseClient(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        storageKey: 'sb-sgukfplhxdhmkqponwft-auth-token',
      },
    }
  );
}

// Export a singleton for backward compatibility, but it may be stale (created during SSR)
export const supabase = createSupabaseClient();
