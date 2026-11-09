'use client';

/**
 * «Уже построено в системе» — перенос фактической застройки в план.
 *
 * Панель показывает то, что в системе реально стоит (Raven Colonial + EDSM),
 * и позволяет добавить выбранное в план одним действием. Это меняет расчёт
 * по существу: очки тиров, «первый порт бесплатно» и налог на порты считаются
 * от настоящего состояния системы, а не от пустого листа.
 *
 * Разбор и перенос делает чистый модуль `src/lib/architect/existing.ts`;
 * здесь — только запрос, выбор и отображение.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { installationName } from '@/lib/architect/catalogue';
import { getInstallation } from '@/lib/architect/planner';
import type { SyncSourceState } from '@/lib/architect/bodySync';
import { parseExistingStructures, type ExistingStructure } from '@/lib/architect/existing';
import type { ArchitectBody } from '@/lib/architect/types';
import { useI18n } from '@/lib/i18n/I18nContext';
import {
  cardStyle,
  errorText,
  ghostButton,
  goodText,
  mutedText,
  primaryButton,
  rowStyle,
  sectionTitle,
} from '@/components/Architect/panelStyles';

const STATUS_LABELS: Record<ExistingStructure['status'], string> = {
  plan: 'exst.stPlan',
  building: 'exst.stBuilding',
  complete: 'exst.stComplete',
};

const STATUS_COLORS: Record<ExistingStructure['status'], string> = {
  plan: 'var(--muted)',
  building: 'var(--orange)',
  complete: 'var(--green)',
};

interface ExistingPanelProps {
  systemName: string;
  /**
   * Тела системы: по ним имена из Raven/EDSM приводятся к каталогу ещё до
   * переноса, поэтому в списке сразу видно, на какое тело встанет постройка.
   */
  bodies: ArchitectBody[];
  /** Ключи построек, которые уже есть в плане (тело + тип) — чтобы не предлагать дубли. */
  plannedKeys: Set<string>;
  onApply: (structures: ExistingStructure[]) => void;
  /** Сообщить наверх состояние источников — для панели «Источники данных». */
  onSources?: (sources: SyncSourceState[]) => void;
}

/** Как нашли тело — подпись под названием постройки. */
const MATCH_LABELS: Record<ExistingStructure['bodyMatch'], string> = {
  exact: '',
  short: 'exst.matchShort',
  compact: 'exst.matchCompact',
  id: 'exst.matchId',
  ring: 'exst.matchRing',
  none: 'exst.matchNone',
};

/** Ключ «тело + постройка» — тем же способом считается на стороне плана. */
export function structureKey(bodyName: string | null, installationId: string | null): string {
  return `${String(bodyName ?? '').trim().toLowerCase()}|${installationId ?? ''}`;
}

export default function ExistingPanel({ systemName, bodies, plannedKeys, onApply, onSources }: ExistingPanelProps) {
  const { t, locale } = useI18n();
  const [structures, setStructures] = useState<ExistingStructure[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [fetched, setFetched] = useState(false);

  const load = useCallback(async (name: string) => {
    const target = name.trim();
    if (!target) return;
    setLoading(true);
    setError('');
    try {
      const response = await fetch(`/api/architect/existing?system=${encodeURIComponent(target)}`, { cache: 'no-store' });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(String(data?.error || `HTTP ${response.status}`));
      // Каталог тел передаётся в разбор: имена из источников сразу приводятся
      // к каталогу системы, иначе перенос кладёт в план «чужое» имя тела.
      const parsed = parseExistingStructures(data, { bodies, system: target });
      setStructures(parsed);
      setWarnings(Array.isArray(data?.warnings) ? data.warnings.map(String) : []);
      // По умолчанию отмечаем всё, что можно перенести без домыслов.
      setSelected(new Set(parsed.filter((item) => item.installationId).map((item) => item.key)));
      setFetched(true);

      const sources = (data?.sources ?? {}) as Record<string, unknown>;
      onSources?.([
        {
          id: 'raven',
          label: 'Raven Colonial',
          status: sources.raven === 'ok' ? 'ok' : 'unavailable',
          count: parsed.filter((item) => item.source === 'raven').length,
          updatedAt: null,
          note: sources.raven === 'ok' ? null : t('exst.noAnswer'),
        },
        {
          id: 'edsm-stations',
          label: t('exst.edsmStations'),
          status: sources.edsm === 'ok' ? 'ok' : 'unavailable',
          count: parsed.filter((item) => item.source === 'edsm').length,
          updatedAt: null,
          note: sources.edsm === 'ok' ? null : t('exst.noAnswer'),
        },
        {
          id: 'site-projects',
          label: t('exst.siteProjects'),
          status: sources.site === 'ok' ? 'ok' : 'unavailable',
          count: parsed.filter((item) => item.source === 'site').length,
          updatedAt: null,
          // Учёт сайта — первичный источник: он работает даже при 503 у Raven
          // (проекты шлёт сам Helper, ресурсы — из журналов).
          note: sources.site === 'ok' ? null : t('exst.siteNoProjects'),
        },
      ]);
    } catch (err) {
      setStructures([]);
      setFetched(false);
      setError(err instanceof Error ? err.message : t('exst.loadFailed'));
      onSources?.([]);
    } finally {
      setLoading(false);
    }
  }, [bodies, onSources, t]);

  // Смена системы обнуляет список: чужая застройка в плане недопустима.
  useEffect(() => {
    setStructures([]);
    setSelected(new Set());
    setFetched(false);
    setError('');
    setWarnings([]);
  }, [systemName]);

  const known = useMemo(() => structures.filter((item) => item.installationId), [structures]);
  const unknown = useMemo(() => structures.filter((item) => !item.installationId), [structures]);
  const selectedList = useMemo(
    () => known.filter((item) => selected.has(item.key)),
    [known, selected],
  );

  const toggle = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <section style={cardStyle}>
      <div style={rowStyle}>
        <h3 style={sectionTitle}>{t('exst.title')}</h3>
        <button
          type="button"
          onClick={() => void load(systemName)}
          disabled={loading || !systemName}
          style={ghostButton}
        >
          {loading ? t('exst.loading') : fetched ? t('exst.refresh') : t('exst.check')}
        </button>
      </div>
      <div style={{ ...mutedText, marginTop: 4 }}>
        {t('exst.intro')}
      </div>

      {error && <div style={{ ...errorText, marginTop: 8 }}>{error}</div>}
      {warnings.map((warning) => (
        <div key={warning} style={{ fontSize: 11, color: 'var(--orange)', marginTop: 6 }}>{warning}</div>
      ))}

      {fetched && structures.length === 0 && !error && (
        <div style={{ ...mutedText, marginTop: 8 }}>
          {t('exst.none')}
        </div>
      )}

      {known.length > 0 && (
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {known.map((item) => {
            const installation = getInstallation(item.installationId!);
            const already = plannedKeys.has(structureKey(item.bodyName, item.installationId));
            return (
              <label
                key={item.key}
                style={{
                  display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer',
                  borderWidth: 1, borderStyle: 'solid', borderColor: 'var(--line)',
                  borderRadius: 3, padding: '6px 8px', background: 'var(--bg)',
                }}
              >
                <input
                  type="checkbox"
                  checked={selected.has(item.key)}
                  onChange={() => toggle(item.key)}
                  aria-label={item.name}
                />
                <span style={{ minWidth: 0 }}>
                  <span style={{ display: 'block', fontSize: 13, color: 'var(--text)' }}>
                    {installationName(installation, locale) || item.installationId}
                    <span style={{ color: 'var(--muted)', fontSize: 11 }}> · {item.name}</span>
                  </span>
                  <span style={{ display: 'block', fontSize: 11, color: 'var(--muted)' }}>
                    {item.bodyName || item.rawBodyName || t('exst.noBody')} · {item.source === 'raven' ? 'Raven' : 'EDSM'}
                    {' · '}
                    <span style={{ color: STATUS_COLORS[item.status] }}>{t(STATUS_LABELS[item.status])}</span>
                    {item.primary ? <span style={{ color: 'var(--orange)' }}>{t('exst.primaryPort')}</span> : null}
                    {already ? t('exst.alreadyPlanned') : ''}
                  </span>
                  {MATCH_LABELS[item.bodyMatch] && (
                    <span
                      style={{
                        display: 'block', fontSize: 11,
                        color: item.bodyMatch === 'none' ? 'var(--orange)' : 'var(--cyan)',
                      }}
                    >
                      {t(MATCH_LABELS[item.bodyMatch])}
                      {item.bodyMatch !== 'none' && item.rawBodyName && item.rawBodyName !== item.bodyName
                        ? `: «${item.rawBodyName}» → «${item.bodyName}»`
                        : ''}
                    </span>
                  )}
                </span>
              </label>
            );
          })}
        </div>
      )}

      {unknown.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div style={{ ...mutedText, textTransform: 'uppercase', letterSpacing: 1, fontSize: 11 }}>
            {t('exst.unknownHead')}
          </div>
          {unknown.map((item) => (
            <div key={item.key} style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
              {item.name}{item.rawType ? ` · ${item.rawType}` : ''}{item.bodyName ? ` · ${item.bodyName}` : ''}
            </div>
          ))}
        </div>
      )}

      {known.length > 0 && (
        <div style={{ ...rowStyle, marginTop: 10 }}>
          <button
            type="button"
            style={primaryButton}
            disabled={selectedList.length === 0}
            onClick={() => onApply(selectedList)}
          >
            {t('exst.applyToPlan', { count: selectedList.length })}
          </button>
          <button
            type="button"
            style={ghostButton}
            onClick={() => setSelected(new Set(known.map((item) => item.key)))}
          >
            {t('exst.selectAll')}
          </button>
          <button type="button" style={ghostButton} onClick={() => setSelected(new Set())}>
            {t('exst.clearSel')}
          </button>
        </div>
      )}

      {fetched && known.length > 0 && (
        <div style={{ ...goodText, marginTop: 6 }}>
          {t('exst.found', { count: known.length })}
          {unknown.length > 0 ? t('exst.unrecognized', { count: unknown.length }) : ''}
        </div>
      )}
    </section>
  );
}
