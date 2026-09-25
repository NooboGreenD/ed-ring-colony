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
        setError(String(data?.error || `Ошибка сервера (${response.status})`));
        return;
      }
      setResult(data as SourcingResponse);
    } catch (err) {
      setResult(null);
      setError(err instanceof Error ? err.message : 'Не удалось посчитать закупки');
    } finally {
      setLoading(false);
    }
  }, [systemName, cargo, capacity, radius, commodityCount]);

  const summary = result?.plan?.summary ?? null;
  const uncovered = result?.plan?.commodities.filter((item) => item.remainingTons > 0) ?? [];

  return (
    <section style={cardStyle}>
      <div style={rowStyle}>
        <h3 style={sectionTitle}>Где купить</h3>
        <span style={mutedText}>
          {commodityCount > 0 ? `${commodityCount} товаров · ${formatTons(totalTons)}` : 'план пока без грузов'}
        </span>
      </div>

      <div style={{ ...rowStyle, marginTop: 10 }}>
        <label style={{ ...mutedText, display: 'flex', alignItems: 'center', gap: 6 }}>
          вместимость, т
          <input
            value={capacity}
            onChange={(event) => setCapacity(event.target.value)}
            style={{ ...inputStyle, width: 78 }}
            inputMode="numeric"
          />
        </label>
        <label style={{ ...mutedText, display: 'flex', alignItems: 'center', gap: 6 }}>
          радиус, св. лет
          <input
            value={radius}
            onChange={(event) => setRadius(event.target.value)}
            style={{ ...inputStyle, width: 78 }}
            inputMode="numeric"
          />
        </label>
        <button type="button" onClick={() => void run()} disabled={loading || commodityCount === 0} style={primaryButton}>
          {loading ? 'Расчёт…' : 'Рассчитать закупки'}
        </button>
      </div>

      {error && <div style={{ ...errorText, marginTop: 8 }}>{error}</div>}

      {result && summary && (
        <>
          <div style={{ marginTop: 10 }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 20, color: 'var(--cyan)', fontFamily: 'ui-monospace, monospace' }}>
                {summary.coveragePercent.toLocaleString('ru-RU')} %
              </span>
              <span style={mutedText}>
                закрыто {formatTons(summary.coveredTons)} из {formatTons(summary.neededTons)}
                {summary.remainingTons > 0 ? ` · осталось ${formatTons(summary.remainingTons)}` : ''}
              </span>
            </div>
            <div style={{ ...mutedText, marginTop: 4 }}>
              Оценка: {formatCredits(summary.estimatedCost)} · {summary.stationCount} станц.
              {' · '}≈{summary.trips} рейс(ов) при {formatTons(result.plan.options.capacityTons)}
              {result.rowsScanned > 0 ? ` · просмотрено записей рынков: ${result.rowsScanned}` : ''}
            </div>
            {!result.originFound && (
              <div style={{ ...mutedText, marginTop: 4, color: 'var(--orange)' }}>
                Координаты системы не найдены — сортировка по расстоянию недоступна.
              </div>
            )}
            {result.empty && (
              <div style={{ ...mutedText, marginTop: 4, color: 'var(--orange)' }}>
                В базе EDDN нет цен по товарам этого плана. Цены появляются, когда кто-то выгружает рынки
                через Colonial Helper или EDDN-поток сайта.
              </div>
            )}
          </div>

          <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 10 }}>
            <thead>
              <tr>
                <th style={thStyle}>Товар</th>
                <th style={thStyle}>Нужно</th>
                <th style={thStyle}>Возьмём</th>
                <th style={thStyle}>Осталось</th>
                <th style={thStyle}>Ближайший рынок</th>
              </tr>
            </thead>
            <tbody>
              {result.plan.commodities.map((item) => (
                <tr key={item.key}>
                  <td style={tdStyle}>{item.label}</td>
                  <td style={tdStyle}>{formatTons(item.neededTons)}</td>
                  <td style={{ ...tdStyle, color: item.coveredTons > 0 ? 'var(--text)' : 'var(--muted)' }}>
                    {formatTons(item.coveredTons)}
                    {item.averagePrice != null ? <div style={{ fontSize: 11, color: 'var(--muted)' }}>≈{item.averagePrice.toLocaleString('ru-RU')} кр/т</div> : null}
                  </td>
                  <td style={{ ...tdStyle, color: item.remainingTons > 0 ? 'var(--red)' : 'var(--muted)' }}>
                    {item.remainingTons > 0 ? formatTons(item.remainingTons) : '—'}
                  </td>
                  <td style={{ ...tdStyle, fontSize: 11, color: 'var(--muted)' }}>
                    {item.offers.length > 0
                      ? `${item.offers[0].stationName} (${item.offers[0].systemName})`
                        + (item.offers[0].distanceLy != null ? ` · ${item.offers[0].distanceLy} св. лет` : '')
                      : 'не найдено'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {result.plan.stops.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div style={{ ...mutedText, textTransform: 'uppercase', letterSpacing: 1, fontSize: 11 }}>
                Остановки перевозчика
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
                    {stop.distanceLy != null ? <span style={mutedText}> · {stop.distanceLy} св. лет</span> : null}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                    {formatTons(stop.totalTons)} · {stop.trips} рейс(ов) · {formatCredits(stop.totalCost)}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                    {stop.items.map((item) => `${item.label}: ${formatTons(item.tons)} по ${item.price.toLocaleString('ru-RU')} кр/т`).join(' · ')}
                  </div>
                </div>
              ))}
            </div>
          )}

          {uncovered.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div style={mutedText}>
                Не хватило данных по товарам: {uncovered.map((item) => item.label).join(', ')}.
              </div>
              <Link
                href={`/atlas?system=${encodeURIComponent(systemName)}&tab=market`}
                style={{ ...ghostButton, marginTop: 6 }}
              >
                Поиск рынка по EDSM
              </Link>
            </div>
          )}
        </>
      )}
    </section>
  );
}
