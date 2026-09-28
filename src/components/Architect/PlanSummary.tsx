'use client';

import { useMemo, useState } from 'react';
import { ECONOMY_LABELS_RU, installationLinks } from '@/lib/architect/catalogue';
import {
  BODY_TRAIT_LABELS_RU,
  ECONOMY_AFFINITY,
  ECONOMY_MARKET,
  type BodyTrait,
} from '@/lib/architect/economy';
import { cargoList, commodityLabel, formatTons, getInstallation, siteCargo } from '@/lib/architect/planner';
import type { ArchitectPlan, PlanEvaluation, SystemEconomy, SystemEffectKey } from '@/lib/architect/types';

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
  /** Клик по порту без пометки — быстро назначить его основным портом. */
  onMarkPrimary?: (siteId: string) => void;
}

export default function PlanSummary({ plan, evaluation, onMarkPrimary }: PlanSummaryProps) {
  const [showAllCargo, setShowAllCargo] = useState(false);
  const [showAllUnlocks, setShowAllUnlocks] = useState(false);
  const [showPrimaryCargo, setShowPrimaryCargo] = useState(false);
  const [showEconomyRef, setShowEconomyRef] = useState(false);

  // Экономики плана в порядке убывания числа построек — для блока «рынки».
  const planEconomies = useMemo(() => (
    (Object.entries(evaluation.economies) as [SystemEconomy, number][])
      .filter(([economy]) => economy !== 'none')
      .sort((left, right) => right[1] - left[1])
      .map(([economy, count]) => ({ economy, count }))
  ), [evaluation.economies]);

  // Уникальные постройки плана и их связи (предшественники → постройка → что открывает).
  const buildingLinks = useMemo(() => {
    const counts = new Map<string, number>();
    for (const site of plan.sites) counts.set(site.installationId, (counts.get(site.installationId) ?? 0) + 1);
    const installedIds = new Set(plan.sites.map((site) => site.installationId));
    return [...counts.entries()]
      .map(([id, count]) => {
        const installation = getInstallation(id);
        const links = installationLinks(id);
        const hasPreReq = links.requires.length === 0
          || links.requires.every((req) => req.options.some((option) => installedIds.has(option.id)));
        return { id, nameRu: installation?.nameRu ?? id, count, links, hasPreReq };
      })
      // В граф попадают только постройки, у которых есть хоть какая-то связь.
      .filter((entry) => entry.links.requires.length > 0 || entry.links.enables.length > 0)
      .sort((left, right) => left.nameRu.localeCompare(right.nameRu));
  }, [plan.sites]);

  const cargo = useMemo(() => cargoList(evaluation), [evaluation]);
  const errors = evaluation.issues.filter((issue) => issue.level === 'error');
  const warnings = evaluation.issues.filter((issue) => issue.level === 'warning');
  const sitesById = useMemo(() => new Map(plan.sites.map((site) => [site.id, site])), [plan.sites]);

  const primaryPort = evaluation.primaryPort;
  const primaryInstallation = primaryPort ? getInstallation(primaryPort.installationId) : null;
  const primaryCargoList = useMemo(() => (
    primaryInstallation?.primary
      ? Object.entries(primaryInstallation.primary.cargo)
        .sort((left, right) => right[1] - left[1])
        .map(([key, tons]) => ({ key, label: commodityLabel(key), tons }))
      : []
  ), [primaryInstallation]);
  const portsWithoutPrimary = useMemo(() => (
    onMarkPrimary
      ? plan.sites.filter((site) => {
        const buildClass = getInstallation(site.installationId)?.buildClass;
        return !site.primary && (buildClass === 'starport' || buildClass === 'outpost');
      })
      : []
  ), [plan.sites, onMarkPrimary]);

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
                    {port.siteId === primaryPort?.siteId ? ' ★ основной — бесплатно' : ''}
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

      <section style={{ ...cardStyle, borderColor: primaryPort ? 'var(--orange)' : 'var(--line)' }}>
        <h3 style={{ ...sectionTitle, color: 'var(--orange)' }}>★ Основной порт</h3>
        {primaryPort && primaryInstallation ? (
          <>
            <div style={{ fontSize: 14, color: 'var(--text)' }}>
              {primaryInstallation.nameRu}
              <span style={{ color: 'var(--muted)', fontSize: 12 }}> — {primaryPort.bodyName}</span>
            </div>
            <div style={{ marginTop: 4, fontSize: 12, color: 'var(--muted)' }}>
              экономика системы: {ECONOMY_LABELS_RU[primaryPort.economy] ?? primaryPort.economy}
              {' · '}
              материалов: {primaryPort.approximate ? '≈ ' : ''}{formatTons(primaryPort.tons)}
              {' · '}очков системы не тратит
            </div>
            <div style={{ marginTop: 6, fontSize: 11, color: 'var(--muted)' }}>{primaryInstallation.primary?.note}</div>
            {primaryCargoList.length > 0 && (
              <>
                <button type="button" style={linkButton} onClick={() => setShowPrimaryCargo((value) => !value)}>
                  {showPrimaryCargo ? 'Свернуть материалы' : `Материалы основного порта (${primaryCargoList.length})`}
                </button>
                {showPrimaryCargo && (
                  <div style={{ marginTop: 6, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '2px 10px', fontSize: 12 }}>
                    {primaryCargoList.map((item) => (
                      <div key={item.key} style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
                        <span style={{ color: 'var(--text)' }}>{item.label}</span>
                        <span style={{ color: 'var(--muted)' }}>{formatTons(item.tons)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </>
        ) : (
          <>
            <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}>
              Основной порт не отмечен. Первый порт новой колонии строится с колониального корабля:
              он не тратит очки системы, но требует больше материалов. Если система уже колонизирована —
              основной порт в плане не нужен.
            </div>
            {portsWithoutPrimary.length > 0 && onMarkPrimary && (
              <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {portsWithoutPrimary.map((site) => {
                  const installation = getInstallation(site.installationId);
                  return (
                    <button
                      key={site.id}
                      type="button"
                      onClick={() => onMarkPrimary(site.id)}
                      style={{ ...chipStyle, borderColor: 'var(--orange)', color: 'var(--orange)' }}
                    >
                      ★ {installation?.nameRu ?? site.installationId}
                    </button>
                  );
                })}
              </div>
            )}
          </>
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
            const tons = siteCargo(site)?.haulTons ?? installation.haulTons;
            return (
              <li key={siteId} style={{ marginBottom: 4 }}>
                {site.primary ? <span style={{ color: 'var(--orange)' }}>★ </span> : null}
                {installation.nameRu}
                <span style={{ color: 'var(--muted)', fontSize: 12 }}>
                  {' · '}
                  {site.bodyName || <span style={{ color: 'var(--orange)' }}>тело не задано</span>}
                  {' · '}{formatTons(tons)} · {STATUS_LABELS[site.status]}
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

      {planEconomies.length > 0 && (
        <section style={cardStyle}>
          <h3 style={sectionTitle}>Экономики и торговые рынки</h3>
          <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 0, marginBottom: 10 }}>
            Что рынки системы будут продавать и покупать. Ассортимент станции плавает — это ориентир
            для перевозчиков, а не точный прайс.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {planEconomies.map(({ economy, count }) => {
              const market = ECONOMY_MARKET[economy];
              const affinity = ECONOMY_AFFINITY[economy];
              return (
                <div key={economy} style={{ borderLeft: '2px solid var(--line)', paddingLeft: 10 }}>
                  <div style={{ fontSize: 13, color: 'var(--text)', fontWeight: 600 }}>
                    {ECONOMY_LABELS_RU[economy]} <span style={{ color: 'var(--muted)', fontWeight: 400 }}>×{count}</span>
                  </div>
                  {market.produces.length > 0 && (
                    <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                      <span style={{ color: 'var(--green)' }}>продаёт:</span> {market.produces.join(', ')}
                    </div>
                  )}
                  {market.imports.length > 0 && (
                    <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                      <span style={{ color: 'var(--cyan)' }}>ввозит:</span> {market.imports.join(', ')}
                    </div>
                  )}
                  {affinity.bodyDependent && affinity.boost.length > 0 && (
                    <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 3, fontStyle: 'italic' }}>
                      усиливается телом: {affinity.boost.map((trait: BodyTrait) => BODY_TRAIT_LABELS_RU[trait]).join(', ')}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {buildingLinks.length > 0 && (
        <section style={cardStyle}>
          <h3 style={sectionTitle}>Связи построек</h3>
          <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 0, marginBottom: 10 }}>
            Цепочки зависимостей: что нужно построить раньше (предшественники) и что постройка
            открывает системе.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {buildingLinks.map(({ id, nameRu, count, links, hasPreReq }) => (
              <div
                key={id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  flexWrap: 'wrap',
                  fontSize: 12,
                  border: '1px solid var(--line)',
                  borderRadius: 3,
                  padding: '6px 9px',
                  background: 'var(--bg)',
                }}
              >
                {links.requires.length > 0 && (
                  <>
                    <span
                      style={{
                        color: hasPreReq ? 'var(--green)' : 'var(--red)',
                        maxWidth: 220,
                      }}
                      title={hasPreReq ? 'Предшественник есть в плане' : 'Предшественника нет в плане'}
                    >
                      {hasPreReq ? '✓ ' : '✗ '}
                      {links.requires.map((req) => req.label).join(' / ')}
                    </span>
                    <span style={{ color: 'var(--muted)' }}>→</span>
                  </>
                )}
                <span style={{ color: 'var(--text)', fontWeight: 600 }}>
                  {nameRu}{count > 1 ? ` ×${count}` : ''}
                </span>
                {links.enables.length > 0 && (
                  <>
                    <span style={{ color: 'var(--muted)' }}>→</span>
                    <span style={{ color: 'var(--cyan)' }}>
                      открывает: {links.enables.map((enable) => shortEnableLabel(enable.label)).join(', ')}
                    </span>
                  </>
                )}
                {links.requires.length === 0 && links.enables.length === 0 && (
                  <span style={{ color: 'var(--muted)' }}>самостоятельная постройка</span>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      <section style={cardStyle}>
        <button
          type="button"
          onClick={() => setShowEconomyRef((value) => !value)}
          style={{ ...sectionTitle, background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center', gap: 6 }}
        >
          Справочник: экономики и тела {showEconomyRef ? '▾' : '▸'}
        </button>
        {showEconomyRef && (
          <div style={{ overflowX: 'auto', marginTop: 8 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ color: 'var(--muted)', textAlign: 'left' }}>
                  <th style={refCell}>Экономика</th>
                  <th style={refCell}>Усиливается на телах</th>
                  <th style={refCell}>Зависит от тела</th>
                </tr>
              </thead>
              <tbody>
                {(Object.keys(ECONOMY_AFFINITY) as SystemEconomy[])
                  .filter((economy) => economy !== 'none')
                  .map((economy) => {
                    const affinity = ECONOMY_AFFINITY[economy];
                    return (
                      <tr key={economy} style={{ borderTop: '1px solid var(--line)' }}>
                        <td style={{ ...refCell, color: 'var(--text)' }}>{ECONOMY_LABELS_RU[economy]}</td>
                        <td style={{ ...refCell, color: 'var(--muted)' }}>
                          {affinity.boost.length > 0
                            ? affinity.boost.map((trait) => BODY_TRAIT_LABELS_RU[trait]).join(', ')
                            : '—'}
                        </td>
                        <td style={{ ...refCell, color: affinity.bodyDependent ? 'var(--orange)' : 'var(--muted)' }}>
                          {affinity.bodyDependent ? 'да' : 'нет'}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
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

/** Сокращаем длинные подписи «открывает» — в скобках у них пояснение «нужен …». */
function shortEnableLabel(label: string): string {
  const cut = label.indexOf(' (');
  return cut > 0 ? label.slice(0, cut) : label;
}

const cardStyle: React.CSSProperties = {
  background: 'var(--panel)',
  border: '1px solid var(--line)',
  borderRadius: 4,
  padding: 14,
};

const refCell: React.CSSProperties = {
  padding: '5px 8px',
  verticalAlign: 'top',
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

const chipStyle: React.CSSProperties = {
  background: 'transparent',
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: 'var(--line)',
  color: 'var(--muted)',
  padding: '3px 9px',
  borderRadius: 3,
  cursor: 'pointer',
  fontSize: 12,
};
