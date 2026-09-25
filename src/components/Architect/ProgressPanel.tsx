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
  exact: 'совпало',
  type: 'по типу постройки',
  body: 'по телу и классу',
  none: 'нет данных',
};

function ProgressRow({ entry }: { entry: SiteProgress }) {
  const installation = getInstallation(entry.site.installationId);
  const percent = entry.progress == null ? null : Math.max(0, Math.min(100, entry.progress));
  const percentLabel = percent == null ? '—' : `${percent.toLocaleString('ru-RU')} %`;
  const tonsLabel = entry.deliveredTons != null && entry.requiredTons != null
    ? `${formatTons(entry.deliveredTons)} из ${formatTons(entry.requiredTons)}`
    : entry.deliveredTons != null
      ? `привезено ${formatTons(entry.deliveredTons)}`
      : entry.requiredTons != null
        ? `нужно ${formatTons(entry.requiredTons)}`
        : 'тоннаж не сообщается';

  return (
    <tr>
      <td style={tdStyle}>
        <div style={{ fontSize: 12, color: 'var(--text)' }}>{installation?.nameRu ?? entry.site.installationId}</div>
        <div style={{ fontSize: 11, color: 'var(--muted)' }}>
          {entry.site.bodyName} · {MATCH_LABELS[entry.matchKind]}
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
  loading: boolean;
  error: string;
  /** Откуда данные: 'raven' — из API, '' — ещё не запрашивали. */
  source: string;
  onRefresh: () => void;
}

export default function ProgressPanel({ systemName, report, loading, error, source, onRefresh }: ProgressPanelProps) {
  const totals = report?.totals ?? null;
  const totalPercent = totals?.progress == null ? null : Math.max(0, Math.min(100, totals.progress));
  const started = report ? report.sites.filter((entry) => entry.actual !== null) : [];

  return (
    <section style={cardStyle}>
      <div style={rowStyle}>
        <h3 style={sectionTitle}>Фактический прогресс</h3>
        <button type="button" onClick={onRefresh} disabled={loading} style={ghostButton}>
          {loading ? 'Обновление…' : 'Обновить'}
        </button>
      </div>
      <div style={{ ...mutedText, marginTop: 4 }}>
        {systemName ? `Стройплощадки системы ${systemName}` : 'Сначала загрузите систему'}
        {source ? ` · источник: ${source}` : ''}
      </div>

      {error && <div style={{ ...errorText, marginTop: 8 }}>{error}</div>}

      {!report && !error && (
        <div style={{ ...mutedText, marginTop: 8 }}>
          Нажмите «Обновить», чтобы сверить план с площадками, которые реально строятся в системе.
        </div>
      )}

      {report && (
        <>
          {totalPercent == null ? (
            <div style={{ ...mutedText, marginTop: 8 }}>
              {started.length > 0
                ? 'Площадки найдены, но тоннаж они не сообщают — процент посчитать нечем.'
                : 'Стройплощадок в системе не найдено: стройка ещё не началась или данные недоступны.'}
            </div>
          ) : (
            <div style={{ marginTop: 10 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                <span style={{ fontSize: 20, color: 'var(--cyan)', fontFamily: 'ui-monospace, monospace' }}>
                  {totalPercent.toLocaleString('ru-RU')} %
                </span>
                <span style={mutedText}>
                  {totals?.provided != null && totals?.required != null
                    ? `привезено ${formatTons(totals.provided)} из ${formatTons(totals.required)}`
                    : 'прогресс по тоннажу'}
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
                  <th style={thStyle}>Постройка плана</th>
                  <th style={thStyle}>Прогресс</th>
                  <th style={thStyle}>Тоннаж</th>
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
                Строится, но не в плане
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
              Не начаты: {report.notStarted.length} из {report.sites.length} построек плана.
            </div>
          )}
          {report.completeCount > 0 && (
            <div style={{ fontSize: 12, color: 'var(--green)', marginTop: 6 }}>
              Готово площадок: {report.completeCount}.
            </div>
          )}
        </>
      )}
    </section>
  );
}
