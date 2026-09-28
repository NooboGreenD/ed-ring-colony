'use client';

/**
 * Инфографика плана: очки системы по шагам стройки, тоннаж и рейсы, стадии,
 * экономики, эффекты и загрузка тел.
 *
 * Все числа считает `src/lib/architect/insights.ts` — здесь только разметка в
 * стиле сайта: плоские панели, рамка 1px, моноширинные подписи капсом и
 * палитра из `DESIGN.md` (оранжевый — акцент, циан — информация, зелёный —
 * хорошо, красный — проблема). Ничего не рисуется библиотеками графиков:
 * полосы — это `div` с процентной шириной, поэтому панель лёгкая и
 * одинаково выглядит в тёмной теме сайта.
 */

import { useMemo, useState } from 'react';
import {
  bodyLoads,
  cargoShares,
  economyShares,
  effectBars,
  haulTrips,
  statusBreakdown,
  tierBudgets,
} from '@/lib/architect/insights';
import { formatTons } from '@/lib/architect/planner';
import type { ArchitectBody, ArchitectPlan, PlanEvaluation } from '@/lib/architect/types';
import { cardStyle, chipActive, chipStyle, mutedText } from '@/components/Architect/panelStyles';

const STATUS_TONES: Record<string, string> = {
  plan: 'var(--muted)',
  building: 'var(--cyan)',
  complete: 'var(--green)',
};

/** Палитра для долевых полос: повторяет акценты сайта, без новых цветов. */
const SHARE_TONES = [
  'var(--orange)', 'var(--cyan)', 'var(--green)', '#b197fc', '#f39c12',
  '#20c997', '#4dabf7', '#e74c3c', '#9ca3af', '#8d6e63',
];

interface PlanInsightsProps {
  plan: ArchitectPlan;
  evaluation: PlanEvaluation;
  bodies: ArchitectBody[];
  /** Клик по шагу — открыть запись плана. */
  onSelectSite?: (siteId: string) => void;
}

export default function PlanInsights({ plan, evaluation, bodies, onSelectSite }: PlanInsightsProps) {
  const [capacity, setCapacity] = useState(784);

  const budgets = useMemo(() => tierBudgets(evaluation), [evaluation]);
  const cargo = useMemo(() => cargoShares(evaluation, 8), [evaluation]);
  const economies = useMemo(() => economyShares(evaluation), [evaluation]);
  const stages = useMemo(() => statusBreakdown(plan), [plan]);
  const effects = useMemo(() => effectBars(evaluation), [evaluation]);
  const loads = useMemo(
    () => bodyLoads(plan, bodies)
      .filter((entry) => entry.used > 0 || entry.orbital > 0)
      .sort((left, right) => (right.used + right.orbital) - (left.used + left.orbital))
      .slice(0, 10),
    [plan, bodies],
  );

  const timeline = evaluation.timeline;
  const peak = useMemo(() => timeline.reduce(
    (max, step) => Math.max(max, Math.abs(step.tier2After), Math.abs(step.tier3After)),
    1,
  ), [timeline]);

  if (plan.sites.length === 0) {
    return (
      <section style={cardStyle}>
        <h3 style={titleStyle}>Инфографика плана</h3>
        <div style={mutedText}>
          Добавьте постройки — здесь появятся бюджет очков по шагам стройки, доли грузов,
          экономики, эффекты системы и загрузка тел.
        </div>
      </section>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <section style={cardStyle}>
        <h3 style={titleStyle}>Бюджет очков системы по шагам</h3>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
          {budgets.map((budget) => (
            <div key={budget.tier} style={{ flex: '1 1 200px', border: '1px solid var(--line)', borderRadius: 3, padding: '8px 10px', background: 'var(--bg)' }}>
              <div style={labelStyle}>очки T{budget.tier}</div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 20, color: budget.free < 0 ? 'var(--red)' : 'var(--text)' }}>
                  {budget.free > 0 ? `+${budget.free}` : budget.free}
                </span>
                <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                  получено {budget.given} · потрачено {budget.spent}
                </span>
              </div>
              <div style={{ display: 'flex', height: 6, marginTop: 6, border: '1px solid var(--line)', borderRadius: 3, overflow: 'hidden', background: 'var(--bg)' }}>
                <div style={{ width: `${Math.min(100, budget.usedPercent)}%`, background: budget.usedPercent > 100 ? 'var(--red)' : 'var(--orange)' }} />
                <div style={{ flex: 1, background: 'rgba(46,204,113,.35)' }} />
              </div>
              <div style={{ fontSize: 11, color: budget.firstDeficitStep ? 'var(--red)' : 'var(--muted)', marginTop: 4 }}>
                {budget.firstDeficitStep
                  ? `не хватает с шага ${budget.firstDeficitStep} (минимум ${budget.lowest})`
                  : 'бюджета хватает на всю стройку'}
              </div>
            </div>
          ))}
        </div>

        {/* График баланса: столбик на каждый шаг стройки, красный — минус. */}
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 90, borderBottom: '1px solid var(--line)', paddingBottom: 2 }}>
          {timeline.map((step) => {
            const height2 = Math.max(2, Math.round((Math.abs(step.tier2After) / peak) * 38));
            const height3 = Math.max(2, Math.round((Math.abs(step.tier3After) / peak) * 38));
            const title = `${step.index}. ${step.nameRu} — ${step.bodyName || 'без тела'}\n`
              + `T2 после шага: ${step.tier2After}, T3: ${step.tier3After}\n`
              + `${step.cost > 0 ? `тратит ${step.cost} очк. T${step.costTier}` : 'очков не тратит'}`
              + `${step.gives > 0 ? `, даёт ${step.gives} очк. T${step.givesTier}` : ''}`;
            return (
              <button
                key={step.siteId}
                type="button"
                title={title}
                onClick={() => onSelectSite?.(step.siteId)}
                className="architect-chart-col"
                style={{
                  flex: '1 1 0', minWidth: 6, maxWidth: 34, background: 'transparent', border: 'none',
                  padding: 0, cursor: onSelectSite ? 'pointer' : 'default', display: 'flex',
                  flexDirection: 'column', justifyContent: 'flex-end', gap: 2, height: '100%',
                }}
              >
                <div
                  className="architect-chart-bar"
                  style={{
                    height: height3, width: '100%',
                    background: step.tier3After < 0 ? 'var(--red)' : 'var(--cyan)',
                    opacity: step.tier3After === 0 ? 0.25 : 1,
                  }}
                />
                <div
                  className="architect-chart-bar"
                  style={{
                    height: height2, width: '100%',
                    background: step.tier2After < 0 ? 'var(--red)' : 'var(--orange)',
                    opacity: step.tier2After === 0 ? 0.25 : 1,
                  }}
                />
                {step.primary && <div style={{ fontSize: 9, color: 'var(--orange)', textAlign: 'center' }}>★</div>}
              </button>
            );
          })}
        </div>
        <div style={{ display: 'flex', gap: 12, marginTop: 6, flexWrap: 'wrap', fontSize: 11, color: 'var(--muted)' }}>
          <Legend tone="var(--orange)" label="баланс T2" />
          <Legend tone="var(--cyan)" label="баланс T3" />
          <Legend tone="var(--red)" label="минус — очков не хватает" />
          <span>шагов: {timeline.length}</span>
        </div>
      </section>

      <section style={cardStyle}>
        <h3 style={titleStyle}>Тоннаж и рейсы</h3>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
          <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 22, color: 'var(--green)' }}>
            {formatTons(evaluation.haulTons)}
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {[400, 784, 25_000].map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setCapacity(value)}
                style={{ ...chipStyle, ...(capacity === value ? chipActive : {}) }}
                title={value === 25_000 ? 'Трюм авианосца' : value === 784 ? 'Каттер / Type-9 с полным трюмом' : 'Средний грузовик'}
              >
                {value.toLocaleString('ru-RU')} т
              </button>
            ))}
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            рейсов: <span style={{ color: 'var(--orange)', fontFamily: 'ui-monospace, monospace' }}>
              {haulTrips(evaluation.haulTons, capacity).toLocaleString('ru-RU')}
            </span>
          </div>
        </div>

        {cargo.items.length > 0 && (
          <>
            <StackedBar items={cargo.items.map((item, index) => ({
              key: item.key,
              percent: item.percent,
              tone: SHARE_TONES[index % SHARE_TONES.length],
              title: `${item.label}: ${formatTons(item.value)} (${item.percent} %)`,
            }))} />
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: '2px 12px', marginTop: 8 }}>
              {cargo.items.map((item, index) => (
                <div key={item.key} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                  <span style={{ width: 8, height: 8, background: SHARE_TONES[index % SHARE_TONES.length], flex: '0 0 auto' }} />
                  <span style={{ color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.label}</span>
                  <span style={{ marginLeft: 'auto', color: 'var(--muted)', fontFamily: 'ui-monospace, monospace' }}>
                    {formatTons(item.value)}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </section>

      <section style={cardStyle}>
        <h3 style={titleStyle}>Стадии и экономики</h3>
        <div style={labelStyle}>стадии построек</div>
        <StackedBar items={stages.filter((stage) => stage.count > 0).map((stage) => ({
          key: stage.status,
          percent: stage.percent,
          tone: STATUS_TONES[stage.status],
          title: `${stage.label}: ${stage.count} шт., ${formatTons(stage.tons)}`,
        }))} />
        <div style={{ display: 'flex', gap: 12, marginTop: 6, flexWrap: 'wrap', fontSize: 12 }}>
          {stages.map((stage) => (
            <span key={stage.status} style={{ color: 'var(--muted)' }}>
              <span style={{ display: 'inline-block', width: 8, height: 8, background: STATUS_TONES[stage.status], marginRight: 5 }} />
              {stage.label}: <span style={{ color: 'var(--text)' }}>{stage.count}</span>
              {stage.tons > 0 ? ` · ${formatTons(stage.tons)}` : ''}
            </span>
          ))}
        </div>

        {economies.length > 0 && (
          <>
            <div style={{ ...labelStyle, marginTop: 14 }}>экономики системы</div>
            <StackedBar items={economies.map((item, index) => ({
              key: item.key,
              percent: item.percent,
              tone: SHARE_TONES[index % SHARE_TONES.length],
              title: `${item.label}: ${item.value} построек (${item.percent} %)`,
            }))} />
            <div style={{ display: 'flex', gap: 12, marginTop: 6, flexWrap: 'wrap', fontSize: 12 }}>
              {economies.map((item, index) => (
                <span key={item.key} style={{ color: 'var(--muted)' }}>
                  <span style={{ display: 'inline-block', width: 8, height: 8, background: SHARE_TONES[index % SHARE_TONES.length], marginRight: 5 }} />
                  {item.label}: <span style={{ color: 'var(--text)' }}>{item.value}</span>
                </span>
              ))}
            </div>
          </>
        )}
      </section>

      <section style={cardStyle}>
        <h3 style={titleStyle}>Эффекты системы</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {effects.map((effect) => (
            <div key={effect.key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
              <span style={{ width: 130, color: 'var(--muted)' }}>{effect.label}</span>
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', height: 10 }}>
                <div style={{ flex: 1, display: 'flex', justifyContent: 'flex-end', paddingRight: 1 }}>
                  {!effect.positive && (
                    <div style={{ width: `${effect.magnitude}%`, height: 10, background: 'var(--red)' }} />
                  )}
                </div>
                <div style={{ width: 1, height: 12, background: 'var(--line)' }} />
                <div style={{ flex: 1, paddingLeft: 1 }}>
                  {effect.positive && effect.value !== 0 && (
                    <div style={{ width: `${effect.magnitude}%`, height: 10, background: 'var(--green)' }} />
                  )}
                </div>
              </div>
              <span style={{ width: 44, textAlign: 'right', fontFamily: 'ui-monospace, monospace', color: effect.value < 0 ? 'var(--red)' : effect.value > 0 ? 'var(--green)' : 'var(--muted)' }}>
                {effect.value > 0 ? `+${effect.value}` : effect.value}
              </span>
            </div>
          ))}
        </div>
      </section>

      {loads.length > 0 && (
        <section style={cardStyle}>
          <h3 style={titleStyle}>Загрузка тел</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {loads.map((load) => (
              <div key={load.name} style={{ fontSize: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{load.name}</span>
                  <span style={{ color: 'var(--muted)', fontFamily: 'ui-monospace, monospace', flex: '0 0 auto' }}>
                    {load.limit > 0 ? `${load.used}/${load.limit} назем.` : 'без наземных'}
                    {load.orbital > 0 ? ` · ${load.orbital} орбит.` : ''}
                  </span>
                </div>
                <div style={{ height: 5, border: '1px solid var(--line)', borderRadius: 3, overflow: 'hidden', marginTop: 3, background: 'var(--bg)' }}>
                  <div
                    style={{
                      height: '100%',
                      width: `${load.percent}%`,
                      background: load.percent >= 100 ? 'var(--red)' : load.percent > 70 ? 'var(--orange)' : 'var(--green)',
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function StackedBar({ items }: { items: { key: string; percent: number; tone: string; title: string }[] }) {
  return (
    <div style={{ display: 'flex', height: 12, border: '1px solid var(--line)', borderRadius: 3, overflow: 'hidden', background: 'var(--bg)' }}>
      {items.map((item) => (
        <div
          key={item.key}
          title={item.title}
          style={{ width: `${item.percent}%`, background: item.tone, minWidth: item.percent > 0 ? 2 : 0 }}
        />
      ))}
    </div>
  );
}

function Legend({ tone, label }: { tone: string; label: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      <span style={{ width: 8, height: 8, background: tone, display: 'inline-block' }} />
      {label}
    </span>
  );
}

const titleStyle: React.CSSProperties = {
  margin: '0 0 10px',
  fontSize: 12,
  letterSpacing: 1,
  textTransform: 'uppercase',
  color: 'var(--orange)',
  fontFamily: 'ui-monospace, monospace',
};

const labelStyle: React.CSSProperties = {
  fontSize: 10,
  letterSpacing: 1,
  textTransform: 'uppercase',
  color: 'var(--muted)',
  marginBottom: 5,
};
