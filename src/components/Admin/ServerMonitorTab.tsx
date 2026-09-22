'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  IconActivity,
  IconAlert,
  IconCheckCircle,
  IconClock,
  IconPackage,
  IconRefresh,
  IconXCircle,
} from '@/components/Icons';
import { authFetch } from '@/lib/supabaseClient';
import type {
  MonitorContainer,
  MonitorJob,
  MonitorLevel,
  ServerMonitorSnapshot,
} from '@/types/monitor';

const REFRESH_MS = 20_000;

type MonitorResponse = { success: true; monitor: ServerMonitorSnapshot } | { error?: string };

const LEVEL_META: Record<MonitorLevel, { label: string; className: string }> = {
  healthy: { label: 'В норме', className: 'healthy' },
  warning: { label: 'Требует внимания', className: 'warning' },
  critical: { label: 'Недоступно', className: 'critical' },
  unknown: { label: 'Нет данных', className: 'unknown' },
};

function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const time = Date.parse(value);
  return Number.isFinite(time)
    ? new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(time))
    : '—';
}

function formatBytes(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value < 0) return '—';
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(Math.max(value, 1)) / Math.log(1024)));
  const scaled = value / 1024 ** index;
  return `${scaled >= 100 ? scaled.toFixed(0) : scaled.toFixed(1)} ${units[index]}`;
}

function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—';
  const units = [
    ['д', 86_400],
    ['ч', 3_600],
    ['м', 60],
    ['с', 1],
  ] as const;
  let rest = Math.floor(seconds);
  const parts: string[] = [];
  for (const [label, size] of units) {
    const amount = Math.floor(rest / size);
    if (amount > 0 || (label === 'с' && parts.length === 0)) parts.push(`${amount}${label}`);
    rest %= size;
    if (parts.length === 2) break;
  }
  return parts.join(' ');
}

function shortSha(value: string | null): string {
  return value ? value.slice(0, 12) : 'не задан';
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

function containerLevel(container: MonitorContainer): MonitorLevel {
  if (container.state === 'missing' || container.state === 'stopped' || container.health === 'unhealthy') return 'critical';
  if (container.state !== 'running' || container.health === 'starting' || container.restartCount > 3) return 'warning';
  return 'healthy';
}

function containerLabel(container: MonitorContainer): string {
  if (container.state === 'missing') return 'Контейнер не найден';
  if (container.state === 'stopped') return `Остановлен${container.exitCode != null ? ` · код ${container.exitCode}` : ''}`;
  if (container.health === 'unhealthy') return 'Healthcheck не пройден';
  if (container.health === 'starting') return 'Запускается';
  return container.health === 'healthy' ? 'Работает · healthcheck OK' : 'Работает';
}

function jobLevel(job: MonitorJob): MonitorLevel {
  return job.status === 'healthy' ? 'healthy' : job.status === 'warning' ? 'warning' : 'unknown';
}

function projectLevel(snapshot: ServerMonitorSnapshot): MonitorLevel {
  if (snapshot.project.updateStatus === 'current') return 'healthy';
  return snapshot.project.updateStatus === 'different' ? 'warning' : 'unknown';
}

export default function ServerMonitorTab() {
  const [snapshot, setSnapshot] = useState<ServerMonitorSnapshot | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    try {
      const response = await authFetch('/api/admin/monitor', { cache: 'no-store' });
      const data = await response.json().catch(() => ({})) as MonitorResponse;
      if (!response.ok || !('success' in data) || data.success !== true) {
        throw new Error(('error' in data && data.error) || `HTTP ${response.status}`);
      }
      setSnapshot(data.monitor);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось получить статус');
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [autoRefresh, load]);

  const dashboard = snapshot && (
    <>
      <section className="ops-summary-grid" aria-label="Сводка состояния">
        <article className="ops-summary-card">
          <div className="ops-summary-heading"><IconActivity size={16} /> Приложение</div>
          <StatusPill level="healthy" label="Отвечает" />
          <div className="ops-summary-value">{formatDuration(snapshot.application.uptimeSeconds)}</div>
          <div className="ops-summary-note">аптайм · Node {snapshot.application.nodeVersion}</div>
        </article>
        <article className="ops-summary-card">
          <div className="ops-summary-heading"><IconPackage size={16} /> База данных</div>
          <StatusPill level={snapshot.database.status} label={snapshot.database.status === 'healthy' ? 'Доступна' : undefined} />
          <div className="ops-summary-value">{snapshot.database.latencyMs == null ? '—' : `${snapshot.database.latencyMs} мс`}</div>
          <div className="ops-summary-note">
            {snapshot.database.configured ? 'проверка через Supabase REST' : 'не настроен service role key'}
          </div>
        </article>
        <article className="ops-summary-card">
          <div className="ops-summary-heading"><IconActivity size={16} /> Docker</div>
          <StatusPill
            level={!snapshot.agent.connected ? 'unknown' : !snapshot.docker.available ? 'critical' : snapshot.docker.containers.some((item) => containerLevel(item) === 'critical') ? 'critical' : snapshot.docker.containers.some((item) => containerLevel(item) === 'warning') ? 'warning' : 'healthy'}
            label={!snapshot.agent.connected ? 'Агент недоступен' : !snapshot.docker.available ? 'Нет доступа' : undefined}
          />
          <div className="ops-summary-value">{snapshot.docker.containers.length || '—'}</div>
          <div className="ops-summary-note">контейнеров проекта</div>
        </article>
        <article className="ops-summary-card">
          <div className="ops-summary-heading"><IconClock size={16} /> Обновления</div>
          <StatusPill level={projectLevel(snapshot)} />
          <div className="ops-summary-value ops-summary-sha">{shortSha(snapshot.project.currentSha)}</div>
          <div className="ops-summary-note">текущая сборка</div>
        </article>
      </section>

      <div className="ops-grid">
        <section className="ops-panel">
          <div className="ops-panel-head">
            <div>
              <h3>Контейнеры Docker</h3>
              <p>Только сервисы этого Compose-проекта. Логи, переменные и конфигурация не выводятся.</p>
            </div>
            {snapshot.agent.connected && snapshot.docker.available && <StatusPill level="healthy" label="Агент подключён" />}
          </div>
          {!snapshot.agent.configured && (
            <div className="ops-notice ops-notice-warning">
              <IconAlert size={16} /> Монитор Docker выключен: задайте <code>MONITOR_AGENT_TOKEN</code> в <code>.env.production</code> и пересоберите сервисы.
            </div>
          )}
          {snapshot.agent.configured && !snapshot.agent.connected && (
            <div className="ops-notice ops-notice-critical">
              <IconXCircle size={16} /> Приватный monitor-agent не отвечает. Проверьте статус сервиса и совпадение <code>MONITOR_AGENT_TOKEN</code>.
            </div>
          )}
          {snapshot.agent.connected && !snapshot.docker.available && (
            <div className="ops-notice ops-notice-critical">
              <IconXCircle size={16} /> Agent запущен, но Docker daemon недоступен. Внутренние данные Docker не раскрываются в интерфейсе.
            </div>
          )}
          {snapshot.agent.connected && snapshot.docker.available && (
            <div className="ops-container-list">
              {snapshot.docker.containers.map((container) => {
                const level = containerLevel(container);
                return (
                  <article className="ops-container-card" key={container.service}>
                    <div className="ops-container-topline">
                      <div>
                        <div className="ops-container-service">{container.service}</div>
                        <div className="ops-container-detail">{containerLabel(container)}</div>
                      </div>
                      <StatusPill level={level} />
                    </div>
                    <dl className="ops-facts">
                      <div><dt>Запущен</dt><dd>{formatDate(container.startedAt)}</dd></div>
                      <div><dt>Перезапуски</dt><dd>{container.restartCount}</dd></div>
                      <div><dt>Память</dt><dd>{container.metrics ? `${formatBytes(container.metrics.memoryBytes)}${container.metrics.memoryLimitBytes ? ` / ${formatBytes(container.metrics.memoryLimitBytes)}` : ''}` : '—'}</dd></div>
                      <div><dt>CPU</dt><dd>{container.metrics?.cpuPercent == null ? '—' : `${container.metrics.cpuPercent}%`}</dd></div>
                    </dl>
                  </article>
                );
              })}
            </div>
          )}
        </section>

        <section className="ops-panel">
          <div className="ops-panel-head">
            <div>
              <h3>Фоновые задачи</h3>
              <p>Последний успешный запуск из защищённого state-файла планировщика.</p>
            </div>
            <StatusPill
              level={!snapshot.scheduler.available ? 'unknown' : snapshot.scheduler.jobs.some((job) => job.status === 'warning') ? 'warning' : snapshot.scheduler.jobs.every((job) => job.status === 'healthy') && snapshot.scheduler.jobs.length ? 'healthy' : 'unknown'}
              label={snapshot.scheduler.available ? undefined : 'Нет state-файла'}
            />
          </div>
          {!snapshot.agent.connected ? (
            <div className="ops-empty">Подключите monitor-agent, чтобы видеть выполнение задач.</div>
          ) : !snapshot.scheduler.available ? (
            <div className="ops-empty">Планировщик ещё не записал состояние или state-файл недоступен.</div>
          ) : snapshot.scheduler.jobs.length === 0 ? (
            <div className="ops-empty">В <code>JOBS_ENABLED</code> нет включённых задач.</div>
          ) : (
            <div className="ops-jobs-list">
              {snapshot.scheduler.jobs.map((job) => (
                <article className="ops-job-row" key={job.name}>
                  <div className="ops-job-name"><StatusPill level={jobLevel(job)} /> <code>{job.name}</code></div>
                  <div className="ops-job-fact"><span>Последний успех</span><strong>{formatDate(job.lastSuccessAt)}</strong></div>
                  <div className="ops-job-fact"><span>Давность</span><strong>{formatDuration(job.ageSeconds)}</strong></div>
                  <div className="ops-job-fact"><span>Следующий слот</span><strong>{formatDate(job.nextRunAt)}</strong></div>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>

      <section className="ops-panel ops-project-panel">
        <div className="ops-panel-head">
          <div>
            <h3>Версия проекта</h3>
            <p>Сверка текущей сборки с веткой <code>{snapshot.project.upstreamBranch}</code> на GitHub выполняется не чаще раза в 5 минут.</p>
          </div>
          <StatusPill level={projectLevel(snapshot)} />
        </div>
        <div className="ops-project-grid">
          <div className="ops-project-item"><span>Текущий commit</span><strong><code>{shortSha(snapshot.project.currentSha)}</code></strong></div>
          <div className="ops-project-item"><span>Ветка сборки</span><strong>{snapshot.project.currentRef ?? '—'}</strong></div>
          <div className="ops-project-item"><span>Собрано</span><strong>{formatDate(snapshot.project.builtAt)}</strong></div>
          <div className="ops-project-item"><span>GitHub {snapshot.project.upstreamBranch}</span><strong><code>{shortSha(snapshot.project.upstreamSha)}</code></strong></div>
        </div>
        {snapshot.project.updateStatus === 'current' && (
          <div className="ops-notice ops-notice-healthy"><IconCheckCircle size={16} /> Сборка совпадает с последней ревизией main, проверенной {formatDate(snapshot.project.upstreamCheckedAt)}.</div>
        )}
        {snapshot.project.updateStatus === 'different' && (
          <div className="ops-notice ops-notice-warning"><IconAlert size={16} /> Ревизия main отличается от развёрнутой. Просмотрите изменения и выполните штатное обновление сервера.</div>
        )}
        {snapshot.project.updateStatus === 'unknown' && (
          <div className="ops-notice ops-notice-info"><IconAlert size={16} /> Точную сверку нельзя выполнить. Перед сборкой передайте <code>APP_GIT_SHA</code>, <code>APP_GIT_REF</code> и <code>APP_BUILD_TIME</code>.</div>
        )}
      </section>

      <section className="ops-panel ops-technical-panel">
        <h3>Технические сведения</h3>
        <dl className="ops-facts ops-technical-facts">
          <div><dt>Старт приложения</dt><dd>{formatDate(snapshot.application.startedAt)}</dd></div>
          <div><dt>Память процесса</dt><dd>{formatBytes(snapshot.application.memory.rssBytes)} RSS · {formatBytes(snapshot.application.memory.heapUsedBytes)} heap</dd></div>
          <div><dt>Проверка БД</dt><dd>{snapshot.database.latencyMs == null ? 'нет ответа' : `${snapshot.database.latencyMs} мс`}</dd></div>
          <div><dt>Обновлено</dt><dd>{formatDate(snapshot.checkedAt)}</dd></div>
        </dl>
      </section>
    </>
  );

  return (
    <div className="ops-monitor">
      <div className="ops-monitor-header">
        <div>
          <div className="ops-kicker">Operations center</div>
          <h2>Мониторинг сервера</h2>
          <p>Состояние сайта, базы данных, Docker, фоновых задач и развёрнутой версии проекта.</p>
        </div>
        <div className="ops-header-actions">
          {snapshot && <StatusPill level={snapshot.overall} label={LEVEL_META[snapshot.overall].label} />}
          <label className="ops-auto-refresh">
            <input type="checkbox" checked={autoRefresh} onChange={(event) => setAutoRefresh(event.target.checked)} />
            автообновление 20 с
          </label>
          <button type="button" className="ops-refresh-button" disabled={loading} onClick={() => void load()}>
            <IconRefresh size={14} /> {loading ? 'Обновление…' : 'Обновить'}
          </button>
        </div>
      </div>
      {error && <div className="ops-notice ops-notice-critical"><IconXCircle size={16} /> {error}</div>}
      {!snapshot && !error && <div className="ops-loading">Собираем безопасный статус сервисов…</div>}
      {dashboard}
    </div>
  );
}
