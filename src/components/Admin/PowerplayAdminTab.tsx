'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { authFetch } from '@/lib/supabaseClient';
import { IconAlert, IconCheckCircle, IconClock, IconCopy, IconPower, IconRefresh, IconXCircle } from '@/components/Icons';
import { POWER_ALLEGIANCE_LABEL, formatPowerplayDate, powerInfo } from '@/lib/powerplay';
import {
  POWERPLAY_PHASE_LABEL,
  POWERPLAY_SYNC_STAGES,
  POWERPLAY_TRIGGER_LABEL,
  formatPowerplayCount,
  formatPowerplayDuration,
  powerplayStageFraction,
  sanitizePowerplayLog,
  sanitizePowerplayProgress,
  type PowerplayLogLine,
  type PowerplayStageProgress,
  type PowerplaySyncProgress,
} from '@/lib/powerplayProgress';

/**
 * Админка → Игровые данные → PowerPlay.
 *
 * Системы под контролем держав для вкладки «PowerPlay» в Atlas приходят из
 * ночного дампа EDSM (`powerPlay.json.gz`). Сайт обновляет их сам — задачей
 * планировщика `powerplay-sync` и при открытии вкладки, если данных нет, —
 * а здесь видно, загружено ли что-нибудь, и можно запустить загрузку вручную:
 * этапы с прогресс-барами, общий процент и журнал процесса.
 */

interface PowerSummaryRow {
  power: string;
  Stronghold: number;
  Fortified: number;
  Exploited: number;
  total: number;
}

interface AdminStatus {
  running: boolean;
  interrupted: boolean;
  progress: PowerplaySyncProgress | null;
  log: PowerplayLogLine[];
  state: {
    status: 'idle' | 'running' | 'ok' | 'error';
    source_url: string | null;
    etag: string | null;
    last_modified: string | null;
    dump_generated_at: string | null;
    run_id: string | null;
    rows_total: number;
    stats: Record<string, unknown> | null;
    error: string | null;
    attempt_at: string | null;
    checked_at: string | null;
    synced_at: string | null;
  };
  summary: {
    total: number;
    powers: PowerSummaryRow[];
    oldestObservation: string | null;
    newestObservation: string | null;
    lastChange: string | null;
  } | null;
  summaryError: string | null;
  progressPersisted: boolean;
  config: {
    dumpUrl: string;
    staleAfterHours: number;
    retryAfterMinutes: number;
    minRows: number;
    batchSize: number;
    nextScheduledRun: string | null;
    nextLazyAttempt: string | null;
  };
  serverTime: string;
}

const POLL_RUNNING_MS = 1000;
const POLL_IDLE_MS = 15000;

const cardStyle = {
  background: '#141618',
  border: '1px solid #323538',
  borderRadius: 4,
  padding: '12px 14px',
  marginBottom: 12,
} as const;

const labelStyle = { fontSize: 11, color: '#9ca3af', textTransform: 'uppercase' as const, marginBottom: 6, letterSpacing: 0.5 };
const MUTED = '#9ca3af';
const DIM = '#6b7280';
const TEXT = '#e5e7eb';
const PP = '#f0af28';

const STAGE_COLORS: Record<PowerplayStageProgress['status'], string> = {
  pending: '#4b5563',
  running: PP,
  done: '#22c55e',
  skipped: '#6b7280',
  error: '#ef4444',
};

function formatTime(value: string | null | undefined): string {
  if (!value) return '—';
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toLocaleString('ru-RU') : value;
}

function formatClock(value: string): string {
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
}

function formatUtc(value: string | null | undefined): string {
  if (!value) return '—';
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return value;
  const date = new Date(at);
  return `${formatTime(value)} (${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')} UTC)`;
}

function stageStatusLabel(stage: PowerplayStageProgress, phase: PowerplaySyncProgress['phase']): string {
  switch (stage.status) {
    case 'running':
      return 'идёт';
    case 'done':
      return 'готово';
    case 'skipped':
      return 'не нужен';
    case 'error':
      return phase === 'cancelled' ? 'остановлен' : 'ошибка';
    default:
      return 'ждёт';
  }
}

function stageDuration(stage: PowerplayStageProgress, serverNow: number): string {
  if (!stage.startedAt) return '';
  const start = Date.parse(stage.startedAt);
  const end = stage.finishedAt ? Date.parse(stage.finishedAt) : serverNow;
  return Number.isFinite(start) && Number.isFinite(end) ? formatPowerplayDuration(Math.max(0, end - start)) : '';
}

function phasePill(status: AdminStatus | null): { text: string; color: string } {
  if (!status) return { text: 'загрузка…', color: MUTED };
  if (status.running) return { text: 'идёт загрузка', color: PP };
  if (status.interrupted) return { text: 'прервана перезапуском сайта', color: '#e67e22' };
  if (status.state.status === 'error') return { text: status.state.rows_total > 0 ? 'ошибка последней загрузки' : 'ошибка — данных нет', color: '#ef4444' };
  if (status.state.rows_total > 0) return { text: 'данные загружены', color: '#22c55e' };
  return { text: 'данных нет', color: MUTED };
}

function ProgressBar({ fraction, color, height = 8, indeterminate = false, label }: { fraction: number; color: string; height?: number; indeterminate?: boolean; label?: string }) {
  const percent = Math.max(0, Math.min(100, fraction * 100));
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(percent)}
      aria-label={label}
      style={{ height, background: '#22252a', borderRadius: height / 2, overflow: 'hidden', position: 'relative' }}
    >
      <div
        style={{
          width: indeterminate ? '30%' : `${percent}%`,
          height: '100%',
          background: color,
          transition: 'width 0.5s',
          animation: indeterminate ? 'pp-admin-indeterminate 1.2s ease-in-out infinite' : undefined,
          position: indeterminate ? 'absolute' : undefined,
        }}
      />
    </div>
  );
}

export default function PowerplayAdminTab() {
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [isError, setIsError] = useState(false);
  const [copied, setCopied] = useState(false);
  const logRef = useRef<HTMLPreElement | null>(null);
  const stickToBottom = useRef(true);

  const load = useCallback(async () => {
    try {
      const response = await authFetch('/api/admin/powerplay', { cache: 'no-store' });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload || payload.success === false) {
        throw new Error(payload?.error || `HTTP ${response.status}`);
      }
      setStatus({
        ...payload,
        progress: sanitizePowerplayProgress(payload.progress),
        log: sanitizePowerplayLog(payload.log),
      } as AdminStatus);
      setLoadError('');
    } catch (error) {
      setLoadError((error as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const running = Boolean(status?.running);
  useEffect(() => {
    const timer = window.setInterval(() => void load(), running ? POLL_RUNNING_MS : POLL_IDLE_MS);
    return () => window.clearInterval(timer);
  }, [running, load]);

  // Журнал прокручивается вниз за новыми строками, пока админ сам не отмотал его вверх.
  const logLength = status?.log.length ?? 0;
  const lastLogAt = status?.log[logLength - 1]?.at ?? '';
  useEffect(() => {
    const el = logRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [logLength, lastLogAt]);

  const act = async (action: 'start' | 'cancel', force = false) => {
    setBusy(force ? 'force' : action);
    setMessage('');
    setIsError(false);
    try {
      const response = await authFetch('/api/admin/powerplay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, force }),
      });
      const payload = await response.json().catch(() => null);
      if (response.status === 409) {
        setMessage(payload?.reason || 'Импорт уже идёт');
      } else if (!response.ok || payload?.success === false) {
        throw new Error(payload?.error || `HTTP ${response.status}`);
      } else if (action === 'cancel') {
        setMessage(payload?.cancelled ? 'Останавливаю импорт…' : 'Импорт не выполнялся');
      } else {
        setMessage(force
          ? 'Загрузка запущена принудительно: дамп скачивается заново и принимается, даже если он меньше прошлого.'
          : 'Загрузка запущена. Если дамп не менялся с прошлого раза, EDSM ответит 304 — это значит «данные актуальны».');
      }
      stickToBottom.current = true;
      await load();
    } catch (error) {
      setMessage((error as Error).message);
      setIsError(true);
    } finally {
      setBusy(null);
    }
  };

  const copyLog = async () => {
    if (!status?.log.length) return;
    const text = status.log.map((line) => `${line.at} ${line.level.toUpperCase()} ${line.text}`).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  const pill = phasePill(status);
  const progress = status?.progress ?? null;
  const serverNow = status ? Date.parse(status.serverTime) || Date.now() : Date.now();
  const elapsed = progress ? Math.max(0, (progress.finishedAt ? Date.parse(progress.finishedAt) : serverNow) - Date.parse(progress.startedAt)) : 0;
  const summary = status?.summary ?? null;
  const total = summary?.total ?? status?.state.rows_total ?? 0;
  const maxPower = useMemo(() => Math.max(1, ...(summary?.powers ?? []).map((row) => row.total)), [summary]);
  const stateTotals = useMemo(() => {
    const out = { Stronghold: 0, Fortified: 0, Exploited: 0 };
    for (const row of summary?.powers ?? []) {
      out.Stronghold += row.Stronghold;
      out.Fortified += row.Fortified;
      out.Exploited += row.Exploited;
    }
    return out;
  }, [summary]);

  return (
    <div data-powerplay-admin="">
      <style>{'@keyframes pp-admin-indeterminate { 0% { left: -30%; } 100% { left: 100%; } }'}</style>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <IconPower size={16} color={PP} /> PowerPlay: системы держав (EDSM)
        </h3>
        <span style={{ fontSize: 12, color: pill.color }} data-pp-admin-pill="">● {pill.text}</span>
        <button type="button" className="btn" style={{ fontSize: 12, padding: '3px 8px' }} onClick={() => void load()}>
          <IconRefresh size={12} color="#9ca3af" /> Обновить
        </button>
      </div>

      {loadError && (
        <div style={{ ...cardStyle, borderColor: '#7f1d1d', color: '#fca5a5', fontSize: 13 }} role="alert">
          <IconXCircle size={14} color="#ef4444" /> {loadError}
        </div>
      )}

      {/* ── Что сейчас на сайте ── */}
      <div style={cardStyle} data-pp-admin-data="">
        <div style={labelStyle}>Данные на сайте</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 10 }}>
          <Stat label="Систем в базе" value={formatPowerplayCount(total)} color={total > 0 ? '#22c55e' : MUTED} />
          <Stat label="Держав" value={summary ? String(summary.powers.length) : '—'} />
          <Stat label="Дамп EDSM от" value={formatTime(status?.state.dump_generated_at)} small />
          <Stat label="Записано на сайт" value={formatTime(status?.state.synced_at)} small />
          <Stat label="Проверено источником" value={formatTime(status?.state.checked_at)} small />
        </div>
        {total > 0 && summary && (
          <div style={{ fontSize: 12, color: MUTED, marginBottom: 8 }}>
            Оплоты {formatPowerplayCount(stateTotals.Stronghold)} · укреплённые {formatPowerplayCount(stateTotals.Fortified)} ·
            эксплуатируемые {formatPowerplayCount(stateTotals.Exploited)}
            {summary.oldestObservation && summary.newestObservation && (
              <> · наблюдения пилотов {formatPowerplayDate(summary.oldestObservation)} – {formatPowerplayDate(summary.newestObservation)}</>
            )}
          </div>
        )}
        {status && total === 0 && !running && (
          <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: 13, color: '#fbbf24', marginBottom: 8 }}>
            <IconAlert size={14} color="#fbbf24" />
            <span>
              Систем PowerPlay в базе нет — вкладка «PowerPlay» в Atlas пуста. Нажмите «Загрузить сейчас» ниже: загрузка
              займёт несколько секунд, ход виден по этапам и в журнале.
            </span>
          </div>
        )}
        {status?.state.status === 'error' && status.state.error && (
          <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: 13, color: '#ef4444', marginBottom: 8 }} data-pp-admin-error="">
            <IconXCircle size={14} color="#ef4444" />
            <span>
              Последняя загрузка не удалась: {status.state.error}
              {status.state.rows_total > 0 ? ' — на карте остались данные прошлой удачной загрузки.' : ''}
            </span>
          </div>
        )}
        {status?.summaryError && <div style={{ fontSize: 12, color: '#e67e22', marginBottom: 8 }}>{status.summaryError}</div>}

        {summary && summary.powers.length > 0 && (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }} aria-label="Системы по державам">
            <thead>
              <tr style={{ color: DIM, textAlign: 'left' }}>
                <th style={{ padding: '4px 6px', fontWeight: 500 }}>Держава</th>
                <th style={{ padding: '4px 6px', fontWeight: 500, textAlign: 'right' }}>Оплоты</th>
                <th style={{ padding: '4px 6px', fontWeight: 500, textAlign: 'right' }}>Укреплённые</th>
                <th style={{ padding: '4px 6px', fontWeight: 500, textAlign: 'right' }}>Эксплуат.</th>
                <th style={{ padding: '4px 6px', fontWeight: 500, textAlign: 'right' }}>Всего</th>
                <th style={{ padding: '4px 6px', width: '22%' }} aria-hidden="true" />
              </tr>
            </thead>
            <tbody>
              {summary.powers.map((row) => {
                const info = powerInfo(row.power);
                return (
                  <tr key={row.power} data-pp-admin-power={row.power} style={{ borderTop: '1px solid #24272a' }}>
                    <td style={{ padding: '4px 6px', color: TEXT, whiteSpace: 'nowrap' }}>
                      <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: info.color, marginRight: 6, verticalAlign: 'middle' }} />
                      {info.label}
                      {info.allegiance && <span style={{ color: DIM, fontSize: 10 }}> · {POWER_ALLEGIANCE_LABEL[info.allegiance]}</span>}
                    </td>
                    <td style={{ padding: '4px 6px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{formatPowerplayCount(row.Stronghold)}</td>
                    <td style={{ padding: '4px 6px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{formatPowerplayCount(row.Fortified)}</td>
                    <td style={{ padding: '4px 6px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{formatPowerplayCount(row.Exploited)}</td>
                    <td style={{ padding: '4px 6px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: TEXT, fontWeight: 600 }}>{formatPowerplayCount(row.total)}</td>
                    <td style={{ padding: '4px 6px' }}>
                      <ProgressBar fraction={row.total / maxPower} color={info.color} height={6} label={`${info.label}: ${row.total}`} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Загрузка ── */}
      <div style={cardStyle} data-pp-admin-sync="">
        <div style={labelStyle}>Загрузка из EDSM</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
          <button type="button" className="btn btn-cyan" disabled={busy !== null || running} onClick={() => void act('start')} data-pp-admin-action="start">
            {total > 0 ? 'Загрузить сейчас' : 'Загрузить данные'}
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy !== null || running}
            onClick={() => void act('start', true)}
            title="Скачать дамп заново без условного запроса и принять его, даже если он заметно меньше прошлого"
            data-pp-admin-action="force"
          >
            Перекачать принудительно
          </button>
          <button type="button" className="btn btn-danger" disabled={busy !== null || !running} onClick={() => void act('cancel')} data-pp-admin-action="cancel">
            Остановить
          </button>
        </div>

        {progress ? (
          <div data-pp-admin-progress={progress.phase}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12, color: MUTED, marginBottom: 4, flexWrap: 'wrap' }}>
              <span style={{ color: progress.phase === 'running' ? PP : progress.phase === 'error' ? '#ef4444' : progress.phase === 'cancelled' ? '#e67e22' : '#22c55e' }}>
                {progress.phase === 'running' ? 'Идёт загрузка' : `Последняя загрузка: ${POWERPLAY_PHASE_LABEL[progress.phase]}`}
                {' · '}{progress.percent.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} %
              </span>
              <span>
                <IconClock size={11} /> {formatPowerplayDuration(elapsed)} · {formatTime(progress.startedAt)}
              </span>
            </div>
            <ProgressBar
              fraction={progress.percent / 100}
              color={progress.phase === 'error' ? '#ef4444' : progress.phase === 'cancelled' ? '#e67e22' : progress.phase === 'running' ? PP : '#22c55e'}
              height={10}
              label="Общий ход загрузки"
            />
            <div style={{ fontSize: 12, color: TEXT, marginTop: 6 }} data-pp-admin-message="">{progress.message}</div>
            <div style={{ fontSize: 11, color: DIM, marginTop: 2 }}>
              Запуск: {POWERPLAY_TRIGGER_LABEL[progress.trigger]}{progress.force ? ' · принудительно' : ''}
            </div>

            <ol style={{ listStyle: 'none', margin: '10px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 7 }} aria-label="Этапы загрузки">
              {POWERPLAY_SYNC_STAGES.map((def) => {
                const stage = progress.stages.find((item) => item.id === def.id);
                if (!stage) return null;
                const color = STAGE_COLORS[stage.status];
                const indeterminate = stage.status === 'running' && !(stage.total && stage.total > 0);
                return (
                  <li key={def.id} data-pp-admin-stage={def.id} data-status={stage.status} style={{ display: 'grid', gridTemplateColumns: '150px minmax(0, 1fr) 90px', gap: 8, alignItems: 'center', fontSize: 12 }}>
                    <span style={{ color: stage.status === 'pending' ? DIM : TEXT, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      {stage.status === 'done' ? <IconCheckCircle size={12} color={color} /> : stage.status === 'error' ? <IconXCircle size={12} color={color} /> : (
                        <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: color, marginLeft: 2, marginRight: 2 }} />
                      )}
                      {def.label}
                    </span>
                    <span style={{ minWidth: 0 }}>
                      <ProgressBar fraction={powerplayStageFraction(stage)} color={color} height={6} indeterminate={indeterminate} label={def.label} />
                      <span style={{ display: 'block', fontSize: 11, color: MUTED, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {stage.detail || stageStatusLabel(stage, progress.phase)}
                      </span>
                    </span>
                    <span style={{ fontSize: 11, color: DIM, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                      {stageStatusLabel(stage, progress.phase)}
                      {stageDuration(stage, serverNow) ? <><br />{stageDuration(stage, serverNow)}</> : null}
                    </span>
                  </li>
                );
              })}
            </ol>

            {progress.phase === 'ok' && progress.result && (
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', color: '#22c55e', fontSize: 13, marginTop: 10 }}>
                <IconCheckCircle size={14} color="#22c55e" />
                Записано {formatPowerplayCount(progress.result.rows)} систем, удалено пропавших {formatPowerplayCount(progress.result.deleted)},
                всего на карте {formatPowerplayCount(progress.result.total)} · за {formatPowerplayDuration(progress.result.durationMs)}
              </div>
            )}
            {progress.phase === 'not_modified' && (
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', color: '#22c55e', fontSize: 13, marginTop: 10 }}>
                <IconCheckCircle size={14} color="#22c55e" />
                EDSM ответил 304: дамп не менялся с прошлой загрузки, данные на сайте актуальны.
              </div>
            )}
            {(progress.phase === 'error' || progress.phase === 'cancelled') && progress.result?.error && (
              <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', color: progress.phase === 'cancelled' ? '#e67e22' : '#ef4444', fontSize: 13, marginTop: 10 }}>
                <IconXCircle size={14} color={progress.phase === 'cancelled' ? '#e67e22' : '#ef4444'} />
                <span>{progress.result.error}</span>
              </div>
            )}
          </div>
        ) : (
          <div style={{ fontSize: 12, color: MUTED }}>
            {status ? 'Загрузок с момента обновления сайта ещё не было. Нажмите «Загрузить данные» — прогресс появится здесь.' : 'Загружаю состояние…'}
          </div>
        )}

        {status?.interrupted && (
          <div style={{ fontSize: 12, color: '#e67e22', marginTop: 8 }}>
            Прошлая загрузка оборвалась вместе с процессом сайта (обновление или перезапуск). Данные в базе согласованы —
            просто запустите загрузку ещё раз.
          </div>
        )}

        <div style={{ fontSize: 12, color: MUTED, lineHeight: 1.6, marginTop: 12 }}>
          Источник: <code>{status?.config.dumpUrl ?? 'https://www.edsm.net/dump/powerPlay.json.gz'}</code> — ночной дамп EDSM
          (≈3–4 МБ gzip): все системы, о состоянии PowerPlay которых пилоты сообщали за последние ~30 дней. На сайт
          попадают системы под контролем (оплоты, укреплённые, эксплуатируемые); Unoccupied отбрасываются.
          <br />
          Автоматически: задача планировщика <code>powerplay-sync</code> раз в 12 часов
          {status?.config.nextScheduledRun ? <> (ближайший запуск — {formatUtc(status.config.nextScheduledRun)}, если задача включена в <code>JOBS_ENABLED</code>)</> : null},
          а также при открытии вкладки PowerPlay, если данных нет или они старше {status?.config.staleAfterHours ?? 26} ч
          (после неудачи — не чаще раза в {status?.config.retryAfterMinutes ?? 30} мин
          {status?.config.nextLazyAttempt ? <>, следующая попытка не раньше {formatTime(status.config.nextLazyAttempt)}</> : null}).
          <br />
          Защита данных: битый gzip, ошибка HTTP, меньше {status?.config.minRows ?? 100} систем или дамп меньше половины прошлого
          таблицу не трогают — карта остаётся со вчерашними данными. «Перекачать принудительно» снимает проверку на «усохший» дамп.
        </div>
      </div>

      {/* ── Журнал ── */}
      <div style={cardStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <div style={{ ...labelStyle, marginBottom: 0 }}>Журнал процесса{status?.log.length ? ` (${status.log.length})` : ''}</div>
          <button type="button" className="btn" style={{ fontSize: 11, padding: '2px 8px' }} onClick={() => void copyLog()} disabled={!status?.log.length}>
            <IconCopy size={11} /> {copied ? 'Скопировано' : 'Скопировать'}
          </button>
        </div>
        {status?.log.length ? (
          <pre
            ref={logRef}
            data-pp-admin-log=""
            onScroll={(event) => {
              const el = event.currentTarget;
              stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
            }}
            style={{
              margin: 0,
              maxHeight: 320,
              overflow: 'auto',
              background: '#0f1113',
              border: '1px solid #262a2e',
              borderRadius: 4,
              padding: 8,
              fontSize: 11,
              lineHeight: 1.55,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {status.log.map((line, index) => (
              <div
                key={`${line.at}-${index}`}
                data-level={line.level}
                style={{
                  color: line.level === 'error' ? '#f87171' : line.level === 'warn' ? '#fbbf24' : /^Запуск импорта/.test(line.text) ? TEXT : MUTED,
                  borderTop: /^Запуск импорта/.test(line.text) && index > 0 ? '1px dashed #2d3136' : undefined,
                  paddingTop: /^Запуск импорта/.test(line.text) && index > 0 ? 4 : undefined,
                  marginTop: /^Запуск импорта/.test(line.text) && index > 0 ? 4 : undefined,
                }}
              >
                <span style={{ color: DIM }}>{formatClock(line.at)}</span> {line.text}
              </div>
            ))}
          </pre>
        ) : (
          <div style={{ fontSize: 12, color: DIM }}>Журнал пуст — он появится с первой загрузкой.</div>
        )}
        {status && !status.progressPersisted && !running && (
          <div style={{ fontSize: 11, color: DIM, marginTop: 6 }}>
            Журнал хранится в базе после миграции <code>20261018180000_powerplay_sync_progress.sql</code>; без неё он виден до
            перезапуска сайта.
          </div>
        )}
      </div>

      {message && (
        <div style={{ fontSize: 13, color: isError ? '#ef4444' : '#22c55e' }} role="status">{message}</div>
      )}
    </div>
  );
}

function Stat({ label, value, color, small = false }: { label: string; value: string; color?: string; small?: boolean }) {
  return (
    <div style={{ background: '#101214', border: '1px solid #26292d', borderRadius: 4, padding: '8px 10px' }}>
      <div style={{ fontSize: 10, color: DIM, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: small ? 13 : 20, color: color ?? TEXT, fontWeight: 600, marginTop: 2, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
    </div>
  );
}
