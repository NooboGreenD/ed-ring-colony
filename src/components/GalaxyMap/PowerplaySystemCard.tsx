'use client';

/**
 * Карточка системы слоя «PowerPlay» на карте Atlas: чья система, откуда это
 * известно, в каком состоянии, когда это видели, и чьи зоны влияния её
 * накрывают (оплоты в 30 св. лет и укреплённые системы в 20 св. лет — и своей
 * державы, и чужих).
 *
 * Владелец бывает не определён: дамп EDSM перечисляет у системы все державы,
 * чьи зоны её накрывают, но не говорит, какая из них владелец. Тогда карточка
 * так и пишет и показывает претендентов.
 */

import Link from 'next/link';
import { IconExternalLink, IconMapPin } from '@/components/Icons';
import {
  formatPowerplayDate,
  isUnknownPower,
  powerInfo,
  powerplayBasisText,
  type PowerplayInfluence,
  type PowerplaySystem,
} from '@/lib/powerplay';
import { useI18n } from '@/lib/i18n/I18nContext';
import {
  POWER_ALLEGIANCE_KEYS,
  POWER_BASIS_KEYS,
  POWER_STATE_HINT_KEYS,
  POWER_STATE_KEYS,
  POWER_STATE_ZONE_KEYS,
  gameLabel,
} from '@/lib/i18n/gameLabels';
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
  const { t, locale } = useI18n();
  const info = powerInfo(system.power);
  const color = info.color;
  const unknown = isUnknownPower(system.power);
  const basisText = gameLabel(
    t,
    POWER_BASIS_KEYS,
    unknown ? 'unknown' : system.basis,
    powerplayBasisText(system) ?? '',
  );
  const lyText = (distance: number) => {
    const digits = distance < 10 ? 2 : 1;
    return t('card.distanceLy', {
      value: distance.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits }),
    });
  };
  const ageText = (value: number | null | undefined) => {
    if (value == null || !Number.isFinite(value)) return t('card.ppAgeUnknown');
    const days = Math.floor(Math.max(0, now - value) / 86_400_000);
    if (days === 0) return t('card.ageToday');
    if (days === 1) return t('card.ageYesterday');
    return t('card.ageDays', { count: days });
  };
  // Соседи владельца (державы, чьи зоны тоже накрывают систему) или претенденты.
  const others = (system.candidates ?? []).filter((candidate) => candidate !== system.power);
  const shown = influence.slice(0, INFLUENCE_SHOWN);
  const hidden = influence.length - shown.length;
  const systemHref = `/system/${encodeURIComponent(system.name)}`;

  return (
    <div
      className="powerplay-system-card"
      role="dialog"
      aria-label={t('card.ppAria', { name: system.name })}
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
          title={t('atlas.ui.close')}
          aria-label={t('card.closeAria')}
          style={{ background: 'transparent', border: 'none', color: DIM, cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: 0 }}
        >
          ✕
        </button>
      </div>

      <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: TEXT }} data-powerplay-owner={unknown ? 'unknown' : system.power}>
        <PowerSwatch color={color} />
        <span style={{ fontWeight: 600 }}>{info.label}</span>
        {info.allegiance && <span style={{ fontSize: 11, color: MUTED }}>· {t(POWER_ALLEGIANCE_KEYS[info.allegiance])}</span>}
      </div>
      {basisText && (
        <div style={{ marginTop: 2, fontSize: 11, color: unknown ? '#fbbf24' : DIM, lineHeight: 1.35 }} data-powerplay-basis={unknown ? 'unknown' : system.basis ?? ''}>
          {unknown ? t('card.ppUnknownOwner') : t('card.ppOwnerBasis', { basis: basisText })}
        </div>
      )}
      {others.length > 0 && (
        <div style={{ marginTop: 4, fontSize: 11, color: MUTED, lineHeight: 1.5 }} data-powerplay-candidates={others.join('|')}>
          {unknown ? t('card.ppCandidates') : t('card.ppNeighbourZones')}
          {others.map((candidate, index) => {
            const other = powerInfo(candidate);
            return (
              <span key={candidate} style={{ whiteSpace: 'nowrap' }}>
                {index > 0 ? ', ' : ''}
                <PowerSwatch color={other.color} /> <span style={{ color: other.color }}>{other.label}</span>
              </span>
            );
          })}
        </div>
      )}
      <div style={{ marginTop: 4, fontSize: 12, color: TEXT }} title={t(POWER_STATE_HINT_KEYS[system.state])}>
        {t(POWER_STATE_KEYS[system.state])}
        <span style={{ color: MUTED }}> · {system.state}</span>
      </div>
      <div style={{ marginTop: 2, fontSize: 11, color: MUTED }}>{t(POWER_STATE_ZONE_KEYS[system.state])}</div>
      <div style={{ marginTop: 6, fontSize: 11, color: DIM }}>
        {system.basis === 'journal' ? t('card.observationJournal') : t('card.observationEdsm')}:{' '}
        {formatPowerplayDate(system.observedAt)} ({ageText(system.observedAt)})
      </div>
      <div style={{ marginTop: 2, fontSize: 11, color: DIM }}>
        <IconMapPin size={11} /> {formatCoordinate(system.x)}, {formatCoordinate(system.y)}, {formatCoordinate(system.z)}
      </div>

      <div style={{ marginTop: 10, borderTop: '1px solid #2d2f33', paddingTop: 8 }}>
        <div style={{ fontSize: 10, color: MUTED, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>
          {t('card.ppZonesTitle')}
        </div>
        {shown.length === 0 ? (
          <div style={{ fontSize: 11, color: DIM, lineHeight: 1.4 }}>
            {t('card.ppNoZones')}
          </div>
        ) : (
          <ul aria-label={t('atlas.ui.ppZonesAria')} style={{ margin: 0, padding: 0, listStyle: 'none' }}>
            {shown.map((item) => {
              const other = powerInfo(item.power);
              const own = item.power === system.power && !unknown;
              return (
                <li key={item.power} data-powerplay-influence={item.power} style={{ display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: 11, color: MUTED, marginTop: 3 }}>
                  <PowerplayGlyph state={item.nearest.state} color={other.color} size={12} style={{ marginTop: 1 }} />
                  <span style={{ minWidth: 0 }}>
                    <span style={{ color: own ? TEXT : other.color, fontWeight: 600 }}>{other.label}</span>
                    {own ? <span style={{ color: DIM }}>{t('card.ppOwnPower')}</span> : null}
                    <br />
                    {t(POWER_STATE_KEYS[item.nearest.state]).toLocaleLowerCase(locale)}{' '}
                    {onShowSystem ? (
                      <button
                        type="button"
                        className="powerplay-system-link"
                        data-powerplay-link={item.nearest.name}
                        title={t('card.ppOpenSystem')}
                        onClick={() => onShowSystem({ id64: item.nearest.id64, name: item.nearest.name })}
                      >
                        {item.nearest.name}
                      </button>
                    ) : item.nearest.name}
                    , {lyText(item.nearest.distance)}
                    {item.sources > 1 ? <span style={{ color: DIM }}>{t('card.ppZonesCount', { count: item.sources })}</span> : null}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {hidden > 0 && <div style={{ fontSize: 10, color: DIM, marginTop: 3 }}>{t('card.ppMorePowers', { count: hidden })}</div>}
      </div>

      <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {onFocus && (
          <button
            type="button"
            onClick={() => onFocus(system)}
            style={{ fontSize: 11, color, background: `${color}14`, border: `1px solid ${color}55`, borderRadius: 4, padding: '3px 8px', cursor: 'pointer', fontFamily: 'inherit', textTransform: 'none', letterSpacing: 'normal' }}
          >
            <IconMapPin size={10} /> {t('card.toSystem')}
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
