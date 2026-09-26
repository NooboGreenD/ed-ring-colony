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
import { getInstallation } from '@/lib/architect/planner';
import { parseExistingStructures, type ExistingStructure } from '@/lib/architect/existing';
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
  plan: 'заявлено',
  building: 'строится',
  complete: 'построено',
};

const STATUS_COLORS: Record<ExistingStructure['status'], string> = {
  plan: 'var(--muted)',
  building: 'var(--orange)',
  complete: 'var(--green)',
};

interface ExistingPanelProps {
  systemName: string;
  /** Ключи построек, которые уже есть в плане (тело + тип) — чтобы не предлагать дубли. */
  plannedKeys: Set<string>;
  onApply: (structures: ExistingStructure[]) => void;
}

/** Ключ «тело + постройка» — тем же способом считается на стороне плана. */
export function structureKey(bodyName: string | null, installationId: string | null): string {
  return `${String(bodyName ?? '').trim().toLowerCase()}|${installationId ?? ''}`;
}

export default function ExistingPanel({ systemName, plannedKeys, onApply }: ExistingPanelProps) {
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
      const parsed = parseExistingStructures(data);
      setStructures(parsed);
      setWarnings(Array.isArray(data?.warnings) ? data.warnings.map(String) : []);
      // По умолчанию отмечаем всё, что можно перенести без домыслов.
      setSelected(new Set(parsed.filter((item) => item.installationId).map((item) => item.key)));
      setFetched(true);
    } catch (err) {
      setStructures([]);
      setFetched(false);
      setError(err instanceof Error ? err.message : 'Не удалось получить застройку системы');
    } finally {
      setLoading(false);
    }
  }, []);

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
        <h3 style={sectionTitle}>Уже построено в системе</h3>
        <button
          type="button"
          onClick={() => void load(systemName)}
          disabled={loading || !systemName}
          style={ghostButton}
        >
          {loading ? 'Загрузка…' : fetched ? 'Обновить' : 'Проверить'}
        </button>
      </div>
      <div style={{ ...mutedText, marginTop: 4 }}>
        Постройки, которые в системе уже стоят: Raven Colonial и станции EDSM. Перенесите их в план, чтобы
        очки тиров, «первый порт бесплатно» и налог на порты считались от реального состояния системы.
      </div>

      {error && <div style={{ ...errorText, marginTop: 8 }}>{error}</div>}
      {warnings.map((warning) => (
        <div key={warning} style={{ fontSize: 11, color: 'var(--orange)', marginTop: 6 }}>{warning}</div>
      ))}

      {fetched && structures.length === 0 && !error && (
        <div style={{ ...mutedText, marginTop: 8 }}>
          Построек не найдено: система ещё не застроена или источники о ней не знают.
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
                    {installation?.nameRu ?? item.installationId}
                    <span style={{ color: 'var(--muted)', fontSize: 11 }}> · {item.name}</span>
                  </span>
                  <span style={{ display: 'block', fontSize: 11, color: 'var(--muted)' }}>
                    {item.bodyName || 'тело не указано'} · {item.source === 'raven' ? 'Raven' : 'EDSM'}
                    {' · '}
                    <span style={{ color: STATUS_COLORS[item.status] }}>{STATUS_LABELS[item.status]}</span>
                    {already ? ' · уже в плане' : ''}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      )}

      {unknown.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div style={{ ...mutedText, textTransform: 'uppercase', letterSpacing: 1, fontSize: 11 }}>
            Тип не опознан — в план не переносится
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
            Применить к плану ({selectedList.length})
          </button>
          <button
            type="button"
            style={ghostButton}
            onClick={() => setSelected(new Set(known.map((item) => item.key)))}
          >
            Отметить всё
          </button>
          <button type="button" style={ghostButton} onClick={() => setSelected(new Set())}>
            Снять отметки
          </button>
        </div>
      )}

      {fetched && known.length > 0 && (
        <div style={{ ...goodText, marginTop: 6 }}>
          Найдено построек: {known.length}
          {unknown.length > 0 ? ` · не опознано: ${unknown.length}` : ''}
        </div>
      )}
    </section>
  );
}
