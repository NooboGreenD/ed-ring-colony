'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  IconAlert,
  IconCheckCircle,
  IconClock,
  IconDatabase,
  IconRefresh,
  IconXCircle,
} from '@/components/Icons';
import { BACKUP_STAGES } from '../../../scripts/lib/update-state.mjs';
import { useI18n } from '@/lib/i18n/I18nContext';
import { authFetch } from '@/lib/supabaseClient';
import type { MonitorLevel } from '@/types/monitor';

/**
 * Админка → Бэкапы: ручная резервная копия базы данных.
 *
 * Ритм еженедельный и только ручной — cron-задач на сервере для этого нет.
 * Копию делает приватный update-agent на хосте (deploy/db-backup.sh), а на
 * время дампа сайт закрыт заглушкой «Ведутся технические работы»; эта вкладка
 * и API остаются доступными, чтобы прогресс было видно, а дамп можно было
 * прервать.
 */

const REFRESH_IDLE_MS = 20_000;
const REFRESH_ACTIVE_MS = 3_000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

interface BackupUpdateState {
  state: string;
  kind: string | null;
  active: boolean;
  stage: string | null;
  stageLabel: string | null;
  percent: number;
  message: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  mode: string | null;
  backupFile: string | null;
  backupBytes: number | null;
  error: string | null;
  log: Array<{ at: string | null; line: string }>;
}

interface BackupRecord {
  lastAt: string | null;
  file: string | null;
  bytes: number | null;
  full: boolean;
  lastResult: 'succeeded' | 'failed' | 'aborted' | null;
  error: string | null;
}

interface MaintenanceInfo {
  active: boolean;
  reason: string;
  startedAt: string | null;
  expiresAt: string | null;
}

interface DueInfo {
  lastAt: string | null;
  daysSince: number | null;
  due: boolean;
  overdueMs: number | null;
}

interface BackupResponse {
  success?: boolean;
  configured?: boolean;
  connected?: boolean;
  reason?: string | null;
  error?: string;
  update?: BackupUpdateState | null;
  backup?: BackupRecord | null;
  maintenance?: MaintenanceInfo | null;
  due?: DueInfo;
}

const LEVEL_META: Record<MonitorLevel, { label: string; className: string }> = {
  healthy: { label: 'bak.levelHealthy', className: 'healthy' },
  warning: { label: 'bak.levelWarning', className: 'warning' },
  critical: { label: 'bak.levelCritical', className: 'critical' },
  unknown: { label: 'bak.levelUnknown', className: 'unknown' },
};

const STATE_META: Record<string, { label: string; level: MonitorLevel }> = {
  idle: { label: 'bak.stateIdle', level: 'unknown' },
  running: { label: 'bak.stateRunning', level: 'warning' },
  succeeded: { label: 'bak.stateSucceeded', level: 'healthy' },
  failed: { label: 'bak.stateFailed', level: 'critical' },
  aborted: { label: 'bak.stateAborted', level: 'warning' },
};

function formatDate(value: string | null | undefined, locale: string): string {
  if (!value) return '—';
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return '—';
  return new Date(time).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
}

function formatBytes(bytes: number | null | undefined, t: (key: string) => string): string {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '—';
  const units = ['mon.unitB', 'mon.unitKB', 'mon.unitMB', 'mon.unitGB', 'mon.unitTB'];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(size >= 100 || index === 0 ? 0 : 1)} ${t(units[index])}`;
}

function StatusPill({ level, label }: { level: MonitorLevel; label?: string }) {
  const { t } = useI18n();
  const meta = LEVEL_META[level];
  return (
    <span className={`ops-status ops-status-${meta.className}`}>
      <span className="ops-status-dot" />
      {label ?? t(meta.label)}
    </span>
  );
}

export default function BackupTab() {
  const { t, locale } = useI18n();
  const [configured, setConfigured] = useState(false);
  const [connected, setConnected] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const [update, setUpdate] = useState<BackupUpdateState | null>(null);
  const [backup, setBackup] = useState<BackupRecord | null>(null);
  const [maintenance, setMaintenance] = useState<MaintenanceInfo | null>(null);
  const [due, setDue] = useState<DueInfo | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmFull, setConfirmFull] = useState(false);
  const logRef = useRef<HTMLPreElement | null>(null);

  const active = update?.active === true && update?.kind === 'backup';
  // Пока идёт дамп, опрашиваем часто: прогресс должен двигаться на глазах.
  const refreshMs = active ? REFRESH_ACTIVE_MS : REFRESH_IDLE_MS;

  const applyPayload = useCallback((data: BackupResponse) => {
    setConfigured(data.configured === true);
    setConnected(data.connected === true);
    setReason(data.reason ?? null);
    if (data.update) setUpdate(data.update);
    if ('backup' in data) setBackup(data.backup ?? null);
    if ('maintenance' in data) setMaintenance(data.maintenance ?? null);
    if (data.due) setDue(data.due);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const response = await authFetch('/api/admin/backup', { cache: 'no-store' });
      const data = (await response.json().catch(() => ({}))) as BackupResponse;
      if (!response.ok && !('update' in data)) {
        throw new Error(data.error || `HTTP ${response.status}`);
      }
      applyPayload(data);
    } catch {
      setConnected(false);
    }
  }, [applyPayload]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), refreshMs);
    return () => clearInterval(timer);
  }, [refresh, refreshMs]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [update?.log.length]);

  const start = useCallback(async (full: boolean) => {
    setBusy(true);
    setMessage('');
    try {
      const response = await authFetch('/api/admin/backup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true, full }),
      });
      const data = (await response.json().catch(() => ({}))) as BackupResponse;
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      applyPayload(data);
      setMessage(
        full
          ? t('bak.startFull')
          : t('bak.startNormal'),
      );
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : t('bak.startFailed'));
    } finally {
      setBusy(false);
    }
  }, [applyPayload]);

  const abort = useCallback(async () => {
    setBusy(true);
    try {
      const response = await authFetch('/api/admin/backup', { method: 'DELETE' });
      const data = (await response.json().catch(() => ({}))) as BackupResponse;
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      applyPayload(data);
      setMessage(t('bak.aborted'));
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : t('bak.abortFailed'));
    } finally {
      setBusy(false);
    }
  }, [applyPayload]);

  const stageState = (index: number) => {
    if (!update) return 'pending';
    const activeIndex = BACKUP_STAGES.findIndex((stage) => stage.id === update.stage);
    if (update.state === 'succeeded') return 'done';
    if (activeIndex < 0) return 'pending';
    if (index < activeIndex) return 'done';
    if (index === activeIndex) return 'active';
    return 'pending';
  };

  const nextDueAt = due?.lastAt ? new Date(Date.parse(due.lastAt) + WEEK_MS) : null;
  const level: MonitorLevel = !configured
    ? 'unknown'
    : !connected
      ? 'critical'
      : STATE_META[update?.state ?? 'idle']?.level ?? 'unknown';
  const label = !configured
    ? t('bak.agentNotConfigured')
    : !connected
      ? t('bak.agentNoAnswer')
      : t(STATE_META[update?.state ?? 'idle']?.label ?? 'bak.stateIdle');

  return (
    <div className="ops-grid">
      <section className="ops-panel">
        <div className="ops-panel-head">
          <div>
            <h3>{t('bak.title')}</h3>
            <p>{t('bak.subtitle')}</p>
          </div>
          <StatusPill level={level} label={label} />
        </div>

        {!configured && (
          <div className="ops-notice ops-notice-info">
            <IconAlert size={16} /> {t('bak.setupHint')}
          </div>
        )}
        {configured && !connected && (
          <div className="ops-notice ops-notice-critical">
            <IconXCircle size={16} /> {reason || t('bak.agentUnavailable')}
          </div>
        )}

        {due?.due && !active && (
          <div className="ops-notice ops-notice-warning">
            <IconAlert size={16} />
            {due.lastAt
              ? t('bak.dueSince', { when: formatDate(due.lastAt, locale) })
              : t('bak.dueNever')}
          </div>
        )}
        {backup?.lastResult && backup.lastResult !== 'succeeded' && (
          <div className="ops-notice ops-notice-critical">
            <IconXCircle size={16} /> {t('bak.lastAttempt', {
              state: backup.lastResult === 'aborted' ? t('bak.attemptAborted') : t('bak.attemptFailed'),
            })}
            {backup.error ? ` — ${backup.error}` : ''}
          </div>
        )}
        {maintenance?.active && !active && (
          <div className="ops-notice ops-notice-warning">
            <IconAlert size={16} /> {t('bak.stuck1')}{' '}
            <code>{formatDate(maintenance.expiresAt, locale)}</code> {t('bak.stuck2')}
          </div>
        )}

        <dl className="ops-facts">
          <div><dt>{t('bak.lastCopy')}</dt><dd>{formatDate(backup?.lastAt, locale)}</dd></div>
          <div><dt>{t('bak.file')}</dt><dd>{backup?.file || '—'}</dd></div>
          <div><dt>{t('bak.size')}</dt><dd>{formatBytes(backup?.bytes, t)}</dd></div>
          <div><dt>{t('bak.mode')}</dt><dd>{backup?.full ? t('bak.modeFull') : t('bak.modeShort')}</dd></div>
          <div><dt>{t('bak.elapsed')}</dt><dd>{due?.daysSince != null ? t('bak.days', { count: due.daysSince }) : '—'}</dd></div>
          <div><dt>{t('bak.nextDue')}</dt><dd>{nextDueAt ? formatDate(nextDueAt.toISOString(), locale) : '—'}</dd></div>
        </dl>

        {active && update && (
          <>
            <div className="ops-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(update.percent || 0)}>
              <div className="ops-progress-fill" style={{ width: `${Math.max(2, Math.min(100, Math.round(update.percent || 0)))}%` }} />
            </div>
            <ul className="ops-update-stages">
              {BACKUP_STAGES.map((stage, index) => (
                <li className="ops-update-stage" key={stage.id} data-state={stageState(index)}>
                  {stageState(index) === 'done' ? <IconCheckCircle size={11} /> : <IconClock size={11} />}
                  {t(stage.labelKey)}
                </li>
              ))}
            </ul>
            {update.message && <div className="ops-inline-note ops-inline-progress">{update.message}</div>}
            {update.log.length > 0 && (
              <pre className="ops-log" ref={logRef}>
                {update.log.map((entry, index) => (
                  <div key={`${entry.at ?? ''}-${index}`}>
                    {entry.at ? <time>{new Date(entry.at).toLocaleTimeString(locale)}</time> : null}
                    {entry.line}
                  </div>
                ))}
              </pre>
            )}
          </>
        )}

        {!active && update?.state === 'succeeded' && (
          <div className="ops-inline-note">
            <IconCheckCircle size={14} /> {update.backupFile ? t('bak.copyFile', { file: update.backupFile }) : t('bak.copyDone')}
            {update.backupBytes ? `, ${formatBytes(update.backupBytes, t)}` : ''} — {formatDate(update.finishedAt, locale)}
          </div>
        )}

        <div className="ops-update-actions">
          <button
            type="button"
            className="ops-button-primary"
            disabled={!connected || busy || active === true}
            onClick={() => void start(false)}
          >
            <IconDatabase size={14} />
            {busy ? t('bak.starting') : active ? t('bak.running') : t('bak.makeBackup')}
          </button>
          <button
            type="button"
            className="ops-refresh-button"
            disabled={!connected || busy || active === true || !confirmFull}
            onClick={() => void start(true)}
            title={t('bak.fullTitle')}
          >
            <IconRefresh size={14} /> {t('bak.fullDump')}
          </button>
          {active && (
            <button type="button" className="ops-refresh-button ops-button-danger" disabled={busy} onClick={() => void abort()}>
              <IconXCircle size={14} /> {t('bak.stop')}
            </button>
          )}
          <label title={t('bak.allowFullTitle')}>
            <input type="checkbox" checked={confirmFull} onChange={(event) => setConfirmFull(event.target.checked)} />
            {t('bak.allowFull')}
          </label>
          <span className="ops-inline-note">
            {t('bak.maintenanceNote')}
          </span>
          {message && <span className="ops-inline-note">{message}</span>}
        </div>
      </section>

      <section className="ops-panel">
        <div className="ops-panel-head">
          <div>
            <h3>{t('bak.howTitle')}</h3>
            <p>{t('bak.howSubtitle')}</p>
          </div>
        </div>
        <ul className="ops-migrations" style={{ display: 'grid', gap: 6 }}>
          <li><strong>{t('bak.howNormalTitle')}</strong> — <code>pg_dump -Fc</code> {t('bak.howNormalText')}</li>
          <li><strong>{t('bak.howFullTitle')}</strong> — {t('bak.howFullText')}</li>
          <li><strong>{t('bak.howStorageTitle')}</strong> — {t('bak.howStorageText')}</li>
          <li><strong>{t('bak.howCheckTitle')}</strong> — {t('bak.howCheckText')}</li>
          <li><strong>{t('bak.howRestoreTitle')}</strong> — {t('bak.howRestoreText')}</li>
          <li><strong>{t('bak.howCronTitle')}</strong>: {t('bak.howCronText')}</li>
        </ul>
      </section>
    </div>
  );
}
