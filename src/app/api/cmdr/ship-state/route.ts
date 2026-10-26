import { createHash } from 'crypto';
import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { authFromRequest } from '@/lib/supabaseServer';

export const dynamic = 'force-dynamic';

function tokenHash(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

async function helperUserId(token: unknown): Promise<string | null> {
  if (typeof token !== 'string' || !token.trim()) return null;
  const { data } = await supabaseAdmin.from('api_tokens').select('user_id,is_revoked')
    .eq('token_hash', tokenHash(token.trim())).maybeSingle();
  return data && !data.is_revoked ? data.user_id : null;
}

/** Private live snapshot for the signed-in owner only. */
export async function GET(req: Request) {
  const { user } = await authFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Требуется авторизация' }, { status: 401 });
  const { data, error } = await supabaseAdmin.from('pilot_ship_state')
    .select('loadout,current_system,fuel_level,cargo_count,received_at,loadout_at')
    .eq('user_id', user.id).maybeSingle();
  if (error) return NextResponse.json({ error: 'Не удалось получить состояние корабля' }, { status: 500 });
  return NextResponse.json({ state: data ?? null }, { headers: { 'Cache-Control': 'no-store, private' } });
}

/** Helper writes journal state with its existing project token (no CAPI auth). */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const userId = await helperUserId(body?.token);
    if (!userId) return NextResponse.json({ error: 'Неверный или отозванный токен Helper' }, { status: 401 });

    const loadout = body.loadout;
    if (loadout != null && (!loadout || typeof loadout !== 'object' || loadout.event !== 'Loadout'
      || typeof loadout.Ship !== 'string' || !Array.isArray(loadout.Modules) || loadout.Modules.length > 256)) {
      return NextResponse.json({ error: 'Некорректное событие Loadout' }, { status: 400 });
    }
    if (loadout && JSON.stringify(loadout).length > 200_000) {
      return NextResponse.json({ error: 'Loadout превышает допустимый размер' }, { status: 413 });
    }
    const currentSystem = typeof body.current_system === 'string' ? body.current_system.trim().slice(0, 200) : '';
    const fuel = Number(body.fuel_level);
    const cargo = Number(body.cargo_count);
    const payload: Record<string, unknown> = {
      user_id: userId,
      received_at: new Date().toISOString(),
    };
    if (loadout) {
      payload.loadout = loadout;
      payload.loadout_at = typeof loadout.timestamp === 'string' ? loadout.timestamp : new Date().toISOString();
    }
    if (currentSystem) payload.current_system = currentSystem;
    if (Number.isFinite(fuel) && fuel >= 0 && fuel <= 100_000) payload.fuel_level = fuel;
    if (Number.isFinite(cargo) && cargo >= 0 && cargo <= 1_000_000) payload.cargo_count = Math.floor(cargo);

    const { error } = await supabaseAdmin.from('pilot_ship_state').upsert(payload, { onConflict: 'user_id' });
    if (error) {
      console.error('[cmdr/ship-state] upsert:', error.message);
      return NextResponse.json({ error: 'Не удалось сохранить состояние корабля' }, { status: 502 });
    }
    return NextResponse.json({ ok: true, received_at: payload.received_at });
  } catch (error) {
    console.error('[cmdr/ship-state] POST:', error);
    return NextResponse.json({ error: 'Некорректный запрос' }, { status: 400 });
  }
}
