import { createClient } from '@supabase/supabase-js';

function getAdminClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      `Missing env vars: NEXT_PUBLIC_SUPABASE_URL=${!!supabaseUrl}, SUPABASE_SERVICE_ROLE_KEY=${!!serviceRoleKey}`
    );
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

/** Admin client with service_role key — bypasses RLS (lazy init) */
export const supabaseAdmin = new Proxy({} as ReturnType<typeof getAdminClient>, {
  get(_, prop) {
    return getAdminClient()[prop as keyof ReturnType<typeof getAdminClient>];
  },
});

/** Factory function for admin client (creates fresh instance) */
export function createAdminClient() {
  return getAdminClient();
}

/** Upsert user profile into the profiles table */
export async function upsertProfile({
  id,
  email,
  cmdr_name,
  avatar_url,
}: {
  id: string;
  email?: string | null;
  cmdr_name?: string | null;
  avatar_url?: string | null;
}): Promise<{ error?: string }> {
  const { error } = await supabaseAdmin
    .from('profiles')
    .upsert(
      {
        id,
        email: email ?? null,
        cmdr_name: cmdr_name ?? null,
        avatar_url: avatar_url ?? null,
      },
      { onConflict: 'id' }
    );

  if (error) {
    console.error('[upsertProfile] Error:', error);
    return { error: error.message };
  }

  return {};
}
