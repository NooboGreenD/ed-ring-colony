'use client';

import { useMemo, useState } from 'react';
import { useAtlas } from '@/components/Atlas/AtlasContext';
import { CollapsibleSection } from '@/components/Atlas/CollapsibleSection';
import { IconCrosshair, IconRefresh, IconSearch, IconTrash, IconX } from '@/components/Icons';
import { formatCoordinates, worldTypeLabel } from '@/lib/atlas';
import type { AtlasFavorite, WorldType } from '@/types/atlas';

interface Props {
  onSelect: (favorite: AtlasFavorite) => void;
}

export function AtlasFavorites({ onSelect }: Props) {
  const { favorites, favoritesLoading, favoritesNeedAuth, removeFavorite, refreshFavorites } = useAtlas();
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<string>('all');

  const types = useMemo(() => {
    const counts = new Map<string, number>();
    for (const favorite of favorites) counts.set(favorite.world_type, (counts.get(favorite.world_type) || 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [favorites]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return favorites.filter((favorite) => {
      if (typeFilter !== 'all' && favorite.world_type !== typeFilter) return false;
      if (!q) return true;
      return favorite.system_name.toLowerCase().includes(q)
        || (favorite.body_name || '').toLowerCase().includes(q)
        || worldTypeLabel(favorite.world_type).toLowerCase().includes(q);
    });
  }, [favorites, query, typeFilter]);

  return (
    <CollapsibleSection
      title="Избранное"
      count={favorites.length}
      storageKey="favorites"
      actions={
        <button type="button" className="atlas-icon-btn" onClick={() => void refreshFavorites()} title="Обновить избранное">
          <IconRefresh size={12} />
        </button>
      }
    >
      {favorites.length > 0 && (
        <>
          <div className="atlas-inline-search">
            <IconSearch size={12} />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Фильтр по системе"
              aria-label="Фильтр избранного"
            />
            {query && (
              <button type="button" onClick={() => setQuery('')} aria-label="Очистить фильтр">
                <IconX size={11} />
              </button>
            )}
          </div>
          {types.length > 1 && (
            <div className="atlas-filter-pills">
              <button
                type="button"
                className={`atlas-filter-pill${typeFilter === 'all' ? ' active' : ''}`}
                onClick={() => setTypeFilter('all')}
              >
                Все ({favorites.length})
              </button>
              {types.map(([type, count]) => (
                <button
                  key={type}
                  type="button"
                  className={`atlas-filter-pill${typeFilter === type ? ' active' : ''}`}
                  onClick={() => setTypeFilter(type)}
                >
                  {worldTypeLabel(type)} ({count})
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {favoritesLoading && favorites.length === 0 && <p className="atlas-muted">Загрузка…</p>}
      {!favoritesLoading && favorites.length === 0 && (
        <p className="atlas-muted">
          {favoritesNeedAuth
            ? 'Нет локальных закладок. Добавляйте их звездой в списке кандидатов — они сохранятся в браузере, а после входа синхронизируются с профилем.'
            : 'Пока ничего не отмечено. Нажмите ☆ у кандидата в списке.'}
        </p>
      )}
      {favorites.length > 0 && visible.length === 0 && <p className="atlas-muted">Ничего не найдено по фильтру.</p>}

      <div className="atlas-list">
        {visible.map((favorite) => (
          <div key={favorite.id} className="atlas-fav-item">
            <div className="row">
              <button type="button" className="atlas-fav-name" onClick={() => onSelect(favorite)}>
                {favorite.system_name}
              </button>
              <button
                type="button"
                className="atlas-icon-btn"
                title="Показать на карте"
                onClick={() => onSelect(favorite)}
              >
                <IconCrosshair size={12} />
              </button>
              <button
                type="button"
                className="atlas-icon-btn danger"
                title="Удалить из избранного"
                onClick={() => void removeFavorite(favorite.id)}
              >
                <IconTrash size={12} />
              </button>
            </div>
            <div className="meta">
              {worldTypeLabel(favorite.world_type as WorldType)}
              {favorite.body_name ? ` · ${favorite.body_name}` : ''}
            </div>
            <div className="coords">{formatCoordinates(favorite)}</div>
            {favorite.note && <div className="note">{favorite.note}</div>}
          </div>
        ))}
      </div>
    </CollapsibleSection>
  );
}
