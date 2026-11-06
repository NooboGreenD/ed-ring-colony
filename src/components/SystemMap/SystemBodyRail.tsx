'use client';

/**
 * Список тел системы — «оглавление» карты.
 *
 * Раньше под картой лежала сетка карточек тел: чтобы найти стройку, приходилось
 * прокручивать десятки плиток, а связи с картой не было. Здесь тот же список,
 * но его можно отфильтровать (стройки, посадка, био, кольца, без скана),
 * найти по имени и навести/сфокусировать на 3D-сцене.
 */

import { useMemo, useState } from 'react';
import {
  formatGravity,
  formatLightSeconds,
  formatNumber,
  formatTons,
  structureColor,
} from '@/lib/orrery3d/palette';
import type { FilterMode } from '@/lib/orrery3d/viewer';
import { SIGNAL_META, activeSignalKinds, hasSignals } from '@/lib/bodySignals';
import type { OrreryViewBody, OrreryViewPayload, OrreryViewStructure } from '@/lib/orrery3d/types';
import { useI18n } from '@/lib/i18n/I18nContext';

export interface SystemBodyRailProps {
  payload: OrreryViewPayload;
  focus: string;
  onFocus: (name: string) => void;
  onFilterChange?: (filter: FilterMode) => void;
  filter: FilterMode;
  /** Коллапс панели (мелкие экраны). */
  onClose?: () => void;
}

const FILTERS: { id: FilterMode; label: string; hint: string }[] = [
  { id: 'all', label: 'sbr.filterAll', hint: 'sbr.hintAll' },
  { id: 'sites', label: 'sbr.filterSites', hint: 'sbr.hintSites' },
  { id: 'landable', label: 'sbr.filterLandable', hint: 'sbr.hintLandable' },
  { id: 'bio', label: 'sbr.filterBio', hint: 'sbr.hintBio' },
  { id: 'signals', label: 'sbr.filterSignals', hint: 'sbr.hintSignals' },
  { id: 'rings', label: 'sbr.filterRings', hint: 'sbr.hintRings' },
  { id: 'unscanned', label: 'sbr.filterUnscanned', hint: 'sbr.hintUnscanned' },
];

function kindIcon(body: OrreryViewBody): string {
  if (body.kind === 'star') return '★';
  if (body.kind === 'moon') return '☾';
  if (body.habitableBand === 'habitable') return '🌍';
  if (body.landable) return '🛬';
  return '●';
}

function matches(body: OrreryViewBody, filter: FilterMode): boolean {
  switch (filter) {
    case 'all': return true;
    case 'bodies': return body.kind !== 'star';
    case 'landable': return body.landable;
    case 'bio': return body.bioSignals > 0;
    case 'signals': return hasSignals(body.signals);
    case 'sites': return body.structures.length > 0;
    case 'rings': return body.rings.length > 0;
    case 'unscanned': return !body.scanned;
    default: return true;
  }
}

/** Ключ группировки: звезда-владелец (у самой звезды — она же). */
const NO_STAR = '__no_star__';

function groupOf(body: OrreryViewBody, payload: OrreryViewPayload): string {
  if (body.kind === 'star') return body.name;
  const cluster = payload.clusters.find((candidate) => candidate.bodies.includes(body.name));
  return cluster?.star || body.star || NO_STAR;
}

export default function SystemBodyRail({
  payload,
  focus,
  onFocus,
  filter,
  onFilterChange,
  onClose,
}: SystemBodyRailProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<'distance' | 'name' | 'progress'>('distance');

  const structuresByBody = useMemo(() => {
    const map = new Map<string, OrreryViewStructure[]>();
    for (const structure of payload.structures) {
      if (!structure.body) continue;
      const list = map.get(structure.body) ?? [];
      list.push(structure);
      map.set(structure.body, list);
    }
    return map;
  }, [payload.structures]);

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const visible = payload.bodies.filter((body) => {
      if (!matches(body, filter)) return false;
      if (!needle) return true;
      return body.name.toLowerCase().includes(needle) || body.cls.toLowerCase().includes(needle);
    });
    const compare = (left: OrreryViewBody, right: OrreryViewBody) => {
      if (sort === 'name') return left.shortName.localeCompare(right.shortName, 'ru');
      if (sort === 'progress') {
        const leftProgress = (structuresByBody.get(left.name) ?? []).reduce((total, item) => total + item.progress, 0);
        const rightProgress = (structuresByBody.get(right.name) ?? []).reduce((total, item) => total + item.progress, 0);
        return rightProgress - leftProgress;
      }
      return (left.orbitLs || left.distanceLs) - (right.orbitLs || right.distanceLs);
    };
    const order: string[] = [];
    const buckets = new Map<string, OrreryViewBody[]>();
    for (const body of visible) {
      const key = groupOf(body, payload);
      if (!buckets.has(key)) {
        buckets.set(key, []);
        order.push(key);
      }
      buckets.get(key)!.push(body);
    }
    return order.map((key) => ({
      key,
      bodies: (buckets.get(key) ?? []).sort(compare),
    }));
  }, [payload.bodies, payload.clusters, query, filter, sort, structuresByBody]);

  const totalShown = groups.reduce((total, group) => total + group.bodies.length, 0);
  const multiStar = payload.summary.stars > 1;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
      <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--line)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <input
            value={query}
            onInput={(event) => setQuery((event.target as HTMLInputElement).value)}
            placeholder={t('sbr.searchPlaceholder')}
            aria-label={t('sbr.searchAria')}
            style={{
              flex: 1, minWidth: 0, background: 'var(--bg)', border: '1px solid var(--line)', borderRadius: 2,
              color: 'var(--text)', padding: '6px 9px', fontSize: 12.5, outline: 'none',
            }}
          />
          <select
            value={sort}
            onChange={(event) => setSort(event.target.value as typeof sort)}
            aria-label={t('sbr.sortAria')}
            style={{
              background: 'var(--bg)', border: '1px solid var(--line)', borderRadius: 2, color: 'var(--text)',
              padding: '6px 6px', fontSize: 12,
            }}
          >
            <option value="distance">{t('sbr.sortDistance')}</option>
            <option value="name">{t('sbr.sortName')}</option>
            <option value="progress">{t('sbr.sortProgress')}</option>
          </select>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              title={t('sbr.collapse')}
              style={{ background: 'transparent', border: '1px solid var(--line)', borderRadius: 2, color: 'var(--muted)', cursor: 'pointer', padding: '4px 8px', fontSize: 12 }}
            >
              ✕
            </button>
          )}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
          {FILTERS.map((entry) => {
            const active = filter === entry.id;
            return (
              <button
                key={entry.id}
                type="button"
                title={t(entry.hint)}
                onClick={() => {
                  onFilterChange?.(entry.id);
                }}
                style={{
                  background: active ? 'rgba(230,126,34,0.12)' : 'var(--bg)',
                  border: `1px solid ${active ? 'var(--orange)' : 'var(--line)'}`,
                  color: active ? 'var(--orange)' : 'var(--muted)',
                  borderRadius: 2,
                  padding: '3px 9px',
                  fontSize: 11,
                  cursor: 'pointer',
                }}
              >
                {t(entry.label)}
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '8px 10px 24px' }}>
        {totalShown === 0 && (
          <p style={{ color: 'var(--muted)', fontSize: 12, marginTop: 12 }}>
            {t('sbr.empty')}
          </p>
        )}
        {groups.map((group) => (
          <div key={group.key} style={{ marginBottom: 12 }}>
            {multiStar && (
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, margin: '4px 2px 6px' }}>
                <button
                  type="button"
                  onClick={() => onFocus(group.key)}
                  title={t('sbr.showCluster')}
                  style={{ background: 'transparent', border: 'none', color: '#ffd166', fontSize: 11.5, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', cursor: 'pointer', padding: 0 }}
                >
                  ★ {group.key === NO_STAR ? t('sbr.noStar') : group.key.replace(`${payload.system} `, '')}
                </button>
                <span style={{ color: '#6b7280', fontSize: 10.5 }}>{t('sbr.bodyCount', { count: group.bodies.length })}</span>
              </div>
            )}
            <div style={{ display: 'grid', gap: 6 }}>
              {group.bodies.map((body) => {
                const bodyStructures = structuresByBody.get(body.name) ?? [];
                const active = focus === body.name;
                const progress = bodyStructures.length
                  ? Math.round(bodyStructures.reduce((total, item) => total + item.progress, 0) / bodyStructures.length)
                  : null;
                return (
                  <button
                    key={body.name}
                    type="button"
                    onClick={() => onFocus(body.name)}
                    onMouseEnter={() => undefined}
                    title={t('sbr.showOnMap', { name: body.name })}
                    style={{
                      textAlign: 'left',
                      background: active ? 'rgba(230,126,34,0.08)' : 'var(--bg)',
                      border: `1px solid ${active ? 'var(--orange)' : 'var(--line)'}`,
                      borderRadius: 2,
                      padding: '8px 10px',
                      cursor: 'pointer',
                      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                      color: 'var(--text)',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ color: body.color, fontSize: 12 }}>{kindIcon(body)}</span>
                      <span style={{ fontSize: 12.5, fontWeight: 600, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {body.shortName || body.name}
                      </span>
                      {progress != null && (
                        <span style={{ fontSize: 10.5, color: progress >= 100 ? '#22c55e' : '#ff9f43', fontWeight: 700 }}>
                          🏗 {progress}%
                        </span>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 3, fontSize: 10.5, color: 'var(--muted)' }}>
                      <span>{body.cls || t(body.kind === 'star' ? 'sbr.star' : 'sbr.body')}</span>
                      {body.orbitLs > 0 && body.kind !== 'star' && <span>{formatLightSeconds(body.orbitLs)}</span>}
                      {body.radiusM > 0 && <span>{t('sbr.km', { value: formatNumber(body.radiusM / 1000, 0) })}</span>}
                      {body.gravity > 0 && <span>{formatGravity(body.gravity)}</span>}
                    </div>
                    {(body.landable || hasSignals(body.signals) || body.rings.length > 0 || body.habitableBand === 'habitable' || !body.scanned) && (
                      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 5 }}>
                        {body.habitableBand === 'habitable' && <Tag color="#2ecc71">{t('sbr.habitable')}</Tag>}
                        {body.landable && <Tag color="#00f3ff">{t('sbr.landing')}</Tag>}
                        {activeSignalKinds(body.signals).map((kind) => (
                          <Tag key={kind} color={SIGNAL_META[kind].color}>
                            {SIGNAL_META[kind].icon} {body.signals[kind]}
                          </Tag>
                        ))}
                        {body.rings.length > 0 && <Tag color="#9fd8ef">💍 {body.rings.length}</Tag>}
                        {!body.scanned && <Tag color="#9ca3af">{t('sbr.noScan')}</Tag>}
                      </div>
                    )}
                    {bodyStructures.map((structure) => (
                      <div key={structure.id} style={{ marginTop: 5 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6, fontSize: 10.5, color: structureColor(structure) }}>
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{structure.name}</span>
                          <span>{structure.complete ? t('sbr.done') : `${Math.round(structure.progress)}%`}</span>
                        </div>
                        <div style={{ height: 3, background: '#2b2f33', borderRadius: 2, marginTop: 2, overflow: 'hidden' }}>
                          <div style={{ width: `${Math.max(0, Math.min(100, structure.progress))}%`, height: '100%', background: structureColor(structure) }} />
                        </div>
                        {structure.remainingTons > 0 && (
                          <div style={{ fontSize: 10, color: 'var(--muted)' }}>{t('sbr.remaining', { tons: formatTons(structure.remainingTons) })}</div>
                        )}
                      </div>
                    ))}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Tag({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span style={{ fontSize: 9.5, color, background: `${color}1f`, border: `1px solid ${color}44`, borderRadius: 2, padding: '0 6px', lineHeight: '15px' }}>
      {children}
    </span>
  );
}
