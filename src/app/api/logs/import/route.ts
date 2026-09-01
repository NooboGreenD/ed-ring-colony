import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createHash } from 'crypto';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function getAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const svc = getAdminClient();

  let body: any = {};
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const deliveries: any[] = body.deliveries || [];
  const cmdr: string | undefined = body.cmdr;

  // Поддержка двух способов авторизации:
  // 1. API token (для Colonial Helper)
  // 2. Bearer token из Supabase session (для браузерной загрузки)
  let userId: string | null = null;

  const authHeader = req.headers.get('authorization') || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const apiTokenStr = String(body.token ?? '').trim();

  if (bearerToken) {
    // Валидация Supabase session token
    const { data: { user }, error } = await svc.auth.getUser(bearerToken);
    if (error || !user) {
      return NextResponse.json({ error: 'Invalid or expired session' }, { status: 401 });
    }
    userId = user.id;
  } else if (apiTokenStr) {
    // Валидация API token (для Colonial Helper)
    const tokenHash = hashToken(apiTokenStr);
    const { data: apiToken } = await svc
      .from('api_tokens')
      .select('user_id, is_revoked')
      .eq('token_hash', tokenHash)
      .maybeSingle();

    if (!apiToken || apiToken.is_revoked) {
      return NextResponse.json({ error: 'Invalid or revoked token' }, { status: 401 });
    }
    userId = apiToken.user_id;
    // Обновляем last_used_at для API token
    await svc.from('api_tokens').update({ last_used_at: new Date().toISOString() }).eq('token_hash', tokenHash);
  } else {
    return NextResponse.json({ error: 'API token or session required' }, { status: 401 });
  }

  if (!userId) {
    return NextResponse.json({ error: 'Authentication failed' }, { status: 401 });
  }

  // Обновляем cmdr_name если передан
  if (cmdr) {
    const { data: profile } = await svc.from('profiles').select('cmdr_name').eq('id', userId).single();
    if (!profile?.cmdr_name) {
      await svc.from('profiles').update({ cmdr_name: cmdr }).eq('id', userId);
    }
  }

  // Filter out deliveries without a valid system name
  const validDeliveries = deliveries.filter(
    (d) => d.system_name && String(d.system_name).trim().length > 0
  );

  if (validDeliveries.length === 0) {
    return NextResponse.json({ inserted: 0, duplicates: 0, eventsFound: 0 });
  }

  // Fallback lookup: если клиент не прислал is_hub/route_system_id, определяем на сервере
  const systemNames = [...new Set(validDeliveries.map((d) => d.system_name).filter(Boolean))];
  let hubSet = new Set<string>();
  let routeMap = new Map<string, number>();
  if (systemNames.length > 0) {
    const [{ data: hubs }, { data: routeSystems }] = await Promise.all([
      svc.from('hubs').select('system_name').in('system_name', systemNames),
      svc.from('route_systems').select('id, system_name').in('system_name', systemNames),
    ]);
    hubSet = new Set((hubs || []).map((h: any) => String(h.system_name).toLowerCase()));
    routeMap = new Map((routeSystems || []).map((r: any) => [String(r.system_name).toLowerCase(), r.id]));
  }

  const toInsert = validDeliveries.map((d) => {
    const systemKey = String(d.system_name || '').toLowerCase();
    return {
      user_id: userId,
      system_name: d.system_name,
      commodity: d.commodity,
      amount: d.amount,
      delivered_at: d.delivered_at || d.timestamp,
      is_hub: d.is_hub ?? hubSet.has(systemKey),
      route_system_id: d.route_system_id ?? routeMap.get(systemKey) ?? null,
      source_hash: d.source_hash || '',
    };
  });

  const { data, error } = await svc.from('deliveries').insert(toInsert).select();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    inserted: data?.length ?? 0,
    duplicates: 0,
    eventsFound: validDeliveries.length,
  });
}
