// ═══════════════════════════════════════════════════════════════
// Положение членов эскадрильи по данным CAPI
// ═══════════════════════════════════════════════════════════════
//
// Принимает уже полученный профиль, токен или клиент. Вариант с профилем —
// основной: синк и так только что забрал `/profile`, а Frontier просит не
// частить (не больше пары запросов в секунду, в идеале — один в минуту).
// Раньше функция всегда ходила в CAPI сама, то есть каждый синк дёргал
// `/profile` дважды.

import { createServiceClient } from '@/lib/supabaseServer';
import { CapiClient } from './client.ts';
import type { CapiProfile } from '@/types/capi';

function isProfile(value: unknown): value is CapiProfile {
  return typeof value === 'object' && value !== null && 'cmdrName' in value;
}

export async function syncMemberLocation(
  userId: string,
  source: string | CapiClient | CapiProfile,
): Promise<string | null> {
  const profile: CapiProfile = isProfile(source)
    ? source
    : await (typeof source === 'string' ? new CapiClient(source) : source).getProfile();

  if (!profile.currentSystem?.name) return null;

  const svc = createServiceClient();

  // Check privacy settings
  const { data: privacy } = await svc
    .from('location_privacy')
    .select('share_with')
    .eq('user_id', userId)
    .maybeSingle();

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
