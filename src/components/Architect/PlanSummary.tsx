'use client';

import { useMemo, useState } from 'react';
import { ECONOMY_LABELS_RU } from '@/lib/architect/catalogue';
import { cargoList, formatTons, getInstallation } from '@/lib/architect/planner';
import type { ArchitectPlan, PlanEvaluation, SystemEffectKey } from '@/lib/architect/types';

const EFFECT_LABELS: Record<SystemEffectKey, string> = {
  pop: 'население',
  mpop: 'предел населения',
  sec: 'безопасность',
  wealth: 'богатство',
  tech: 'технологии',
  sol: 'близость к Солнцу',
  dev: 'развитие',
};

const STATUS_LABELS = { plan: 'план', building: 'строится', complete: 'готово' } as const;

interface PlanSummaryProps {
  plan: ArchitectPlan;
  evaluation: PlanEvaluation;
}

export default function PlanSummary({ plan, evaluation }: PlanSummaryProps) {
  const [showAllCargo, setShowAllCargo] = useState(false);
  const [showAllUnlocks, setShowAllUnlocks] = useState(false);

  const cargo = useMemo(() => cargoList(evaluation), [evaluation]);
  const errors = evaluation.issues.filter((issue) => issue.level === 'error');
  const warnings = evaluation.issues.filter((issue) => issue.level === 'warning');
  const sitesById = useMemo(() => new Map(plan.sites.map((site) => [site.id, site])), [plan.sites]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <section style={cardStyle}>
        <h3 style={sectionTitle}>Сводка плана</h3>
        <div style={metricGrid}>
          <Metric label="построек" value={String(plan.sites.length)} />
          <Metric label="тоннаж" value={formatTons(evaluation.haulTons)} />
          <Metric label="оценка системы" value={String(evaluation.score)} />
          <Metric
            label="ошибок"
            value={String(errors.length)}
            tone={errors.length > 0 ? 'var(--red)' : 'var(--green)'}
          />
        </div>

        <div style={{ marginTop: 12, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <TierBadge
            tier="T2"
            free={evaluation.tierPoints.tier2}
            spent={evaluation.tierSpent.tier2}
            given={evaluation.tierGiven.tier2}
          />
          <TierBadge
            tier="T3"
            free={evaluation.tierPoints.tier3}
            spent={evaluation.tierSpent.tier3}
            given={evaluation.tierGiven.tier3}
          />
        </div>

        {evaluation.portCosts.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <div style={subTitle}>Стоимость портов</div>
            {evaluation.portCosts.map((port, index) => {
              const installation = getInstallation(port.installationId);
              return (
                <div key={port.siteId} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--muted)' }}>
                  <span>
                    {index + 1}. {installation?.nameRu ?? port.installationId}
                    {index === 0 ? ' (первый порт — бесплатно)' : ''}
                  </span>
                  <span style={{ color: port.taxed ? 'var(--orange)' : 'var(--text)' }}>
                    {port.cost > 0 ? `${port.cost} очк. T${port.tier}` : '—'}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {(errors.length > 0 || warnings.length > 0) && (
        <section style={cardStyle}>
          <h3 style={sectionTitle}>Замечания</h3>
          {errors.map((issue, index) => (
            <div key={`e${index}`} style={{ color: 'var(--red)', fontSize: 12, marginBottom: 4 }}>
              ✕ {issue.message}
            </div>
          ))}
          {warnings.map((issue, index) => (
            <div key={`w${index}`} style={{ color: 'var(--orange)', fontSize: 12, marginBottom: 4 }}>
              ! {issue.message}
            </div>
          ))}
        </section>
      )}

      <section style={cardStyle}>
        <h3 style={sectionTitle}>Порядок стройки</h3>
        {evaluation.order.length === 0 && (
          <div style={{ color: 'var(--muted)', fontSize: 13 }}>Добавьте постройки — порядок посчитается сам.</div>
        )}
        <ol style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: 'var(--text)' }}>
          {evaluation.order.map((siteId) => {
            const site = sitesById.get(siteId);
            const installation = site ? getInstallation(site.installationId) : null;
            if (!site || !installation) return null;
            return (
              <li key={siteId} style={{ marginBottom: 4 }}>
                {installation.nameRu}
                <span style={{ color: 'var(--muted)', fontSize: 12 }}>
                  {' · '}
                  {site.bodyName} · {formatTons(installation.haulTons)} · {STATUS_LABELS[site.status]}
                </span>
              </li>
            );
          })}
        </ol>
      </section>

      <section style={cardStyle}>
        <h3 style={sectionTitle}>Грузы ({cargo.length})</h3>
        {(showAllCargo ? cargo : cargo.slice(0, 10)).map((item) => (
          <div key={item.key} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--muted)' }}>
            <span style={{ color: 'var(--text)' }}>{item.label}</span>
            <span>{formatTons(item.tons)}</span>
          </div>
        ))}
        {cargo.length > 10 && (
          <button type="button" style={linkButton} onClick={() => setShowAllCargo((value) => !value)}>
            {showAllCargo ? 'Свернуть' : `Показать все (${cargo.length})`}
          </button>
        )}
      </section>

      <section style={cardStyle}>
        <h3 style={sectionTitle}>Эффекты на систему</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 6 }}>
          {(Object.keys(EFFECT_LABELS) as SystemEffectKey[]).map((key) => {
            const value = evaluation.effects[key];
            return (
              <div key={key} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                <span style={{ color: 'var(--muted)' }}>{EFFECT_LABELS[key]}</span>
                <span style={{ color: value > 0 ? 'var(--green)' : value < 0 ? 'var(--red)' : 'var(--text)' }}>
                  {value > 0 ? `+${value}` : value}
                </span>
              </div>
            );
          })}
        </div>
        {Object.keys(evaluation.economies).length > 0 && (
          <div style={{ marginTop: 10, fontSize: 12, color: 'var(--muted)' }}>
            Экономики:{' '}
            {Object.entries(evaluation.economies)
              .map(([economy, count]) => `${ECONOMY_LABELS_RU[economy as keyof typeof ECONOMY_LABELS_RU] ?? economy} ×${count}`)
              .join(', ')}
          </div>
        )}
      </section>

      <section style={cardStyle}>
        <h3 style={sectionTitle}>Что открывает система</h3>
        {(showAllUnlocks ? evaluation.unlocks : evaluation.unlocks.filter((unlock) => unlock.satisfied)).map((unlock) => (
          <div
            key={unlock.id}
            style={{ fontSize: 12, color: unlock.satisfied ? 'var(--green)' : 'var(--muted)', marginBottom: 3 }}
          >
            {unlock.satisfied ? '✓' : '·'} {unlock.label}
          </div>
        ))}
        {!showAllUnlocks && evaluation.unlocks.some((unlock) => !unlock.satisfied) && (
          <button type="button" style={linkButton} onClick={() => setShowAllUnlocks(true)}>
            Показать недостроенное
          </button>
        )}
        {showAllUnlocks && (
          <button type="button" style={linkButton} onClick={() => setShowAllUnlocks(false)}>
            Только открытое
          </button>
        )}
      </section>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div style={{ background: 'var(--bg)', border: '1px solid var(--line)', borderRadius: 3, padding: '6px 10px' }}>
      <div style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 1 }}>{label}</div>
      <div style={{ fontSize: 16, color: tone ?? 'var(--text)', fontFamily: 'ui-monospace, monospace' }}>{value}</div>
    </div>
  );
}

function TierBadge({ tier, free, spent, given }: { tier: string; free: number; spent: number; given: number }) {
  return (
    <div
      style={{
        flex: '1 1 140px',
        border: `1px solid ${free < 0 ? 'var(--red)' : 'var(--line)'}`,
        borderRadius: 3,
        padding: '6px 10px',
        background: 'var(--bg)',
      }}
    >
      <div style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 1 }}>
        Очки {tier}
      </div>
      <div style={{ fontSize: 18, color: free < 0 ? 'var(--red)' : 'var(--text)', fontFamily: 'ui-monospace, monospace' }}>
        {free > 0 ? `+${free}` : free}
      </div>
      <div style={{ fontSize: 11, color: 'var(--muted)' }}>тратим {spent} · получаем {given}</div>
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  background: 'var(--panel)',
  border: '1px solid var(--line)',
  borderRadius: 4,
  padding: 14,
};

const sectionTitle: React.CSSProperties = {
  margin: '0 0 10px',
  fontSize: 12,
  letterSpacing: 1,
  textTransform: 'uppercase',
  color: 'var(--orange)',
  fontFamily: 'ui-monospace, monospace',
};

const subTitle: React.CSSProperties = {
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: 1,
  color: 'var(--muted)',
  marginBottom: 4,
};

const metricGrid: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))',
  gap: 8,
};

const linkButton: React.CSSProperties = {
  marginTop: 8,
  background: 'transparent',
  border: 'none',
  color: 'var(--cyan)',
  cursor: 'pointer',
  fontSize: 12,
  padding: 0,
};
