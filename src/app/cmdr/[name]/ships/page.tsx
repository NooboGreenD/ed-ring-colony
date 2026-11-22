import { notFound } from 'next/navigation';
import { createClient, createServiceClient } from '@/lib/supabaseServer';
import { assessProfileBinding } from '@/lib/capi/profileBinding';
import { maskCapiProfile } from '@/lib/privacy';
import { getServerI18n } from '@/lib/i18n/server';
import Link from 'next/link';
import {
  capiShipTypeToOutfittingId,
  shipImageUrlFromStorage,
} from '@/lib/outfitting/shipImages';

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
  if (typeof type !== 'string' || !type) return '—';
  return type
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Цветной оттенок для плейсхолдера изображения (по типу корабля). */
function shipPlaceholderColor(type: string | null): string {
  if (typeof type !== 'string' || !type) return '#3a3d40';
  const hash = type.split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  const hues = [
    '#e67e22', '#3498db', '#2ecc71', '#e74c3c', '#9b59b6',
    '#f1c40f', '#1abc9c', '#e84393', '#fd7e14', '#6c757d',
  ];
  return hues[hash % hues.length];
}

export default async function CmdrShipsPage({
  params,
}: { params: Promise<{ name: string }> }) {
  const resolvedParams = await params;
  const name = decodeURIComponent(resolvedParams.name);

  let svc: ReturnType<typeof createServiceClient>;
  try {
    svc = createServiceClient();
  } catch {
    return (
      <div className="card" style={{ width: '100%', minHeight: '100vh', padding: 40, textAlign: 'center', color: '#9ca3af' }}>
        <div style={{ width: 64, height: 64, borderRadius: '50%', background: '#1a1c1e', border: '2px solid #323538', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 24px', fontSize: 32 }}>⚠️</div>
        <h3 style={{ color: '#eeeeee', margin: '0 0 12px', fontSize: 16 }}>Сервис временно недоступен</h3>
        <p style={{ margin: 0, fontSize: 13 }}>Попробуйте обновить страницу позже.</p>
      </div>
    );
  }

  const profile = await svc
    .from('profiles')
    .select('id, cmdr_name, avatar_url, privacy_settings')
    .eq('cmdr_name', name)
    .maybeSingle();

  if (profile.error || !profile?.data) {
    notFound();
  }

  const profileId = profile.data.id;

  const { data: capiProfile, error: capiError } = await svc
    .from('capi_profiles')
    .select('*')
    .eq('user_id', profileId)
    .maybeSingle();

  const privacyRaw = profile.data.privacy_settings ?? {};
  const ownerId = profileId;
  let privacyLocation = true;
  if (typeof privacyRaw === 'object' && privacyRaw !== null && !Array.isArray(privacyRaw)) {
    const loc = (privacyRaw as Record<string, unknown>)['location'];
    privacyLocation = typeof loc === 'boolean' ? loc : true;
  }

  const capiBinding = assessProfileBinding(
    profile.data.cmdr_name,
    capiProfile?.cmdr_name ?? null,
  );
  const capiView = (capiBinding.status === 'linked' || capiBinding.status === 'already_linked')
    ? capiProfile
    : null;

  const publicCapiProfile = maskCapiProfile(capiView ?? null, {
    balance: true,
    ranks: true,
    cargo: true,
    deliveries: true,
    location: privacyLocation,
  } as any);

  const rawShips = publicCapiProfile?.ships ?? null;
  const ships: ShipCard[] = Array.isArray(rawShips) ? rawShips : [];
  const currentShip = publicCapiProfile?.current_ship ?? null;
  const currentShipIdent = publicCapiProfile?.current_ship_ident ?? null;

  return (
    <div className="card" style={{ width: '100%', minHeight: '100vh' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 24 }}>
        <div>
          <h1 style={{ margin: 0, color: '#eeeeee', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            {name}
          </h1>
          <p style={{ margin: '4px 0 0', color: '#9ca3af', fontSize: 14 }}>
            Корабли пилота
          </p>
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
            const shipTypeLower = ship.shipType?.toLowerCase() ?? '';
            const shipTypeSnake = ship.shipType
              ?.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
              .toLowerCase() ?? '';
            const imageUrl =
              shipImageUrlFromStorage(outfittingId) ||
              shipImageUrlFromStorage(ship.shipType) ||
              shipImageUrlFromStorage(shipTypeLower) ||
              shipImageUrlFromStorage(shipTypeSnake);
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
                <div style={{ position: 'relative', height: 140, background: shipPlaceholderColor(ship.shipType), overflow: 'hidden' }}>
                  <div
                    style={{
                      width: '100%',
                      height: '100%',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: '#eeeeee',
                      fontFamily: 'ui-monospace, monospace',
                      zIndex: 1,
                    }}
                  >
                    <div style={{ fontSize: 48, marginBottom: 8 }}>🚀</div>
                    <div style={{ fontSize: 11, opacity: 0.8 }}>{shipTypeLabel(ship.shipType)}</div>
                  </div>
                  {imageUrl && (
                    <img
                      src={imageUrl}
                      alt={ship.shipName ?? ship.shipType ?? ''}
                      style={{ width: '100%', height: '100%', objectFit: 'contain', background: 'transparent', position: 'absolute', top: 0, left: 0, zIndex: 2 }}
                      loading="lazy"
                      onError={(e) => {
                        const target = e.target as HTMLImageElement;
                        target.style.display = 'none';
                      }}
                    />
                  )}
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
                      aria-label={isCurrent ? 'Current ship' : 'Add to squadron'}
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
}
