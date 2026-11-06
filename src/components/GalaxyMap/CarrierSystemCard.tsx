'use client';

/**
 * Карточка системы с авианосцами на карте галактики: какие носители там
 * стоят, чьи, кого пускают на стыковку, какие службы работают, когда их
 * видели и куда они собираются прыгать. Груза и финансов здесь нет — они в
 * профиле (свой носитель) и на странице эскадрильи.
 */

import Link from 'next/link';
import type { ReactNode } from 'react';
import { IconExternalLink, IconMapPin } from '@/components/Icons';
import {
  CARRIER_RELATION_HINT,
  CARRIER_TONE_COLOR,
  CARRIER_TYPE_FULL,
  CARRIER_TYPE_LABEL,
  carrierCountLabel,
  carrierIconVariant,
  carrierJumpText,
  carrierLocationText,
  carrierTitle,
  carrierTone,
  isCarrierStale,
  type CarrierSystemGroup,
  type MapCarrier,
} from '@/lib/carrierMap';
import { carrierSquadronTag } from '@/lib/carrierTags';
import { CarrierGlyph } from './CarrierGlyph';
import { useI18n } from '@/lib/i18n/I18nContext';

const MUTED = '#9ca3af';
const DIM = '#6b7280';
const TEXT = '#eeeeee';
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const SERVICES_SHOWN = 5;

function Chip({ color, children, title }: { color: string; children: ReactNode; title?: string }) {
  return (
    <span title={title} style={{
      display: 'inline-block', fontSize: 10, padding: '0 6px', margin: '0 4px 4px 0', borderRadius: 3, lineHeight: 1.7,
      border: `1px solid ${color}55`, color, background: `${color}14`,
    }}>{children}</span>
  );
}

function formatCoordinate(value: number): string {
  return Number.isFinite(value) ? value.toFixed(1) : '?';
}

function squadronLabel(squadron: NonNullable<MapCarrier['squadron']>, fallback: string): string {
  const tag = squadron.tag ? `[${squadron.tag}]` : '';
  return [tag, squadron.name].filter(Boolean).join(' ') || fallback;
}

function CarrierRow({ carrier, now }: { carrier: MapCarrier; now: number }) {
  const { t } = useI18n();
  const tone = carrierTone(carrier);
  const color = CARRIER_TONE_COLOR[tone];
  const title = carrierTitle(carrier);
  const jump = carrierJumpText(carrier, now);
  const stale = isCarrierStale(carrier, now);
  const services = carrier.services.slice(0, SERVICES_SHOWN);
  const moreServices = carrier.services.length - services.length;
  const javelin = carrier.type === 'SquadronCarrier';
  // Позывной Javelin — тег его эскадрильи в игре: виден, даже если эскадрильи нет на сайте.
  const gameTag = carrierSquadronTag(carrier);

  return (
    <li data-carrier-id={carrier.id} style={{ borderTop: '1px solid #2d2f33', paddingTop: 8, marginTop: 8, listStyle: 'none' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        <CarrierGlyph
          size={22}
          glyph={carrier.type === 'SquadronCarrier' ? 'javelin' : 'drake'}
          tone={tone}
          title={`${CARRIER_TYPE_FULL[carrier.type]}, ${CARRIER_RELATION_HINT[carrier.relation]}`}
          style={{ marginTop: 1, opacity: stale ? 0.6 : 1 }}
        />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 600, color: TEXT, fontSize: 13, overflowWrap: 'anywhere' }}>{title}</div>
          <div style={{ fontSize: 11, color: MUTED, fontFamily: MONO }}>
            {carrier.callsign && carrier.callsign !== title ? `${carrier.callsign} · ` : ''}{CARRIER_TYPE_LABEL[carrier.type]}
          </div>
          <div style={{ marginTop: 4 }}>
            <Chip color={CARRIER_TONE_COLOR[carrier.relation]}>{CARRIER_RELATION_HINT[carrier.relation]}</Chip>
            {carrier.decommission && <Chip color={CARRIER_TONE_COLOR.decommission} title={t('csc.decommissionTitle')}>{t('csc.decommission')}</Chip>}
            {carrier.estimated && <Chip color="#ffd166" title={t('csc.estimatedTitle')}>{t('csc.estimated')}</Chip>}
            {stale && <Chip color={DIM} title={t('csc.staleTitle')}>{t('csc.stale')}</Chip>}
          </div>

          <div style={{ fontSize: 11, color: MUTED, lineHeight: 1.5 }}>
            {carrier.owner ? (
              <div>{t('csc.owner')}{' '}<Link href={`/cmdr/${encodeURIComponent(carrier.owner)}`} style={{ color: TEXT, textDecoration: 'none' }}>CMDR {carrier.owner}</Link></div>
            ) : carrier.ownerHidden ? (
              <div>{t('csc.ownerHidden')}</div>
            ) : !carrier.squadron && !javelin ? (
              <div>{t('csc.ownerNotLinked')}</div>
            ) : null}
            {carrier.squadron ? (
              <div>
                {t('csc.squadron')}{' '}
                <Link href={`/squadrons/${carrier.squadron.id}`} style={{ color: '#4ade80', textDecoration: 'none' }}>
                  {squadronLabel(carrier.squadron, t('csc.squadronFallback', { id: carrier.squadron.id }))}
                </Link>
              </div>
            ) : javelin ? (
              <div data-carrier-game-squadron={gameTag ?? ''}>
                {gameTag ? (
                  <>{t('csc.squadronInGame')}{' '}<span style={{ color: TEXT, fontFamily: MONO }}>[{gameTag}]</span>{t('csc.squadronNotLinkedSuffix')}</>
                ) : t('csc.squadronNotLinked')}
              </div>
            ) : null}
            {carrier.body && <div>{t('csc.atBody')}{' '}<span style={{ color: TEXT }}>{carrier.body}</span></div>}
            {carrier.docking && (
              <div>
                {t('csc.docking')}{' '}<span style={{ color: TEXT }}>{carrier.docking}</span>
                {carrier.notorious ? <span style={{ color: '#f87171' }}>{t('csc.notorious')}</span> : null}
              </div>
            )}
            {services.length > 0 && (
              <div>{t('csc.services')}{' '}<span style={{ color: TEXT }}>{services.join(', ')}</span>{moreServices > 0 ? t('csc.andMore', { count: moreServices }) : ''}</div>
            )}
            <div style={{ color: DIM }}>{carrierLocationText(carrier, now)}</div>
            {jump && <div style={{ color: '#ffd166' }}>{jump}</div>}
          </div>

          {(carrier.relation === 'own' || carrier.squadron?.member) && (
            <div style={{ marginTop: 4, display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 11 }}>
              {carrier.relation === 'own' && (
                <Link href="/account?tab=carrier" style={{ color: CARRIER_TONE_COLOR.own, textDecoration: 'none' }}>{t('csc.myCarrier')}</Link>
              )}
              {carrier.squadron?.member && (
                <Link href={`/squadrons/${carrier.squadron.id}?tab=carrier`} style={{ color: CARRIER_TONE_COLOR.squadron, textDecoration: 'none' }}>{t('csc.squadronCarrier')}</Link>
              )}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

export interface CarrierSystemCardProps {
  group: CarrierSystemGroup;
  onClose: () => void;
  onFocus?: (group: CarrierSystemGroup) => void;
  /** Для тестов: «сейчас». */
  now?: number;
}

export function CarrierSystemCard({ group, onClose, onFocus, now = Date.now() }: CarrierSystemCardProps) {
  const { t } = useI18n();
  const variant = carrierIconVariant(group, now);
  const color = CARRIER_TONE_COLOR[variant.tone];
  const systemHref = `/system/${encodeURIComponent(group.system)}`;

  return (
    <div
      className="carrier-system-card"
      role="dialog"
      aria-label={t('csc.ariaCarriers', { system: group.system })}
      style={{
        position: 'absolute', bottom: 12, left: 12, zIndex: 10, background: 'rgba(13,15,17,0.92)', backdropFilter: 'blur(8px)',
        border: `1px solid ${color}55`, borderRadius: 8, padding: 12, minWidth: 260, maxWidth: 340, maxHeight: 'calc(100% - 24px)',
        overflowY: 'auto', pointerEvents: 'auto', boxSizing: 'border-box',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <CarrierGlyph size={22} glyph={variant.glyph} tone={variant.tone} />
          <Link href={systemHref} style={{ textDecoration: 'none', minWidth: 0 }}>
            <span style={{ fontWeight: 700, fontSize: 15, color, display: 'inline-flex', alignItems: 'center', gap: 6, overflowWrap: 'anywhere' }}>
              {group.system}
              <IconExternalLink size={12} />
            </span>
          </Link>
        </div>
        <button
          type="button"
          onClick={onClose}
          title={t('csc.close')}
          aria-label={t('csc.closeAria')}
          style={{ background: 'transparent', border: 'none', color: DIM, cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: 0 }}
        >
          ✕
        </button>
      </div>
      <div style={{ marginTop: 4, fontSize: 12, color: MUTED }}>
        {t('csc.carriers')} {carrierCountLabel(group.carriers.length)}
      </div>
      <div style={{ marginTop: 2, fontSize: 11, color: DIM }}>
        <IconMapPin size={11} />{' '}
        {group.position
          ? `${formatCoordinate(group.position.x)}, ${formatCoordinate(group.position.y)}, ${formatCoordinate(group.position.z)}`
          : t('csc.unknownCoords')}
      </div>

      <ul style={{ margin: 0, padding: 0 }}>
        {group.carriers.map((carrier) => <CarrierRow key={carrier.id} carrier={carrier} now={now} />)}
      </ul>

      <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {group.position && onFocus && (
          <button
            type="button"
            onClick={() => onFocus(group)}
            style={{ fontSize: 11, color, background: `${color}14`, border: `1px solid ${color}55`, borderRadius: 4, padding: '3px 8px', cursor: 'pointer', fontFamily: 'inherit' }}
          >
            <IconMapPin size={10} /> {t('csc.toSystem')}
          </button>
        )}
        <a
          href={`https://ravencolonial.com/#sys=${encodeURIComponent(group.system)}`}
          target="_blank"
          rel="noopener noreferrer"
          style={{ fontSize: 11, color: '#e67e22', textDecoration: 'none' }}
        >
          Raven <IconExternalLink size={10} />
        </a>
        <a
          href={`https://www.edsm.net/en/system?systemName=${encodeURIComponent(group.system)}`}
          target="_blank"
          rel="noopener noreferrer"
          style={{ fontSize: 11, color: '#3b82f6', textDecoration: 'none' }}
        >
          EDSM <IconExternalLink size={10} />
        </a>
      </div>
    </div>
  );
}
