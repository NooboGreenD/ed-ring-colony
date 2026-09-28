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

const LEVEL_TONES: Record<DataIssue['level'], string> = {
  error: 'var(--red)',
  warning: 'var(--orange)',
  info: 'var(--muted)',
};

const LEVEL_MARKS: Record<DataIssue['level'], string> = { error: '✕', warning: '!', info: '·' };

const COVERAGE_LABELS: { key: keyof BodyDataReport['coverage']; label: string }[] = [
  { key: 'name', label: 'имя' },
  { key: 'subType', label: 'класс' },
  { key: 'distance', label: 'расстояние' },
  { key: 'radius', label: 'радиус' },
  { key: 'gravity', label: 'гравитация' },
  { key: 'temperature', label: 'температура' },
  { key: 'signals', label: 'сигналы' },
];

interface DataQualityPanelProps {
  report: BodyDataReport;
  planReport: PlanDataReport;
  /** Показать тела, которых нет в каталоге (переключает фильтр списка тел). */
  onShowUnknownBodies?: () => void;
}

export default function DataQualityPanel({ report, planReport, onShowUnknownBodies }: DataQualityPanelProps) {
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
        <h3 style={sectionTitle}>Качество данных</h3>
        <button type="button" onClick={() => setOpen((value) => !value)} style={ghostButton}>
          {open ? 'Свернуть' : 'Подробно'}
        </button>
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
        <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 24, color: tone }}>{report.score}</div>
        <div style={{ flex: '1 1 160px' }}>
          <div style={{ height: 6, border: '1px solid var(--line)', borderRadius: 3, overflow: 'hidden', background: 'var(--bg)' }}>
            <div style={{ height: '100%', width: `${report.score}%`, background: tone }} />
          </div>
          <div style={{ ...mutedText, marginTop: 4 }}>
            строк: {report.rawCount} · тел: {report.total}
            {report.duplicates.length > 0 ? ` · повторов: ${report.duplicates.length}` : ' · повторов нет'}
            {errors > 0 ? ` · ошибок: ${errors}` : ''}
            {warnings > 0 ? ` · предупреждений: ${warnings}` : ''}
          </div>
        </div>
      </div>

      {planReport.unknownBodies.length > 0 && onShowUnknownBodies && (
        <button
          type="button"
          onClick={onShowUnknownBodies}
          style={{ ...ghostButton, marginTop: 8, borderColor: 'var(--orange)', color: 'var(--orange)' }}
        >
          Показать {planReport.unknownBodies.length} постройк(и) вне каталога тел
        </button>
      )}

      {open && (
        <>
          <div style={{ marginTop: 12 }}>
            <div style={{ ...mutedText, textTransform: 'uppercase', letterSpacing: 1, fontSize: 10, marginBottom: 6 }}>
              Заполненность полей
            </div>
            {COVERAGE_LABELS.map(({ key, label }) => {
              const value = Math.round((report.coverage[key] ?? 0) * 100);
              return (
                <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, marginBottom: 3 }}>
                  <span style={{ width: 96, color: 'var(--muted)' }}>{label}</span>
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
              строки по источникам: {Object.entries(report.sources)
                .sort((left, right) => right[1] - left[1])
                .map(([source, count]) => `${source}: ${count}`)
                .join(' · ')}
            </div>
          )}

          {report.duplicates.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div style={{ ...mutedText, textTransform: 'uppercase', letterSpacing: 1, fontSize: 10, marginBottom: 4 }}>
                Повторяющиеся тела
              </div>
              {report.duplicates.slice(0, 8).map((entry) => (
                <div key={entry.name} style={{ fontSize: 12, color: 'var(--muted)' }}>
                  {entry.name} <span style={{ color: 'var(--orange)' }}>×{entry.count}</span>
                </div>
              ))}
              {report.duplicates.length > 8 && (
                <div style={mutedText}>…и ещё {report.duplicates.length - 8}</div>
              )}
            </div>
          )}
        </>
      )}

      {issues.length === 0 ? (
        <div style={{ marginTop: 10, fontSize: 12, color: 'var(--green)' }}>
          ✓ Повторов и подозрительных значений не найдено.
        </div>
      ) : (
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {(open ? issues : issues.slice(0, 3)).map((issue) => (
            <div key={issue.code} style={{ fontSize: 12, color: LEVEL_TONES[issue.level] }}>
              {LEVEL_MARKS[issue.level]} {issue.message}
              {issue.bodies.length > 0 && (
                <div style={{ color: 'var(--muted)', fontSize: 11, marginTop: 2 }}>
                  {issue.bodies.join(', ')}
                  {issue.count > issue.bodies.length ? ` …и ещё ${issue.count - issue.bodies.length}` : ''}
                </div>
              )}
            </div>
          ))}
          {!open && issues.length > 3 && (
            <button type="button" onClick={() => setOpen(true)} style={{ ...ghostButton, alignSelf: 'flex-start' }}>
              Ещё {issues.length - 3}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
