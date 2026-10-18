'use client';

/**
 * Карточка системы слоя «PowerPlay» на карте Atlas: чья система, в каком
 * состоянии, когда это видели, и чьи зоны влияния её накрывают (оплоты в
 * 30 св. лет и укреплённые системы в 20 св. лет — и своей державы, и чужих).
 */

import Link from 'next/link';
import { IconExternalLink, IconMapPin } from '@/components/Icons';
import {
  POWER_ALLEGIANCE_LABEL,
  POWERPLAY_STATE_HINT,
  POWERPLAY_STATE_LABEL,
  POWERPLAY_STATE_ZONE,
  formatLy,
  formatPowerplayDate,
  powerInfo,
  powerplayAge,
  type PowerplayInfluence,
  type PowerplaySystem,
} from '@/lib/powerplay';
import { PowerSwatch, PowerplayGlyph } from './PowerplayGlyph';

const MUTED = '#9ca3af';
const DIM = '#6b7280';
const TEXT = '#eeeeee';
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const INFLUENCE_SHOWN = 6;

function formatCoordinate(value: number): string {
  return Number.isFinite(value) ? value.toFixed(1) : '?';
}

export interface PowerplaySystemCardProps {
  system: PowerplaySystem;
  influence: PowerplayInfluence[];
  onClose: () => void;
  onFocus?: (system: PowerplaySystem) => void;
  /** Клик по системе в «зонах влияния»: открыть её карточку (или подвести камеру). */
  onShowSystem?: (ref: { id64?: string | null; name: string }) => void;
  /** Для тестов: «сейчас». */
  now?: number;
}

export function PowerplaySystemCard({ system, influence, onClose, onFocus, onShowSystem, now = Date.now() }: PowerplaySystemCardProps) {
  const info = powerInfo(system.power);
  const color = info.color;
  const shown = influence.slice(0, INFLUENCE_SHOWN);
  const hidden = influence.length - shown.length;
  const systemHref = `/system/${encodeURIComponent(system.name)}`;

  return (
    <div
      className="powerplay-system-card"
      role="dialog"
      aria-label={`PowerPlay: система ${system.name}`}
      data-powerplay-system={system.id64 || system.name}
      style={{
        position: 'absolute', bottom: 12, left: 12, zIndex: 10, background: 'rgba(13,15,17,0.92)', backdropFilter: 'blur(8px)',
        border: `1px solid ${color}66`, borderRadius: 8, padding: 12, minWidth: 260, maxWidth: 340, maxHeight: 'calc(100% - 24px)',
        overflowY: 'auto', pointerEvents: 'auto', boxSizing: 'border-box',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <PowerplayGlyph state={system.state} color={color} size={18} />
          <Link href={systemHref} style={{ textDecoration: 'none', minWidth: 0 }}>
            <span style={{ fontWeight: 700, fontSize: 15, color, display: 'inline-flex', alignItems: 'center', gap: 6, overflowWrap: 'anywhere' }}>
              {system.name}
              <IconExternalLink size={12} />
            </span>
          </Link>
        </div>
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

      <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: TEXT }}>
        <PowerSwatch color={color} />
        <span style={{ fontWeight: 600 }}>{info.label}</span>
        {info.allegiance && <span style={{ fontSize: 11, color: MUTED }}>· {POWER_ALLEGIANCE_LABEL[info.allegiance]}</span>}
      </div>
      <div style={{ marginTop: 4, fontSize: 12, color: TEXT }} title={POWERPLAY_STATE_HINT[system.state]}>
        {POWERPLAY_STATE_LABEL[system.state]}
        <span style={{ color: MUTED }}> · {system.state}</span>
      </div>
      <div style={{ marginTop: 2, fontSize: 11, color: MUTED }}>{POWERPLAY_STATE_ZONE[system.state]}</div>
      <div style={{ marginTop: 6, fontSize: 11, color: DIM }}>
        Данные EDSM: {formatPowerplayDate(system.observedAt)} ({powerplayAge(system.observedAt, now)})
      </div>
      <div style={{ marginTop: 2, fontSize: 11, color: DIM }}>
        <IconMapPin size={11} /> {formatCoordinate(system.x)}, {formatCoordinate(system.y)}, {formatCoordinate(system.z)}
      </div>

      <div style={{ marginTop: 10, borderTop: '1px solid #2d2f33', paddingTop: 8 }}>
        <div style={{ fontSize: 10, color: MUTED, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>
          Зоны влияния в этой точке
        </div>
        {shown.length === 0 ? (
          <div style={{ fontSize: 11, color: DIM, lineHeight: 1.4 }}>
            Ни один оплот (30 св. лет) или укреплённая система (20 св. лет) сюда не дотягивается — по данным слоя.
          </div>
        ) : (
          <ul aria-label="Зоны влияния" style={{ margin: 0, padding: 0, listStyle: 'none' }}>
            {shown.map((item) => {
              const other = powerInfo(item.power);
              const own = item.power === system.power;
              return (
                <li key={item.power} data-powerplay-influence={item.power} style={{ display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: 11, color: MUTED, marginTop: 3 }}>
                  <PowerplayGlyph state={item.nearest.state} color={other.color} size={12} style={{ marginTop: 1 }} />
                  <span style={{ minWidth: 0 }}>
                    <span style={{ color: own ? TEXT : other.color, fontWeight: 600 }}>{other.label}</span>
                    {own ? <span style={{ color: DIM }}> · своя держава</span> : null}
                    <br />
                    {POWERPLAY_STATE_LABEL[item.nearest.state].toLowerCase()}{' '}
                    {onShowSystem ? (
                      <button
                        type="button"
                        className="powerplay-system-link"
                        data-powerplay-link={item.nearest.name}
                        title="Открыть эту систему"
                        onClick={() => onShowSystem({ id64: item.nearest.id64, name: item.nearest.name })}
                      >
                        {item.nearest.name}
                      </button>
                    ) : item.nearest.name}
                    , {formatLy(item.nearest.distance)}
                    {item.sources > 1 ? <span style={{ color: DIM }}> · зон: {item.sources}</span> : null}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {hidden > 0 && <div style={{ fontSize: 10, color: DIM, marginTop: 3 }}>и ещё держав: {hidden}</div>}
      </div>

      <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {onFocus && (
          <button
            type="button"
            onClick={() => onFocus(system)}
            style={{ fontSize: 11, color, background: `${color}14`, border: `1px solid ${color}55`, borderRadius: 4, padding: '3px 8px', cursor: 'pointer', fontFamily: 'inherit', textTransform: 'none', letterSpacing: 'normal' }}
          >
            <IconMapPin size={10} /> К системе
          </button>
        )}
        <a
          href={`https://www.edsm.net/en/system?systemName=${encodeURIComponent(system.name)}`}
          target="_blank"
          rel="noopener noreferrer"
          style={{ fontSize: 11, color: '#3b82f6', textDecoration: 'none' }}
        >
          EDSM <IconExternalLink size={10} />
        </a>
        <a
          href={`https://inara.cz/elite/starsystem/?search=${encodeURIComponent(system.name)}`}
          target="_blank"
          rel="noopener noreferrer"
          style={{ fontSize: 11, color: MUTED, textDecoration: 'none' }}
        >
          Inara <IconExternalLink size={10} />
        </a>
        {system.id64 && (
          <a
            href={`https://spansh.co.uk/system/${encodeURIComponent(system.id64)}`}
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontSize: 11, color: '#ffd166', textDecoration: 'none' }}
          >
            Spansh <IconExternalLink size={10} />
          </a>
        )}
      </div>
      <div style={{ marginTop: 6, fontSize: 9, color: DIM, fontFamily: MONO }}>id64 {system.id64 || '—'}</div>
    </div>
  );
}
