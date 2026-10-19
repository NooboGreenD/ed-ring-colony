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
 *
 * Таблица по державам показывает и то, откуда известен владелец системы:
 * дамп EDSM перечисляет у системы все державы, чьи зоны её накрывают, и не
 * говорит, какая владелец, — у спорных систем его называют только журналы
 * (Colonial Helper, сайт, CAPI) и живые данные EDDN.
 */

interface PowerSummaryRow {
  power: string;
  Stronghold: number;
  Fortified: number;
  Exploited: number;
  total: number;
  journal?: number;
  sole?: number;
  kept?: number;
  legacy?: number;
  contested?: number;
}

interface UnknownSummary {
  total: number;
  Stronghold: number;
  Fortified: number;
  Exploited: number;
}

/** Слушатель живых данных EDDN (`src/lib/eddn/listener.ts`). */
interface EddnAdminStatus {
  enabled: boolean;
  forbidden: boolean;
  supported: boolean;
  running: boolean;
  status: 'off' | 'connecting' | 'connected' | 'waiting';
  relay: string;
  stats: {
    startedAt?: string | null;
    connectedAt?: string | null;
    lastMessageAt?: string | null;
    lastFlushAt?: string | null;
    attempts?: number;
    sessions?: number;
    stalls?: number;
    lastSessionBytes?: number;
    bytes?: number;
    messages?: number;
    journal?: number;
    observations?: number;
    skipped?: { legacy?: number; test?: number; broken?: number; other?: number; overflow?: number };
    powerplay?: { applied?: number; created?: number; resolved?: number; vacated?: number; stale?: number };
    factions?: { applied?: number; created?: number; stale?: number };
    flushes?: number;
    flushErrors?: number;
  };
  log: PowerplayLogLine[];
  error: string | null;
  nextAttemptAt: string | null;
  pending?: number;
  enabledAt?: string | null;
  heartbeatAt?: string | null;
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
    sources?: Record<string, number>;
    unknown?: UnknownSummary;
    bases?: Record<string, number>;
    vacated?: number;
    oldestObservation: string | null;
    newestObservation: string | null;
    lastChange: string | null;
  } | null;
  summaryError: string | null;
  eddn?: EddnAdminStatus;
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

  const act = async (action: 'start' | 'cancel' | 'eddn-start' | 'eddn-stop', force = false) => {
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
      } else if (action === 'eddn-start') {
        setMessage('Живые данные EDDN включены: слушатель подключается к реле. Флаг сохранён — после перезапуска сайта слушатель поднимется сам.');
      } else if (action === 'eddn-stop') {
        setMessage('Живые данные EDDN выключены: накопленные наблюдения дописаны, подписка закрыта.');
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
  const maxPower = useMemo(
    () => Math.max(1, summary?.unknown?.total ?? 0, ...(summary?.powers ?? []).map((row) => row.total)),
    [summary],
  );
  const stateTotals = useMemo(() => {
    const out = { Stronghold: 0, Fortified: 0, Exploited: 0 };
    for (const row of [...(summary?.powers ?? []), ...(summary?.unknown ? [summary.unknown] : [])]) {
      out.Stronghold += row.Stronghold;
      out.Fortified += row.Fortified;
      out.Exploited += row.Exploited;
    }
    return out;
  }, [summary]);
  const unknownOwners = summary?.unknown?.total ?? 0;
  // Сводка старой базы (без миграции 20261021120000) не знает оснований.
  const basesKnown = Boolean(summary?.bases && Object.keys(summary.bases).length > 0);
  const legacyRows = summary?.bases?.legacy ?? 0;
  // Системы, где данные пилотов свежее дампа (Helper, сайт, CAPI) — не «edsm».
  const pilotRows = Object.entries(summary?.sources ?? {})
    .filter(([source]) => source !== 'edsm')
    .reduce((sum, [, value]) => sum + value, 0);

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
          <Stat label="Держав" value={summary ? String(summary.powers.filter((row) => row.total > 0).length) : '—'} />
          {basesKnown && (
            <Stat label="Владелец не определён" value={formatPowerplayCount(unknownOwners)} color={unknownOwners > 0 ? '#fbbf24' : '#22c55e'} />
          )}
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
        {basesKnown && total > 0 && (
          <div style={{ fontSize: 12, color: MUTED, marginBottom: 8, lineHeight: 1.5 }} data-pp-admin-bases="">
            Владелец системы: по журналам (ControllingPower) {formatPowerplayCount(summary?.bases?.journal ?? 0)} ·
            по дампу EDSM, где держава одна, {formatPowerplayCount(summary?.bases?.sole ?? 0)} ·
            сохранён из прошлых точных данных {formatPowerplayCount(summary?.bases?.kept ?? 0)} ·
            не определён {formatPowerplayCount(unknownOwners)}
            {legacyRows > 0 && <> · по прежнему разбору (до перезагрузки) {formatPowerplayCount(legacyRows)}</>}
            {unknownOwners > 0 && (
              <div style={{ color: DIM, marginTop: 2 }}>
                Дамп EDSM перечисляет у системы все державы, чьи зоны её накрывают, и не говорит, какая из них владелец.
                У таких систем владельца называют только журналы пилотов и EDDN — включите «Живые данные EDDN» ниже, чтобы
                число «не определён» таяло. «+N?» в таблице — в скольких таких системах держава среди претендентов: её
                настоящее число систем — от «Всего» до «Всего + N».
              </div>
            )}
          </div>
        )}
        {summary && (pilotRows > 0 || (summary.vacated ?? 0) > 0) && (
          <div style={{ fontSize: 12, color: MUTED, marginBottom: 8 }} data-pp-admin-pilots="">
            Из журналов пилотов (Colonial Helper, загрузка на сайте, CAPI): {formatPowerplayCount(pilotRows)} систем свежее дампа
            {(summary.vacated ?? 0) > 0 && <> · {formatPowerplayCount(summary.vacated ?? 0)} систем пилоты увидели свободными</>}
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
                {basesKnown && (
                  <th style={{ padding: '4px 6px', fontWeight: 500, textAlign: 'right' }} title="Систем с неопределённым владельцем, где держава среди претендентов">
                    +спорных
                  </th>
                )}
                {basesKnown && <th style={{ padding: '4px 6px', fontWeight: 500 }}>Откуда известно</th>}
                <th style={{ padding: '4px 6px', width: '18%' }} aria-hidden="true" />
              </tr>
            </thead>
            <tbody>
              {summary.powers.map((row) => {
                const info = powerInfo(row.power);
                const basisParts = [
                  row.journal ? `журнал ${formatPowerplayCount(row.journal)}` : '',
                  row.sole ? `EDSM ${formatPowerplayCount(row.sole)}` : '',
                  row.kept ? `прошлое ${formatPowerplayCount(row.kept)}` : '',
                  row.legacy ? `старый разбор ${formatPowerplayCount(row.legacy)}` : '',
                ].filter(Boolean);
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
                    {basesKnown && (
                      <td style={{ padding: '4px 6px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: row.contested ? '#fbbf24' : DIM }} data-pp-admin-contested={row.contested ?? 0}>
                        {row.contested ? `+${formatPowerplayCount(row.contested)}` : '—'}
                      </td>
                    )}
                    {basesKnown && <td style={{ padding: '4px 6px', color: DIM, fontSize: 11 }}>{basisParts.join(' · ') || '—'}</td>}
                    <td style={{ padding: '4px 6px' }}>
                      <ProgressBar fraction={row.total / maxPower} color={info.color} height={6} label={`${info.label}: ${row.total}`} />
                    </td>
                  </tr>
                );
              })}
              {basesKnown && unknownOwners > 0 && summary.unknown && (
                <tr data-pp-admin-power="unknown" style={{ borderTop: '1px solid #24272a', color: '#fbbf24' }}>
                  <td style={{ padding: '4px 6px', whiteSpace: 'nowrap', fontStyle: 'italic' }}>
                    <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: powerInfo('?').color, marginRight: 6, verticalAlign: 'middle' }} />
                    Владелец не определён
                  </td>
                  <td style={{ padding: '4px 6px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{formatPowerplayCount(summary.unknown.Stronghold)}</td>
                  <td style={{ padding: '4px 6px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{formatPowerplayCount(summary.unknown.Fortified)}</td>
                  <td style={{ padding: '4px 6px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{formatPowerplayCount(summary.unknown.Exploited)}</td>
                  <td style={{ padding: '4px 6px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{formatPowerplayCount(summary.unknown.total)}</td>
                  <td style={{ padding: '4px 6px' }} />
                  <td style={{ padding: '4px 6px', color: DIM, fontSize: 11 }}>EDSM: несколько держав</td>
                  <td style={{ padding: '4px 6px' }}>
                    <ProgressBar fraction={summary.unknown.total / maxPower} color={powerInfo('?').color} height={6} label={`Не определён: ${summary.unknown.total}`} />
                  </td>
                </tr>
              )}
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

      {/* ── Живые данные EDDN ── */}
      {status?.eddn && (
        <EddnCard
          eddn={status.eddn}
          busy={busy}
          onStart={() => void act('eddn-start')}
          onStop={() => void act('eddn-stop')}
        />
      )}

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

const EDDN_STATUS: Record<EddnAdminStatus['status'], { text: string; color: string }> = {
  off: { text: 'выключено', color: MUTED },
  connecting: { text: 'подключение к реле…', color: PP },
  connected: { text: 'получает данные', color: '#22c55e' },
  waiting: { text: 'ждёт переподключения', color: '#fbbf24' },
};

function EddnCard({ eddn, busy, onStart, onStop }: { eddn: EddnAdminStatus; busy: string | null; onStart: () => void; onStop: () => void }) {
  const stats = eddn.stats ?? {};
  const pill = eddn.running ? EDDN_STATUS[eddn.status] ?? EDDN_STATUS.off : eddn.enabled ? { text: 'включено, слушатель не запущен', color: '#fbbf24' } : EDDN_STATUS.off;
  const log = (eddn.log ?? []).slice(-15);
  const count = (value: number | undefined) => formatPowerplayCount(value ?? 0);
  return (
    <div style={cardStyle} data-pp-admin-eddn={eddn.running ? eddn.status : eddn.enabled ? 'enabled' : 'off'}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
        <div style={{ ...labelStyle, marginBottom: 0 }}>Живые данные EDDN — владелец систем из журналов пилотов</div>
        <span style={{ fontSize: 12, color: pill.color }}>● {pill.text}</span>
      </div>
      <div style={{ fontSize: 12, color: MUTED, lineHeight: 1.5, marginBottom: 8 }}>
        Дамп EDSM не говорит, какая держава владеет спорной системой. Это знает журнал игры (поле ControllingPower), а его шлют
        в EDDN тысячи пилотов — оттуда же данные у EDSM, Spansh и Inara. Слушатель берёт из потока прыжки и входы в игру и
        обновляет PowerPlay (владелец, состояние) и фракции — тем же разбором, что журналы Colonial Helper.
        <br />
        <span style={{ color: DIM }}>
          Трафик — около 2–5 ГБ в сутки (реле не фильтрует по типу данных). Сервер в России: долгие соединения к зарубежным
          хостингам ТСПУ может «замораживать» — слушатель тогда сам переподключается, а журнал ниже покажет, сколько данных
          успевает прийти до замирания.
        </span>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        {eddn.enabled ? (
          <button type="button" className="btn btn-danger" disabled={busy !== null} onClick={onStop} data-pp-admin-action="eddn-stop">
            Выключить EDDN
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-cyan"
            disabled={busy !== null || !eddn.supported || eddn.forbidden}
            onClick={onStart}
            data-pp-admin-action="eddn-start"
          >
            Включить EDDN
          </button>
        )}
        <span style={{ fontSize: 11, color: DIM, alignSelf: 'center' }}>реле {eddn.relay}</span>
      </div>
      {!eddn.supported && (
        <div style={{ fontSize: 12, color: '#fbbf24', marginBottom: 8 }}>
          Нет таблицы <code>eddn_listener_state</code>: примените миграцию <code>20261021130000_eddn_listener.sql</code> (Мониторинг → «Обновить сейчас»).
        </div>
      )}
      {eddn.forbidden && (
        <div style={{ fontSize: 12, color: '#fbbf24', marginBottom: 8 }}>
          На сервере задано <code>EDDN_LISTENER=off</code> — слушатель запрещён, пока переменную не уберут.
        </div>
      )}
      {(eddn.running || (stats.messages ?? 0) > 0) && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8, marginBottom: 8 }} data-pp-admin-eddn-stats="">
          <Stat label="Сообщений" value={count(stats.messages)} small />
          <Stat label="Прыжков в слои" value={count(stats.observations)} small />
          <Stat label="PowerPlay применено" value={count(stats.powerplay?.applied)} small color="#22c55e" />
          <Stat label="Владельцев названо" value={count(stats.powerplay?.resolved)} small color="#22c55e" />
          <Stat label="Фракции применено" value={count(stats.factions?.applied)} small />
          <Stat label="Трафик" value={formatBytesShort(stats.bytes ?? 0)} small />
          <Stat label="Сессий / «тишин»" value={`${count(stats.sessions)} / ${count(stats.stalls)}`} small />
          <Stat label="Последнее сообщение" value={formatTime(stats.lastMessageAt)} small />
        </div>
      )}
      {eddn.running && (eddn.pending ?? 0) > 0 && (
        <div style={{ fontSize: 11, color: DIM, marginBottom: 6 }}>В очереди на запись: {count(eddn.pending)} систем (пачка — раз в минуту)</div>
      )}
      {eddn.running && eddn.status === 'waiting' && eddn.nextAttemptAt && (
        <div style={{ fontSize: 11, color: DIM, marginBottom: 6 }}>Следующая попытка: {formatTime(eddn.nextAttemptAt)}</div>
      )}
      {eddn.error && <div style={{ fontSize: 12, color: '#f87171', marginBottom: 6 }} data-pp-admin-eddn-error="">{eddn.error}</div>}
      {log.length > 0 && (
        <pre
          data-pp-admin-eddn-log=""
          style={{
            margin: 0, maxHeight: 200, overflow: 'auto', background: '#0f1113', border: '1px solid #262a2e', borderRadius: 4,
            padding: 8, fontSize: 11, lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          }}
        >
          {log.map((line, index) => (
            <div key={`${line.at}-${index}`} data-level={line.level} style={{ color: line.level === 'error' ? '#f87171' : line.level === 'warn' ? '#fbbf24' : MUTED }}>
              <span style={{ color: DIM }}>{formatClock(line.at)}</span> {line.text}
            </div>
          ))}
        </pre>
      )}
    </div>
  );
}

function formatBytesShort(value: number): string {
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} КБ`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1).replace('.', ',')} МБ`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2).replace('.', ',')} ГБ`;
}

function Stat({ label, value, color, small = false }: { label: string; value: string; color?: string; small?: boolean }) {
  return (
    <div style={{ background: '#101214', border: '1px solid #26292d', borderRadius: 4, padding: '8px 10px' }}>
      <div style={{ fontSize: 10, color: DIM, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: small ? 13 : 20, color: color ?? TEXT, fontWeight: 600, marginTop: 2, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
    </div>
  );
}
