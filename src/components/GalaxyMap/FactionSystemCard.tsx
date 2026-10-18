'use client';

/**
 * Карточка системы слоя «Фракции» на карте Atlas: кто у власти, все минорные
 * фракции системы с влиянием и состояниями, принадлежность, правительство,
 * экономика, безопасность, население, когда и откуда данные. Любую фракцию из
 * списка можно одним кликом добавить на карту (или убрать с неё).
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { IconExternalLink, IconMapPin, IconPlus, IconX } from '@/components/Icons';
import {
  BGS_ALLEGIANCE_COLOR,
  BGS_CONFLICT_STATES,
  BGS_MAX_SELECTED,
  BGS_SOURCE_LABEL,
  allegianceLabel,
  bgsAge,
  decodeSystemDetail,
  economyLabel,
  formatBgsDate,
  formatInfluence,
  formatPopulation,
  governmentLabel,
  happinessLabel,
  securityLabel,
  stateLabel,
  type BgsMapPoint,
  type BgsSystemDetail,
} from '@/lib/bgs';

const MUTED = '#9ca3af';
const DIM = '#6b7280';
const TEXT = '#eeeeee';
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

export interface FactionSystemCardProps {
  point: BgsMapPoint;
  /** Выбранные на карте фракции: id → цвет. */
  selectedColors: ReadonlyMap<number, string>;
  onClose: () => void;
  onAddFaction?: (faction: { id: number; name: string; allegiance?: string | null }) => void;
  onRemoveFaction?: (id: number) => void;
  /** Для тестов: «сейчас». */
  now?: number;
}

function StateChips({ title, states, color }: { title: string; states: string[]; color: string }) {
  if (states.length === 0) return null;
  return (
    <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 3, alignItems: 'center' }}>
      <span style={{ color: DIM }}>{title}:</span>
      {states.map((state) => (
        <span
          key={state}
          style={{
            fontSize: 10, padding: '0 4px', borderRadius: 3, border: `1px solid ${BGS_CONFLICT_STATES.has(state) ? '#ef444477' : `${color}55`}`,
            color: BGS_CONFLICT_STATES.has(state) ? '#f87171' : color,
          }}
        >
          {stateLabel(state)}
        </span>
      ))}
    </span>
  );
}

export function FactionSystemCard({ point, selectedColors, onClose, onAddFaction, onRemoveFaction, now = Date.now() }: FactionSystemCardProps) {
  const [detail, setDetail] = useState<BgsSystemDetail | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!point.id64) {
      setDetail(null);
      setError('У системы нет id64 — подробностей нет');
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError('');
    fetch(`/api/factions/system?id64=${encodeURIComponent(point.id64)}`)
      .then(async (response) => {
        const body = await response.json().catch(() => null);
        if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
        const parsed = decodeSystemDetail(body);
        if (!parsed) throw new Error('Пустой ответ сервера');
        if (!cancelled) setDetail(parsed);
      })
      .catch((err) => {
        if (!cancelled) {
          setDetail(null);
          setError(err instanceof Error ? err.message : 'Не удалось загрузить систему');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [point.id64]);

  const allegiance = detail?.allegiance ?? point.system?.allegiance ?? 'None';
  const accent = point.background || point.entries.length === 0 ? BGS_ALLEGIANCE_COLOR[allegiance] : point.color;
  const controlling = detail?.controlling ?? point.system?.controlling ?? null;
  const observed = detail?.observedAt ?? (point.observedAt != null ? new Date(point.observedAt).toISOString() : null);
  const source = detail?.source ?? point.system?.source ?? null;
  const selectedCount = selectedColors.size;

  return (
    <div
      className="bgs-system-card"
      role="dialog"
      aria-label={`Фракции: система ${point.name}`}
      data-bgs-system={point.id64 || point.name}
      style={{
        position: 'absolute', bottom: 12, left: 12, zIndex: 10, background: 'rgba(13,15,17,0.93)', backdropFilter: 'blur(8px)',
        border: `1px solid ${accent}66`, borderRadius: 8, padding: 12, minWidth: 280, maxWidth: 360, maxHeight: 'calc(100% - 24px)',
        overflowY: 'auto', pointerEvents: 'auto', boxSizing: 'border-box',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
        <Link href={`/system/${encodeURIComponent(point.name)}`} style={{ textDecoration: 'none', minWidth: 0 }}>
          <span style={{ fontWeight: 700, fontSize: 15, color: accent, display: 'inline-flex', alignItems: 'center', gap: 6, overflowWrap: 'anywhere' }}>
            {point.name}
            <IconExternalLink size={12} />
          </span>
        </Link>
        <button
          type="button"
          onClick={onClose}
          title="Закрыть"
          aria-label="Закрыть карточку"
          style={{ background: 'transparent', border: 'none', color: DIM, cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: 0 }}
        >
          ✕
        </button>
      </div>

      <div style={{ marginTop: 6, fontSize: 12, color: TEXT, lineHeight: 1.5 }}>
        {controlling ? (
          <div data-bgs-controlling={controlling}>
            У власти: <strong style={{ color: TEXT }}>{controlling}</strong>
            {detail?.state && detail.state !== 'None' ? <span style={{ color: MUTED }}> · {stateLabel(detail.state)}</span> : null}
          </div>
        ) : (
          <div style={{ color: MUTED }}>Контролирующая фракция неизвестна</div>
        )}
        <div style={{ color: MUTED }}>
          <span style={{ color: BGS_ALLEGIANCE_COLOR[allegiance] }}>{allegianceLabel(allegiance)}</span>
          {(detail?.government ?? point.system?.government) ? ` · ${governmentLabel(detail?.government ?? point.system?.government)}` : ''}
          {detail?.security ? ` · безопасность ${securityLabel(detail.security).toLowerCase()}` : ''}
        </div>
        {(detail?.economy || detail?.population || point.system?.population) && (
          <div style={{ color: MUTED }}>
            {detail?.economy ? `Экономика: ${economyLabel(detail.economy)}${detail.secondEconomy ? ` / ${economyLabel(detail.secondEconomy)}` : ''}` : ''}
            {detail?.economy && (detail?.population ?? point.system?.population) ? ' · ' : ''}
            {(detail?.population ?? point.system?.population) ? `население ${formatPopulation(detail?.population ?? point.system?.population)}` : ''}
          </div>
        )}
      </div>

      <div style={{ marginTop: 10, borderTop: '1px solid #2d2f33', paddingTop: 8 }}>
        <div style={{ fontSize: 10, color: MUTED, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>
          Фракции системы{detail ? ` (${detail.factions.length})` : ''}
        </div>
        {loading && !detail && <div style={{ fontSize: 11, color: DIM }}>Загружаю фракции…</div>}
        {error && <div style={{ fontSize: 11, color: '#f87171' }}>{error}</div>}
        {detail && detail.factions.length === 0 && <div style={{ fontSize: 11, color: DIM }}>Список фракций пуст.</div>}
        {detail && detail.factions.length > 0 && (
          <ul aria-label="Фракции системы" style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
            {detail.factions.map((faction) => {
              const selectedColor = selectedColors.get(faction.id) ?? null;
              const color = selectedColor ?? BGS_ALLEGIANCE_COLOR[faction.allegiance];
              const controls = detail.controllingId === faction.id || (controlling != null && faction.name === controlling);
              const share = faction.influence == null ? 0 : Math.max(0, Math.min(1, faction.influence));
              const canAdd = !selectedColor && selectedCount < BGS_MAX_SELECTED;
              return (
                <li key={faction.id} data-bgs-faction={faction.name} style={{ fontSize: 11, color: MUTED }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span
                      aria-hidden="true"
                      style={{ width: 8, height: 8, borderRadius: controls ? 1 : '50%', background: color, flex: '0 0 auto', transform: controls ? 'rotate(45deg)' : undefined }}
                    />
                    <span style={{ color: TEXT, fontWeight: controls ? 700 : 500, minWidth: 0, overflowWrap: 'anywhere', flex: 1 }}>
                      {faction.name}
                      {faction.isPlayer && <span title="Фракция игроков" style={{ color: '#fbbf24', fontWeight: 400 }}> · PMF</span>}
                    </span>
                    <span style={{ fontFamily: MONO, color: TEXT, fontVariantNumeric: 'tabular-nums' }}>{formatInfluence(faction.influence)}</span>
                    {selectedColor ? (
                      onRemoveFaction && (
                        <button
                          type="button"
                          className="bgs-card-btn"
                          title="Убрать фракцию с карты"
                          aria-label={`Убрать ${faction.name} с карты`}
                          onClick={() => onRemoveFaction(faction.id)}
                          style={{ color: selectedColor, borderColor: `${selectedColor}77` }}
                        >
                          <IconX size={10} />
                        </button>
                      )
                    ) : (
                      onAddFaction && (
                        <button
                          type="button"
                          className="bgs-card-btn"
                          title={canAdd ? 'Показать все системы этой фракции на карте' : `Не больше ${BGS_MAX_SELECTED} фракций за раз`}
                          aria-label={`Показать ${faction.name} на карте`}
                          disabled={!canAdd}
                          onClick={() => onAddFaction({ id: faction.id, name: faction.name, allegiance: faction.allegiance })}
                        >
                          <IconPlus size={10} />
                        </button>
                      )
                    )}
                  </div>
                  <div style={{ height: 3, background: '#22252a', borderRadius: 2, marginTop: 3, overflow: 'hidden' }}>
                    <div style={{ width: `${share * 100}%`, height: '100%', background: color, opacity: 0.85 }} />
                  </div>
                  <div style={{ marginTop: 2, display: 'flex', flexWrap: 'wrap', gap: '2px 8px' }}>
                    <span>
                      {allegianceLabel(faction.allegiance)} · {governmentLabel(faction.government)}
                      {controls ? <span style={{ color: TEXT }}> · у власти</span> : null}
                      {faction.happiness ? ` · ${happinessLabel(faction.happiness).toLowerCase()}` : ''}
                      {faction.systemsCount > 1 ? ` · систем: ${faction.systemsCount}` : ''}
                    </span>
                    <StateChips title="состояние" states={faction.activeStates} color={color} />
                    <StateChips title="ожидается" states={faction.pendingStates} color={DIM} />
                    <StateChips title="затухает" states={faction.recoveringStates} color={DIM} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div style={{ marginTop: 8, fontSize: 11, color: DIM }}>
        Данные: {observed ? `${formatBgsDate(observed)} (${bgsAge(observed, now)})` : 'дата неизвестна'}
        {source ? ` · ${BGS_SOURCE_LABEL[source]}` : ''}
      </div>
      <div style={{ marginTop: 2, fontSize: 11, color: DIM }}>
        <IconMapPin size={11} /> {point.x.toFixed(1)}, {point.y.toFixed(1)}, {point.z.toFixed(1)}
      </div>

      <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <a
          href={`https://www.edsm.net/en/system?systemName=${encodeURIComponent(point.name)}`}
          target="_blank"
          rel="noopener noreferrer"
          style={{ fontSize: 11, color: '#3b82f6', textDecoration: 'none' }}
        >
          EDSM <IconExternalLink size={10} />
        </a>
        <a
          href={`https://inara.cz/elite/starsystem/?search=${encodeURIComponent(point.name)}`}
          target="_blank"
          rel="noopener noreferrer"
          style={{ fontSize: 11, color: MUTED, textDecoration: 'none' }}
        >
          Inara <IconExternalLink size={10} />
        </a>
        {point.id64 && (
          <a
            href={`https://spansh.co.uk/system/${encodeURIComponent(point.id64)}`}
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontSize: 11, color: '#ffd166', textDecoration: 'none' }}
          >
            Spansh <IconExternalLink size={10} />
          </a>
        )}
      </div>
      <div style={{ marginTop: 6, fontSize: 9, color: DIM, fontFamily: MONO }}>id64 {point.id64 || '—'}</div>
    </div>
  );
}
