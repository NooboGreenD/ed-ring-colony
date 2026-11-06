import { createHash } from 'crypto';
import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { authFromRequest } from '@/lib/supabaseServer';
import { apiTranslate } from '@/lib/i18n/apiT';

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

/**
 * Website session publishes a route; Colonial Helper explicitly consumes it
 * with its existing project token. This is a tracker import, not a writer for
 * the game's NavRoute.json.
 */
export async function POST(req: Request) {
  const t = await apiTranslate();
  try {
    const body = await req.json();
    if (body?.action === 'poll') {
      const userId = await helperUserId(body.token);
      if (!userId) return NextResponse.json({ error: t('api.helperTokenInvalid') }, { status: 401 });
      const { data, error } = await supabaseAdmin.from('helper_route_inbox')
        .update({ consumed_at: new Date().toISOString() })
        .eq('user_id', userId).is('consumed_at', null)
        .select('route,created_at').maybeSingle();
      if (error) return NextResponse.json({ error: t('api.cmdrRouteFetchFailed') }, { status: 502 });
      return NextResponse.json({ ok: true, route: data?.route ?? null, created_at: data?.created_at ?? null });
    }

    const { user } = await authFromRequest(req);
    if (!user) return NextResponse.json({ error: t('api.authRequiredSite') }, { status: 401 });
    const route = body?.route;
    if (!Array.isArray(route) || route.length < 2 || route.length > 500) {
      return NextResponse.json({ error: t('api.cmdrRouteSize') }, { status: 400 });
    }
    const cleanRoute = [];
    for (const point of route) {
      const name = typeof point?.name === 'string' ? point.name.trim().slice(0, 200) : '';
      const x = Number(point?.x), y = Number(point?.y), z = Number(point?.z);
      if (!name || ![x, y, z].every(Number.isFinite)) {
        return NextResponse.json({ error: t('api.cmdrRouteSystemInvalid') }, { status: 400 });
      }
      cleanRoute.push({ name, x, y, z });
    }
    const payload = { user_id: user.id, route: cleanRoute, created_at: new Date().toISOString(), consumed_at: null };
    const { error } = await supabaseAdmin.from('helper_route_inbox').upsert(payload, { onConflict: 'user_id' });
    if (error) {
      console.error('[cmdr/route] publish:', error.message);
      return NextResponse.json({ error: t('api.cmdrRouteSendFailed') }, { status: 502 });
    }
    return NextResponse.json({ ok: true, systems: cleanRoute.length });
  } catch (error) {
    console.error('[cmdr/route] POST:', error);
    return NextResponse.json({ error: t('api.invalidRequest') }, { status: 400 });
  }
}
