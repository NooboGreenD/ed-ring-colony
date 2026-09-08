// ═══════════════════════════════════════════════════════════════
// Sync squadron member locations from CAPI
// ═══════════════════════════════════════════════════════════════

import { createServiceClient } from '@/lib/supabaseServer';
import { CapiClient } from './client';

export async function syncMemberLocation(userId: string, accessToken: string): Promise<string | null> {
  const client = new CapiClient(accessToken);
  const profile = await client.getProfile();

  if (!profile.currentSystem?.name) return null;

  const svc = createServiceClient();

  // Check privacy settings
  const { data: privacy } = await svc
    .from('location_privacy')
    .select('share_with')
    .eq('user_id', userId)
    .single();

  if (privacy?.share_with === 'none') return null;

  // Get squadron memberships
  const { data: memberships } = await svc
    .from('squadron_members')
    .select('squadron_id')
    .eq('user_id', userId);

  if (!memberships || memberships.length === 0) return null;

  for (const m of memberships) {
    await svc.from('squadron_member_locations').upsert(
      {
        user_id: userId,
        squadron_id: m.squadron_id,
        system_name: profile.currentSystem.name,
        ship_name: profile.currentShip,
        last_seen_at: new Date().toISOString(),
        is_online: true,
      },
      { onConflict: 'user_id,squadron_id' }
    );
  }

  return profile.currentSystem.name;
}
