'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { IconAlert, IconCheckCircle, IconHardDrive, IconRefresh, IconSync, IconXCircle } from '@/components/Icons';
import { authFetch } from '@/lib/supabaseClient';
import { useI18n } from '@/lib/i18n/I18nContext';

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
  running: 'shp.stateRunning',
  exited: 'shp.stateExited',
  restarting: 'shp.stateRestarting',
  created: 'shp.stateCreated',
  paused: 'shp.statePaused',
  dead: 'shp.stateDead',
  missing: 'shp.stateMissing',
  unknown: 'shp.stateUnknown',
};

const API_RU: Record<string, string> = {
  ok: 'shp.apiOk',
  auth: 'shp.apiAuth',
  failed: 'shp.apiFailed',
  unknown: 'shp.apiUnknown',
};

const VIA_RU: Record<string, string> = {
  agent: 'shp.viaAgent',
  container: 'shp.viaContainer',
  none: 'shp.viaNone',
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
  healthy: 'shp.levelHealthy',
  warning: 'shp.levelWarning',
  critical: 'shp.levelCritical',
  unknown: 'shp.levelUnknown',
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
  const { t } = useI18n();
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
        setMessage(payload.error || t('shp.checkFailedHttp', { status: response.status }));
        return;
      }
      setData(payload);
      setMessage('');
    } catch (cause) {
      if (!alive.current) return;
      setData(null);
      setMessage(cause instanceof Error ? cause.message : t('shp.checkFailed'));
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [agentConfigured, t]);

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
    if (!window.confirm(t('shp.restartConfirm'))) return;
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
      setMessage(t('shp.restartStarted'));
      onStarted?.();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : t('shp.restartFailed'));
    } finally {
      setRestarting(false);
    }
  }, [onStarted, t]);

  if (!agentConfigured) return null;

  const level = levelOf(data);
  const report = data?.report ?? null;
  const unavailable = data != null && data.available === false;
  const detail = Array.isArray(data?.detail) ? data.detail : [];

  return (
    <section className="ops-panel">
      <div className="ops-panel-head">
        <div>
          <h3><IconHardDrive size={15} /> {t('shp.title')}</h3>
          <p>{t('shp.intro')}</p>
        </div>
        <span className={`ops-status ops-status-${level}`}>
          <span className="ops-status-dot" />
          {t(LEVEL_LABEL[level])}
        </span>
      </div>

      {!agentConnected && (
        <div className="ops-notice ops-notice-warning">
          <IconAlert size={16} /> {t('shp.agentDown')}
        </div>
      )}

      {unavailable && (
        <div className="ops-notice ops-notice-warning">
          <IconAlert size={16} /> {data?.reason || t('shp.checkFailedFallback')}
        </div>
      )}

      {report && (
        <>
          <dl className="ops-facts">
            <div>
              <dt>{t('shp.dtContainer')}</dt>
              <dd>
                {t(STATE_RU[report.state] ?? report.state)}
                {report.health !== 'none' ? t('shp.healthLine', { state: report.health === 'healthy' ? t('shp.healthOk') : report.health === 'unhealthy' ? t('shp.healthBad') : t('shp.healthStarting') }) : ''}
              </dd>
            </div>
            <div><dt>{t('shp.dtRestarts')}</dt><dd>{report.restarts}{report.oom ? t('shp.oom') : ''}</dd></div>
            <div><dt>{t('shp.dtApi')}</dt><dd>{t('shp.apiLine', { api: t(API_RU[report.api] ?? report.api), via: t(VIA_RU[report.apiVia] ?? report.apiVia) })}</dd></div>
            {report.state === 'exited' && report.exitCode != null && (
              <div><dt>{t('shp.dtExitCode')}</dt><dd>{report.exitCode}</dd></div>
            )}
          </dl>
          {report.problem && (
            <div className={`ops-notice ${report.state === 'running' ? 'ops-notice-warning' : 'ops-notice-critical'}`}>
              {report.state === 'running' ? <IconAlert size={16} /> : <IconXCircle size={16} />}
              <span>
                {report.reason || t('shp.problemDefault')}
                {report.restartable
                  ? t('shp.restartableHint')
                  : t('shp.notRestartableHint')}
              </span>
            </div>
          )}
          {!report.problem && report.state === 'running' && report.api === 'ok' && (
            <div className="ops-notice ops-notice-info">
              <IconCheckCircle size={16} /> {t('shp.allGood')}
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
          <IconSync size={14} /> {loading ? t('shp.checking') : t('shp.check')}
        </button>
        <button
          type="button"
          className="ops-button-primary"
          disabled={!agentConnected || restarting || data?.busy === true}
          title={data?.busy ? t('shp.busyTitle') : t('shp.restartTitle')}
          onClick={() => void restart()}
        >
          <IconRefresh size={14} /> {restarting ? t('shp.starting') : t('shp.restart')}
        </button>
        {message && <span className="ops-inline-note">{message}</span>}
      </div>
    </section>
  );
}
