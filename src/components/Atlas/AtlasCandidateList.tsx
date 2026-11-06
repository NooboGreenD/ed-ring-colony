'use client';

import { useMemo, useState } from 'react';
import { useAtlas } from '@/components/Atlas/AtlasContext';
import { IconCopy, IconCrosshair, IconRoute, IconSearch, IconStar, IconX } from '@/components/Icons';
import { toast } from '@/components/ui/Toaster';
import { useI18n } from '@/lib/i18n/I18nContext';
import {
  copyText,
  favoriteKey,
  filterCandidates,
  formatArrivalLs,
  formatCoordinates,
  formatCredits,
  formatDistanceLy,
  sortCandidates,
  worldTypeLabel,
  type AtlasCandidateSort,
} from '@/lib/atlas';
import type { AtlasCandidate } from '@/types/atlas';

interface Props {
  candidates: AtlasCandidate[];
  onSelect: (c: AtlasCandidate) => void;
  selectedId?: string | null;
  /** Всего кандидатов в сессии поиска (может быть больше загруженных). */
  total?: number;
  onLoadMore?: () => void;
  loadingMore?: boolean;
}

const PAGE_SIZE = 60;

export function AtlasCandidateList({ candidates, onSelect, selectedId, total, onLoadMore, loadingMore }: Props) {
  const { t, locale } = useI18n();
  const { favoriteKeys, favorites, addFavorite, removeFavorite } = useAtlas();
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<AtlasCandidateSort>('distance');
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  const filtered = useMemo(
    () => sortCandidates(filterCandidates(candidates, { query, favoritesOnly, favoriteKeys }), sort),
    [candidates, favoriteKeys, favoritesOnly, query, sort],
  );

  const visible = filtered.slice(0, visibleCount);
  const hasMoreLoaded = filtered.length > visible.length;

  if (candidates.length === 0) {
    return <p className="empty">{t('atlas.ui.noCandidates')}</p>;
  }

  const toggleFavorite = async (candidate: AtlasCandidate) => {
    const existing = favorites.find(
      (favorite) => favorite.system_name === candidate.system_name && favorite.world_type === candidate.world_type,
    );
    if (existing) {
      await removeFavorite(existing.id);
      toast(t('atlas.ui.removedFromFavorites'), 'info');
      return;
    }
    const ok = await addFavorite(candidate);
    toast(ok ? t('atlas.ui.addedToFavorites') : t('atlas.ui.addFavoriteFailed'), ok ? 'success' : 'error');
  };

  const onCopy = async (candidate: AtlasCandidate) => {
    const text = `${candidate.system_name} (${formatCoordinates(candidate)})`;
    const ok = await copyText(text);
    toast(ok ? t('atlas.ui.coordsCopied') : t('atlas.ui.clipboardUnavailable'), ok ? 'success' : 'error');
  };

  return (
    <div className="atlas-candidate-block">
      <div className="atlas-list-toolbar">
        <div className="atlas-inline-search">
          <IconSearch size={12} />
          <input
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setVisibleCount(PAGE_SIZE);
            }}
            placeholder={t('atlas.ui.filterPlaceholder')}
            aria-label={t('atlas.ui.filterCandidatesAria')}
          />
          {query && (
            <button type="button" onClick={() => setQuery('')} aria-label={t('atlas.clearFilter')}>
              <IconX size={11} />
            </button>
          )}
        </div>
        <div className="atlas-list-toolbar-row">
          <select
            value={sort}
            onChange={(event) => setSort(event.target.value as AtlasCandidateSort)}
            aria-label={t('atlas.ui.sortCandidatesAria')}
          >
            <option value="distance">{t('atlas.ui.sortDistance')}</option>
            <option value="value">{t('atlas.ui.sortValue')}</option>
            <option value="type">{t('atlas.ui.sortType')}</option>
            <option value="name">{t('atlas.ui.sortName')}</option>
          </select>
          <button
            type="button"
            className={`atlas-toggle-btn${favoritesOnly ? ' active' : ''}`}
            onClick={() => {
              setFavoritesOnly((current) => !current);
              setVisibleCount(PAGE_SIZE);
            }}
            aria-pressed={favoritesOnly}
            title={t('atlas.ui.onlyFavoritesTitle')}
          >
            <IconStar size={12} /> {t('atlas.favorites')}
          </button>
        </div>
      </div>

      <p className="atlas-list-counter">
        {t('atlas.shownOf', { shown: visible.length, total: filtered.length })}
        {typeof total === 'number' && total > candidates.length ? t('atlas.ui.sessionTotal', { count: total.toLocaleString(locale) }) : ''}
      </p>

      {filtered.length === 0 && <p className="atlas-muted">{t('atlas.ui.nothingFound')}</p>}

      <div className="atlas-candidate-list">
        {visible.map((candidate, index) => {
          const isFavorite = favoriteKeys.has(favoriteKey(candidate.system_name, candidate.world_type));
          return (
            <div
              key={candidate.id}
              className={`atlas-candidate-item${selectedId === candidate.id ? ' selected' : ''}`}
            >
              <button type="button" className="atlas-candidate-main" onClick={() => onSelect(candidate)}>
                <span className="atlas-candidate-index">{index + 1}</span>
                <span className="name">
                  <span className="system-name">{candidate.system_name}</span>
                  <span className="type-label">{worldTypeLabel(candidate.world_type)}</span>
                </span>
                <span className="meta">
                  {formatDistanceLy(candidate.distance_from_ref)}
                  {candidate.distance_to_arrival ? ` · ${formatArrivalLs(candidate.distance_to_arrival)}` : ''}
                  {candidate.estimated_value ? ` · ${formatCredits(candidate.estimated_value)}` : ''}
                </span>
              </button>
              <span className="atlas-candidate-actions">
                <button
                  type="button"
                  className={`atlas-icon-btn${isFavorite ? ' active' : ''}`}
                  title={isFavorite ? t('atlas.ui.removeFavorite') : t('atlas.ui.addFavorite')}
                  aria-pressed={isFavorite}
                  onClick={() => void toggleFavorite(candidate)}
                >
                  <IconStar size={12} />
                </button>
                <button type="button" className="atlas-icon-btn" title={t('atlas.showOnMap')} onClick={() => onSelect(candidate)}>
                  <IconCrosshair size={12} />
                </button>
                <button type="button" className="atlas-icon-btn" title={t('atlas.ui.shipRouteTo', { system: candidate.system_name })} onClick={() => window.dispatchEvent(new CustomEvent('atlas-route-target-selected', { detail: { name: candidate.system_name } }))}>
                  <IconRoute size={12} />
                </button>
                <button type="button" className="atlas-icon-btn" title={t('atlas.ui.copyCoords')} onClick={() => void onCopy(candidate)}>
                  <IconCopy size={12} />
                </button>
              </span>
            </div>
          );
        })}
      </div>

      {hasMoreLoaded && (
        <button type="button" className="atlas-secondary-btn" onClick={() => setVisibleCount((current) => current + PAGE_SIZE)}>
          {t('atlas.ui.showMore', { count: Math.min(PAGE_SIZE, filtered.length - visible.length) })}
        </button>
      )}
      {!hasMoreLoaded && onLoadMore && typeof total === 'number' && total > candidates.length && (
        <button type="button" className="atlas-secondary-btn" onClick={onLoadMore} disabled={loadingMore}>
          {loadingMore ? t('atlas.loadingDots') : t('atlas.ui.loadMoreSession', { count: total - candidates.length })}
        </button>
      )}
    </div>
  );
}
