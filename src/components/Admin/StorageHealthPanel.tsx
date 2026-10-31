'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { IconAlert, IconCheckCircle, IconHardDrive, IconRefresh, IconSync, IconXCircle } from '@/components/Icons';
import { authFetch } from '@/lib/supabaseClient';

/**
 * Supabase Storage: состояние и перезапуск (Админка → Мониторинг).
 *
 * Storage — отдельный стек (`/opt/supabase`), который обновление проекта не
 * трогает. Когда его контейнер падает (OOM на маленьком VPS, сбой внутренних
 * миграций, отвалившаяся база, права на том), сайт остаётся живым: пропадают
 * только аватары, логотипы эскадрилий и документы — их запись молча уходит в
 * резервную таблицу. Снаружи это выглядит как «картинки не загружаются», и
 * раньше лечилось только по SSH.
 *
 * Панель не гадает: она показывает ровно то, что вернул
 * `deploy/storage-repair.sh --check` — состояние контейнера, healthcheck,
 * число перезапусков и ответ API `/bucket`, — и даёт одну кнопку, которая
 * перезапускает ТОЛЬКО сервис storage и только если он действительно лежит.
 */

interface StorageReport {
  ok: boolean;
  problem: boolean;
  restartable: boolean;
  state: string;
  health: string;
  restarts: number;
  exitCode: number | null;
  oom: boolean;
  api: string;
  apiVia: string;
  apiCode: string;
  reason: string;
}

interface StorageResponse {
  success?: boolean;
  available?: boolean;
  reason?: string | null;
  report?: StorageReport | null;
  detail?: string[];
  busy?: boolean;
  error?: string;
}

const REFRESH_MS = 60_000;

const STATE_RU: Record<string, string> = {
  running: 'работает',
  exited: 'остановлен',
  restarting: 'перезапускается',
  created: 'создан, не запущен',
  paused: 'приостановлен',
  dead: 'мёртв',
  missing: 'контейнер не найден',
  unknown: 'неизвестно',
};

const API_RU: Record<string, string> = {
  ok: 'бакеты читаются',
  auth: 'ключ не принят (401/403)',
  failed: 'не отвечает',
  unknown: 'не проверено',
};

const VIA_RU: Record<string, string> = {
  agent: 'из сети агента',
  container: 'изнутри контейнера',
  none: 'проверить нечем',
};

type Level = 'healthy' | 'warning' | 'critical' | 'unknown';

function levelOf(data: StorageResponse | null): Level {
  if (!data) return 'unknown';
  if (data.available === false) return 'unknown';
  const report = data.report;
  if (!report) return 'unknown';
  if (report.problem) return report.state === 'running' ? 'warning' : 'critical';
  if (report.state === 'running' && report.api === 'ok') return 'healthy';
  if (report.state === 'running') return 'warning';
  return 'critical';
}

const LEVEL_LABEL: Record<Level, string> = {
  healthy: 'Работает',
  warning: 'Требует внимания',
  critical: 'Не работает',
  unknown: 'Нет данных',
};

export default function StorageHealthPanel({
  agentConfigured,
  agentConnected,
  refreshToken,
  onStarted,
}: {
  agentConfigured: boolean;
  agentConnected: boolean;
  /** Меняется, когда задача kind=storage завершилась: перечитываем состояние. */
  refreshToken?: string | null;
  onStarted?: () => void;
}) {
  const [data, setData] = useState<StorageResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [restarting, setRestarting] = useState(false);
  const alive = useRef(true);

  // StrictMode в dev монтирует эффект дважды: без явного сброса флага в true
  // панель после повторного монтирования навсегда осталась бы «загружается».
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const load = useCallback(async () => {
    if (!agentConfigured) return;
    setLoading(true);
    try {
      const response = await authFetch('/api/admin/storage', { cache: 'no-store' });
      const payload = await response.json().catch(() => ({})) as StorageResponse;
      if (!alive.current) return;
      if (!response.ok) {
        setData(null);
        setMessage(payload.error || `Не удалось проверить Storage (HTTP ${response.status})`);
        return;
      }
      setData(payload);
      setMessage('');
    } catch (cause) {
      if (!alive.current) return;
      setData(null);
      setMessage(cause instanceof Error ? cause.message : 'Не удалось проверить Storage');
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [agentConfigured]);

  useEffect(() => {
    void load();
  }, [load]);

  // Задача перезапуска закончилась — снимок состояния сразу после неё важнее
  // любого таймера: админ смотрит на панель в эту секунду.
  useEffect(() => {
    if (refreshToken) void load();
  }, [refreshToken, load]);

  useEffect(() => {
    if (!agentConfigured || !agentConnected) return;
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [agentConfigured, agentConnected, load]);

  const restart = useCallback(async () => {
    if (!window.confirm(
      'Перезапустить Supabase Storage?\n\n'
      + 'Перезапускается только сервис storage: сайт и база не остановятся, но загрузки файлов прервутся на несколько секунд. '
      + 'Если Storage работает, ничего не произойдёт.',
    )) return;
    setRestarting(true);
    setMessage('');
    try {
      const response = await authFetch('/api/admin/storage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true }),
      });
      const payload = await response.json().catch(() => ({})) as StorageResponse;
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      setMessage('Перезапуск запущен — прогресс и журнал в блоке «Обновление проекта».');
      onStarted?.();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Не удалось запустить перезапуск');
    } finally {
      setRestarting(false);
    }
  }, [onStarted]);

  if (!agentConfigured) return null;

  const level = levelOf(data);
  const report = data?.report ?? null;
  const unavailable = data != null && data.available === false;
  const detail = Array.isArray(data?.detail) ? data.detail : [];

  return (
    <section className="ops-panel">
      <div className="ops-panel-head">
        <div>
          <h3><IconHardDrive size={15} /> Хранилище файлов (Supabase Storage)</h3>
          <p>
            Storage — отдельный стек Supabase, обновление проекта его не касается. Проверка читает состояние
            контейнера и список бакетов; перезапуск поднимает только сервис <code>storage</code>, если он лежит.
          </p>
        </div>
        <span className={`ops-status ops-status-${level}`}>
          <span className="ops-status-dot" />
          {LEVEL_LABEL[level]}
        </span>
      </div>

      {!agentConnected && (
        <div className="ops-notice ops-notice-warning">
          <IconAlert size={16} /> Update-агент не отвечает: проверить и перезапустить Storage из панели нельзя.
        </div>
      )}

      {unavailable && (
        <div className="ops-notice ops-notice-warning">
          <IconAlert size={16} /> {data?.reason || 'Проверить Storage не удалось.'}
        </div>
      )}

      {report && (
        <>
          <dl className="ops-facts">
            <div>
              <dt>Контейнер</dt>
              <dd>
                {STATE_RU[report.state] ?? report.state}
                {report.health !== 'none' ? ` · healthcheck: ${report.health === 'healthy' ? 'проходит' : report.health === 'unhealthy' ? 'не проходит' : 'запускается'}` : ''}
              </dd>
            </div>
            <div><dt>Перезапусков</dt><dd>{report.restarts}{report.oom ? ' · был OOM' : ''}</dd></div>
            <div><dt>API</dt><dd>{API_RU[report.api] ?? report.api} · {VIA_RU[report.apiVia] ?? report.apiVia}</dd></div>
            {report.state === 'exited' && report.exitCode != null && (
              <div><dt>Код выхода</dt><dd>{report.exitCode}</dd></div>
            )}
          </dl>
          {report.problem && (
            <div className={`ops-notice ${report.state === 'running' ? 'ops-notice-warning' : 'ops-notice-critical'}`}>
              {report.state === 'running' ? <IconAlert size={16} /> : <IconXCircle size={16} />}
              <span>
                {report.reason || 'Storage не работает.'}
                {report.restartable
                  ? ' Кнопка «Перезапустить Storage» поднимает только сервис storage.'
                  : ' Перезапуск это не лечит — исправьте ключ в .env стека Supabase.'}
              </span>
            </div>
          )}
          {!report.problem && report.state === 'running' && report.api === 'ok' && (
            <div className="ops-notice ops-notice-info">
              <IconCheckCircle size={16} /> Загрузки аватаров, логотипов и документов идут в Storage.
            </div>
          )}
          {report.reason && !report.problem && (
            <div className="ops-notice ops-notice-info"><IconAlert size={16} /> {report.reason}</div>
          )}
        </>
      )}

      {detail.length > 0 && (unavailable || report?.problem) && (
        <pre className="ops-log">{detail.join('\n')}</pre>
      )}

      <div className="ops-update-actions">
        <button
          type="button"
          className="ops-refresh-button"
          disabled={!agentConnected || loading}
          onClick={() => void load()}
        >
          <IconSync size={14} /> {loading ? 'Проверяю…' : 'Проверить'}
        </button>
        <button
          type="button"
          className="ops-button-primary"
          disabled={!agentConnected || restarting || data?.busy === true}
          title={data?.busy ? 'Агент занят другой задачей — дождитесь её окончания' : 'Перезапустить только сервис storage, если он не работает'}
          onClick={() => void restart()}
        >
          <IconRefresh size={14} /> {restarting ? 'Запускаю…' : 'Перезапустить Storage'}
        </button>
        {message && <span className="ops-inline-note">{message}</span>}
      </div>
    </section>
  );
}
