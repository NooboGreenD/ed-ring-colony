'use client';

/**
 * Карточка авианосца (`/carriers/<MarketID>`).
 *
 * Страницу открывают из карточки системы (`/system/<name>` → «Авианосцы») и из
 * уведомления о прыжке. Здесь собрано всё, что сайт знает о носителе:
 *
 *   * где он стоит — система и **тело**, у которого висит (в игре ищут именно
 *     по телу), и когда его видели в последний раз;
 *   * заказ прыжка, если он есть: куда, когда, статус;
 *   * службы: какие работают, какие нет (`N из M`), и кого пускают на стыковку;
 *   * владелец и эскадрилья — по тем же правилам приватности, что на карте;
 *   * статистика прыжков за год: всего, за 7 и 30 дней, темп, направления,
 *     графики по дням месяца и месяцам года, список последних прыжков.
 *
 * Инфографика — SVG с `viewBox` в долях (как на вкладке «История»): столбцы
 * тянутся по ширине без пересчёта пикселей. Ничего личного: груза и финансов
 * на публичной карточке нет никогда.
 */

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import {
  IconAnchor,
  IconChart,
  IconClock,
  IconExternalLink,
  IconGlobe,
  IconHistory,
  IconRefresh,
  IconStar,
} from '@/components/Icons';
import { useI18n } from '@/lib/i18n/I18nContext';
import { historyBarHeights, historyBarWidth } from '@/lib/carrierJumpHistory';
import { carrierAtlasHref, systemPageHref } from '@/lib/systemIdentity';
import type { CarrierCardBucket, CarrierCardJump, CarrierCardService } from '@/lib/carrierCard';

/** Как часто карточка обновляется сама: носитель прыгает раз в 15–20 минут. */
const REFRESH_MS = 120_000;
/** Сколько прыжков показываем таблицей — остальные годы уже на графике. */
const JUMP_ROWS = 40;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

interface CardResponse {
  ok?: boolean;
  card?: CarrierCardView;
  error?: string;
}

interface CarrierCardView {
  id: string;
  type: 'FleetCarrier' | 'SquadronCarrier';
  callsign: string | null;
  name: string | null;
  relation: 'own' | 'squadron' | 'other';
  decommission: boolean;
  location: {
    system: string | null;
    systemAddress: string | null;
    body: string | null;
    position: { x: number; y: number; z: number } | null;
    at: string | null;
    source: 'site' | 'eddn';
    estimated: boolean;
    previousSystem: string | null;
  };
  jump: { system: string; body: string | null; departureAt: string | null; requestedAt: string | null; state: 'scheduled' | 'jumping' } | null;
  owner: { name: string | null; hidden: boolean };
  squadron: { id: number; name: string | null; tag: string | null; member: boolean } | null;
  docking: string | null;
  notorious: boolean | null;
  fuelLevel: number | null;
  jumpRange: { current: number | null; max: number | null } | null;
  services: CarrierCardService[];
  sightings: number | null;
  stats: {
    total: number;
    last7: number;
    last30: number;
    site: number;
    eddn: number;
    uniqueDestinations: number;
    top: Array<{ system: string; jumps: number; share: number }>;
    firstAt: string | null;
    lastAt: string | null;
    perWeek: number;
    daily: CarrierCardBucket[];
    monthly: CarrierCardBucket[];
  };
  jumps: CarrierCardJump[];
  warnings: string[];
}

function timeMs(value: string | null | undefined): number {
  if (!value) return NaN;
  return Date.parse(value);
}

/** Абсолютное время: дата и часы. Год добавляется, только если он не текущий. */
function stamp(value: string | null | undefined, locale: string, withYear = false): string {
  const ms = timeMs(value);
  if (!Number.isFinite(ms)) return '—';
  try {
    return new Date(ms).toLocaleString(locale, withYear
      ? { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }
      : { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch {
    return new Date(ms).toISOString();
  }
}

/** «через 2 ч», «12 мин назад» — чтобы не считать в уме. */
function relative(value: string | null | undefined, now: number, locale: string): string {
  const ms = timeMs(value);
  if (!Number.isFinite(ms)) return '';
  const diff = ms - now;
  const abs = Math.abs(diff);
  const unit: Intl.RelativeTimeFormatUnit = abs < 3_600_000 ? 'minute' : abs < 172_800_000 ? 'hour' : 'day';
  const step = unit === 'minute' ? 60_000 : unit === 'hour' ? 3_600_000 : 86_400_000;
  try {
    return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(Math.round(diff / step), unit);
  } catch {
    return '';
  }
}

function numberText(locale: string, value: number | null | undefined, digits = 0): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? value.toLocaleString(locale, { maximumFractionDigits: digits })
    : '—';
}

/**
 * Столбцы одного графика. Подписи прореживаются, чтобы на узком экране они не
 * наезжали друг на друга: раз в `labelStep`, плюс последняя.
 */
function BarChart({
  buckets,
  unit,
  locale,
  label,
  emptyText,
  tooltip,
}: {
  buckets: readonly CarrierCardBucket[];
  unit: 'day' | 'month';
  locale: string;
  label: string;
  emptyText: string;
  tooltip: (start: string, jumps: number) => string;
}) {
  const values = buckets.map((bucket) => bucket.jumps);
  const heights = historyBarHeights(values);
  const width = historyBarWidth(buckets.length);
  const peak = values.reduce((best, value) => Math.max(best, value), 0);
  const labelStep = unit === 'day' ? 5 : 2;
  const bucketLabel = (start: string) => {
    const date = new Date(start);
    try {
      return unit === 'day'
        ? date.toLocaleDateString(locale, { day: '2-digit', month: '2-digit' })
        : date.toLocaleDateString(locale, { month: 'short' });
    } catch {
      return start.slice(0, 10);
    }
  };
  if (!peak) return <div className="cjh-chart-empty">{emptyText}</div>;
  return (
    <>
      <svg className="cjh-chart" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label={label}>
        {[25, 50, 75].map((line) => (
          <line key={line} className="cjh-grid-line" x1="0" x2="100" y1={100 - line} y2={100 - line} />
        ))}
        {buckets.map((bucket, index) => (
          <rect
            key={bucket.start}
            className={`cjh-bar${bucket.jumps ? '' : ' empty'}`}
            x={index * width * 100}
            y={100 - Math.max(heights[index] * 100, bucket.jumps ? 2 : 0)}
            width={Math.max(width * 100, 0.4)}
            height={Math.max(heights[index] * 100, bucket.jumps ? 2 : 0)}
          >
            <title>{tooltip(bucket.start, bucket.jumps)}</title>
          </rect>
        ))}
      </svg>
      <div className="cjh-axis" style={{ gridTemplateColumns: `repeat(${buckets.length}, minmax(0, 1fr))` }} aria-hidden="true">
        {buckets.map((bucket, index) => (
          <span key={bucket.start} className={index % labelStep === 0 || index === buckets.length - 1 ? '' : 'quiet'}>
            {bucketLabel(bucket.start)}
          </span>
        ))}
      </div>
    </>
  );
}

export interface CarrierCardPageProps {
  /** MarketID из адреса: страница одна на носитель, без клиентского поиска. */
  carrierId: string;
}

export function CarrierCardPage({ carrierId }: CarrierCardPageProps) {
  const { t, locale } = useI18n();
  const [card, setCard] = useState<CarrierCardView | null>(null);
  const [status, setStatus] = useState<'loading' | 'error' | 'empty' | 'ready'>('loading');
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/carriers/${encodeURIComponent(carrierId)}/card`, { cache: 'no-store' });
      if (response.status === 404) {
        setStatus('empty');
        return;
      }
      const payload = await response.json().catch(() => ({})) as CardResponse;
      if (!response.ok || !payload.card) throw new Error(payload.error || String(response.status));
      setCard(payload.card);
      setStatus('ready');
      setError('');
      setNow(Date.now());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setStatus('error');
    }
  }, [carrierId]);

  useEffect(() => { void load(); }, [load]);

  // Носитель живёт минутами: без обновления карточка устареет незаметно.
  useEffect(() => {
    const refresh = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') void load();
    }, REFRESH_MS);
    const ticker = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      clearInterval(refresh);
      clearInterval(ticker);
    };
  }, [load]);

  const title = card ? (card.name || card.callsign || `#${card.id}`) : `#${carrierId}`;
  const servicesActive = card?.services.filter((service) => service.active) ?? [];

  return (
    <div className="ccd" data-carrier={carrierId}>
      <div className="ccd-head">
        <div className="ccd-head-main">
          <h1 className="ccd-title">{title}</h1>
          <p className="ccd-sub">
            <span className="ccd-callsign">{card?.callsign || t('ccd.noCallsign')}</span>
            <span className="cj-dim">{` · ${t(card?.type === 'SquadronCarrier' ? 'ccd.typeSquadron' : 'ccd.typeFleet')}`}</span>
            {card?.relation === 'own' ? <span className="ccd-chip own">{t('ccd.relationOwn')}</span> : null}
            {card?.relation === 'squadron' ? <span className="ccd-chip squadron">{t('ccd.relationSquadron')}</span> : null}
            {card?.decommission ? <span className="ccd-chip warn">{t('ccd.decommission')}</span> : null}
          </p>
        </div>
        <div className="ccd-head-actions">
          <button type="button" className="cj-btn" onClick={() => void load()} disabled={status === 'loading'}>
            <IconRefresh size={13} />
            {t('cj.refresh')}
          </button>
          <Link className="cj-btn" href={carrierAtlasHref(card?.id ?? carrierId, {
            system: card?.location.system,
            point: card?.location.position,
          })}>
            <IconStar size={13} />
            {t('ccd.openAtlas')}
          </Link>
        </div>
      </div>

      {status === 'loading' ? (
        <div className="cj-state-block">
          <b>{t('ccd.loading')}</b>
          <span>{t('ccd.loadingDetail')}</span>
        </div>
      ) : null}

      {status === 'empty' ? (
        <div className="cj-state-block">
          <b>{t('ccd.notFound')}</b>
          <span>{t('ccd.notFoundHint')}</span>
        </div>
      ) : null}

      {status === 'error' ? (
        <div className="cj-state-block" role="alert">
          <b>{t('ccd.loadFailed')}</b>
          <span>{error}</span>
          <button type="button" className="cj-btn" onClick={() => void load()}>{t('cj.retry')}</button>
        </div>
      ) : null}

      {status === 'ready' && card ? (
        <>
          {/* Где носитель: система и тело — то, что ищут в игре. */}
          <section className="ccd-panel" aria-label={t('ccd.whereTitle')}>
            <h2 className="ccd-panel-title"><IconAnchor size={16} /> {t('ccd.whereTitle')}</h2>
            <div className="ccd-facts">
              <div className="ccd-fact">
                <span className="ccd-fact-name">{t('ccd.factSystem')}</span>
                <span className="ccd-fact-value">
                  {card.location.system ? (
                    <Link href={systemPageHref(card.location.system)} className="cj-target">
                      {card.location.system}
                    </Link>
                  ) : t('ccd.unknown')}
                </span>
              </div>
              <div className="ccd-fact">
                <span className="ccd-fact-name">{t('ccd.factBody')}</span>
                <span className="ccd-fact-value">{card.location.body || t('ccd.noBody')}</span>
              </div>
              <div className="ccd-fact">
                <span className="ccd-fact-name">{t('ccd.factCoords')}</span>
                <span className="ccd-fact-value mono">
                  {card.location.position
                    ? `${card.location.position.x.toFixed(1)}, ${card.location.position.y.toFixed(1)}, ${card.location.position.z.toFixed(1)}`
                    : t('ccd.unknown')}
                </span>
              </div>
              <div className="ccd-fact">
                <span className="ccd-fact-name">{t('ccd.factSeen')}</span>
                <span className="ccd-fact-value">
                  {stamp(card.location.at, locale)}
                  <span className="cj-dim">{` · ${card.location.source === 'eddn' ? 'EDDN' : t('ccd.sourceSite')}`}</span>
                  {card.location.estimated ? <span className="cj-dim">{` · ${t('ccd.estimated')}`}</span> : null}
                </span>
              </div>
              <div className="ccd-fact">
                <span className="ccd-fact-name">{t('ccd.factOwner')}</span>
                <span className="ccd-fact-value">
                  {card.owner.name || (card.owner.hidden ? t('ccd.ownerHidden') : t('ccd.unknown'))}
                </span>
              </div>
              <div className="ccd-fact">
                <span className="ccd-fact-name">{t('ccd.factSquadron')}</span>
                <span className="ccd-fact-value">
                  {card.squadron
                    ? `${card.squadron.name || card.squadron.tag || `#${card.squadron.id}`}${card.squadron.tag ? ` [${card.squadron.tag}]` : ''}${card.squadron.member ? ` · ${t('ccd.squadronMember')}` : ''}`
                    : t('ccd.unknown')}
                </span>
              </div>
              <div className="ccd-fact">
                <span className="ccd-fact-name">{t('ccd.factDocking')}</span>
                <span className="ccd-fact-value">{card.docking || t('ccd.unknown')}</span>
              </div>
              <div className="ccd-fact">
                <span className="ccd-fact-name">{t('ccd.factNotorious')}</span>
                <span className="ccd-fact-value">
                  {card.notorious == null ? t('ccd.unknown') : card.notorious ? t('ccd.notoriousYes') : t('ccd.notoriousNo')}
                </span>
              </div>
              <div className="ccd-fact">
                <span className="ccd-fact-name">{t('ccd.factFuel')}</span>
                <span className="ccd-fact-value">{numberText(locale, card.fuelLevel)}</span>
              </div>
              <div className="ccd-fact">
                <span className="ccd-fact-name">{t('ccd.factJumpRange')}</span>
                <span className="ccd-fact-value">
                  {card.jumpRange
                    ? `${numberText(locale, card.jumpRange.current, 1)} / ${numberText(locale, card.jumpRange.max, 1)} ${t('ccd.ly')}`
                    : t('ccd.unknown')}
                </span>
              </div>
              {card.sightings != null ? (
                <div className="ccd-fact">
                  <span className="ccd-fact-name">{t('ccd.factSightings')}</span>
                  <span className="ccd-fact-value">{numberText(locale, card.sightings)}</span>
                </div>
              ) : null}
            </div>
          </section>

          {/* Заказ прыжка: если он есть, это самое важное на странице. */}
          <section className="ccd-panel" aria-label={t('ccd.jumpTitle')}>
            <h2 className="ccd-panel-title"><IconClock size={16} /> {t('ccd.jumpTitle')}</h2>
            {card.jump ? (
              <div className="ccd-jump">
                <div>
                  <span className="ccd-jump-target">
                    {card.jump.system}
                    {card.jump.body ? <span className="cj-dim">{` · ${card.jump.body}`}</span> : null}
                  </span>
                  <span className={`cj-pill ${card.jump.state}`}>
                    {card.jump.state === 'jumping' ? t('cj.stateJumping') : t('cj.stateScheduled')}
                  </span>
                </div>
                <div className="ccd-jump-time">
                  <span>{stamp(card.jump.departureAt, locale)}</span>
                  <span className="cj-relative">{relative(card.jump.departureAt, now, locale)}</span>
                </div>
              </div>
            ) : (
              <p className="cj-empty-inline">{t('ccd.noJump')}</p>
            )}
            {card.jump ? (
              <p className="cj-dim ccd-hint">
                <Link href="/carriers/jumps" className="cj-target">{t('ccd.jumpsLink')}</Link>
              </p>
            ) : null}
          </section>

          {/* Службы: что работает и кого пускают. */}
          <section className="ccd-panel" aria-label={t('ccd.servicesTitle')}>
            <h2 className="ccd-panel-title">
              <IconGlobe size={16} /> {t('ccd.servicesTitle')}
              <span className="ccd-panel-meta">
                {t('ccd.servicesCount', { active: servicesActive.length, total: card.services.length })}
              </span>
            </h2>
            {card.services.length ? (
              <ul className="ccd-services">
                {card.services.map((service) => (
                  <li key={service.role} className={`ccd-service${service.active ? ' on' : ''}`} title={service.role}>
                    <span className="ccd-service-dot" aria-hidden="true" />
                    {service.label}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="cj-empty-inline">{t('ccd.noServices')}</p>
            )}
          </section>

          {/* Статистика прыжков: счётчики, два графика и направления. */}
          <section className="ccd-panel" aria-label={t('ccd.historyTitle')}>
            <h2 className="ccd-panel-title">
              <IconHistory size={16} /> {t('ccd.historyTitle')}
              <span className="ccd-panel-meta">{t('ccd.historyWindow')}</span>
            </h2>

            <div className="cjh-stats ccd-stats">
              <div className="cjh-stat">
                <b>{numberText(locale, card.stats.total)}</b>
                <span>{t('ccd.statTotal')}</span>
              </div>
              <div className="cjh-stat">
                <b>{numberText(locale, card.stats.last7)}</b>
                <span>{t('ccd.statWeek')}</span>
              </div>
              <div className="cjh-stat">
                <b>{numberText(locale, card.stats.last30)}</b>
                <span>{t('ccd.statMonth')}</span>
              </div>
              <div className="cjh-stat">
                <b>{numberText(locale, card.stats.perWeek, 2)}</b>
                <span>{t('ccd.statPerWeek')}</span>
              </div>
              <div className="cjh-stat">
                <b>{numberText(locale, card.stats.uniqueDestinations)}</b>
                <span>{t('ccd.statDestinations')}</span>
              </div>
              <div className="cjh-stat">
                <b>{`${card.stats.site} / ${card.stats.eddn}`}</b>
                <span>{t('ccd.statSources')}</span>
              </div>
            </div>

            <div className="ccd-charts">
              <div className="ccd-chart-block">
                <header className="cjh-chart-head">
                  <b>{t('ccd.dailyTitle')}</b>
                  <span className="cjh-chart-meta">{t('cjh.utc')}</span>
                </header>
                <BarChart
                  buckets={card.stats.daily}
                  unit="day"
                  locale={locale}
                  label={t('ccd.dailyAria', { total: card.stats.last30 })}
                  emptyText={t('ccd.chartEmpty')}
                  tooltip={(start, jumps) => t('cjh.bucketTooltip', {
                    time: new Date(start).toLocaleDateString(locale, { day: '2-digit', month: '2-digit' }),
                    jumps,
                  })}
                />
              </div>
              <div className="ccd-chart-block">
                <header className="cjh-chart-head">
                  <b>{t('ccd.monthlyTitle')}</b>
                  <span className="cjh-chart-meta">{t('cjh.utc')}</span>
                </header>
                <BarChart
                  buckets={card.stats.monthly}
                  unit="month"
                  locale={locale}
                  label={t('ccd.monthlyAria', { total: card.stats.total })}
                  emptyText={t('ccd.chartEmpty')}
                  tooltip={(start, jumps) => t('cjh.bucketTooltip', {
                    time: new Date(start).toLocaleDateString(locale, { month: 'long', year: 'numeric' }),
                    jumps,
                  })}
                />
              </div>
            </div>

            {card.stats.top.length ? (
              <div className="ccd-top">
                <b>{t('ccd.topTitle')}</b>
                <ul>
                  {card.stats.top.map((entry) => (
                    <li key={entry.system}>
                      <Link href={systemPageHref(entry.system)} className="cj-target">{entry.system}</Link>
                      <span className="ccd-top-bar" aria-hidden="true">
                        <span style={{ width: `${Math.round(entry.share * 100)}%` }} />
                      </span>
                      <span className="cjh-top-count">{t('cjh.topJumps', { count: entry.jumps })}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {card.warnings.includes('noJumpHistory') ? (
              <p className="cj-empty-inline">{t('ccd.noHistory')}</p>
            ) : null}

            {card.jumps.length ? (
              <div className="cj-scroll">
                <table className="cj-table ccd-table" aria-label={t('ccd.historyTitle')}>
                  <thead>
                    <tr>
                      <th scope="col">{t('cjh.colTime')}</th>
                      <th scope="col">{t('cj.colRoute')}</th>
                      <th scope="col">{t('cjh.colSource')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {card.jumps.slice(0, JUMP_ROWS).map((jump) => (
                      <tr key={jump.id}>
                        <td data-label={t('cjh.colTime')}>
                          <span className="cj-time">{stamp(jump.jumpedAt, locale)}</span>
                          <span className="cj-relative">{relative(jump.jumpedAt, now, locale)}</span>
                        </td>
                        <td data-label={t('cj.colRoute')}>
                          <span className="cj-route">
                            <Link className="cj-system" href={systemPageHref(jump.from)}>{jump.from}</Link>
                            <span className="cj-arrow" aria-hidden="true">→</span>
                            <Link className="cj-system cj-target" href={systemPageHref(jump.to)}>{jump.to}</Link>
                          </span>
                        </td>
                        <td data-label={t('cjh.colSource')}>
                          <span className={`cjh-source ${jump.source}`}>
                            {jump.source === 'eddn' ? t('cjh.sourceEddn') : t('cjh.sourceSite')}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}

            <p className="ccd-foot">
              {card.stats.firstAt ? (
                <span>{t('ccd.firstSeenAt', { date: stamp(card.stats.firstAt, locale, true) })} </span>
              ) : null}
              <span className="cj-dim">{t('ccd.footnote')}</span>
            </p>
          </section>

          <section className="ccd-panel ccd-links" aria-label={t('ccd.linksTitle')}>
            <h2 className="ccd-panel-title"><IconChart size={16} /> {t('ccd.linksTitle')}</h2>
            <div className="ccd-links-row">
              {card.location.system ? (
                <Link className="cj-btn" href={systemPageHref(card.location.system)}>
                  <IconGlobe size={13} /> {t('ccd.systemCard')}
                </Link>
              ) : null}
              <Link className="cj-btn" href={carrierAtlasHref(card.id, {
                system: card.location.system,
                point: card.location.position,
              })}>
                <IconStar size={13} /> {t('ccd.openAtlas')}
              </Link>
              <Link className="cj-btn" href="/carriers/jumps">
                <IconClock size={13} /> {t('ccd.jumpsLink')}
              </Link>
              <Link className="cj-btn" href={`/atlas?tab=carriers&carrier_system=${encodeURIComponent(card.location.system ?? '')}`}>
                <IconExternalLink size={13} /> {t('ccd.atlasSystemCarriers')}
              </Link>
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}

export default CarrierCardPage;
