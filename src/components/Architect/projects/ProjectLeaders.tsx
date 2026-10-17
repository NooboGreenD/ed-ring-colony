'use client';

/**
 * Инфографика лидеров проекта: кто сколько какого груза привёз и на какую
 * площадку.
 *
 *   * пьедестал и рейтинг пилотов (полоса пилота разбита по товарам,
 *     клик — подробная разбивка «площадка × товар»);
 *   * матрица «пилот × площадка» — тепловая карта тонн;
 *   * разрезы по товарам, площадкам, системам и авианосцам (кто сколько дал);
 *   * лента активности по дням (по неделям — для длинных периодов).
 *
 * Рейтинг — по тоннам, сданным на стройплощадки; груз на авианосцы проекта
 * показан отдельно и в рейтинг не входит, чтобы тонна не считалась дважды.
 */

import { Fragment, useMemo, useState } from 'react';
import { cardStyle, chipActive, chipStyle, errorText, mutedText, rowStyle, sectionTitle, tableStyle, tdStyle, thStyle } from '@/components/Architect/panelStyles';
import {
  LEADER_PERIODS,
  PERIOD_LABELS,
  type LeaderPeriod,
  type LeaderPilot,
  type LeaderScope,
  type LeaderSlice,
  type LeaderTimeline,
} from '@/lib/architect/projectLeaders';
import {
  EmptyState,
  Kpi,
  Legend,
  OTHER_TONE,
  RoleBadge,
  StackedBar,
  compactTons,
  formatAgo,
  formatPercent,
  formatTons,
  toneAt,
  type Segment,
} from '@/components/Architect/projects/projectUi';
import type { LeadersResponse } from '@/components/Architect/projects/ProjectView';

interface Props {
  leaders: LeadersResponse | null;
  loading: boolean;
  error: string;
  period: LeaderPeriod;
  scope: LeaderScope;
  color: string;
  onPeriod: (period: LeaderPeriod) => void;
  onScope: (scope: LeaderScope) => void;
}

const PODIUM_TONES = ['#f1c40f', '#ced4da', '#d08c5b'];
const mono = { fontFamily: 'ui-monospace, monospace' } as const;

function useTones(leaders: LeadersResponse | null) {
  return useMemo(() => {
    const pilotTone = new Map<string, string>();
    (leaders?.pilots ?? []).forEach((pilot, index) => pilotTone.set(pilot.key, toneAt(index)));
    const commodityTone = new Map<string, string>();
    (leaders?.commodities ?? []).forEach((commodity, index) => commodityTone.set(commodity.key, toneAt(index)));
    return {
      pilot: (key: string) => (key === '__other' ? OTHER_TONE : pilotTone.get(key) ?? OTHER_TONE),
      commodity: (key: string) => (key === '__other' ? OTHER_TONE : commodityTone.get(key) ?? OTHER_TONE),
    };
  }, [leaders]);
}

function toSegments(slices: LeaderSlice[], tone: (key: string) => string): Segment[] {
  return slices.map((slice) => ({ key: slice.key, label: slice.label, value: slice.tons, tone: tone(slice.key) }));
}

export default function ProjectLeaders({ leaders, loading, error, period, scope, color, onPeriod, onScope }: Props) {
  const tones = useTones(leaders);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showAllPilots, setShowAllPilots] = useState(false);

  const controls = (
    <section style={{ ...cardStyle, display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', justifyContent: 'space-between' }}>
      <div style={rowStyle} role="group" aria-label="Период">
        {LEADER_PERIODS.map((value) => (
          <button key={value} type="button" style={period === value ? { ...chipStyle, ...chipActive } : chipStyle} onClick={() => onPeriod(value)}>
            {PERIOD_LABELS[value]}
          </button>
        ))}
      </div>
      <div style={rowStyle} role="group" aria-label="Кого считать">
        <button type="button" style={scope === 'all' ? { ...chipStyle, ...chipActive } : chipStyle} onClick={() => onScope('all')}>Все пилоты</button>
        <button type="button" style={scope === 'members' ? { ...chipStyle, ...chipActive } : chipStyle} onClick={() => onScope('members')}>Только участники</button>
        {loading && <span style={mutedText}>обновляем…</span>}
      </div>
    </section>
  );

  if (!leaders) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {controls}
        {error ? <p style={errorText}>{error}</p> : <p style={mutedText}>Собираем вклад пилотов…</p>}
      </div>
    );
  }

  const { totals } = leaders;
  const pilots = leaders.pilots;
  const rated = pilots.filter((pilot) => pilot.siteTons > 0 || pilot.carrierTons > 0);
  const visiblePilots = showAllPilots ? rated : rated.slice(0, 25);
  const maxPilotTons = rated.reduce((max, pilot) => Math.max(max, pilot.siteTons), 0);
  const podium = rated.filter((pilot) => pilot.siteTons > 0).slice(0, 3);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {controls}
      {error && <p style={errorText}>{error}</p>}

      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8 }}>
        <Kpi label="Сдано на площадки" value={formatTons(totals.siteTons)} tone={color} hint={`${totals.siteOps} поставок`} />
        <Kpi label="Пилотов" value={totals.pilots} hint={`участников ${totals.members} · гостей ${totals.guests}`} />
        <Kpi label="Площадок" value={totals.sites} hint={`систем ${totals.systems}`} />
        <Kpi label="Товаров" value={totals.commodities} hint={leaders.commodities[0] ? `больше всего: ${leaders.commodities[0].label}` : undefined} />
        <Kpi label="На авианосцы" value={formatTons(totals.carrierTons)} hint="отдельно от площадок" />
      </section>

      {rated.length === 0 ? (
        <EmptyState>
          За выбранный период поставок в системы проекта нет. Вклад считается по журналам, загруженным на сайт
          (Colonial Helper или загрузка журналов), — у пилотов должны быть загружены журналы.
        </EmptyState>
      ) : (
        <>
          {podium.length > 0 && (
            <section aria-label="Пьедестал" style={{ display: 'grid', gridTemplateColumns: `repeat(${podium.length}, minmax(0, 1fr))`, gap: 8 }}>
              {podium.map((pilot, index) => (
                <div key={pilot.key} style={{ ...cardStyle, borderTopWidth: 3, borderTopColor: PODIUM_TONES[index], display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                    <span style={{ ...mono, fontSize: 22, color: PODIUM_TONES[index] }}>#{pilot.rank}</span>
                    <strong style={{ fontSize: 15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: pilot.hidden ? 'var(--muted)' : 'var(--text)' }}>
                      {pilot.name}{pilot.isYou ? ' (вы)' : ''}
                    </strong>
                  </div>
                  <div style={{ ...mono, fontSize: 20 }}>{formatTons(pilot.siteTons)}</div>
                  <div style={mutedText}>
                    {formatPercent(pilot.share * 100)} всего · {pilot.siteOps} поставок · {pilot.sites} площадок
                  </div>
                  <StackedBar segments={toSegments(pilot.commodities, tones.commodity)} total={pilot.siteTons} />
                  <div style={{ ...mutedText, fontSize: 11 }}>
                    {pilot.commodities.slice(0, 3).map((slice) => `${slice.label} ${compactTons(slice.tons)}`).join(' · ')}
                  </div>
                </div>
              ))}
            </section>
          )}

          <section style={cardStyle} aria-label="Рейтинг пилотов">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8, gap: 8, flexWrap: 'wrap' }}>
              <h2 style={sectionTitle}>Рейтинг пилотов</h2>
              <span style={mutedText}>полоса — тонны на площадки по товарам; клик по строке — что и куда</span>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={{ ...thStyle, width: 36 }}>#</th>
                    <th style={thStyle}>Пилот</th>
                    <th style={{ ...thStyle, minWidth: 220 }}>Груз на площадки</th>
                    <th style={{ ...thStyle, textAlign: 'right' }}>Тонн</th>
                    <th style={{ ...thStyle, textAlign: 'right' }}>Доля</th>
                    <th style={{ ...thStyle, textAlign: 'right' }}>Поставок</th>
                    <th style={{ ...thStyle, textAlign: 'right' }}>Площадок</th>
                    <th style={{ ...thStyle, textAlign: 'right' }} title="Груз, проданный или перегруженный на авианосцы проекта">На FC</th>
                    <th style={{ ...thStyle, textAlign: 'right' }}>Последняя</th>
                  </tr>
                </thead>
                <tbody>
                  {visiblePilots.map((pilot) => (
                    <PilotRow
                      key={pilot.key}
                      pilot={pilot}
                      maxTons={maxPilotTons}
                      tone={tones.commodity}
                      expanded={expanded === pilot.key}
                      onToggle={() => setExpanded((current) => (current === pilot.key ? null : pilot.key))}
                    />
                  ))}
                </tbody>
              </table>
            </div>
            {rated.length > 25 && (
              <button type="button" style={{ ...chipStyle, marginTop: 8 }} onClick={() => setShowAllPilots((value) => !value)}>
                {showAllPilots ? 'Показать первые 25' : `Показать всех (${rated.length})`}
              </button>
            )}
            <Legend items={leaders.commodities.slice(0, 12).map((commodity) => ({ key: commodity.key, label: commodity.label, tone: tones.commodity(commodity.key) }))} />
          </section>

          <MatrixSection leaders={leaders} tone={tones.pilot} />

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 12 }}>
            <section style={cardStyle} aria-label="По товарам">
              <h2 style={{ ...sectionTitle, marginBottom: 8 }}>По товарам — кто сколько привёз</h2>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {leaders.commodities.slice(0, 20).map((commodity) => (
                  <div key={commodity.key}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 3, gap: 8 }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ width: 8, height: 8, background: tones.commodity(commodity.key) }} />
                        {commodity.label}
                      </span>
                      <span style={{ ...mono, color: 'var(--muted)' }}>
                        {formatTons(commodity.tons)} · {formatPercent(commodity.share * 100)} · {commodity.pilotCount} пил.
                      </span>
                    </div>
                    <StackedBar segments={toSegments(commodity.pilots, tones.pilot)} total={commodity.tons} height={8} />
                    <div style={{ ...mutedText, fontSize: 11, marginTop: 2 }}>
                      {commodity.pilots.filter((slice) => slice.key !== '__other').slice(0, 3)
                        .map((slice) => `${slice.label} ${compactTons(slice.tons)}`).join(' · ')}
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section style={cardStyle} aria-label="По площадкам">
              <h2 style={{ ...sectionTitle, marginBottom: 8 }}>По площадкам — кто сколько сдал</h2>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {leaders.sites.slice(0, 20).map((site) => (
                  <div key={site.key}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 3, gap: 8 }}>
                      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={site.marketId ? `MarketID ${site.marketId}` : undefined}>
                        {site.name} <span style={{ color: 'var(--muted)' }}>· {site.systemName}</span>
                      </span>
                      <span style={{ ...mono, color: 'var(--muted)', whiteSpace: 'nowrap' }}>{formatTons(site.tons)} · {site.pilotCount} пил.</span>
                    </div>
                    <StackedBar segments={toSegments(site.pilots, tones.pilot)} total={site.tons} height={8} />
                    <div style={{ ...mutedText, fontSize: 11, marginTop: 2 }}>
                      {site.commodities.slice(0, 4).map((slice) => `${slice.label} ${compactTons(slice.tons)}`).join(' · ')}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 12 }}>
            <section style={cardStyle} aria-label="По системам">
              <h2 style={{ ...sectionTitle, marginBottom: 8 }}>По системам</h2>
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={thStyle}>Система</th>
                    <th style={{ ...thStyle, textAlign: 'right' }}>Тонн</th>
                    <th style={{ ...thStyle, textAlign: 'right' }}>Пилотов</th>
                    <th style={{ ...thStyle, textAlign: 'right' }}>Площадок</th>
                    <th style={thStyle}>Больше всех</th>
                  </tr>
                </thead>
                <tbody>
                  {leaders.systems.map((system) => (
                    <tr key={system.name}>
                      <td style={tdStyle}>{system.name}</td>
                      <td style={{ ...tdStyle, ...mono, textAlign: 'right' }}>{compactTons(system.tons)}</td>
                      <td style={{ ...tdStyle, ...mono, textAlign: 'right' }}>{system.pilotCount}</td>
                      <td style={{ ...tdStyle, ...mono, textAlign: 'right' }}>{system.siteCount}</td>
                      <td style={{ ...tdStyle, color: 'var(--muted)' }}>
                        {system.pilots.filter((slice) => slice.key !== '__other').slice(0, 2).map((slice) => slice.label).join(', ')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            <section style={cardStyle} aria-label="Авианосцы проекта">
              <h2 style={{ ...sectionTitle, marginBottom: 8 }}>Авианосцы проекта</h2>
              {leaders.carriers.length === 0 ? (
                <EmptyState>На привязанные авианосцы груз за период не поступал.</EmptyState>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {leaders.carriers.map((carrier) => (
                    <div key={carrier.carrierId}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 3 }}>
                        <span>{carrier.name}</span>
                        <span style={{ ...mono, color: 'var(--muted)' }}>{formatTons(carrier.tons)}</span>
                      </div>
                      <StackedBar segments={toSegments(carrier.pilots, tones.pilot)} total={carrier.tons} height={8} />
                      <div style={{ ...mutedText, fontSize: 11, marginTop: 2 }}>
                        {carrier.commodities.slice(0, 4).map((slice) => `${slice.label} ${compactTons(slice.tons)}`).join(' · ')}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>

          <section style={cardStyle} aria-label="Активность по дням">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
              <h2 style={sectionTitle}>Активность {leaders.timeline.bucket === 'week' ? 'по неделям' : 'по дням'}</h2>
              <span style={mutedText}>цвет — лидеры, серый — остальные, голубая риска — груз на авианосцы</span>
            </div>
            {leaders.timeline.points.length ? <ActivityChart timeline={leaders.timeline} tone={tones.pilot} /> : <EmptyState>Нет поставок за период.</EmptyState>}
          </section>
        </>
      )}

      <p style={{ ...mutedText, margin: 0 }}>
        Учитываются поставки из журналов, загруженных на сайт: стройплощадки и колониальные корабли в системах проекта
        {leaders.trackingSince ? ` начиная с ${new Date(leaders.trackingSince).toLocaleDateString('ru-RU')}` : ''}, продажа и
        перегрузка на привязанные авианосцы. Пилоты вне проекта, скрывшие поставки в настройках приватности, показаны как
        «Скрытый командир». Сводка собрана {formatAgo(leaders.generatedAt)}.
      </p>
    </div>
  );
}

function PilotRow({ pilot, maxTons, tone, expanded, onToggle }: {
  pilot: LeaderPilot;
  maxTons: number;
  tone: (key: string) => string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const width = maxTons > 0 ? Math.max(2, (pilot.siteTons / maxTons) * 100) : 0;
  return (
    <Fragment>
      <tr
        onClick={onToggle}
        style={{ cursor: 'pointer', background: pilot.isYou ? 'rgba(230, 126, 34, 0.08)' : undefined }}
        aria-expanded={expanded}
      >
        <td style={{ ...tdStyle, ...mono, color: pilot.rank <= 3 ? PODIUM_TONES[pilot.rank - 1] : 'var(--muted)' }}>{pilot.rank}</td>
        <td style={tdStyle}>
          <span style={{ color: pilot.hidden ? 'var(--muted)' : 'var(--text)' }}>{pilot.name}</span>
          {pilot.isYou && <span style={{ color: 'var(--orange)' }}> · вы</span>}
          {pilot.member && <span style={{ marginLeft: 6 }}><RoleBadge role={pilot.role} /></span>}
        </td>
        <td style={tdStyle}>
          {pilot.siteTons > 0 ? (
            <div style={{ width: `${width}%` }}>
              <StackedBar segments={toSegments(pilot.commodities, tone)} total={pilot.siteTons} height={10} />
            </div>
          ) : <span style={mutedText}>—</span>}
        </td>
        <td style={{ ...tdStyle, ...mono, textAlign: 'right' }}>{compactTons(pilot.siteTons)}</td>
        <td style={{ ...tdStyle, ...mono, textAlign: 'right' }}>{formatPercent(pilot.share * 100)}</td>
        <td style={{ ...tdStyle, ...mono, textAlign: 'right' }}>{pilot.siteOps}</td>
        <td style={{ ...tdStyle, ...mono, textAlign: 'right' }}>{pilot.sites}</td>
        <td style={{ ...tdStyle, ...mono, textAlign: 'right', color: pilot.carrierTons ? 'var(--cyan)' : 'var(--muted)' }}>
          {pilot.carrierTons ? compactTons(pilot.carrierTons) : '—'}
        </td>
        <td style={{ ...tdStyle, textAlign: 'right', color: 'var(--muted)', whiteSpace: 'nowrap' }}>{formatAgo(pilot.lastAt)}</td>
      </tr>
      {expanded && (
        <tr>
          <td style={tdStyle} />
          <td colSpan={8} style={{ ...tdStyle, background: 'var(--bg)' }}>
            {pilot.breakdown.length === 0 ? (
              <span style={mutedText}>Только груз на авианосцы: {pilot.carriers.map((slice) => `${slice.label} ${compactTons(slice.tons)} т`).join(', ')}</span>
            ) : (
              <table style={{ ...tableStyle, fontSize: 11 }}>
                <thead>
                  <tr>
                    <th style={thStyle}>Площадка</th>
                    <th style={thStyle}>Система</th>
                    <th style={thStyle}>Товар</th>
                    <th style={{ ...thStyle, textAlign: 'right' }}>Тонн</th>
                    <th style={{ ...thStyle, textAlign: 'right' }}>Поставок</th>
                  </tr>
                </thead>
                <tbody>
                  {pilot.breakdown.map((line) => (
                    <tr key={`${line.siteKey}|${line.commodity}`}>
                      <td style={tdStyle}>{line.siteName}</td>
                      <td style={{ ...tdStyle, color: 'var(--muted)' }}>{line.systemName}</td>
                      <td style={tdStyle}>
                        <span style={{ display: 'inline-block', width: 8, height: 8, background: tone(line.commodity), marginRight: 6 }} />
                        {line.commodityLabel}
                      </td>
                      <td style={{ ...tdStyle, ...mono, textAlign: 'right' }}>{formatTons(line.tons, '')}</td>
                      <td style={{ ...tdStyle, ...mono, textAlign: 'right' }}>{line.ops}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {pilot.carrierTons > 0 && pilot.breakdown.length > 0 && (
              <div style={{ ...mutedText, marginTop: 6 }}>
                На авианосцы: {pilot.carriers.map((slice) => `${slice.label} ${compactTons(slice.tons)} т`).join(', ')}
              </div>
            )}
          </td>
        </tr>
      )}
    </Fragment>
  );
}

function MatrixSection({ leaders, tone }: { leaders: LeadersResponse; tone: (key: string) => string }) {
  const { matrix } = leaders;
  if (!matrix.pilots.length || !matrix.sites.length) return null;
  const colTotals = matrix.sites.map((_, column) => matrix.cells.reduce((sum, row) => sum + (row[column] ?? 0), 0));
  return (
    <section style={cardStyle} aria-label="Матрица пилот × площадка">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8, gap: 8, flexWrap: 'wrap' }}>
        <h2 style={sectionTitle}>Кто и куда: пилот × площадка</h2>
        <span style={mutedText}>яркость клетки — сданные тонны; топ-{matrix.pilots.length} пилотов и топ-{matrix.sites.length} площадок</span>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ ...tableStyle, fontSize: 11 }}>
          <thead>
            <tr>
              <th style={{ ...thStyle, position: 'sticky', left: 0, background: 'var(--panel)' }}>Пилот</th>
              {matrix.sites.map((site) => (
                <th key={site.key} style={{ ...thStyle, textAlign: 'center', minWidth: 72, maxWidth: 120, whiteSpace: 'normal', textTransform: 'none' }} title={site.label}>
                  {site.label.length > 28 ? `${site.label.slice(0, 26)}…` : site.label}
                </th>
              ))}
              <th style={{ ...thStyle, textAlign: 'right' }}>Всего</th>
            </tr>
          </thead>
          <tbody>
            {matrix.pilots.map((pilot, rowIndex) => (
              <tr key={pilot.key}>
                <td style={{ ...tdStyle, position: 'sticky', left: 0, background: 'var(--panel)', whiteSpace: 'nowrap' }}>
                  <span style={{ display: 'inline-block', width: 8, height: 8, background: tone(pilot.key), marginRight: 6 }} />
                  {pilot.label}
                </td>
                {matrix.sites.map((site, column) => {
                  const value = matrix.cells[rowIndex]?.[column] ?? 0;
                  const intensity = matrix.max > 0 ? value / matrix.max : 0;
                  return (
                    <td
                      key={site.key}
                      title={`${pilot.label} → ${site.label}: ${formatTons(value)}`}
                      style={{
                        ...tdStyle,
                        ...mono,
                        textAlign: 'center',
                        background: value > 0 ? `rgba(230, 126, 34, ${0.12 + intensity * 0.78})` : 'transparent',
                        color: intensity > 0.55 ? '#1e2022' : value > 0 ? 'var(--text)' : 'var(--muted)',
                      }}
                    >
                      {value > 0 ? compactTons(value) : '·'}
                    </td>
                  );
                })}
                <td style={{ ...tdStyle, ...mono, textAlign: 'right' }}>{compactTons(pilot.tons)}</td>
              </tr>
            ))}
            <tr>
              <td style={{ ...tdStyle, color: 'var(--muted)', position: 'sticky', left: 0, background: 'var(--panel)' }}>Всего на площадке</td>
              {colTotals.map((total, column) => (
                <td key={matrix.sites[column].key} style={{ ...tdStyle, ...mono, textAlign: 'center', color: 'var(--muted)' }}>{compactTons(matrix.sites[column].tons || total)}</td>
              ))}
              <td style={tdStyle} />
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Столбики активности: доли лидеров, серый остаток, риска груза на FC. */
export function ActivityChart({ timeline, tone, height = 160 }: { timeline: LeaderTimeline; tone?: (key: string) => string; height?: number }) {
  const colorOf = tone ?? ((key: string) => {
    const index = timeline.pilots.findIndex((pilot) => pilot.key === key);
    return index >= 0 ? toneAt(index) : OTHER_TONE;
  });
  const points = timeline.points;
  const max = Math.max(1, ...points.map((point) => point.siteTons), ...points.map((point) => point.carrierTons));
  const labelEvery = Math.max(1, Math.ceil(points.length / 8));
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: points.length > 60 ? 1 : 2, height, borderBottom: '1px solid var(--line)' }}>
        {points.map((point) => {
          const segments = [
            ...timeline.pilots.map((pilot) => ({ key: pilot.key, label: pilot.label, value: point.byPilot[pilot.key] ?? 0 })),
            { key: '__other', label: 'Остальные', value: point.other },
          ].filter((segment) => segment.value > 0);
          const title = [
            `${point.day}: ${formatTons(point.siteTons)} на площадки`,
            ...segments.map((segment) => `${segment.label}: ${formatTons(segment.value)}`),
            point.carrierTons ? `на авианосцы: ${formatTons(point.carrierTons)}` : '',
          ].filter(Boolean).join('\n');
          return (
            <div key={point.day} title={title} style={{ flex: '1 1 0', minWidth: 2, height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', position: 'relative' }}>
              {point.carrierTons > 0 && (
                <div style={{ position: 'absolute', left: 0, right: 0, bottom: `${(point.carrierTons / max) * 100}%`, height: 2, background: 'var(--cyan)' }} />
              )}
              {segments.reverse().map((segment) => (
                <div key={segment.key} style={{ height: `${(segment.value / max) * 100}%`, background: segment.key === '__other' ? OTHER_TONE : colorOf(segment.key) }} />
              ))}
            </div>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: points.length > 60 ? 1 : 2, marginTop: 4 }}>
        {points.map((point, index) => (
          <div key={point.day} style={{ flex: '1 1 0', minWidth: 2, fontSize: 10, color: 'var(--muted)', overflow: 'visible', whiteSpace: 'nowrap' }}>
            {index % labelEvery === 0 ? point.day.slice(5) : ''}
          </div>
        ))}
      </div>
      {timeline.pilots.length > 0 && (
        <Legend items={[
          ...timeline.pilots.map((pilot) => ({ key: pilot.key, label: pilot.label, tone: colorOf(pilot.key), value: pilot.tons })),
          { key: '__other', label: 'Остальные', tone: OTHER_TONE },
        ]} />
      )}
    </div>
  );
}
