"use client";

import { useEffect } from 'react';
import { useAtlasHistory } from '@/hooks/useAtlasHistory';
import type { AtlasFavorite } from '@/types/atlas';

interface Props {
  onSelect: (fav: AtlasFavorite) => void;
}

export function AtlasFavorites({ onSelect }: Props) {
  const { favorites, loading, fetchFavorites, removeFavorite } = useAtlasHistory();

  useEffect(() => { fetchFavorites(); }, [fetchFavorites]);

  return (
    <div className="atlas-section">
      <h4>Избранное</h4>
      {loading && <p className="empty">Загрузка...</p>}
      {favorites.length === 0 && !loading && (
        <p className="empty">Нет избранных систем</p>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {favorites.map((f) => (
          <div
            key={f.id}
            className="atlas-fav-item"
          >
            <div className="row">
              <button
                onClick={() => onSelect(f)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--text)',
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: 'pointer',
                  textAlign: 'left',
                  padding: 0,
                  margin: 0,
                  minHeight: 'auto',
                  minWidth: 'auto',
                }}
              >
                {f.system_name}
              </button>
              <button
                onClick={() => removeFavorite(f.id)}
                className="remove-btn"
                title="Удалить"
              >
                &#10005;
              </button>
            </div>
            <div className="meta">
              {f.world_type.replace('_', ' ')}
            </div>
            {f.note && (
              <div className="note">
                {f.note}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
