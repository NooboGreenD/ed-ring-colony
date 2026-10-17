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
  const perms = detail.viewer.permissions;
  const [reference, setReference] = useState('');
  const [systemId, setSystemId] = useState('');
  const [purpose, setPurpose] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const delivered = useMemo(() => new Map((leaders?.carriers ?? []).map((carrier) => [carrier.carrierId, carrier])), [leaders]);

  const bind = async () => {
    if (!reference.trim()) {
      setError('Введите Carrier ID или позывной');
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
    onNotice(`Авианосец ${result.data?.name ?? result.data?.callsign ?? ''} привязан${result.data?.shareCargo ? ', груз виден участникам' : ''}`);
    await onChanged();
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {perms.bindOwnCarrier || perms.bindAnyCarrier ? (
        <section style={cardStyle} aria-label="Привязать авианосец">
          <h2 style={sectionTitle}>Привязать авианосец</h2>
          <p style={{ ...mutedText, margin: '6px 0 10px' }}>
            {perms.bindAnyCarrier
              ? 'Можно привязать любой авианосец по Carrier ID или позывному. Груз виден, только если носитель привязал его владелец или офицер эскадрильи.'
              : 'Привяжите свой авианосец или носитель эскадрильи, где вы офицер: участники увидят его положение и груз. Финансы не показываются.'}
            {' '}Свой носитель и его Carrier ID — в профиле, вкладка <Link href="/account?tab=carrier" style={{ color: 'var(--cyan)' }}>«Авианосец»</Link>.
          </p>
          <div style={rowStyle}>
            <input value={reference} onChange={(event) => setReference(event.target.value)} placeholder="Carrier ID или позывной (ABC-123)" aria-label="Авианосец" style={{ ...inputStyle, flex: '1 1 220px' }} />
            <select value={systemId} onChange={(event) => setSystemId(event.target.value)} style={inputStyle} aria-label="Система проекта">
              <option value="">— обслуживает проект —</option>
              {detail.systems.map((system) => <option key={system.id} value={system.id}>{system.name}</option>)}
            </select>
            <input value={purpose} onChange={(event) => setPurpose(event.target.value)} maxLength={PROJECT_LIMITS.purpose} placeholder="Роль: склад стали, челнок…" style={{ ...inputStyle, flex: '1 1 200px' }} />
            <button type="button" style={primaryButton} disabled={busy} onClick={() => void bind()}>Привязать</button>
          </div>
          {error && <p style={errorText}>{error}</p>}
          <div style={{ ...mutedText, marginTop: 6 }}>{detail.carriers.length}/{detail.limits.carriers} авианосцев</div>
        </section>
      ) : null}

      {detail.carriers.length === 0 ? (
        <EmptyState>К проекту не привязано ни одного авианосца.</EmptyState>
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
  const carrier = link.carrier;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const title = carrier ? [carrier.name, carrier.callsign].filter(Boolean).join(' · ') || `Авианосец ${link.carrierId}` : `Авианосец ${link.carrierId}`;
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
    if (!window.confirm(`Отвязать ${title} от проекта?`)) return;
    setBusy(true);
    const result = await apiJson(`${base}/carriers?carrierId=${encodeURIComponent(link.carrierId)}`, { method: 'DELETE' });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onNotice(`${title} отвязан от проекта`);
    await onChanged();
  };

  return (
    <section style={{ ...cardStyle, display: 'flex', flexDirection: 'column', gap: 8 }} aria-label={title}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 15 }}>{title}</strong>
        <Badge tone={carrier?.type === 'SquadronCarrier' ? 'var(--cyan)' : 'var(--muted)'}>
          {carrier?.type === 'SquadronCarrier' ? 'эскадренный' : 'личный'}
        </Badge>
        {link.shareCargo && <Badge tone="var(--green)">груз виден проекту</Badge>}
        {carrier?.relation === 'own' && <Badge tone="var(--orange)">ваш</Badge>}
      </div>
      <div style={{ ...mutedText, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span>
          Стоит: <b style={{ color: 'var(--text)' }}>{carrier?.location.system ?? 'неизвестно'}</b>
          {carrier?.location.body ? ` · ${carrier.location.body}` : ''}
          {carrier?.location.estimated ? ' (по расписанию прыжка)' : ''}
          {carrier?.location.at ? ` · ${formatAgo(carrier.location.at)}` : ''}
        </span>
        {carrier?.jump && (
          <span style={{ color: 'var(--orange)' }}>
            {carrier.jump.state === 'jumping' ? 'Прыгает' : 'Прыжок'} → {carrier.jump.system}
            {carrier.jump.departureAt ? ` · вылет ${new Date(carrier.jump.departureAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}` : ''}
          </span>
        )}
        {carrier?.status.dockingLabel && <span>Стыковка: {carrier.status.dockingLabel}</span>}
        <span>
          Обслуживает: {link.systemName ?? 'весь проект'}{link.purpose ? ` · ${link.purpose}` : ''}
          {link.addedByName ? ` · привязал ${link.addedByName}` : ''}
        </span>
      </div>

      {space && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 3 }}>
            <span style={{ color: 'var(--muted)' }}>Трюм</span>
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
            <div style={{ ...mutedText, marginBottom: 4 }}>Груз ({formatTons(carrier.cargo.trackedTotal)}, учёт {formatAgo(carrier.cargo.updatedAt ?? carrier.cargo.baselineAt)})</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '2px 12px' }}>
              {carrier.cargo.items.slice(0, 16).map((item) => (
                <span key={item.commodity} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, gap: 6 }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.name}</span>
                  <span style={{ fontFamily: 'ui-monospace, monospace', color: 'var(--muted)' }}>{compactTons(item.quantity)}</span>
                </span>
              ))}
            </div>
          </div>
        ) : <span style={mutedText}>Трюм пуст по учёту журналов.</span>
      ) : (
        <span style={mutedText}>Груз скрыт: носитель привязан без показа груза.</span>
      )}

      {carrier && carrier.orders.length > 0 && (
        <div style={{ ...mutedText, fontSize: 11 }}>
          Заказы: {carrier.orders.slice(0, 6).map((order) => `${order.name}${order.purchase ? ` покупка ${compactTons(order.purchase)}` : ''}${order.sale ? ` продажа ${compactTons(order.sale)}` : ''}`).join(' · ')}
        </div>
      )}

      <div style={{ ...mutedText, fontSize: 12 }}>
        Сдано на носитель пилотами проекта: <b style={{ color: 'var(--text)' }}>{formatTons(deliveredTons)}</b>
        {deliveredBy.length > 0 && ` · ${deliveredBy.filter((slice) => slice.key !== '__other').slice(0, 3).map((slice) => `${slice.label} ${compactTons(slice.tons)}`).join(', ')}`}
      </div>

      {(link.canManage || link.canShare) && (
        <div style={{ ...rowStyle, marginTop: 4 }}>
          {link.canManage && (
            <select
              value={link.systemId ?? ''}
              disabled={busy}
              onChange={(event) => void patch({ systemId: event.target.value || null }, 'Система носителя изменена')}
              style={{ ...inputStyle, padding: '4px 8px' }}
              aria-label="Система носителя"
            >
              <option value="">весь проект</option>
              {detail.systems.map((system) => <option key={system.id} value={system.id}>{system.name}</option>)}
            </select>
          )}
          {link.canShare && !link.shareCargo && (
            <button type="button" style={ghostButton} disabled={busy} onClick={() => void patch({ shareCargo: true }, 'Груз носителя открыт участникам проекта')}>Показать груз проекту</button>
          )}
          {link.shareCargo && link.canManage && (
            <button type="button" style={ghostButton} disabled={busy} onClick={() => void patch({ shareCargo: false }, 'Груз носителя скрыт от проекта')}>Скрыть груз</button>
          )}
          {link.canManage && (
            <button type="button" style={{ ...ghostButton, borderColor: 'var(--red)', color: 'var(--red)', marginLeft: 'auto' }} disabled={busy} onClick={() => void unbind()}>
              Отвязать
            </button>
          )}
        </div>
      )}
      {error && <p style={errorText}>{error}</p>}
    </section>
  );
}
