import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const svc = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const body = await req.json().catch(() => ({}));
  const deliveries: any[] = body.deliveries || [];
  const cmdr: string | undefined = body.cmdr;

  let userId: string | null = null;
  if (cmdr) {
    const { data: profile } = await svc
      .from('profiles')
      .select('id')
      .eq('cmdr_name', cmdr)
      .maybeSingle();
    if (profile) userId = profile.id;
  }

  if (!userId) {
    return NextResponse.json({ error: 'Не удалось определить пользователя. Загрузите через сайт или убедитесь, что никнейм совпадает.' }, { status: 400 });
  }

  const { data: userProfile } = await svc.from('profiles').select('cmdr_name').eq('id', userId).single();
  if (!userProfile?.cmdr_name && cmdr) {
    await svc.from('profiles').update({ cmdr_name: cmdr }).eq('id', userId);
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
