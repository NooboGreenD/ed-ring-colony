'use client';

/**
 * Клиентский компонент: загрузка пользовательских фото кораблей.
 * Доступен только владельцу профиля с премиум-подпиской (перк «Фото Галерея кораблей»).
 */
import { useCallback, useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n/I18nContext';
import { Tr } from '@/components/Translate';
import { authFetch } from '@/lib/supabaseClient';
import { IconUpload, IconTrash, IconImage, IconLock } from '@/components/Icons';

interface UserShipPhoto {
  id: string;
  user_id: string;
  ship_id: string;
  image_url: string;
  is_primary: boolean;
  uploaded_at: string;
}

interface ShipWithPhotos {
  id: string;
  name: string;
  photos: UserShipPhoto[];
}

interface Props {
  ships: Array<{ id: string; name: string; shipType: string | null }>;
  currentUserId: string;
}

export default function UserShipPhotoUploader({ ships, currentUserId }: Props) {
  const { t, locale } = useI18n();
  const [userShips, setUserShips] = useState<ShipWithPhotos[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState<{ shipId: string; progress: number } | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [hasPremium, setHasPremium] = useState<boolean | null>(null);

  const fetchPhotos = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      // Проверяем премиум-перк
      const perkRes = await authFetch('/api/user/ships/photos?ship_id=' + encodeURIComponent(ships[0]?.id || ''), { cache: 'no-store' });
      if (perkRes.status === 403) {
        setHasPremium(false);
        setLoading(false);
        return;
      }

      const shipsWithPhotos: ShipWithPhotos[] = [];
      for (const ship of ships) {
        const res = await authFetch(`/api/user/ships/photos?ship_id=${encodeURIComponent(ship.id)}`, { cache: 'no-store' });
        if (res.ok) {
          const data = await res.json();
          shipsWithPhotos.push({
            id: ship.id,
            name: ship.name,
            photos: data.photos || [],
          });
        }
      }
      setUserShips(shipsWithPhotos);
      setHasPremium(true);
    } catch (e: any) {
      setError(e.message || 'Ошибка загрузки фото');
    } finally {
      setLoading(false);
    }
  }, [ships]);

  useEffect(() => {
    void fetchPhotos();
  }, [fetchPhotos]);

  const handleUpload = async (shipId: string, e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);
    formData.append('ship_id', shipId);

    setUploading({ shipId, progress: 0 });
    try {
      const res = await authFetch('/api/user/ships/photos', {
        method: 'POST',
        body: formData,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Upload failed');
      }
      setNotice(`Фото загружено для ${shipId}`);
      setUploading(null);
      e.target.value = '';
      void fetchPhotos();
    } catch (err: any) {
      setError(err.message || 'Ошибка загрузки');
      setUploading(null);
    }
  };

  const deletePhoto = async (photoId: string, shipId: string) => {
    if (!confirm('Удалить это фото?')) return;
    try {
      const res = await authFetch(`/api/user/ships/photos?photo_id=${encodeURIComponent(photoId)}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error('Delete failed');
      setNotice('Фото удалено');
      void fetchPhotos();
    } catch (err: any) {
      setError(err.message || 'Ошибка удаления');
    }
  };

  if (!hasPremium) {
    return (
      <section className="card" style={{ padding: 24, marginTop: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: '#f1c40f' }}>
          <IconLock size={20} />
          <span style={{ fontSize: 13, fontWeight: 600, fontFamily: 'ui-monospace, monospace' }}>
            {t('admin.shipPhotoPremium') || 'Премиум-перк требуется'}
          </span>
        </div>
        <p style={{ margin: '8px 0 0', fontSize: 13, color: '#9ca3af' }}>
          {t('admin.shipPhotoPremiumDesc') || 'Оформите премиум-подписку с перком «Фото Галерея кораблей», чтобы загружать личные фото своих кораблей (до 5 на каждый).'}
        </p>
      </section>
    );
  }

  if (loading) {
    return <div style={{ padding: 20, textAlign: 'center', color: '#9ca3af' }}>{t('common.loading') || 'Загрузка…'}</div>;
  }

  return (
    <section className="card" style={{ padding: 24, marginTop: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <IconImage size={20} color="currentColor" />
        <h3 style={{ margin: 0, color: '#eeeeee', fontSize: 16, fontFamily: 'ui-monospace, monospace' }}>
          {t('admin.myShipPhotos') || 'Мои фото кораблей'}
        </h3>
      </div>

      {error && (
        <div role="alert" style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: '#fca5a5', padding: 10, borderRadius: 4, fontSize: 13, marginBottom: 16 }}>
          {error}
        </div>
      )}
      {notice && (
        <div role="status" style={{ background: 'rgba(46,204,113,0.1)', border: '1px solid rgba(46,204,113,0.3)', color: '#86c87c', padding: 10, borderRadius: 4, fontSize: 13, marginBottom: 16 }}>
          {notice}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 16 }}>
        {userShips.map((ship) => (
          <div key={ship.id} style={{
            background: '#25282b',
            border: '1px solid #323538',
            borderRadius: 6,
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
          }}>
            <div style={{ padding: 14, borderBottom: '1px solid #323538' }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: '#eeeeee', fontFamily: 'ui-monospace, monospace' }}>{ship.name}</div>
              <div style={{ fontSize: 12, color: '#61a9d8', fontFamily: 'ui-monospace, monospace', marginTop: 4 }}>{ship.id}</div>
            </div>

            <div style={{ padding: 12, display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
              {ship.photos.length > 0 ? (
                ship.photos.map((photo) => (
                  <div
                    key={photo.id}
                    style={{
                      position: 'relative',
                      width: '100%',
                      aspectRatio: '1',
                      borderRadius: 4,
                      overflow: 'hidden',
                      background: '#1a1c1e',
                    }}
                  >
                    <img
                      src={photo.image_url}
                      alt={`User photo ${ship.name}`}
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    />
                    {photo.is_primary && (
                      <div style={{ position: 'absolute', top: 4, left: 4, background: 'rgba(230,126,34,0.9)', color: '#1e2022', fontSize: 9, fontWeight: 700, padding: '1px 4px', borderRadius: 2, fontFamily: 'ui-monospace, monospace', textTransform: 'uppercase' }}>
                        Основное
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={() => deletePhoto(photo.id, ship.id)}
                      style={{
                        position: 'absolute',
                        top: 4,
                        right: 4,
                        background: 'rgba(231,76,60,0.8)',
                        border: 'none',
                        borderRadius: 3,
                        color: '#fff',
                        width: 20,
                        height: 20,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: 'pointer',
                        fontSize: 10,
                        lineHeight: 1,
                      }}
                      title="Удалить"
                    >
                      <IconTrash size={10} color="currentColor" />
                    </button>
                  </div>
                ))
              ) : (
                <div style={{ gridColumn: '1 / -1', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 20, color: '#9ca3af', fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>
                  <IconImage size={32} />
                  <p style={{ marginTop: 8 }}>Нет фото</p>
                </div>
              )}
              {ship.photos.length < 5 && (
                <div
                  style={{
                    gridColumn: '1 / -1',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 8,
                    padding: '12px',
                    border: '2px dashed #323538',
                    borderRadius: 4,
                    background: '#1a1c1e',
                    cursor: 'pointer',
                  }}
                  onClick={(e) => {
                    if (uploading?.shipId === ship.id) return;
                    const input = document.getElementById(`photo-upload-${ship.id}`) as HTMLInputElement | null;
                    input?.click();
                  }}
                >
                  <IconUpload size={16} color="#61a9d8" />
                  <span style={{ fontSize: 12, color: '#61a9d8', fontFamily: 'ui-monospace, monospace' }}>
                    {t('admin.uploadShipPhoto') || `Загрузить фото (${ship.photos.length}/5)`}
                  </span>
                  <input
                    id={`photo-upload-${ship.id}`}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    onChange={(e) => handleUpload(ship.id, e)}
                    style={{ display: 'none' }}
                  />
                </div>
              )}
              {ship.photos.length >= 5 && (
                <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12, color: '#9ca3af', fontSize: 11, fontFamily: 'ui-monospace, monospace' }}>
                  Лимит фото достигнут (5/5)
                </div>
              )}
            </div>

            {uploading?.shipId === ship.id && (
              <div style={{ padding: 8, background: 'rgba(230,126,34,0.1)', borderTop: '1px solid rgba(230,126,34,0.3)', fontSize: 11, color: '#f0953f', fontFamily: 'ui-monospace, monospace', textAlign: 'center' }}>
                Загрузка…
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
