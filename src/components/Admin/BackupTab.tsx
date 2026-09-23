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
  healthy: { label: 'В норме', className: 'healthy' },
  warning: { label: 'Требует внимания', className: 'warning' },
  critical: { label: 'Недоступно', className: 'critical' },
  unknown: { label: 'Нет данных', className: 'unknown' },
};

const STATE_META: Record<string, { label: string; level: MonitorLevel }> = {
  idle: { label: 'Копирование не выполняется', level: 'unknown' },
  running: { label: 'Идёт резервное копирование', level: 'warning' },
  succeeded: { label: 'Копия готова', level: 'healthy' },
  failed: { label: 'Копирование завершилось с ошибкой', level: 'critical' },
  aborted: { label: 'Копирование остановлено', level: 'warning' },
};

function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return '—';
  return new Date(time).toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' });
}

function formatBytes(bytes: number | null | undefined): string {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '—';
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(size >= 100 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function StatusPill({ level, label }: { level: MonitorLevel; label?: string }) {
  const meta = LEVEL_META[level];
  return (
    <span className={`ops-status ops-status-${meta.className}`}>
      <span className="ops-status-dot" />
      {label ?? meta.label}
    </span>
  );
}

export default function BackupTab() {
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
          ? 'Полный дамп запущен: сайт под заглушкой, окно техработ будет длинным.'
          : 'Копирование запущено: сайт показывает заглушку «Ведутся технические работы».',
      );
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Не удалось запустить резервное копирование');
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
      setMessage('Копирование остановлено, заглушка снята.');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Не удалось остановить копирование');
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
    ? 'Агент не настроен'
    : !connected
      ? 'Update-агент не отвечает'
      : STATE_META[update?.state ?? 'idle']?.label;

  return (
    <div className="ops-grid">
      <section className="ops-panel">
        <div className="ops-panel-head">
          <div>
            <h3>Резервная копия базы данных</h3>
            <p>Раз в неделю, вручную. Пока идёт дамп, посетители видят заглушку «Ведутся технические работы».</p>
          </div>
          <StatusPill level={level} label={label} />
        </div>

        {!configured && (
          <div className="ops-notice ops-notice-info">
            <IconAlert size={16} /> Кнопка появится, когда на хосте запущен приватный update-agent
            (<code>bash deploy/start-update-agent.sh</code>), а в <code>.env.production</code> заданы
            <code> UPDATE_AGENT_URL</code> и <code>UPDATE_AGENT_TOKEN</code>.
          </div>
        )}
        {configured && !connected && (
          <div className="ops-notice ops-notice-critical">
            <IconXCircle size={16} /> {reason || 'Update-агент недоступен: копию сделать нельзя.'}
          </div>
        )}

        {due?.due && !active && (
          <div className="ops-notice ops-notice-warning">
            <IconAlert size={16} />
            {due.lastAt
              ? `Прошла неделя с последней копии (${formatDate(due.lastAt)}) — пора сделать новую.`
              : 'Успешной копии ещё не было — сделайте первую.'}
          </div>
        )}
        {backup?.lastResult && backup.lastResult !== 'succeeded' && (
          <div className="ops-notice ops-notice-critical">
            <IconXCircle size={16} /> Последняя попытка: {backup.lastResult === 'aborted' ? 'остановлена' : 'с ошибкой'}
            {backup.error ? ` — ${backup.error}` : ''}
          </div>
        )}
        {maintenance?.active && !active && (
          <div className="ops-notice ops-notice-warning">
            <IconAlert size={16} /> Заглушка техработ активна, но агент свободен — снимите её повторным опросом
            или дождитесь <code>{formatDate(maintenance.expiresAt)}</code> (флаг отпустит сайт сам).
          </div>
        )}

        <dl className="ops-facts">
          <div><dt>Последняя копия</dt><dd>{formatDate(backup?.lastAt)}</dd></div>
          <div><dt>Файл</dt><dd>{backup?.file || '—'}</dd></div>
          <div><dt>Размер</dt><dd>{formatBytes(backup?.bytes)}</dd></div>
          <div><dt>Режим</dt><dd>{backup?.full ? 'полный (с каталогом систем)' : 'без каталога систем'}</dd></div>
          <div><dt>Прошло</dt><dd>{due?.daysSince != null ? `${due.daysSince} дн.` : '—'}</dd></div>
          <div><dt>Следующая по плану</dt><dd>{nextDueAt ? formatDate(nextDueAt.toISOString()) : '—'}</dd></div>
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
                  {stage.label}
                </li>
              ))}
            </ul>
            {update.message && <div className="ops-inline-note ops-inline-progress">{update.message}</div>}
            {update.log.length > 0 && (
              <pre className="ops-log" ref={logRef}>
                {update.log.map((entry, index) => (
                  <div key={`${entry.at ?? ''}-${index}`}>
                    {entry.at ? <time>{new Date(entry.at).toLocaleTimeString('ru-RU')}</time> : null}
                    {entry.line}
                  </div>
                ))}
              </pre>
            )}
          </>
        )}

        {!active && update?.state === 'succeeded' && (
          <div className="ops-inline-note">
            <IconCheckCircle size={14} /> Копия {update.backupFile || 'готова'}
            {update.backupBytes ? `, ${formatBytes(update.backupBytes)}` : ''} — {formatDate(update.finishedAt)}
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
            {busy ? 'Запускаю…' : active ? 'Идёт копирование…' : 'Сделать бэкап'}
          </button>
          <button
            type="button"
            className="ops-refresh-button"
            disabled={!connected || busy || active === true || !confirmFull}
            onClick={() => void start(true)}
            title="Включает в дамп public.galaxy_systems: десятки гигабайт и долгое окно техработ"
          >
            <IconRefresh size={14} /> Полный дамп
          </button>
          {active && (
            <button type="button" className="ops-refresh-button ops-button-danger" disabled={busy} onClick={() => void abort()}>
              <IconXCircle size={14} /> Остановить
            </button>
          )}
          <label title="Полный дамп включает каталог систем: это десятки гигабайт и часы под заглушкой">
            <input type="checkbox" checked={confirmFull} onChange={(event) => setConfirmFull(event.target.checked)} />
            разрешить полный дамп (с каталогом систем)
          </label>
          <span className="ops-inline-note">
            На время копии посетители видят заглушку «Ведутся технические работы»; админка и API остаются доступными.
          </span>
          {message && <span className="ops-inline-note">{message}</span>}
        </div>
      </section>

      <section className="ops-panel">
        <div className="ops-panel-head">
          <div>
            <h3>Как это устроено</h3>
            <p>Что именно копируется, где лежит и как восстанавливать.</p>
          </div>
        </div>
        <ul className="ops-migrations" style={{ display: 'grid', gap: 6 }}>
          <li><strong>Обычная копия</strong> — <code>pg_dump -Fc</code> без <code>public.galaxy_systems</code>: каталог весит десятки гигабайт и полностью восстанавливается импортом дампа Spansh, поэтому окно техработ короткое.</li>
          <li><strong>Полный дамп</strong> — та же команда без исключения: нужен перед переносом сервера или крупными миграциями.</li>
          <li><strong>Хранение</strong> — 4 последние копии в <code>UPDATE_BACKUP_DIR</code> (по умолчанию <code>/opt/ed-ring-colony/backups</code>), старые удаляет сам скрипт.</li>
          <li><strong>Проверка</strong> — каждая копия проверяется через <code>pg_restore --list</code>: нечитаемый архив не засчитывается.</li>
          <li><strong>Восстановление</strong> — <code>docker exec -i supabase-db pg_restore -U postgres -d postgres --clean --if-exists &lt; КОПИЯ.dump</code>; каталог систем после этого импортируется заново.</li>
          <li><strong>Никакого cron</strong>: расписания на сервере нет, ритм держит эта панель (подсветка «пора» через неделю).</li>
        </ul>
      </section>
    </div>
  );
}
