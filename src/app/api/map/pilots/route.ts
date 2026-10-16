import { NextResponse } from 'next/server';
import { authFromRequest, createServiceClient } from '@/lib/supabaseServer';
import { privacyForViewer } from '@/lib/privacy';

export const dynamic = 'force-dynamic';

async function resolveEdsmCoordinates(names: string[]): Promise<Record<string, { x: number; y: number; z: number }>> {
  const results: Record<string, { x: number; y: number; z: number }> = {};
  const BATCH = 25;
  for (let i = 0; i < names.length; i += BATCH) {
    const batch = names.slice(i, i + BATCH);
    const params = new URLSearchParams();
    params.append('showCoordinates', '1');
    for (const n of batch) params.append('systemName[]', n);
    try {
      const res = await fetch('https://www.edsm.net/api-v1/systems?' + params.toString(), {
        headers: { Accept: 'application/json' },
        next: { revalidate: 86400 },
      });
      const data = await res.json();
      for (const item of data || []) {
        if (item?.name && item.coords) {
          results[item.name] = { x: item.coords.x, y: item.coords.y, z: item.coords.z };
        }
      }
    } catch (e: any) {
      console.error('[Map Pilots] EDSM batch error:', e.message);
    }
  }
  return results;
}

export async function GET(req: Request) {
  const svc = createServiceClient();
  let viewerId: string | null = null;
  try {
    const { user } = await authFromRequest(req);
    viewerId = user?.id ?? null;
  } catch {
    viewerId = null;
  }

  const { data: profiles, error } = await svc
    .from('capi_profiles')
    .select('user_id, cmdr_name, current_system, current_ship, last_updated')
    .not('current_system', 'is', null)
    .order('last_updated', { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = profiles || [];
  const userIds = [...new Set(rows.map(p => p.user_id).filter(Boolean))];
  const privacyByUser = new Map<string, unknown>();

  if (userIds.length > 0) {
    const { data: privacyRows } = await svc
      .from('profiles')
      .select('id, privacy_settings')
      .in('id', userIds);
    for (const row of privacyRows || []) {
      if (row?.id) privacyByUser.set(row.id, row.privacy_settings);
    }
  }

  const visibleRows = rows.filter(p => {
    const privacy = privacyForViewer(privacyByUser.get(p.user_id), viewerId, p.user_id);
    return privacy.location;
  });

  const uniqueSystems = [...new Set(visibleRows.map(p => p.current_system))];
  const coords = await resolveEdsmCoordinates(uniqueSystems);

  const pilots = visibleRows
    .map(p => {
      const c = coords[p.current_system];
      return {
        user_id: p.user_id,
        cmdr_name: p.cmdr_name,
        system_name: p.current_system,
        ship_name: p.current_ship,
        last_updated: p.last_updated,
        x: c?.x ?? null,
        y: c?.y ?? null,
        z: c?.z ?? null,
      };
    })
    .filter(p => p.x !== null);

  return NextResponse.json({ pilots }, { headers: { 'Cache-Control': 'no-store' } });
}
