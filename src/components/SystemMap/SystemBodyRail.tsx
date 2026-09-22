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
import type { OrreryViewBody, OrreryViewPayload, OrreryViewStructure } from '@/lib/orrery3d/types';

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
  { id: 'all', label: 'все', hint: 'Все тела системы' },
  { id: 'sites', label: 'стройки', hint: 'Только тела со стройплощадками' },
  { id: 'landable', label: 'посадка', hint: 'Тела, где можно сесть' },
  { id: 'bio', label: 'био', hint: 'Тела с биологическими сигнатурами' },
  { id: 'rings', label: 'кольца', hint: 'Тела с кольцами' },
  { id: 'unscanned', label: 'без скана', hint: 'Не нанесены на карту' },
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
    case 'sites': return body.structures.length > 0;
    case 'rings': return body.rings.length > 0;
    case 'unscanned': return !body.scanned;
    default: return true;
  }
}

/** Ключ группировки: звезда-владелец (у самой звезды — она же). */
function groupOf(body: OrreryViewBody, payload: OrreryViewPayload): string {
  if (body.kind === 'star') return body.name;
  const cluster = payload.clusters.find((candidate) => candidate.bodies.includes(body.name));
  return cluster?.star || body.star || 'Без своей звезды';
}

export default function SystemBodyRail({
  payload,
  focus,
  onFocus,
  filter,
  onFilterChange,
  onClose,
}: SystemBodyRailProps) {
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
      <div style={{ padding: '10px 12px', borderBottom: '1px solid #323538' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <input
            value={query}
            onInput={(event) => setQuery((event.target as HTMLInputElement).value)}
            placeholder="поиск тела…"
            aria-label="Поиск тела"
            style={{
              flex: 1, minWidth: 0, background: '#1c1f22', border: '1px solid #3a3d40', borderRadius: 6,
              color: '#eeeeee', padding: '6px 9px', fontSize: 12.5, outline: 'none',
            }}
          />
          <select
            value={sort}
            onChange={(event) => setSort(event.target.value as typeof sort)}
            aria-label="Сортировка тел"
            style={{
              background: '#1c1f22', border: '1px solid #3a3d40', borderRadius: 6, color: '#cbd5e1',
              padding: '6px 6px', fontSize: 12,
            }}
          >
            <option value="distance">по дистанции</option>
            <option value="name">по имени</option>
            <option value="progress">по стройкам</option>
          </select>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              title="Свернуть список"
              style={{ background: 'transparent', border: '1px solid #3a3d40', borderRadius: 6, color: '#9ca3af', cursor: 'pointer', padding: '4px 8px', fontSize: 12 }}
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
                title={entry.hint}
                onClick={() => {
                  onFilterChange?.(entry.id);
                }}
                style={{
                  background: active ? 'rgba(230,126,34,0.18)' : '#1c1f22',
                  border: `1px solid ${active ? '#e67e22' : '#3a3d40'}`,
                  color: active ? '#ff9f43' : '#9ca3af',
                  borderRadius: 999,
                  padding: '3px 9px',
                  fontSize: 11,
                  cursor: 'pointer',
                }}
              >
                {entry.label}
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '8px 10px 24px' }}>
        {totalShown === 0 && (
          <p style={{ color: '#7e8794', fontSize: 12, marginTop: 12 }}>
            Ничего не найдено. Сбросьте фильтр или поиск.
          </p>
        )}
        {groups.map((group) => (
          <div key={group.key} style={{ marginBottom: 12 }}>
            {multiStar && (
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, margin: '4px 2px 6px' }}>
                <button
                  type="button"
                  onClick={() => onFocus(group.key)}
                  title="Показать кластер этой звезды"
                  style={{ background: 'transparent', border: 'none', color: '#ffd166', fontSize: 11.5, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', cursor: 'pointer', padding: 0 }}
                >
                  ★ {group.key.replace(`${payload.system} `, '')}
                </button>
                <span style={{ color: '#6b7280', fontSize: 10.5 }}>{group.bodies.length} тел</span>
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
                    title={`Показать ${body.name} на карте`}
                    style={{
                      textAlign: 'left',
                      background: active ? 'rgba(0,243,255,0.08)' : '#1c1f22',
                      border: `1px solid ${active ? 'rgba(0,243,255,0.55)' : '#323538'}`,
                      borderRadius: 8,
                      padding: '8px 10px',
                      cursor: 'pointer',
                      color: '#eeeeee',
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
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 3, fontSize: 10.5, color: '#9ca3af' }}>
                      <span>{body.cls || (body.kind === 'star' ? 'звезда' : 'тело')}</span>
                      {body.orbitLs > 0 && body.kind !== 'star' && <span>{formatLightSeconds(body.orbitLs)}</span>}
                      {body.radiusM > 0 && <span>{formatNumber(body.radiusM / 1000, 0)} км</span>}
                      {body.gravity > 0 && <span>{formatGravity(body.gravity)}</span>}
                    </div>
                    {(body.landable || body.bioSignals > 0 || body.rings.length > 0 || body.habitableBand === 'habitable' || !body.scanned) && (
                      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 5 }}>
                        {body.habitableBand === 'habitable' && <Tag color="#2ecc71">🌍 обитаемая зона</Tag>}
                        {body.landable && <Tag color="#00f3ff">🛬 посадка</Tag>}
                        {body.bioSignals > 0 && <Tag color="#22c55e">🌿 {body.bioSignals}</Tag>}
                        {body.rings.length > 0 && <Tag color="#9fd8ef">💍 {body.rings.length}</Tag>}
                        {!body.scanned && <Tag color="#9ca3af">❔ нет скана</Tag>}
                      </div>
                    )}
                    {bodyStructures.map((structure) => (
                      <div key={structure.id} style={{ marginTop: 5 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6, fontSize: 10.5, color: structureColor(structure) }}>
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{structure.name}</span>
                          <span>{structure.complete ? 'готово' : `${Math.round(structure.progress)}%`}</span>
                        </div>
                        <div style={{ height: 3, background: '#2b2f33', borderRadius: 2, marginTop: 2, overflow: 'hidden' }}>
                          <div style={{ width: `${Math.max(0, Math.min(100, structure.progress))}%`, height: '100%', background: structureColor(structure) }} />
                        </div>
                        {structure.remainingTons > 0 && (
                          <div style={{ fontSize: 10, color: '#7e8794' }}>осталось {formatTons(structure.remainingTons)}</div>
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
    <span style={{ fontSize: 9.5, color, background: `${color}1f`, border: `1px solid ${color}44`, borderRadius: 999, padding: '0 6px', lineHeight: '15px' }}>
      {children}
    </span>
  );
}
