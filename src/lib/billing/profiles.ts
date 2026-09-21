import { hasSupabaseServiceConfig } from './storage';
import { createAdminClient } from '@/lib/supabaseAdmin';

export interface ResolvedProfile {
  id: string;
  cmdr_name: string | null;
  avatar_url?: string | null;
  email?: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Find a real profile by UUID or exact/ci cmdr_name. Returns null when the
 * pilot does not exist — billing entities are only created for real users.
 * Without a service key (local preview) a synthetic profile is returned.
 */
export async function resolveProfile(q: { userId?: string | null; cmdrName?: string | null }): Promise<ResolvedProfile | null> {
  const userId = (q.userId || '').trim();
  const name = (q.cmdrName || '').trim().replace(/^cmdr\s+/i, '');
  if (!hasSupabaseServiceConfig()) {
    if (!userId && !name) return null;
    return { id: userId || `preview-${name.toLowerCase().replace(/\s+/g, '_')}`, cmdr_name: name || userId };
  }
  const db = createAdminClient();
  if (userId && UUID_RE.test(userId)) {
    const { data } = await db.from('profiles').select('id, cmdr_name, avatar_url, email').eq('id', userId).maybeSingle();
    if (data) return data as ResolvedProfile;
  }
  if (name) {
    const { data } = await db.from('profiles').select('id, cmdr_name, avatar_url, email').ilike('cmdr_name', name).limit(2);
    if (data && data.length === 1) return data[0] as ResolvedProfile;
    if (data && data.length > 1) {
      const exact = data.find((p: any) => p.cmdr_name === name || p.cmdr_name === q.cmdrName);
      if (exact) return exact as ResolvedProfile;
    }
  }
  return null;
}

/** Search profiles by partial name for admin pickers. */
export async function searchProfiles(query: string, limit = 10): Promise<ResolvedProfile[]> {
  const q = query.trim();
  if (!q || !hasSupabaseServiceConfig()) return [];
  const db = createAdminClient();
  const { data } = await db.from('profiles').select('id, cmdr_name, avatar_url').ilike('cmdr_name', `%${q}%`).order('cmdr_name').limit(limit);
  return (data || []) as ResolvedProfile[];
}
