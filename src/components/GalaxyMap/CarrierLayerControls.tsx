'use client';

/**
 * Панель слоя «Авианосцы» в управлении картой (и на `/map`, и в Atlas):
 * переключатель слоя, фильтр «чьи» (мой / эскадрилья / другие) и «класс»
 * (Drake / Javelin) со счётчиками и список систем, где стоят носители, —
 * клик по строке ведёт камеру к системе и открывает карточку.
 */

import { useState, type ReactNode } from 'react';
import {
  CARRIER_RELATION_HINT,
  CARRIER_RELATION_LABEL,
  CARRIER_TONE_COLOR,
  CARRIER_TYPE_FULL,
  CARRIER_TYPE_LABEL,
  MAP_CARRIER_RELATIONS,
  MAP_CARRIER_TYPES,
  carrierIconVariant,
  carrierJumpText,
  carrierListLabel,
  isDefaultCarrierFilter,
  toggleCarrierRelation,
  toggleCarrierType,
  type CarrierCounts,
  type CarrierLayerFilter,
  type CarrierSystemGroup,
} from '@/lib/carrierMap';
import { CarrierGlyph } from './CarrierGlyph';

export type CarrierLayerStatus = 'loading' | 'ready' | 'error';

export interface CarrierLayerControlsProps {
  show: boolean;
  onShowChange: (show: boolean) => void;
  filter: CarrierLayerFilter;
  onFilterChange: (filter: CarrierLayerFilter) => void;
  /** Счётчики по всем носителям (до фильтра). */
  counts: CarrierCounts;
  /** Носителей после фильтра. */
  visibleCount: number;
  /** Системы после фильтра. */
  groups: CarrierSystemGroup[];
  selectedKey: string | null;
  onSelectGroup: (group: CarrierSystemGroup) => void;
  status: CarrierLayerStatus;
  signedIn: boolean;
}

const MUTED = '#9ca3af';
const DIM = '#6b7280';
const LINE = '#3a3d40';
const LAYER_COLOR = CARRIER_TONE_COLOR.other;

function FilterChip({ on, color, title, onClick, children }: { on: boolean; color: string; title: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      title={title}
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontSize: 10,
        color: on ? color : DIM,
        background: on ? `${color}1f` : 'transparent',
        border: `1px solid ${on ? `${color}66` : LINE}`,
        borderRadius: 3,
        padding: '1px 6px',
        cursor: 'pointer',
        fontFamily: 'inherit',
        lineHeight: 1.6,
      }}
    >
      {children}
    </button>
  );
}

export function CarrierLayerControls({
  show,
  onShowChange,
  filter,
  onFilterChange,
  counts,
  visibleCount,
  groups,
  selectedKey,
  onSelectGroup,
  status,
  signedIn,
}: CarrierLayerControlsProps) {
  const [listOpen, setListOpen] = useState(true);
  const filtered = !isDefaultCarrierFilter(filter);
  const total = status === 'loading' && counts.total === 0 ? '…' : filtered ? `${visibleCount}/${counts.total}` : String(counts.total);
  const unplaced = groups.filter((group) => !group.position).length;

  return (
    <div className="carrier-layer-controls" style={{ borderTop: '1px solid #2d2f33', marginTop: 5, paddingTop: 5 }}>
      <label style={{ fontSize: 11, color: LAYER_COLOR, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}
        title="Где стоят авианосцы пилотов сайта: значок как в игре, жёлтый — ваш, зелёный — эскадрильи, оранжевый — остальные">
        <input type="checkbox" checked={show} onChange={(event) => onShowChange(event.target.checked)} />
        <CarrierGlyph size={14} tone="other" />
        Авианосцы ({total})
      </label>

      {show && (
        <div style={{ paddingLeft: 22, marginTop: 4, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div role="group" aria-label="Чьи носители" style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
            {MAP_CARRIER_RELATIONS.map((relation) => (
              <FilterChip
                key={relation}
                on={filter.relations[relation] !== false}
                color={CARRIER_TONE_COLOR[relation]}
                title={`Показывать: ${CARRIER_RELATION_HINT[relation]}`}
                onClick={() => onFilterChange(toggleCarrierRelation(filter, relation))}
              >
                <CarrierGlyph size={10} tone={relation} />
                {CARRIER_RELATION_LABEL[relation]} {counts.relations[relation]}
              </FilterChip>
            ))}
          </div>
          <div role="group" aria-label="Класс носителя" style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
            {MAP_CARRIER_TYPES.map((type) => (
              <FilterChip
                key={type}
                on={filter.types[type] !== false}
                color="#d1d5db"
                title={`Показывать: ${CARRIER_TYPE_FULL[type]}`}
                onClick={() => onFilterChange(toggleCarrierType(filter, type))}
              >
                <CarrierGlyph size={10} glyph={type === 'SquadronCarrier' ? 'javelin' : 'drake'} color="#d1d5db" />
                {CARRIER_TYPE_LABEL[type]} {counts.types[type]}
              </FilterChip>
            ))}
          </div>

          <button
            type="button"
            aria-expanded={listOpen}
            onClick={() => setListOpen((open) => !open)}
            style={{ alignSelf: 'flex-start', background: 'transparent', border: 'none', padding: 0, color: MUTED, fontSize: 10, cursor: 'pointer', fontFamily: 'inherit', textTransform: 'uppercase', letterSpacing: 0.5 }}
          >
            {listOpen ? '▾' : '▸'} В каких системах ({groups.length})
          </button>

          {listOpen && (
            <ul aria-label="Системы с авианосцами" style={{ listStyle: 'none', margin: 0, padding: 0, maxHeight: 190, overflowY: 'auto', border: `1px solid #2d2f33`, borderRadius: 3 }}>
              {groups.map((group) => {
                const variant = carrierIconVariant(group);
                const jump = group.carriers.map((carrier) => carrierJumpText(carrier)).find(Boolean);
                const active = selectedKey === group.key;
                return (
                  <li key={group.key}>
                    <button
                      type="button"
                      data-carrier-system={group.key}
                      aria-pressed={active}
                      onClick={() => onSelectGroup(group)}
                      title={group.position ? 'Показать на карте' : 'Координаты системы неизвестны — откроется только карточка'}
                      style={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: 6,
                        width: '100%',
                        textAlign: 'left',
                        background: active ? 'rgba(230,126,34,0.16)' : 'transparent',
                        border: 'none',
                        borderBottom: '1px solid #24272a',
                        color: '#eeeeee',
                        padding: '4px 6px',
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                        // Глобальный стиль кнопок — капс с разрядкой; имена систем и носителей так не читаются.
                        textTransform: 'none',
                        letterSpacing: 'normal',
                      }}
                    >
                      <CarrierGlyph size={14} glyph={variant.glyph} tone={variant.tone} style={{ marginTop: 1, opacity: variant.fade === 'stale' ? 0.55 : 1 }} />
                      <span style={{ minWidth: 0, flex: 1 }}>
                        <span style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
                          <span style={{ fontSize: 11, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{group.system}</span>
                          {group.carriers.length > 1 && <span style={{ fontSize: 10, color: CARRIER_TONE_COLOR[variant.tone] }}>×{group.carriers.length}</span>}
                        </span>
                        <span style={{ display: 'block', fontSize: 10, color: MUTED, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {carrierListLabel(group)}
                        </span>
                        {jump && <span style={{ display: 'block', fontSize: 10, color: '#ffd166', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{jump}</span>}
                        {!group.position && <span style={{ display: 'block', fontSize: 10, color: DIM }}>нет координат системы</span>}
                      </span>
                    </button>
                  </li>
                );
              })}
              {groups.length === 0 && (
                <li style={{ fontSize: 10, color: DIM, padding: '6px' }}>
                  {status === 'loading' ? 'Загрузка…' : counts.total === 0 ? 'Сайт пока не знает ни одного носителя' : 'Под выбранный фильтр носителей нет'}
                </li>
              )}
            </ul>
          )}

          {status === 'error' && <div style={{ fontSize: 10, color: '#f87171' }}>Не удалось обновить носители — повторим через минуту</div>}
          {unplaced > 0 && <div style={{ fontSize: 9, color: DIM }}>Без координат: {unplaced} — система не найдена ни в каталоге, ни в EDSM</div>}
          {!signedIn && <div style={{ fontSize: 9, color: DIM, lineHeight: 1.3 }}>Войдите, чтобы отличать свои носители и носители эскадрильи.</div>}
          <div style={{ fontSize: 9, color: DIM, lineHeight: 1.3 }}>
            значок как в игре; заполненный круг — Javelin, пунктир — запланированный прыжок, бледный — стоянка старше двух недель
          </div>
        </div>
      )}
    </div>
  );
}
