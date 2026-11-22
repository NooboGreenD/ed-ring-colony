import { createServiceClient } from '@/lib/supabaseServer';
import { assessProfileBinding } from '@/lib/capi/profileBinding';
import { maskCapiProfile } from '@/lib/privacy';
import Link from 'next/link';
import { capiShipTypeToOutfittingId } from '@/lib/outfitting/shipImages';

export const dynamic = 'force-dynamic';

/** Нормализованное представление корабля из `capi_profiles.ships`. */
interface ShipCard {
  shipId: number | null;
  shipType: string | null;
  shipName: string | null;
  shipIdent: string | null;
  value: number | null;
  systemName: string | null;
  stationName: string | null;
}

/** Краткое название типа для отображения. */
function shipTypeLabel(type: string | null): string {
  if (!type) return '—';
  return type
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Цветной оттенок для плейсхолдера изображения (по типу корабля). */
function shipPlaceholderColor(type: string | null): string {
  if (!type) return '#3a3d40';
  const hash = type.split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  const hues = [
    '#e67e22', '#3498db', '#2ecc71', '#e74c3c', '#9b59b6',
    '#f1c40f', '#1abc9c', '#e84393', '#fd7e14', '#6c757d',
  ];
  return hues[hash % hues.length];
}

function renderNotFound() {
  return (
    <div className="card" style={{ width: '100%', minHeight: '100vh', padding: 40, textAlign: 'center', color: '#9ca3af' }}>
      <h3 style={{ color: '#eeeeee', margin: '0 0 12px', fontSize: 16 }}>Пилот не найден</h3>
      <p style={{ margin: 0, fontSize: 13 }}>Профиль с таким именем не существует.</p>
    </div>
  );
}

function renderError() {
  return (
    <div className="card" style={{ width: '100%', minHeight: '100vh', padding: 40, textAlign: 'center', color: '#9ca3af' }}>
      <h3 style={{ color: '#eeeeee', margin: '0 0 12px', fontSize: 16 }}>Ошибка загрузки досье</h3>
      <p style={{ margin: 0, fontSize: 13 }}>Попробуйте обновить страницу позже.</p>
    </div>
  );
}

export default async function CmdrShipsPage({
  params,
}: { params: Promise<{ name: string }> }) {
  try {
    const resolvedParams = await params;
    const name = decodeURIComponent(resolvedParams.name);

    let svc;
    try {
      svc = createServiceClient();
    } catch {
      return renderError();
    }

    // 1. Находим профиль по cmdr_name
    let profileData: { id: string } | null = null;
    try {
      const profile = await svc
        .from('profiles')
        .select('id')
        .eq('cmdr_name', name)
        .maybeSingle();
      if (profile.error || !profile?.data) {
        return renderNotFound();
      }
      profileData = profile.data;
    } catch {
      return renderError();
    }

    const profileId = profileData.id;

    // 2. Читаем CAPI профиль
    let capiProfile: Record<string, any> | null = null;
    try {
      const { data } = await svc
        .from('capi_profiles')
        .select('*')
        .eq('user_id', profileId)
        .maybeSingle();
      capiProfile = data ?? null;
    } catch {
      capiProfile = null;
    }

    // 3. Привязка CAPI
    let capiView: Record<string, any> | null = null;
    try {
      const capiBinding = assessProfileBinding(
        name,
        capiProfile?.cmdr_name ?? null,
      );
      if (capiBinding.status === 'linked' || capiBinding.status === 'already_linked') {
        capiView = capiProfile;
      }
    } catch {
      capiView = null;
    }

    // 4. Конфиденциальность — владелец видит всё
    const privacy = { balance: true, ranks: true, cargo: true, deliveries: true, location: true } as const;
    let publicCapiProfile: Record<string, any> | null = null;
    try {
      publicCapiProfile = maskCapiProfile(capiView ?? null, privacy);
    } catch {
      publicCapiProfile = null;
    }

    const rawShips = publicCapiProfile?.ships ?? null;
    const ships: ShipCard[] = Array.isArray(rawShips) ? rawShips : [];
    const currentShip = publicCapiProfile?.current_ship ?? null;
    const currentShipIdent = publicCapiProfile?.current_ship_ident ?? null;

    return (
      <div className="card" style={{ width: '100%', minHeight: '100vh' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 24 }}>
          <div>
            <h1 style={{ margin: 0, color: '#eeeeee', fontSize: 24 }}>{name}</h1>
            <p style={{ margin: '4px 0 0', color: '#9ca3af', fontSize: 14 }}>Корабли пилота</p>
          </div>
        </div>

        {!capiView && (
          <div style={{ padding: '48px 20px', textAlign: 'center', color: '#9ca3af' }}>
            <div style={{ width: 64, height: 64, borderRadius: '50%', background: '#1a1c1e', border: '2px solid #323538', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px', fontSize: 28 }}>🚀</div>
            <h3 style={{ color: '#eeeeee', margin: '0 0 8px', fontSize: 16 }}>CAPI профиль не подключён</h3>
            <p style={{ margin: 0, fontSize: 13 }}>Подключите CAPI профиль для просмотра кораблей.</p>
          </div>
        )}

        {capiView && ships.length > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 16 }}>
            {ships.map((ship) => {
              const isCurrent = currentShipIdent
                ? ship.shipIdent === currentShipIdent
                : ship.shipName === currentShip;
              const outfittingId = capiShipTypeToOutfittingId(ship.shipType);
              const imageUrl = `/api/supabase/storage/v1/object/public/ship-images/${outfittingId ?? ship.shipType ?? 'unknown'}.png`;

              return (
                <div
                  key={ship.shipId ?? ship.shipIdent ?? ship.shipName}
                  style={{
                    background: '#25282b',
                    border: `1px solid ${isCurrent ? '#e67e22' : '#323538'}`,
                    borderRadius: 6,
                    overflow: 'hidden',
                    display: 'flex',
                    flexDirection: 'column',
                    transition: 'border-color 0.2s, box-shadow 0.2s',
                  }}
                >
                  <div style={{
                    position: 'relative',
                    height: 140,
                    background: shipPlaceholderColor(ship.shipType),
                    backgroundImage: imageUrl ? `url("${imageUrl}")` : 'none',
                    backgroundSize: 'contain',
                    backgroundRepeat: 'no-repeat',
                    backgroundPosition: 'center',
                    overflow: 'hidden',
                  }}>
                    {isCurrent && (
                      <div style={{ position: 'absolute', top: 8, right: 8, background: '#e67e22', color: '#1e2022', padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 700, fontFamily: 'ui-monospace, monospace', textTransform: 'uppercase' }}>
                        Текущий
                      </div>
                    )}
                  </div>

                  <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                      <div style={{ fontSize: 16, fontWeight: 700, color: '#eeeeee', fontFamily: 'ui-monospace, monospace' }}>
                        {ship.shipName || '—'}
                      </div>
                      {ship.shipIdent && (
                        <span style={{ fontSize: 10, color: '#9ca3af', background: '#1e2124', padding: '1px 6px', borderRadius: 3, fontFamily: 'ui-monospace, monospace' }}>
                          {ship.shipIdent}
                        </span>
                      )}
                    </div>

                    <div style={{ fontSize: 12, color: '#61a9d8', fontFamily: 'ui-monospace, monospace' }}>
                      {shipTypeLabel(ship.shipType)}
                    </div>

                    {ship.value != null && ship.value > 0 && (
                      <div style={{ fontSize: 12, color: '#f1c40f', fontFamily: 'ui-monospace, monospace' }}>
                        ≈ {ship.value.toLocaleString()} CR
                      </div>
                    )}

                    <div style={{ display: 'flex', gap: 10, fontSize: 11, color: '#9ca3af', fontFamily: 'ui-monospace, monospace' }}>
                      <span>
                        Система: {ship.systemName || '—'}
                      </span>
                      {ship.stationName && (
                        <span>·</span>
                      )}
                      {ship.stationName && (
                        <span>
                          Док: {ship.stationName}
                        </span>
                      )}
                    </div>

                    <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
                      <Link
                        href={`/outfitting?ship=${encodeURIComponent(outfittingId ?? '')}`}
                        className="btn btn-cyan"
                        style={{ flex: 1, padding: '6px 10px', fontSize: 11, textAlign: 'center' }}
                      >
                        Верфь
                      </Link>
                      <button
                        className="btn"
                        style={{ padding: '6px 10px', fontSize: 16, lineHeight: 1, color: '#e67e22' }}
                        aria-label={isCurrent ? 'Текущий корабль' : 'В эскадру'}
                      >
                        +
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {capiView && ships.length === 0 && (
          <div style={{ padding: '48px 20px', textAlign: 'center', color: '#9ca3af' }}>
            <div style={{ width: 64, height: 64, borderRadius: '50%', background: '#1a1c1e', border: '2px solid #323538', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px', fontSize: 28 }}>🚫</div>
            <h3 style={{ color: '#eeeeee', margin: '0 0 8px', fontSize: 16 }}>Кораблей нет</h3>
            <p style={{ margin: 0, fontSize: 13 }}>В CAPI профиле не найдено кораблей.</p>
          </div>
        )}
      </div>
    );
  } catch {
    return renderError();
  }
}
