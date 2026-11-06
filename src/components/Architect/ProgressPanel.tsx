'use client';

/**
 * Фактический прогресс стройплощадок.
 *
 * Данные приходят из `/api/systems/progress?name=<система>` (там же, где их
 * читает остальной сайт), разбираются `parseActualSites` и сопоставляются с
 * планом функцией `matchProgress`. Отчёт честно различает три случая:
 * стройка найдена и идёт, стройки нет, и данных нет вообще — выдумывать 0 %
 * при недоступном источнике нельзя.
 */

import { getInstallation, formatTons } from '@/lib/architect/planner';
import type { ProgressReport, SiteProgress } from '@/lib/architect/progress';
import { useI18n } from '@/lib/i18n/I18nContext';
import {
  barTrack,
  cardStyle,
  errorText,
  ghostButton,
  mutedText,
  rowStyle,
  sectionTitle,
  tdStyle,
  thStyle,
} from '@/components/Architect/panelStyles';

const MATCH_LABELS: Record<SiteProgress['matchKind'], string> = {
  exact: 'prg.matchExact',
  type: 'prg.matchType',
  body: 'prg.matchBody',
  none: 'prg.matchNone',
};

function ProgressRow({ entry }: { entry: SiteProgress }) {
  const { t, locale } = useI18n();
  const installation = getInstallation(entry.site.installationId);
  const percent = entry.progress == null ? null : Math.max(0, Math.min(100, entry.progress));
  const percentLabel = percent == null ? '—' : `${percent.toLocaleString(locale)} %`;
  const tonsLabel = entry.deliveredTons != null && entry.requiredTons != null
    ? t('prg.tonsOf', { delivered: formatTons(entry.deliveredTons), required: formatTons(entry.requiredTons) })
    : entry.deliveredTons != null
      ? t('prg.delivered', { tons: formatTons(entry.deliveredTons) })
      : entry.requiredTons != null
        ? t('prg.required', { tons: formatTons(entry.requiredTons) })
        : t('prg.tonsUnknown');

  return (
    <tr>
      <td style={tdStyle}>
        <div style={{ fontSize: 12, color: 'var(--text)' }}>{installation?.nameRu ?? entry.site.installationId}</div>
        <div style={{ fontSize: 11, color: 'var(--muted)' }}>
          {entry.site.bodyName} · {t(MATCH_LABELS[entry.matchKind])}
        </div>
        {entry.mismatch && <div style={{ fontSize: 11, color: 'var(--orange)' }}>{entry.mismatch}</div>}
      </td>
      <td style={{ ...tdStyle, width: 130 }}>
        <div style={barTrack}>
          <div
            style={{
              height: '100%',
              width: `${percent ?? 0}%`,
              background: entry.actual?.complete ? 'var(--green)' : 'var(--orange)',
            }}
          />
        </div>
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 3 }}>{percentLabel}</div>
      </td>
      <td style={{ ...tdStyle, width: 120, fontSize: 11, color: 'var(--muted)' }}>{tonsLabel}</td>
    </tr>
  );
}

interface ProgressPanelProps {
  systemName: string;
  report: ProgressReport | null;
  telemetry?: { available: boolean; snapshots: number; latestAt: string | null } | null;
  loading: boolean;
  error: string;
  /** Откуда данные: 'raven' — из API, '' — ещё не запрашивали. */
  source: string;
  onRefresh: () => void;
}

export default function ProgressPanel({ systemName, report, telemetry, loading, error, source, onRefresh }: ProgressPanelProps) {
  const { t, locale } = useI18n();
  const totals = report?.totals ?? null;
  const totalPercent = totals?.progress == null ? null : Math.max(0, Math.min(100, totals.progress));
  const started = report ? report.sites.filter((entry) => entry.actual !== null) : [];

  return (
    <section style={cardStyle}>
      <div style={rowStyle}>
        <h3 style={sectionTitle}>{t('prg.title')}</h3>
        <button type="button" onClick={onRefresh} disabled={loading} style={ghostButton}>
          {loading ? t('prg.updating') : t('prg.refresh')}
        </button>
      </div>
      <div style={{ ...mutedText, marginTop: 4 }}>
        {systemName ? t('prg.sitesOfSystem', { name: systemName }) : t('prg.loadSystemFirst')}
        {source ? t('prg.source', { source }) : ''}
      </div>
      {telemetry?.available ? (
        <div style={{ marginTop: 8, padding: '7px 9px', border: '1px solid rgba(46,204,113,.35)', background: 'rgba(46,204,113,.06)', borderRadius: 4, fontSize: 11, color: 'var(--green)' }}>
          <strong>{t('prg.dualActive')}</strong> · {t('prg.dualBody', { count: telemetry.snapshots })}
          {telemetry.latestAt ? t('prg.journal', { at: new Date(telemetry.latestAt).toLocaleString(locale) }) : ''}
        </div>
      ) : (
        <div style={{ marginTop: 8, fontSize: 11, color: 'var(--muted)' }}>
          {t('prg.noSnapshots')}
        </div>
      )}

      {error && <div style={{ ...errorText, marginTop: 8 }}>{error}</div>}

      {!report && !error && (
        <div style={{ ...mutedText, marginTop: 8 }}>
          {t('prg.refreshHint')}
        </div>
      )}

      {report && (
        <>
          {totalPercent == null ? (
            <div style={{ ...mutedText, marginTop: 8 }}>
              {started.length > 0
                ? t('prg.sitesNoTons')
                : t('prg.sitesNone')}
            </div>
          ) : (
            <div style={{ marginTop: 10 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                <span style={{ fontSize: 20, color: 'var(--cyan)', fontFamily: 'ui-monospace, monospace' }}>
                  {totalPercent.toLocaleString(locale)} %
                </span>
                <span style={mutedText}>
                  {totals?.provided != null && totals?.required != null
                    ? t('prg.tonsOf', { delivered: formatTons(totals.provided), required: formatTons(totals.required) })
                    : t('prg.tonsProgress')}
                </span>
              </div>
              <div style={{ ...barTrack, marginTop: 6 }}>
                <div style={{ height: '100%', width: `${totalPercent}%`, background: 'var(--cyan)' }} />
              </div>
            </div>
          )}

          {report.matchedCount > 0 && (
            <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 10 }}>
              <thead>
                <tr>
                  <th style={thStyle}>{t('prg.thBuild')}</th>
                  <th style={thStyle}>{t('prg.thProgress')}</th>
                  <th style={thStyle}>{t('prg.thTons')}</th>
                </tr>
              </thead>
              <tbody>
                {report.sites.filter((entry) => entry.actual !== null).map((entry) => (
                  <ProgressRow key={entry.siteId} entry={entry} />
                ))}
              </tbody>
            </table>
          )}

          {report.unplanned.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div style={{ ...mutedText, textTransform: 'uppercase', letterSpacing: 1, fontSize: 11 }}>
                {t('prg.unplanned')}
              </div>
              {report.unplanned.map((site) => (
                <div key={site.buildId} style={{ fontSize: 12, color: 'var(--text)', marginTop: 4 }}>
                  {site.name}
                  <span style={mutedText}>
                    {site.buildType ? ` · ${site.buildType}` : ''}
                    {site.bodyName ? ` · ${site.bodyName}` : ''}
                    {` · ${Math.round(site.progress)} %`}
                  </span>
                </div>
              ))}
            </div>
          )}

          {report.notStarted.length > 0 && (
            <div style={{ ...mutedText, marginTop: 10 }}>
              {t('prg.notStarted', { done: report.notStarted.length, total: report.sites.length })}
            </div>
          )}
          {report.completeCount > 0 && (
            <div style={{ fontSize: 12, color: 'var(--green)', marginTop: 6 }}>
              {t('prg.complete', { count: report.completeCount })}
            </div>
          )}
        </>
      )}
    </section>
  );
}
