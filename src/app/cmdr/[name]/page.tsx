import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabaseServer';
import { fetchRavenColonialData } from '@/lib/ravenColonial';
import CmdrDossier from '@/components/CmdrDossier';
import { IconProfile, IconSquadron, IconLeaderboard } from '@/components/Icons';

export const dynamic = 'force-dynamic';

export default async function CmdrPage({ params }: { params: { name: string } }) {
  const name = decodeURIComponent(params.name);
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  const currentUserId = user?.id ?? null;

  // 1. Находим профиль по cmdr_name (единственный источник имени)
  const { data: profile } = await supabase
    .from('profiles')
    .select('id, cmdr_name, avatar_url, created_at')
    .eq('cmdr_name', name)
    .maybeSingle();

  // 2. ВСЕ данные агрегируем по profile.id (UUID), а не по имени!
  // Это решает проблему: при смене ника досье не отвязывается.
  // Не используем .limit(10000): PostgREST и Supabase могут вернуть меньше
  // строк, чем ожидается, из-за configured maximum. Лидерборд читает страницы
  // по 1000, поэтому досье должно использовать тот же полный набор доставок.
  const profileId = profile?.id ?? null;
  const loadAllDeliveries = async (): Promise<any[]> => {
    if (!profileId) return [];

    const rows: any[] = [];
    const pageSize = 1000;
    let offset = 0;
    while (true) {
      const { data, error } = await supabase
        .from('deliveries')
        .select('id, system_name, commodity, amount, delivered_at, is_hub, route_system_id')
        .eq('user_id', profileId)
        .order('id', { ascending: true })
        .range(offset, offset + pageSize - 1);
      if (error) throw new Error(error.message);
      rows.push(...(data || []));
      if (!data || data.length < pageSize) break;
      offset += data.length;
    }
    return rows;
  };

  const [
    allRows,
    { data: recentRows },
    { data: rankRow },
    rcData,
    { data: capiProfile },
  ] = await Promise.all([
    loadAllDeliveries(),
    profileId
      ? supabase.from('deliveries').select('system_name, commodity, amount, delivered_at').eq('user_id', profileId).order('delivered_at', { ascending: false }).limit(50)
      : Promise.resolve({ data: [] }),
    profileId
      ? supabase.rpc('get_cmdr_rank', { user_uuid: profileId })
      : Promise.resolve({ data: [] }),
    fetchRavenColonialData(name),
    profileId
      ? supabase.from('capi_profiles').select('*').eq('user_id', profileId).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  // Агрегация
  const deliveryRows = allRows || [];
  const amountOf = (value: unknown) => {
    const amount = Number(value);
    return Number.isFinite(amount) && amount > 0 ? amount : 0;
  };
  const validDeliveryRows = deliveryRows.filter((row) => amountOf(row.amount) > 0);
  const opsCount = validDeliveryRows.length;
  const normalizedSystem = (value: unknown) => String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
  const totalTons = deliveryRows.reduce((sum, r) => sum + amountOf(r.amount), 0);
  const systemsMap = new Map<string, number>();
  const commoditiesMap = new Map<string, number>();
  validDeliveryRows.forEach((r) => {
    const systemName = String(r.system_name || '').trim() || 'Unknown system';
    const commodity = String(r.commodity || '').trim() || 'Unknown commodity';
    const amount = amountOf(r.amount);
    systemsMap.set(systemName, (systemsMap.get(systemName) || 0) + amount);
    commoditiesMap.set(commodity, (commoditiesMap.get(commodity) || 0) + amount);
  });

  // Derive these counters from the same complete delivery set as totalTons.
  // Separate unpaginated queries previously stopped at PostgREST's 1,000-row
  // limit and could disagree with /leaderboard.
  const uniqueHubs = new Set(
    validDeliveryRows.filter((row) => row.is_hub).map((row) => normalizedSystem(row.system_name)).filter(Boolean),
  );
  const uniqueRoutes = new Set(
    validDeliveryRows.filter((row) => row.is_hub === false).map((row) => normalizedSystem(row.system_name)).filter(Boolean),
  );
  const uniqueRouteSystems = new Set(
    validDeliveryRows
      .map((row) => Number(row.route_system_id))
      .filter((id) => Number.isSafeInteger(id) && id > 0),
  );

  const rank = rankRow?.[0]?.rank ?? null;
  const lastDelivery = recentRows?.[0]?.delivered_at ?? null;

  const trackSince = Date.now() - 7 * 86400000;
  const trackTons: Record<string, number> = {};
  deliveryRows.forEach((r: any) => {
    if (!r.delivered_at || new Date(r.delivered_at).getTime() < trackSince) return;
    const systemName = String(r.system_name || '').trim() || 'Unknown system';
    trackTons[systemName] = (trackTons[systemName] || 0) + amountOf(r.amount);
  });

  // Squadron membership is public data. Read the base tables directly rather
  // than depending on a service key and the untracked squadron_summary view.
  // This keeps the squadron label visible on a commander's profile even while
  // database views are being restored.
  let squadron = null;
  if (profileId) {
    const { data: membership, error: membershipError } = await supabase
      .from('squadron_members')
      .select('squadron_id')
      .eq('user_id', profileId)
      .order('id', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (membershipError) {
      console.warn('[cmdr profile] Could not load squadron membership:', membershipError.message);
    }
    if (membership?.squadron_id) {
      const { data: memberSquadron, error: squadronError } = await supabase
        .from('squadrons')
        .select('*')
        .eq('id', membership.squadron_id)
        .maybeSingle();
      if (squadronError) console.warn('[cmdr profile] Could not load squadron:', squadronError.message);
      squadron = memberSquadron;
    }
    if (!squadron) {
      const { data: createdSquadron, error: squadronError } = await supabase
        .from('squadrons')
        .select('*')
        .eq('created_by', profileId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (squadronError) console.warn('[cmdr profile] Could not load created squadron:', squadronError.message);
      squadron = createdSquadron;
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
          {squadron?.name && <p style={{ margin: '4px 0 0', color: '#9ca3af', fontSize: 14, display: 'flex', alignItems: 'center', gap: 6 }}><IconSquadron size={14} color='#9ca3af' /> {squadron.name}</p>}
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
        opsCount={opsCount}
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
        capiProfile={capiProfile}
      />
    </div>
  );
}
