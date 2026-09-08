import { createClient as createJsClient, type SupabaseClient, type User } from '@supabase/supabase-js';
import { createClient as createCookieClient } from '@/lib/supabaseServer';

function jwtFromHeader(req: Request): string | null {
  const auth = req.headers.get('authorization') || req.headers.get('x-journal-token') || '';
  if (auth.toLowerCase().startsWith('bearer ')) {
    const jwt = auth.slice(7).trim();
    return jwt || null;
  }
  const raw = auth.trim();
  return raw || null;
}

function tokenClient(jwt: string): SupabaseClient {
  return createJsClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    },
  );
}

export async function authFromRequest(
  req: Request,
  bodyToken?: string | null,
): Promise<{ user: User | null; supabase: SupabaseClient }> {
  const jwt = jwtFromHeader(req) || (typeof bodyToken === 'string' ? bodyToken.trim() : '') || null;
  if (jwt) {
    const supabase = tokenClient(jwt);
    const { data } = await supabase.auth.getUser(jwt);
    if (data.user) return { user: data.user, supabase };
  }
  const supabase = await createCookieClient();
  const { data } = await supabase.auth.getUser();
  return { user: data.user ?? null, supabase };
}
