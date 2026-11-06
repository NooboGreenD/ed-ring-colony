'use client';

/**
 * «Качество данных» — что не так с тем, что загрузилось.
 *
 * Панель отвечает на два практических вопроса: не пришло ли одно и то же тело
 * дважды и можно ли доверять расчёту слотов/экономик по этим полям. Проверки
 * считает `src/lib/architect/dataQuality.ts`, здесь — только показ: сводная
 * оценка, полосы покрытия ключевых полей и список замечаний с телами.
 */

import { useState } from 'react';
import type { BodyDataReport, DataIssue, PlanDataReport } from '@/lib/architect/dataQuality';
import { cardStyle, ghostButton, mutedText, rowStyle, sectionTitle } from '@/components/Architect/panelStyles';
import { useI18n } from '@/lib/i18n/I18nContext';

const LEVEL_TONES: Record<DataIssue['level'], string> = {
  error: 'var(--red)',
  warning: 'var(--orange)',
  info: 'var(--muted)',
};

const LEVEL_MARKS: Record<DataIssue['level'], string> = { error: '✕', warning: '!', info: '·' };

const COVERAGE_LABELS: { key: keyof BodyDataReport['coverage']; label: string }[] = [
  { key: 'name', label: 'dq.fName' },
  { key: 'subType', label: 'dq.fSubType' },
  { key: 'distance', label: 'dq.fDistance' },
  { key: 'radius', label: 'dq.fRadius' },
  { key: 'gravity', label: 'dq.fGravity' },
  { key: 'temperature', label: 'dq.fTemperature' },
  { key: 'signals', label: 'dq.fSignals' },
];

interface DataQualityPanelProps {
  report: BodyDataReport;
  planReport: PlanDataReport;
  /** Показать тела, которых нет в каталоге (переключает фильтр списка тел). */
  onShowUnknownBodies?: () => void;
}

export default function DataQualityPanel({ report, planReport, onShowUnknownBodies }: DataQualityPanelProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const issues = [...planReport.issues, ...report.issues];
  const errors = issues.filter((issue) => issue.level === 'error').length;
  const warnings = issues.filter((issue) => issue.level === 'warning').length;
  const tone = report.score >= 80 && errors === 0
    ? 'var(--green)'
    : report.score >= 50 ? 'var(--orange)' : 'var(--red)';

  return (
    <section style={cardStyle}>
      <div style={rowStyle}>
        <h3 style={sectionTitle}>{t('dq.title')}</h3>
        <button type="button" onClick={() => setOpen((value) => !value)} style={ghostButton}>
          {open ? t('dq.collapse') : t('dq.details')}
        </button>
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
        <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 24, color: tone }}>{report.score}</div>
        <div style={{ flex: '1 1 160px' }}>
          <div style={{ height: 6, border: '1px solid var(--line)', borderRadius: 3, overflow: 'hidden', background: 'var(--bg)' }}>
            <div style={{ height: '100%', width: `${report.score}%`, background: tone }} />
          </div>
          <div style={{ ...mutedText, marginTop: 4 }}>
            {t('dq.rows', { rows: report.rawCount, total: report.total })}
            {report.duplicates.length > 0 ? t('dq.dupCount', { count: report.duplicates.length }) : t('dq.noDup')}
            {errors > 0 ? t('dq.errors', { count: errors }) : ''}
            {warnings > 0 ? t('dq.warnings', { count: warnings }) : ''}
          </div>
        </div>
      </div>

      {planReport.unknownBodies.length > 0 && onShowUnknownBodies && (
        <button
          type="button"
          onClick={onShowUnknownBodies}
          style={{ ...ghostButton, marginTop: 8, borderColor: 'var(--orange)', color: 'var(--orange)' }}
        >
          {t('dq.showUnknown', { count: planReport.unknownBodies.length })}
        </button>
      )}

      {open && (
        <>
          <div style={{ marginTop: 12 }}>
            <div style={{ ...mutedText, textTransform: 'uppercase', letterSpacing: 1, fontSize: 10, marginBottom: 6 }}>
              {t('dq.coverage')}
            </div>
            {COVERAGE_LABELS.map(({ key, label }) => {
              const value = Math.round((report.coverage[key] ?? 0) * 100);
              return (
                <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, marginBottom: 3 }}>
                  <span style={{ width: 96, color: 'var(--muted)' }}>{t(label)}</span>
                  <div style={{ flex: 1, height: 5, border: '1px solid var(--line)', borderRadius: 3, overflow: 'hidden', background: 'var(--bg)' }}>
                    <div style={{
                      height: '100%',
                      width: `${value}%`,
                      background: value >= 80 ? 'var(--green)' : value >= 40 ? 'var(--orange)' : 'var(--red)',
                    }}
                    />
                  </div>
                  <span style={{ width: 38, textAlign: 'right', fontFamily: 'ui-monospace, monospace', color: 'var(--muted)' }}>
                    {value} %
                  </span>
                </div>
              );
            })}
          </div>

          {Object.keys(report.sources).length > 0 && (
            <div style={{ marginTop: 10, ...mutedText }}>
              {t('dq.rowsBySource', { list: Object.entries(report.sources)
                .sort((left, right) => right[1] - left[1])
                .map(([source, count]) => `${source}: ${count}`)
                .join(' · ') })}
            </div>
          )}

          {report.duplicates.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div style={{ ...mutedText, textTransform: 'uppercase', letterSpacing: 1, fontSize: 10, marginBottom: 4 }}>
                {t('dq.duplicates')}
              </div>
              {report.duplicates.slice(0, 8).map((entry) => (
                <div key={entry.name} style={{ fontSize: 12, color: 'var(--muted)' }}>
                  {entry.name} <span style={{ color: 'var(--orange)' }}>×{entry.count}</span>
                </div>
              ))}
              {report.duplicates.length > 8 && (
                <div style={mutedText}>{t('dq.andMore', { count: report.duplicates.length - 8 })}</div>
              )}
            </div>
          )}
        </>
      )}

      {issues.length === 0 ? (
        <div style={{ marginTop: 10, fontSize: 12, color: 'var(--green)' }}>
          {t('dq.clean')}
        </div>
      ) : (
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {(open ? issues : issues.slice(0, 3)).map((issue) => (
            <div key={issue.code} style={{ fontSize: 12, color: LEVEL_TONES[issue.level] }}>
              {LEVEL_MARKS[issue.level]} {issue.message}
              {issue.bodies.length > 0 && (
                <div style={{ color: 'var(--muted)', fontSize: 11, marginTop: 2 }}>
                  {issue.bodies.join(', ')}
                  {issue.count > issue.bodies.length ? ` ${t('dq.andMore', { count: issue.count - issue.bodies.length })}` : ''}
                </div>
              )}
            </div>
          ))}
          {!open && issues.length > 3 && (
            <button type="button" onClick={() => setOpen(true)} style={{ ...ghostButton, alignSelf: 'flex-start' }}>
              {t('dq.moreIssues', { count: issues.length - 3 })}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
