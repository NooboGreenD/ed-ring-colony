import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabaseServer';
import { fetchRavenColonialData } from '@/lib/ravenColonial';
import CmdrDossier from '@/components/CmdrDossier';
import { IconProfile, IconSquadron, IconLeaderboard } from '@/components/Icons';

export const revalidate = 60;

export default async function CmdrPage({ params }: { params: { name: string } }) {
  const name = decodeURIComponent(params.name);
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  const currentUserId = user?.id ?? null;

  // 1. Находим профиль по cmdr_name (единственный источник имени)
  const { data: profile } = await supabase
    .from('profiles')
    .select('id, cmdr_name, avatar_url, created_at, squadron')
    .eq('cmdr_name', name)
    .maybeSingle();

  // 2. ВСЕ данные агрегируем по profile.id (UUID), а не по имени!
  // Это решает проблему: при смене ника досье не отвязывается
  const profileId = profile?.id ?? null;

  const [
    { data: allRows },
    { data: recentRows },
    { count: opsCountRaw },
    { data: hubRows },
    { data: routeRows },
    { data: routeSystemRows },
    { data: rankRow },
    { data: trackData },
    rcData,
  ] = await Promise.all([
    profileId
      ? supabase.from('deliveries').select('system_name, commodity, amount').eq('user_id', profileId).limit(10000)
      : Promise.resolve({ data: [] }),
    profileId
      ? supabase.from('deliveries').select('system_name, commodity, amount, delivered_at').eq('user_id', profileId).order('delivered_at', { ascending: false }).limit(50)
      : Promise.resolve({ data: [] }),
    profileId
      ? supabase.from('deliveries').select('*', { count: 'exact', head: true }).eq('user_id', profileId)
      : Promise.resolve({ count: 0 }),
    profileId
      ? supabase.from('deliveries').select('system_name').eq('user_id', profileId).eq('is_hub', true)
      : Promise.resolve({ data: [] }),
    profileId
      ? supabase.from('deliveries').select('system_name').eq('user_id', profileId).eq('is_hub', false)
      : Promise.resolve({ data: [] }),
    profileId
      ? supabase.from('deliveries').select('route_system_id').eq('user_id', profileId).not('route_system_id', 'is', null)
      : Promise.resolve({ data: [] }),
    profileId
      ? supabase.rpc('get_cmdr_rank', { user_uuid: profileId })
      : Promise.resolve({ data: [] }),
    profileId
      ? supabase.from('deliveries').select('system_name, amount').eq('user_id', profileId).gte('delivered_at', new Date(Date.now() - 7 * 86400000).toISOString())
      : Promise.resolve({ data: [] }),
    fetchRavenColonialData(name),
  ]);

  // Агрегация
  const totalTons = (allRows || []).reduce((sum, r) => sum + (r.amount || 0), 0);
  const systemsMap = new Map<string, number>();
  const commoditiesMap = new Map<string, number>();
  (allRows || []).forEach((r) => {
    systemsMap.set(r.system_name, (systemsMap.get(r.system_name) || 0) + r.amount);
    commoditiesMap.set(r.commodity, (commoditiesMap.get(r.commodity) || 0) + r.amount);
  });

  const uniqueHubs = new Set((hubRows || []).map((h: any) => h.system_name));
  const uniqueRoutes = new Set((routeRows || []).map((h: any) => h.system_name));
  const uniqueRouteSystems = new Set((routeSystemRows || []).map((h: any) => h.route_system_id));

  const rank = rankRow?.[0]?.rank ?? null;
  const lastDelivery = recentRows?.[0]?.delivered_at ?? null;

  const trackTons: Record<string, number> = {};
  (trackData || []).forEach((r: any) => {
    trackTons[r.system_name] = (trackTons[r.system_name] || 0) + r.amount;
  });

  // Эскадрилья
  let squadron = null;
  if (profileId) {
    const { data: membership } = await supabase
      .from('squadron_members')
      .select('squadron_id')
      .eq('user_id', profileId)
      .maybeSingle();
    if (membership) {
      const { data: sq } = await supabase
        .from('squadron_summary')
        .select('*')
        .eq('id', membership.squadron_id)
        .maybeSingle();
      squadron = sq;
    }
    if (!squadron) {
      const { data: sq } = await supabase
        .from('squadron_summary')
        .select('*')
        .eq('created_by', profileId)
        .maybeSingle();
      squadron = sq;
    }
  }

  if (!profile && (allRows?.length || 0) === 0 && rcData.architectCount === 0) {
    notFound();
  }

  return (
    <div className="card" style={{ width: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 24 }}>
        {profile?.avatar_url ? (
          <img src={profile.avatar_url} alt="" style={{ width: 64, height: 64, borderRadius: '50%', border: '2px solid #3b82f6' }} />
        ) : (
          <div style={{ width: 64, height: 64, borderRadius: '50%', background: '#323538', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><IconProfile size={28} color='#9ca3af' /></div>
        )}
        <div>
          <h1 style={{ margin: 0, color: '#eeeeee' }}>{name}</h1>
          {profile?.squadron && <p style={{ margin: '4px 0 0', color: '#9ca3af', fontSize: 14, display: 'flex', alignItems: 'center', gap: 6 }}><IconSquadron size={14} color='#9ca3af' /> {profile.squadron}</p>}
          {rank && <p style={{ margin: '4px 0 0', color: '#e67e22', fontSize: 14, display: 'flex', alignItems: 'center', gap: 6 }}><IconLeaderboard size={14} color='#e67e22' /> Место в лидерборде: #{rank}</p>}
          {profile?.created_at && <p style={{ margin: '4px 0 0', color: '#9ca3af', fontSize: 12 }}>С нами с {new Date(profile.created_at).toLocaleDateString('ru-RU')}</p>}
        </div>
      </div>

      <CmdrDossier
        displayName={name}
        avatarUrl={profile?.avatar_url ?? null}
        createdAt={profile?.created_at ?? null}
        rank={rank}
        totalTons={totalTons}
        hubsCount={uniqueHubs.size}
        routeCount={uniqueRoutes.size}
        routeSystemsVisited={uniqueRouteSystems.size}
        opsCount={opsCountRaw ?? 0}
        lastDelivery={lastDelivery}
        systems={Array.from(systemsMap.entries()).sort((a, b) => b[1] - a[1])}
        commodities={Array.from(commoditiesMap.entries()).sort((a, b) => b[1] - a[1])}
        recent={recentRows || []}
        allDeliveries={allRows || []}
        trackTons={trackTons}
        architectCount={rcData.architectCount}
        architectSystems={rcData.architectSystems}
        squadron={squadron}
        currentUserId={currentUserId}
        profileUserId={profileId}
      />
    </div>
  );
}
