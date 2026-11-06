'use client';

/**
 * Авианосцы проекта: где стоят, куда прыгают, что везут и сколько на них
 * сдали пилоты проекта.
 *
 * Привязать любой носитель (публичная карточка) могут ведущие проекта;
 * участник привязывает свой носитель или носитель эскадрильи, где он офицер,
 * — тогда груз носителя виден участникам проекта. Финансы не показываются.
 */

import Link from 'next/link';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useMemo, useState } from 'react';
import {
  cardStyle,
  errorText,
  ghostButton,
  inputStyle,
  mutedText,
  primaryButton,
  rowStyle,
  sectionTitle,
} from '@/components/Architect/panelStyles';
import { PROJECT_LIMITS } from '@/lib/architect/projects';
import {
  Badge,
  EmptyState,
  ProgressBar,
  apiJson,
  compactTons,
  formatAgo,
  formatTons,
  type ProjectCarrierLink,
  type ProjectDetailResponse,
} from '@/components/Architect/projects/projectUi';
import type { LeadersResponse } from '@/components/Architect/projects/ProjectView';

interface Props {
  base: string;
  detail: ProjectDetailResponse;
  leaders: LeadersResponse | null;
  onChanged: () => Promise<void> | void;
  onNotice: (message: string) => void;
}

export default function ProjectCarriers({ base, detail, leaders, onChanged, onNotice }: Props) {
  const { t } = useI18n();
  const perms = detail.viewer.permissions;
  const [reference, setReference] = useState('');
  const [systemId, setSystemId] = useState('');
  const [purpose, setPurpose] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const delivered = useMemo(() => new Map((leaders?.carriers ?? []).map((carrier) => [carrier.carrierId, carrier])), [leaders]);

  const bind = async () => {
    if (!reference.trim()) {
      setError(t('pcar.enterRef'));
      return;
    }
    setBusy(true);
    setError('');
    const result = await apiJson<{ name: string | null; callsign: string | null; shareCargo: boolean }>(`${base}/carriers`, {
      method: 'POST',
      json: { carrier: reference.trim(), systemId: systemId || null, purpose },
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setReference('');
    setPurpose('');
    onNotice(result.data?.shareCargo
      ? t('pcar.boundCargo', { name: result.data?.name ?? result.data?.callsign ?? '' })
      : t('pcar.bound', { name: result.data?.name ?? result.data?.callsign ?? '' }));
    await onChanged();
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {perms.bindOwnCarrier || perms.bindAnyCarrier ? (
        <section style={cardStyle} aria-label={t('pcar.bindAria')}>
          <h2 style={sectionTitle}>{t('pcar.bindAria')}</h2>
          <p style={{ ...mutedText, margin: '6px 0 10px' }}>
            {perms.bindAnyCarrier
              ? t('pcar.hintAny')
              : t('pcar.hintOwn')}
            {' '}{t('pcar.hintProfile')} <Link href="/account?tab=carrier" style={{ color: 'var(--cyan)' }}>{t('pcar.carrierTab')}</Link>.
          </p>
          <div style={rowStyle}>
            <input value={reference} onChange={(event) => setReference(event.target.value)} placeholder={t('pcar.phRef')} aria-label={t('pcar.ariaCarrier')} style={{ ...inputStyle, flex: '1 1 220px' }} />
            <select value={systemId} onChange={(event) => setSystemId(event.target.value)} style={inputStyle} aria-label={t('pcar.ariaProjectSystem')}>
              <option value="">{t('pcar.optionProjectWide')}</option>
              {detail.systems.map((system) => <option key={system.id} value={system.id}>{system.name}</option>)}
            </select>
            <input value={purpose} onChange={(event) => setPurpose(event.target.value)} maxLength={PROJECT_LIMITS.purpose} placeholder={t('pcar.phPurpose')} style={{ ...inputStyle, flex: '1 1 200px' }} />
            <button type="button" style={primaryButton} disabled={busy} onClick={() => void bind()}>{t('pcar.bindButton')}</button>
          </div>
          {error && <p style={errorText}>{error}</p>}
          <div style={{ ...mutedText, marginTop: 6 }}>{t('pcar.carriersCount', { current: detail.carriers.length, limit: detail.limits.carriers })}</div>
        </section>
      ) : null}

      {detail.carriers.length === 0 ? (
        <EmptyState>{t('pcar.empty')}</EmptyState>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(380px, 1fr))', gap: 12 }}>
          {detail.carriers.map((link) => (
            <CarrierCard
              key={link.carrierId}
              base={base}
              link={link}
              detail={detail}
              deliveredTons={delivered.get(link.carrierId)?.tons ?? 0}
              deliveredBy={delivered.get(link.carrierId)?.pilots ?? []}
              onChanged={onChanged}
              onNotice={onNotice}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function CarrierCard({ base, link, detail, deliveredTons, deliveredBy, onChanged, onNotice }: {
  base: string;
  link: ProjectCarrierLink;
  detail: ProjectDetailResponse;
  deliveredTons: number;
  deliveredBy: Array<{ key: string; label: string; tons: number }>;
  onChanged: () => Promise<void> | void;
  onNotice: (message: string) => void;
}) {
  const { t, locale } = useI18n();
  const carrier = link.carrier;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const title = carrier ? [carrier.name, carrier.callsign].filter(Boolean).join(' · ') || t('pcar.titleFallback', { id: link.carrierId }) : t('pcar.titleFallback', { id: link.carrierId });
  const space = carrier?.space ?? null;
  const usage = space?.cargoCapacity ? ((space.cargo ?? 0) / space.cargoCapacity) * 100 : null;

  const patch = async (body: Record<string, unknown>, message: string) => {
    setBusy(true);
    setError('');
    const result = await apiJson(`${base}/carriers`, { method: 'PATCH', json: { carrierId: link.carrierId, ...body } });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onNotice(message);
    await onChanged();
  };

  const unbind = async () => {
    if (!window.confirm(t('pcar.unbindQuestion', { title }))) return;
    setBusy(true);
    const result = await apiJson(`${base}/carriers?carrierId=${encodeURIComponent(link.carrierId)}`, { method: 'DELETE' });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onNotice(t('pcar.unbound', { title }));
    await onChanged();
  };

  return (
    <section style={{ ...cardStyle, display: 'flex', flexDirection: 'column', gap: 8 }} aria-label={title}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 15 }}>{title}</strong>
        <Badge tone={carrier?.type === 'SquadronCarrier' ? 'var(--cyan)' : 'var(--muted)'}>
          {carrier?.type === 'SquadronCarrier' ? t('pcar.typeSquadron') : t('pcar.typePersonal')}
        </Badge>
        {link.shareCargo && <Badge tone="var(--green)">{t('pcar.badgeCargoShared')}</Badge>}
        {carrier?.relation === 'own' && <Badge tone="var(--orange)">{t('pcar.badgeOwn')}</Badge>}
      </div>
      <div style={{ ...mutedText, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span>
          {t('pcar.location')} <b style={{ color: 'var(--text)' }}>{carrier?.location.system ?? t('pcar.unknown')}</b>
          {carrier?.location.body ? ` · ${carrier.location.body}` : ''}
          {carrier?.location.estimated ? t('pcar.byJumpSchedule') : ''}
          {carrier?.location.at ? ` · ${formatAgo(carrier.location.at)}` : ''}
        </span>
        {carrier?.jump && (
          <span style={{ color: 'var(--orange)' }}>
            {carrier.jump.state === 'jumping' ? t('pcar.jumping') : t('pcar.jump')} → {carrier.jump.system}
            {carrier.jump.departureAt ? t('pcar.departure', { time: new Date(carrier.jump.departureAt).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' }) }) : ''}
          </span>
        )}
        {carrier?.status.dockingLabel && <span>{t('pcar.docking', { label: carrier.status.dockingLabel })}</span>}
        <span>
          {t('pcar.serves')} {link.systemName ?? t('pcar.wholeProject')}{link.purpose ? ` · ${link.purpose}` : ''}
          {link.addedByName ? t('pcar.boundBy', { name: link.addedByName }) : ''}
        </span>
      </div>

      {space && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 3 }}>
            <span style={{ color: 'var(--muted)' }}>{t('pcar.hold')}</span>
            <span style={{ fontFamily: 'ui-monospace, monospace' }}>
              {formatTons(space.cargo)}{space.cargoCapacity ? ` / ${formatTons(space.cargoCapacity)}` : ''}
            </span>
          </div>
          <ProgressBar value={usage} tone="var(--cyan)" height={6} />
        </div>
      )}

      {carrier?.cargo ? (
        carrier.cargo.items.length ? (
          <div>
            <div style={{ ...mutedText, marginBottom: 4 }}>{t('pcar.cargoTitle', { tons: formatTons(carrier.cargo.trackedTotal), ago: formatAgo(carrier.cargo.updatedAt ?? carrier.cargo.baselineAt) })}</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '2px 12px' }}>
              {carrier.cargo.items.slice(0, 16).map((item) => (
                <span key={item.commodity} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, gap: 6 }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.name}</span>
                  <span style={{ fontFamily: 'ui-monospace, monospace', color: 'var(--muted)' }}>{compactTons(item.quantity)}</span>
                </span>
              ))}
            </div>
          </div>
        ) : <span style={mutedText}>{t('pcar.holdEmpty')}</span>
      ) : (
        <span style={mutedText}>{t('pcar.cargoHidden')}</span>
      )}

      {carrier && carrier.orders.length > 0 && (
        <div style={{ ...mutedText, fontSize: 11 }}>
          {t('pcar.orders')} {carrier.orders.slice(0, 6).map((order) => `${order.name}${order.purchase ? t('pcar.orderBuy', { tons: compactTons(order.purchase) }) : ''}${order.sale ? t('pcar.orderSell', { tons: compactTons(order.sale) }) : ''}`).join(' · ')}
        </div>
      )}

      <div style={{ ...mutedText, fontSize: 12 }}>
        {t('pcar.deliveredTo')} <b style={{ color: 'var(--text)' }}>{formatTons(deliveredTons)}</b>
        {deliveredBy.length > 0 && ` · ${deliveredBy.filter((slice) => slice.key !== '__other').slice(0, 3).map((slice) => `${slice.label} ${compactTons(slice.tons)}`).join(', ')}`}
      </div>

      {(link.canManage || link.canShare) && (
        <div style={{ ...rowStyle, marginTop: 4 }}>
          {link.canManage && (
            <select
              value={link.systemId ?? ''}
              disabled={busy}
              onChange={(event) => void patch({ systemId: event.target.value || null }, t('pcar.systemChanged'))}
              style={{ ...inputStyle, padding: '4px 8px' }}
              aria-label={t('pcar.ariaCarrierSystem')}
            >
              <option value="">{t('pcar.wholeProject')}</option>
              {detail.systems.map((system) => <option key={system.id} value={system.id}>{system.name}</option>)}
            </select>
          )}
          {link.canShare && !link.shareCargo && (
            <button type="button" style={ghostButton} disabled={busy} onClick={() => void patch({ shareCargo: true }, t('pcar.cargoShown'))}>{t('pcar.showCargo')}</button>
          )}
          {link.shareCargo && link.canManage && (
            <button type="button" style={ghostButton} disabled={busy} onClick={() => void patch({ shareCargo: false }, t('pcar.cargoHiddenMsg'))}>{t('pcar.hideCargo')}</button>
          )}
          {link.canManage && (
            <button type="button" style={{ ...ghostButton, borderColor: 'var(--red)', color: 'var(--red)', marginLeft: 'auto' }} disabled={busy} onClick={() => void unbind()}>
              {t('pcar.unbind')}
            </button>
          )}
        </div>
      )}
      {error && <p style={errorText}>{error}</p>}
    </section>
  );
}
