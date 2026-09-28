'use client';

/**
 * «Источники данных» — состояние синхронизации системы со сторонними
 * сервисами. Раньше «Архитектор» молча показывал то, что получилось
 * загрузить, и отличить «в системе правда два тела» от «EDSM не ответил»
 * было невозможно.
 *
 * Панель показывает по каждому источнику: ответил ли он, сколько строк дал,
 * насколько свежи данные и кто победил в сверке. Разбор ответа —
 * `parseSyncReport` в `src/lib/architect/bodySync.ts`.
 */

import type { SyncSourceState, SystemSyncReport, SyncStatus } from '@/lib/architect/bodySync';
import { cardStyle, ghostButton, mutedText, rowStyle, sectionTitle } from '@/components/Architect/panelStyles';

const STATUS_TONES: Record<SyncStatus, string> = {
  ok: 'var(--green)',
  empty: 'var(--muted)',
  unavailable: 'var(--red)',
  skipped: 'var(--muted)',
};

const STATUS_LABELS: Record<SyncStatus, string> = {
  ok: 'данные получены',
  empty: 'нет данных',
  unavailable: 'недоступен',
  skipped: 'пропущен',
};

const NOTE_LABELS: Record<string, string> = {
  'too-large': 'дамп слишком большой',
  timeout: 'таймаут',
  'not-found': 'система не найдена',
  error: 'ошибка сети',
  'id64 системы неизвестен': 'id64 системы неизвестен',
};

function ago(iso: string | null): string {
  if (!iso) return '';
  const value = Date.parse(iso);
  if (!Number.isFinite(value)) return '';
  const days = Math.floor((Date.now() - value) / 86_400_000);
  if (days <= 0) return 'сегодня';
  if (days === 1) return 'вчера';
  if (days < 30) return `${days} дн. назад`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} мес. назад`;
  return `${Math.floor(days / 365)} г. назад`;
}

interface SyncPanelProps {
  system: string;
  report: SystemSyncReport | null;
  /** Дополнительные источники (Raven Colonial, прогресс строек) от других панелей. */
  extra?: SyncSourceState[];
  loading?: boolean;
  onRefresh?: () => void;
}

export default function SyncPanel({ system, report, extra = [], loading = false, onRefresh }: SyncPanelProps) {
  const sources = [...(report?.sources ?? []), ...extra];
  const winners = report?.winners;

  return (
    <section style={cardStyle}>
      <div style={rowStyle}>
        <h3 style={sectionTitle}>Источники данных</h3>
        {onRefresh && (
          <button type="button" onClick={onRefresh} disabled={loading} style={ghostButton}>
            {loading ? 'Обновление…' : 'Обновить'}
          </button>
        )}
      </div>

      {sources.length === 0 ? (
        <div style={mutedText}>
          {system ? 'Система ещё не загружена.' : 'Укажите систему, чтобы свериться с источниками.'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
          {sources.map((source) => (
            <div key={source.id} style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 12 }}>
              <span
                aria-hidden
                style={{
                  width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
                  background: STATUS_TONES[source.status],
                  boxShadow: source.status === 'ok' ? '0 0 6px var(--green)' : undefined,
                }}
              />
              <span style={{ minWidth: 104, color: 'var(--text)' }}>{source.label}</span>
              <span style={{ color: STATUS_TONES[source.status] }}>
                {STATUS_LABELS[source.status]}
                {source.status === 'ok' && source.count > 0 ? ` · ${source.count}` : ''}
              </span>
              <span style={{ marginLeft: 'auto', color: 'var(--muted)', fontSize: 11 }}>
                {source.note
                  ? NOTE_LABELS[source.note] ?? source.note
                  : ago(source.updatedAt)}
              </span>
            </div>
          ))}
        </div>
      )}

      {winners && winners.total > 0 && (
        <div style={{ ...mutedText, marginTop: 10, lineHeight: 1.5 }}>
          Сверка: {winners.total} тел · из базы {winners.database} · EDSM {winners.edsm}
          {winners.spansh > 0 ? ` · Spansh ${winners.spansh}` : ''}
          {winners.merged > 0 ? ` · дополнено ${winners.merged}` : ''}
          {report && report.cached > 0 ? ` · сохранено в базу ${report.cached}` : ''}
        </div>
      )}

      {report && Object.keys(report.duplicates).length > 0 && (
        <div style={{ marginTop: 6, fontSize: 11, color: 'var(--orange)' }}>
          склеены повторы в источниках: {Object.entries(report.duplicates)
            .map(([id, count]) => `${id} ×${count}`)
            .join(', ')}
        </div>
      )}
    </section>
  );
}
