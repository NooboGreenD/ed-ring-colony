'use client';

/**
 * Табличный вид плана — второй способ смотреть на систему, как в Raven Colonial
 * («Map» / «Table»). Карточки тел удобны, когда правишь одно тело; таблица —
 * когда надо окинуть взглядом весь план: порядок стройки, очки, тоннаж, факт.
 *
 * Таблица ничего не считает сама: строки приходят из плана, порядок — из
 * `evaluation.timeline`, факт — из отчёта прогресса. Любая строка кликабельна
 * (открывает редактор записи), статус переключается прямо в таблице.
 */

import { useMemo, useState } from 'react';
import { formatTons, getInstallation, siteCargo } from '@/lib/architect/planner';
import type { SiteProgress } from '@/lib/architect/progress';
import type {
  ArchitectPlan,
  PlanEvaluation,
  PlannedSite,
  PlannedSiteStatus,
} from '@/lib/architect/types';
import { cardStyle, chipActive, chipStyle, mutedText, tdStyle, thStyle } from '@/components/Architect/panelStyles';

type SortKey = 'order' | 'name' | 'body' | 'tier' | 'tons' | 'status';

const STATUS_LABELS: Record<PlannedSiteStatus, string> = { plan: 'план', building: 'строится', complete: 'готово' };
const STATUS_TONES: Record<PlannedSiteStatus, string> = { plan: 'var(--muted)', building: 'var(--cyan)', complete: 'var(--green)' };
const STATUS_ORDER: PlannedSiteStatus[] = ['plan', 'building', 'complete'];

interface SiteTableProps {
  plan: ArchitectPlan;
  evaluation: PlanEvaluation;
  progressBySite: Map<string, SiteProgress>;
  /** Имена тел, которые есть в загруженном каталоге, — остальные помечаются. */
  knownBodyNames: Set<string>;
  flashIds?: string[];
  onEdit: (siteId: string) => void;
  onRemove: (siteId: string) => void;
  onCycle: (siteId: string, status: PlannedSiteStatus) => void;
  onTogglePrimary: (siteId: string) => void;
}

export default function SiteTable({
  plan,
  evaluation,
  progressBySite,
  knownBodyNames,
  flashIds = [],
  onEdit,
  onRemove,
  onCycle,
  onTogglePrimary,
}: SiteTableProps) {
  const [sort, setSort] = useState<SortKey>('order');
  const [query, setQuery] = useState('');

  const orderIndex = useMemo(
    () => new Map(evaluation.timeline.map((step) => [step.siteId, step.index])),
    [evaluation.timeline],
  );

  const rows = useMemo(() => {
    const text = query.trim().toLocaleLowerCase();
    const list = plan.sites
      .map((site) => {
        const installation = getInstallation(site.installationId);
        const cargo = siteCargo(site);
        return {
          site,
          installation,
          tons: cargo?.haulTons ?? installation?.haulTons ?? 0,
          order: orderIndex.get(site.id) ?? 999,
          progress: progressBySite.get(site.id) ?? null,
        };
      })
      .filter((row) => {
        if (!text) return true;
        return `${row.installation?.nameRu ?? row.site.installationId} ${row.site.bodyName} ${row.site.note ?? ''}`
          .toLocaleLowerCase()
          .includes(text);
      });

    const compare: Record<SortKey, (a: typeof list[number], b: typeof list[number]) => number> = {
      order: (a, b) => a.order - b.order,
      name: (a, b) => (a.installation?.nameRu ?? '').localeCompare(b.installation?.nameRu ?? '', 'ru'),
      body: (a, b) => a.site.bodyName.localeCompare(b.site.bodyName, 'ru'),
      tier: (a, b) => (b.installation?.tier ?? 0) - (a.installation?.tier ?? 0),
      tons: (a, b) => b.tons - a.tons,
      status: (a, b) => STATUS_ORDER.indexOf(a.site.status) - STATUS_ORDER.indexOf(b.site.status),
    };
    return [...list].sort(compare[sort]);
  }, [plan.sites, query, sort, orderIndex, progressBySite]);

  const totals = useMemo(() => ({
    tons: rows.reduce((sum, row) => sum + row.tons, 0),
    sites: rows.length,
  }), [rows]);

  if (plan.sites.length === 0) {
    return (
      <section style={cardStyle}>
        <div style={mutedText}>План пуст: добавьте постройки на карточках тел или перенесите существующую застройку.</div>
      </section>
    );
  }

  return (
    <section style={cardStyle}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Поиск по постройкам, телам, заметкам"
          aria-label="Поиск по плану"
          style={{
            flex: '1 1 220px', margin: 0, background: 'var(--bg)', border: '1px solid var(--line)',
            color: 'var(--text)', padding: '7px 10px', borderRadius: 3, fontSize: 13,
          }}
        />
        {(['order', 'name', 'body', 'tier', 'tons', 'status'] as SortKey[]).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setSort(key)}
            style={{ ...chipStyle, ...(sort === key ? chipActive : {}) }}
          >
            {key === 'order' ? 'по порядку'
              : key === 'name' ? 'по названию'
                : key === 'body' ? 'по телу'
                  : key === 'tier' ? 'по тиру'
                    : key === 'tons' ? 'по тоннажу' : 'по статусу'}
          </button>
        ))}
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr>
              <th style={{ ...thStyle, width: 34 }}>#</th>
              <th style={thStyle}>постройка</th>
              <th style={thStyle}>тело</th>
              <th style={{ ...thStyle, width: 74 }}>место</th>
              <th style={{ ...thStyle, width: 96 }}>очки</th>
              <th style={{ ...thStyle, width: 90 }}>тоннаж</th>
              <th style={{ ...thStyle, width: 96 }}>факт</th>
              <th style={{ ...thStyle, width: 200 }}>действия</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ site, installation, tons, order, progress }) => {
              const unknownBody = knownBodyNames.size > 0
                && Boolean(site.bodyName)
                && !knownBodyNames.has(site.bodyName);
              const flash = flashIds.includes(site.id);
              return (
                <tr
                  key={site.id}
                  className={flash ? 'architect-flash' : undefined}
                  style={{ background: site.primary ? 'rgba(230,126,34,.07)' : undefined }}
                >
                  <td style={{ ...tdStyle, color: 'var(--muted)', fontFamily: 'ui-monospace, monospace' }}>{order}</td>
                  <td style={tdStyle}>
                    <button
                      type="button"
                      onClick={() => onEdit(site.id)}
                      style={{
                        background: 'transparent', border: 'none', padding: 0, margin: 0, cursor: 'pointer',
                        color: 'var(--text)', fontSize: 12, textAlign: 'left',
                      }}
                    >
                      {site.primary && <span style={{ color: 'var(--orange)' }} title="Основной порт">★ </span>}
                      {installation?.nameRu ?? site.installationId}
                    </button>
                    <div style={{ fontSize: 10, color: 'var(--muted)' }}>
                      T{installation?.tier ?? '?'} · {installation?.id ?? '—'}
                      {site.note ? ` · ${site.note}` : ''}
                    </div>
                  </td>
                  <td style={tdStyle}>
                    <span style={{ color: unknownBody ? 'var(--orange)' : 'var(--text)' }}>
                      {site.bodyName || <span style={{ color: 'var(--red)' }}>тело не задано</span>}
                    </span>
                    {unknownBody && (
                      <div style={{ fontSize: 10, color: 'var(--orange)' }} title="Тела нет в загруженных данных системы">
                        вне каталога тел
                      </div>
                    )}
                  </td>
                  <td style={{ ...tdStyle, color: 'var(--muted)' }}>
                    {installation?.location === 'surface' ? 'поверхн.' : 'орбита'}
                  </td>
                  <td style={{ ...tdStyle, color: 'var(--muted)', fontFamily: 'ui-monospace, monospace' }}>
                    {site.primary
                      ? <span style={{ color: 'var(--green)' }}>0 (осн.)</span>
                      : installation && installation.needs.count > 0
                        ? `−${installation.needs.count} T${installation.needs.tier}`
                        : '—'}
                    {installation && installation.gives.count > 0 && installation.gives.tier > 1 && (
                      <span style={{ color: 'var(--green)' }}> +{installation.gives.count} T{installation.gives.tier}</span>
                    )}
                  </td>
                  <td style={{ ...tdStyle, fontFamily: 'ui-monospace, monospace' }}>{formatTons(tons)}</td>
                  <td style={tdStyle}>
                    {progress?.actual ? (
                      <>
                        <div style={{ height: 5, border: '1px solid var(--line)', borderRadius: 3, overflow: 'hidden', background: 'var(--bg)' }}>
                          <div style={{
                            height: '100%',
                            width: `${Math.max(0, Math.min(100, progress.progress ?? 0))}%`,
                            background: progress.actual.complete ? 'var(--green)' : 'var(--orange)',
                          }}
                          />
                        </div>
                        <span style={{ fontSize: 10, color: 'var(--muted)' }}>
                          {Math.round(progress.progress ?? 0)} %
                        </span>
                      </>
                    ) : <span style={{ color: 'var(--muted)' }}>—</span>}
                  </td>
                  <td style={tdStyle}>
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      <button
                        type="button"
                        onClick={() => onCycle(site.id, STATUS_ORDER[(STATUS_ORDER.indexOf(site.status) + 1) % STATUS_ORDER.length])}
                        style={{ ...miniButton, color: STATUS_TONES[site.status], borderColor: STATUS_TONES[site.status] }}
                      >
                        {STATUS_LABELS[site.status]}
                      </button>
                      {installation?.primary && (
                        <button
                          type="button"
                          onClick={() => onTogglePrimary(site.id)}
                          style={{ ...miniButton, ...(site.primary ? { color: 'var(--orange)', borderColor: 'var(--orange)' } : {}) }}
                          title="Основной порт системы"
                        >
                          {site.primary ? '★' : '☆'}
                        </button>
                      )}
                      <button type="button" onClick={() => onEdit(site.id)} style={miniButton}>изменить</button>
                      <button type="button" onClick={() => onRemove(site.id)} style={{ ...miniButton, color: 'var(--red)' }}>×</button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td style={{ ...tdStyle, borderBottom: 'none' }} />
              <td style={{ ...tdStyle, borderBottom: 'none', color: 'var(--muted)' }} colSpan={4}>
                построек: {totals.sites}
              </td>
              <td style={{ ...tdStyle, borderBottom: 'none', fontFamily: 'ui-monospace, monospace', color: 'var(--green)' }}>
                {formatTons(totals.tons)}
              </td>
              <td style={{ ...tdStyle, borderBottom: 'none' }} colSpan={2} />
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}

const miniButton: React.CSSProperties = {
  background: 'transparent',
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: 'var(--line)',
  color: 'var(--muted)',
  padding: '2px 6px',
  borderRadius: 3,
  cursor: 'pointer',
  fontSize: 11,
  margin: 0,
};
