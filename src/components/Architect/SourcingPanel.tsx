'use client';

/**
 * «Где купить»: закупки под план застройки.
 *
 * Расчёт делает сервер (`POST /api/architect/sourcing`): цены берутся из
 * собственной базы EDDN (`market_prices`), расстояния — из каталога галактики,
 * раскладка по рынкам — чистая функция `planSourcing`. Здесь только запрос и
 * вывод, поэтому панель работает и когда в базе пусто: тогда она честно
 * показывает нулевое покрытие и отправляет искать рынки через EDSM.
 */

import { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  formatCredits,
  type SourcingPlan,
} from '@/lib/architect/sourcing';
import { formatTons } from '@/lib/architect/planner';
import { useI18n } from '@/lib/i18n/I18nContext';
import {
  cardStyle,
  errorText,
  ghostButton,
  inputStyle,
  mutedText,
  primaryButton,
  rowStyle,
  sectionTitle,
  tdStyle,
  thStyle,
} from '@/components/Architect/panelStyles';

interface SourcingResponse {
  source: string;
  system: string;
  originFound: boolean;
  rowsScanned: number;
  offers: number;
  empty: boolean;
  plan: SourcingPlan;
}

interface SourcingPanelProps {
  systemName: string;
  /** Товары плана: ключ → тонн. */
  cargo: Record<string, number>;
}

function numberInput(value: string): number {
  const parsed = Number.parseFloat(value.replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : 0;
}

export default function SourcingPanel({ systemName, cargo }: SourcingPanelProps) {
  const { t, locale } = useI18n();
  const [capacity, setCapacity] = useState('400');
  const [radius, setRadius] = useState('80');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<SourcingResponse | null>(null);

  const totalTons = useMemo(
    () => Object.values(cargo).reduce((sum, tons) => sum + (Number.isFinite(tons) ? tons : 0), 0),
    [cargo],
  );
  const commodityCount = useMemo(
    () => Object.entries(cargo).filter(([, tons]) => Number.isFinite(tons) && tons > 0).length,
    [cargo],
  );

  const run = useCallback(async () => {
    if (!systemName || commodityCount === 0) return;
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/architect/sourcing', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          system: systemName,
          cargo,
          options: {
            capacityTons: numberInput(capacity),
            maxDistanceLy: numberInput(radius),
          },
        }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setResult(null);
        setError(String(data?.error || t('src.serverError', { status: response.status })));
        return;
      }
      setResult(data as SourcingResponse);
    } catch (err) {
      setResult(null);
      setError(err instanceof Error ? err.message : t('src.failed'));
    } finally {
      setLoading(false);
    }
  }, [systemName, cargo, capacity, radius, commodityCount]);

  const summary = result?.plan?.summary ?? null;
  const uncovered = result?.plan?.commodities.filter((item) => item.remainingTons > 0) ?? [];

  return (
    <section style={cardStyle}>
      <div style={rowStyle}>
        <h3 style={sectionTitle}>{t('src.title')}</h3>
        <span style={mutedText}>
          {commodityCount > 0 ? t('src.commodities', { count: commodityCount, tons: formatTons(totalTons) }) : t('src.noCargo')}
        </span>
      </div>

      <div style={{ ...rowStyle, marginTop: 10 }}>
        <label style={{ ...mutedText, display: 'flex', alignItems: 'center', gap: 6 }}>
          {t('src.capacity')}
          <input
            value={capacity}
            onChange={(event) => setCapacity(event.target.value)}
            style={{ ...inputStyle, width: 78 }}
            inputMode="numeric"
          />
        </label>
        <label style={{ ...mutedText, display: 'flex', alignItems: 'center', gap: 6 }}>
          {t('src.radius')}
          <input
            value={radius}
            onChange={(event) => setRadius(event.target.value)}
            style={{ ...inputStyle, width: 78 }}
            inputMode="numeric"
          />
        </label>
        <button type="button" onClick={() => void run()} disabled={loading || commodityCount === 0} style={primaryButton}>
          {loading ? t('src.calculating') : t('src.calculate')}
        </button>
      </div>

      {error && <div style={{ ...errorText, marginTop: 8 }}>{error}</div>}

      {result && summary && (
        <>
          <div style={{ marginTop: 10 }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 20, color: 'var(--cyan)', fontFamily: 'ui-monospace, monospace' }}>
                {summary.coveragePercent.toLocaleString(locale)} %
              </span>
              <span style={mutedText}>
                {t('src.covered', { covered: formatTons(summary.coveredTons), needed: formatTons(summary.neededTons) })}
                {summary.remainingTons > 0 ? t('src.remaining', { tons: formatTons(summary.remainingTons) }) : ''}
              </span>
            </div>
            <div style={{ ...mutedText, marginTop: 4 }}>
              {t('src.estimate', { cost: formatCredits(summary.estimatedCost), count: summary.stationCount })}
              {' · '}{t('src.tripsAt', { trips: summary.trips, capacity: formatTons(result.plan.options.capacityTons) })}
              {result.rowsScanned > 0 ? t('src.rowsScanned', { count: result.rowsScanned }) : ''}
            </div>
            {!result.originFound && (
              <div style={{ ...mutedText, marginTop: 4, color: 'var(--orange)' }}>
                {t('src.noCoords')}
              </div>
            )}
            {result.empty && (
              <div style={{ ...mutedText, marginTop: 4, color: 'var(--orange)' }}>
                {t('src.noEddn')}
              </div>
            )}
          </div>

          <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 10 }}>
            <thead>
              <tr>
                <th style={thStyle}>{t('src.colCommodity')}</th>
                <th style={thStyle}>{t('src.colNeeded')}</th>
                <th style={thStyle}>{t('src.colTake')}</th>
                <th style={thStyle}>{t('src.colRemaining')}</th>
                <th style={thStyle}>{t('src.colNearest')}</th>
              </tr>
            </thead>
            <tbody>
              {result.plan.commodities.map((item) => (
                <tr key={item.key}>
                  <td style={tdStyle}>{item.label}</td>
                  <td style={tdStyle}>{formatTons(item.neededTons)}</td>
                  <td style={{ ...tdStyle, color: item.coveredTons > 0 ? 'var(--text)' : 'var(--muted)' }}>
                    {formatTons(item.coveredTons)}
                    {item.averagePrice != null ? <div style={{ fontSize: 11, color: 'var(--muted)' }}>{t('src.perTon', { price: item.averagePrice.toLocaleString(locale) })}</div> : null}
                  </td>
                  <td style={{ ...tdStyle, color: item.remainingTons > 0 ? 'var(--red)' : 'var(--muted)' }}>
                    {item.remainingTons > 0 ? formatTons(item.remainingTons) : '—'}
                  </td>
                  <td style={{ ...tdStyle, fontSize: 11, color: 'var(--muted)' }}>
                    {item.offers.length > 0
                      ? `${item.offers[0].stationName} (${item.offers[0].systemName})`
                        + (item.offers[0].distanceLy != null ? t('src.lyShort', { value: item.offers[0].distanceLy }) : '')
                      : t('src.notFound')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {result.plan.stops.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div style={{ ...mutedText, textTransform: 'uppercase', letterSpacing: 1, fontSize: 11 }}>
                {t('src.stops')}
              </div>
              {result.plan.stops.map((stop) => (
                <div
                  key={`${stop.systemName}::${stop.stationName}`}
                  style={{
                    borderWidth: 1, borderStyle: 'solid', borderColor: 'var(--line)', borderRadius: 3,
                    padding: '6px 8px', marginTop: 6, background: 'var(--bg)',
                  }}
                >
                  <div style={{ fontSize: 13, color: 'var(--text)' }}>
                    {stop.stationName}
                    <span style={mutedText}> · {stop.systemName}</span>
                    {stop.distanceLy != null ? <span style={mutedText}>{t('src.lyShort', { value: stop.distanceLy })}</span> : null}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                    {t('src.stopLine', { tons: formatTons(stop.totalTons), trips: stop.trips, cost: formatCredits(stop.totalCost) })}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                    {stop.items.map((item) => t('src.stopItem', { label: item.label, tons: formatTons(item.tons), price: item.price.toLocaleString(locale) })).join(' · ')}
                  </div>
                </div>
              ))}
            </div>
          )}

          {uncovered.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div style={mutedText}>
                {t('src.missingData', { list: uncovered.map((item) => item.label).join(', ') })}
              </div>
              <Link
                href={`/atlas?system=${encodeURIComponent(systemName)}&tab=market`}
                style={{ ...ghostButton, marginTop: 6 }}
              >
                {t('src.searchEdsm')}
              </Link>
            </div>
          )}
        </>
      )}
    </section>
  );
}
