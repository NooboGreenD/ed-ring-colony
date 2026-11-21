'use client';

/**
 * Админ-панель: управление картинками кораблей.
 * Позволяет загружать/заменять/удалять официальные картинки кораблей
 * в Supabase Storage bucket `ship-images`.
 */
import { useCallback, useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n/I18nContext';
import { Tr } from '@/components/Translate';
import { authFetch, getAccessToken } from '@/lib/supabaseClient';
import { IconImage, IconUpload, IconTrash, IconSearch, IconRocket } from '@/components/Icons';

interface ShipRow {
  id: string;
  name: string;
  manufacturer: string;
  hasImage: boolean;
  imageUrl: string | null;
  imageExt: string;
}

export default function ShipImagesAdmin() {
  const { t, locale } = useI18n();
  const [ships, setShips] = useState<ShipRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [query, setQuery] = useState('');

  const fetchShips = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await authFetch('/api/admin/ships/images', { cache: 'no-store' });
      if (!res.ok) throw new Error('Failed to load ships');
      const data = await res.json();
      setShips(data.ships || []);
    } catch (e: any) {
      setError(e.message || 'Ошибка загрузки');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchShips();
  }, [fetchShips]);

  const filtered = ships.filter((s) => {
    const q = query.trim().toLowerCase();
    return !q || s.name.toLowerCase().includes(q) || s.id.toLowerCase().includes(q) || s.manufacturer.toLowerCase().includes(q);
  });

  const uploadImage = async (shipId: string, file: File) => {
    setSaving(shipId);
    setError('');
    try {
      const token = await getAccessToken();
      const formData = new FormData();
      formData.append('file', file);
      formData.append('ship_id', shipId);
      const res = await fetch('/api/admin/ships/images', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Upload failed');
      }
      setNotice(`Картинка для ${shipId} загружена`);
      setSaving(null);
      void fetchShips();
    } catch (e: any) {
      setError(e.message || 'Ошибка загрузки');
      setSaving(null);
    }
  };

  const deleteImage = async (shipId: string, ext: string) => {
    if (!confirm(`Удалить картинку для ${shipId}?`)) return;
    setSaving(shipId);
    try {
      const res = await authFetch(`/api/admin/ships/images?ship_id=${encodeURIComponent(shipId)}&ext=${encodeURIComponent(ext)}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Delete failed');
      }
      setNotice(`Картинка для ${shipId} удалена`);
      setSaving(null);
      void fetchShips();
    } catch (e: any) {
      setError(e.message || 'Ошибка удаления');
      setSaving(null);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>, shipId: string) => {
    const file = e.target.files?.[0];
    if (!file) return;
    void uploadImage(shipId, file).then(() => {
      e.target.value = '';
    });
  };

  return (
    <section className="card" style={{ padding: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
        <IconRocket size={24} color="currentColor" />
        <div>
          <span style={{ fontSize: 11, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            {t('admin.shipImagesTitle') || 'Картинки кораблей'}
          </span>
          <h2 style={{ margin: '4px 0 0', color: '#eeeeee', fontSize: 18 }}>{t('admin.shipImagesSubtitle') || 'Официальные картинки кораблей для досье пилота'}</h2>
        </div>
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

      <div style={{ display: 'flex', gap: 12, marginBottom: 20, alignItems: 'center' }}>
        <input
          type="search"
          placeholder={t('admin.searchShips') || 'Поиск корабля…'}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ width: 320, padding: '8px 12px', background: '#1e2124', border: '1px solid #323538', borderRadius: 4, color: '#eeeeee', fontFamily: 'ui-monospace, monospace', fontSize: 13 }}
        />
        <span style={{ fontSize: 12, color: '#9ca3af' }}>{filtered.length} из {ships.length}</span>
      </div>

      {loading ? (
        <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>{t('common.loading') || 'Загрузка…'}</div>
      ) : filtered.length === 0 ? (
        <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>
          <IconSearch size={32} color="currentColor" />
          <p style={{ marginTop: 12 }}>{t('admin.noShipsFound') || 'Корабли не найдены'}</p>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 20 }}>
          {filtered.map((ship) => {
            const ext = ship.imageExt || 'png';
            return (
              <div key={ship.id} style={{
                background: '#25282b',
                border: `1px solid ${ship.hasImage ? '#2ecc71' : '#323538'}`,
                borderRadius: 6,
                overflow: 'hidden',
                display: 'flex',
                flexDirection: 'column',
              }}>
                <div style={{ position: 'relative', height: 200, background: '#1a1c1e', overflow: 'hidden' }}>
                  {ship.hasImage && ship.imageUrl && (
                    <img
                      src={ship.imageUrl}
                      alt={ship.name}
                      style={{ width: '100%', height: '100%', objectFit: 'contain', background: 'transparent' }}
                      loading="lazy"
                    />
                  )}
                  {!ship.hasImage && (
                    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#61a9d8', fontFamily: 'ui-monospace, monospace' }}>
                      <IconImage size={48} color="currentColor" />
                      <div style={{ marginTop: 10, fontSize: 12 }}>{t('admin.noImage') || 'Нет картинки'}</div>
                    </div>
                  )}
                  {saving === ship.id && (
                    <div style={{ position: 'absolute', top: 8, right: 8, background: 'rgba(0,0,0,0.7)', color: '#eeeeee', padding: '4px 8px', borderRadius: 4, fontSize: 11, fontFamily: 'ui-monospace, monospace' }}>
                      {t('common.loading') || 'Загрузка…'}
                    </div>
                  )}
                </div>

                <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                    <div style={{ fontSize: 16, fontWeight: 700, color: '#eeeeee', fontFamily: 'ui-monospace, monospace' }}>{ship.name}</div>
                    <span style={{ fontSize: 10, color: '#9ca3af', background: '#1e2124', padding: '1px 6px', borderRadius: 3, fontFamily: 'ui-monospace, monospace' }}>{ship.id}</span>
                  </div>
                  <div style={{ fontSize: 12, color: '#61a9d8', fontFamily: 'ui-monospace, monospace' }}>{ship.manufacturer}</div>
                  <div style={{ fontSize: 11, color: ship.hasImage ? '#2ecc71' : '#fca5a5', fontFamily: 'ui-monospace, monospace' }}>
                    {ship.hasImage ? t('admin.imageExists') || 'Картинка загружена' : t('admin.imageMissing') || 'Нет картинки'}
                  </div>

                  <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
                    <label style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', background: '#1e2124', border: '1px solid #323538', borderRadius: 4, cursor: 'pointer', fontSize: 12, color: '#eeeeee' }}>
                      {saving === ship.id ? (t('common.uploading') || 'Загрузка…') : (t('admin.uploadImage') || 'Загрузить картинку')}
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/webp,image/gif"
                        onChange={(e) => handleFileChange(e, ship.id)}
                        style={{ display: 'none' }}
                      />
                    </label>
                    {ship.hasImage && (
                      <button
                        type="button"
                        disabled={saving === ship.id}
                        onClick={() => deleteImage(ship.id, ext)}
                        style={{
                          padding: '6px 10px',
                          background: 'transparent',
                          border: '1px solid #e74c3c',
                          borderRadius: 4,
                          color: '#fca5a5',
                          fontSize: 11,
                          fontFamily: 'ui-monospace, monospace',
                          cursor: 'pointer',
                        }}
                        title={t('admin.deleteImage') || 'Удалить картинку'}
                      >
                        <IconTrash size={14} color="currentColor" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
