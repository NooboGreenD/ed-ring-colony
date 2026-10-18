'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { authFetch } from '@/lib/supabaseClient';
import { IconAlert, IconCheckCircle, IconClock, IconCopy, IconRefresh, IconShieldHalf, IconTrash, IconXCircle } from '@/components/Icons';
import { BGS_ALLEGIANCE_COLOR, BGS_SOURCE_LABEL, allegianceLabel, formatBgsDate, normalizeSource } from '@/lib/bgs';
import {
  BGS_PHASE_LABEL,
  BGS_SYNC_STAGES,
  BGS_TRIGGER_LABEL,
  bgsStageFraction,
  formatBgsBytes,
  formatBgsCount,
  formatBgsDuration,
  sanitizeBgsLog,
  sanitizeBgsProgress,
  type BgsLogLine,
  type BgsStageProgress,
  type BgsSyncProgress,
} from '@/lib/bgsProgress';

/**
 * Админка → Игровые данные → Фракции.
 *
 * Минорные фракции для вкладки «Фракции» в Atlas хранятся в базе проекта и
 * приходят из двух источников:
 *   * ночной дамп EDSM `systemsPopulated.json.gz` (≈0,5 ГБ) — полный набор
 *     населённых систем; здесь его загружают: этапы с прогресс-барами (запрос,
 *     скачивание на диск с докачкой, разбор и запись, завершение), общий
 *     процент, журнал процесса, остановка и удаление архива;
 *   * журналы пилотов — Colonial Helper и загрузчик журналов на сайте шлют
 *     состояние фракций каждой посещённой системы; здесь видно, сколько
 *     обновлений пришло и от кого.
 */

interface UpdateRow {
  received_at: string;
  source: string;
  received: number;
  applied: number;
  stale: number;
  created: number;
  invalid: number;
  systems: string[];
  cmdr: string | null;
}

interface AdminStatus {
  running: boolean;
  interrupted: boolean;
  progress: BgsSyncProgress | null;
  log: BgsLogLine[];
  state: {
    status: 'idle' | 'running' | 'ok' | 'error';
    source_url: string | null;
    last_modified: string | null;
    dump_generated_at: string | null;
    dump_bytes: number | null;
    systems_total: number;
    factions_total: number;
    presence_total: number;
    error: string | null;
    attempt_at: string | null;
    checked_at: string | null;
    synced_at: string | null;
  };
  summary: {
    systems: number;
    factions: number;
    playerFactions: number;
    presence: number;
    allegiances: Record<string, number>;
    sources: Record<string, number>;
    oldestObservation: string | null;
    newestObservation: string | null;
    fresh7d: number;
    updates24h: number;
    applied24h: number;
    updates7d: number;
    applied7d: number;
    reporters7d: number;
    lastUpdate: string | null;
  } | null;
  summaryError: string | null;
  updates: UpdateRow[];
  archive: {
    path: string;
    exists: boolean;
    bytes: number;
    partial: boolean;
    complete: boolean;
    lastModified: string | null;
    freeBytes: number | null;
  };
  config: {
    dumpUrl: string;
    archiveKeep: boolean;
    segments: number;
    batchSize: number;
    minSystems: number;
    keepDays: number;
    refreshDays: number;
    nextScheduledRun: string | null;
    scheduleDecision: { action: 'start' | 'skip'; reason: string } | null;
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
const ACCENT = '#c4b5fd';
const RUN = '#f0af28';

const STAGE_COLORS: Record<BgsStageProgress['status'], string> = {
  pending: '#4b5563',
  running: RUN,
  done: '#22c55e',
  skipped: '#6b7280',
  error: '#ef4444',
};

const SCHEDULE_REASON: Record<string, string> = {
  running: 'импорт уже идёт',
  running_elsewhere: 'импорт идёт в другом процессе',
  not_initialized: 'первый импорт ещё не делали — задача ждёт его из админки',
  fresh: 'данные свежие',
  stale: 'данные устарели — задача обновит их',
  interrupted: 'прошлый импорт оборвался — задача продолжит его',
  forced: 'принудительно',
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

function stageStatusLabel(stage: BgsStageProgress, phase: BgsSyncProgress['phase']): string {
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

function stageDuration(stage: BgsStageProgress, serverNow: number): string {
  if (!stage.startedAt) return '';
  const start = Date.parse(stage.startedAt);
  const end = stage.finishedAt ? Date.parse(stage.finishedAt) : serverNow;
  return Number.isFinite(start) && Number.isFinite(end) ? formatBgsDuration(Math.max(0, end - start)) : '';
}

function phasePill(status: AdminStatus | null): { text: string; color: string } {
  if (!status) return { text: 'загрузка…', color: MUTED };
  if (status.running) return { text: 'идёт загрузка дампа', color: RUN };
  if (status.interrupted) return { text: 'загрузка прервана перезапуском сайта', color: '#e67e22' };
  const systems = status.summary?.systems ?? status.state.systems_total;
  if (status.state.status === 'error') return { text: systems > 0 ? 'ошибка последней загрузки' : 'ошибка — данных нет', color: '#ef4444' };
  if (systems > 0) return { text: 'данные загружены', color: '#22c55e' };
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
          animation: indeterminate ? 'bgs-admin-indeterminate 1.2s ease-in-out infinite' : undefined,
          position: indeterminate ? 'absolute' : undefined,
        }}
      />
    </div>
  );
}

function Stat({ label, value, color, small = false, title }: { label: string; value: string; color?: string; small?: boolean; title?: string }) {
  return (
    <div style={{ background: '#101214', border: '1px solid #26292d', borderRadius: 4, padding: '8px 10px' }} title={title}>
      <div style={{ fontSize: 10, color: DIM, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: small ? 13 : 20, color: color ?? TEXT, fontWeight: 600, marginTop: 2, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
    </div>
  );
}

export default function FactionsAdminTab() {
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
      const response = await authFetch('/api/admin/factions', { cache: 'no-store' });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload || payload.success === false) {
        throw new Error(payload?.error || `HTTP ${response.status}`);
      }
      setStatus({
        ...payload,
        progress: sanitizeBgsProgress(payload.progress),
        log: sanitizeBgsLog(payload.log),
        updates: Array.isArray(payload.updates) ? payload.updates : [],
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

  const logLength = status?.log.length ?? 0;
  const lastLogAt = status?.log[logLength - 1]?.at ?? '';
  useEffect(() => {
    const el = logRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [logLength, lastLogAt]);

  const act = async (action: 'start' | 'cancel' | 'cleanup', force = false) => {
    if (action === 'cleanup' && !window.confirm('Удалить скачанный архив дампа с диска? Следующая загрузка скачает его заново.')) return;
    setBusy(force ? 'force' : action);
    setMessage('');
    setIsError(false);
    try {
      const response = await authFetch('/api/admin/factions', {
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
        setMessage(payload?.cancelled ? 'Останавливаю импорт… Скачанная часть дампа останется на диске для докачки.' : 'Импорт не выполнялся');
      } else if (action === 'cleanup') {
        setMessage(payload?.removed ? `Архив удалён — освобождено ${formatBgsBytes(payload?.freed)}` : 'Архива на диске нет');
      } else {
        setMessage(force
          ? 'Импорт запущен принудительно: дамп импортируется, даже если он тот же, и принимается, даже если он заметно меньше прошлого.'
          : 'Загрузка запущена. Если дамп тот же, что в прошлый раз, импорт закончится сразу («без изменений»).');
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
  const systems = summary?.systems ?? status?.state.systems_total ?? 0;
  const allegiances = useMemo(
    () => Object.entries(summary?.allegiances ?? {}).sort((a, b) => b[1] - a[1]),
    [summary],
  );
  const maxAllegiance = Math.max(1, ...allegiances.map(([, n]) => n));
  const archive = status?.archive ?? null;
  const decision = status?.config.scheduleDecision ?? null;

  return (
    <div data-bgs-admin="">
      <style>{'@keyframes bgs-admin-indeterminate { 0% { left: -30%; } 100% { left: 100%; } }'}</style>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <IconShieldHalf size={16} color={ACCENT} /> Минорные фракции (BGS)
        </h3>
        <span style={{ fontSize: 12, color: pill.color }} data-bgs-admin-pill="">● {pill.text}</span>
        <button type="button" className="btn" style={{ fontSize: 12, padding: '3px 8px' }} onClick={() => void load()}>
          <IconRefresh size={12} color="#9ca3af" /> Обновить
        </button>
      </div>

      {loadError && (
        <div style={{ ...cardStyle, borderColor: '#7f1d1d', color: '#fca5a5', fontSize: 13 }} role="alert">
          <IconXCircle size={14} color="#ef4444" /> {loadError}
        </div>
      )}

      {/* ── Что в базе ── */}
      <div style={cardStyle} data-bgs-admin-data="">
        <div style={labelStyle}>Данные в базе проекта</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10, marginBottom: 10 }}>
          <Stat label="Населённых систем" value={formatBgsCount(systems)} color={systems > 0 ? '#22c55e' : MUTED} />
          <Stat label="Фракций" value={summary ? formatBgsCount(summary.factions) : '—'} title={summary ? `из них фракций игроков (PMF): ${summary.playerFactions}` : undefined} />
          <Stat label="Присутствий" value={summary ? formatBgsCount(summary.presence) : '—'} title="Пар «система — фракция»" />
          <Stat label="Обновлено за 7 дней" value={summary ? formatBgsCount(summary.fresh7d) : '—'} title="Систем с наблюдением не старше недели" />
          <Stat label="Дамп EDSM от" value={formatTime(status?.state.dump_generated_at)} small />
          <Stat label="Импорт записан" value={formatTime(status?.state.synced_at)} small />
        </div>
        {summary && systems > 0 && (
          <div style={{ fontSize: 12, color: MUTED, marginBottom: 8 }}>
            Источник последнего наблюдения:{' '}
            {Object.entries(summary.sources).map(([source, n], index) => (
              <span key={source}>{index > 0 ? ' · ' : ''}{BGS_SOURCE_LABEL[normalizeSource(source)]} {formatBgsCount(n)}</span>
            ))}
            {summary.oldestObservation && summary.newestObservation && (
              <> · наблюдения {formatBgsDate(summary.oldestObservation)} – {formatBgsDate(summary.newestObservation)}</>
            )}
          </div>
        )}
        {status && systems === 0 && !running && (
          <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: 13, color: '#fbbf24', marginBottom: 8 }}>
            <IconAlert size={14} color="#fbbf24" />
            <span>
              Данных о фракциях в базе нет — вкладка «Фракции» в Atlas пуста. Нажмите «Загрузить данные» ниже: дамп EDSM весит
              ≈0,5 ГБ, ход скачивания и записи виден по этапам и в журнале. Колонии и системы, где побывали пилоты с Colonial
              Helper, появятся и без него.
            </span>
          </div>
        )}
        {status?.state.status === 'error' && status.state.error && (
          <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: 13, color: '#ef4444', marginBottom: 8 }} data-bgs-admin-error="">
            <IconXCircle size={14} color="#ef4444" />
            <span>
              Последняя загрузка не удалась: {status.state.error}
              {systems > 0 ? ' — на карте остались прежние данные.' : ''}
            </span>
          </div>
        )}
        {status?.summaryError && <div style={{ fontSize: 12, color: '#e67e22', marginBottom: 8 }}>{status.summaryError}</div>}
        {allegiances.length > 0 && (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }} aria-label="Системы по принадлежности">
            <tbody>
              {allegiances.map(([allegiance, n]) => {
                const color = BGS_ALLEGIANCE_COLOR[allegiance as keyof typeof BGS_ALLEGIANCE_COLOR] ?? DIM;
                return (
                  <tr key={allegiance} data-bgs-admin-allegiance={allegiance} style={{ borderTop: '1px solid #24272a' }}>
                    <td style={{ padding: '4px 6px', color: TEXT, whiteSpace: 'nowrap', width: '30%' }}>
                      <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: color, marginRight: 6, verticalAlign: 'middle' }} />
                      {allegianceLabel(allegiance)}
                    </td>
                    <td style={{ padding: '4px 6px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', width: 90 }}>{formatBgsCount(n)}</td>
                    <td style={{ padding: '4px 6px' }}>
                      <ProgressBar fraction={n / maxAllegiance} color={color} height={6} label={`${allegianceLabel(allegiance)}: ${n}`} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Загрузка дампа EDSM ── */}
      <div style={cardStyle} data-bgs-admin-sync="">
        <div style={labelStyle}>Загрузка из EDSM (systemsPopulated)</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
          <button type="button" className="btn btn-cyan" disabled={busy !== null || running} onClick={() => void act('start')} data-bgs-admin-action="start">
            {systems > 0 ? 'Загрузить сейчас' : 'Загрузить данные'}
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy !== null || running}
            onClick={() => void act('start', true)}
            title="Импортировать дамп, даже если он тот же, что в прошлый раз, и принять его, даже если он заметно меньше"
            data-bgs-admin-action="force"
          >
            Импортировать принудительно
          </button>
          <button type="button" className="btn btn-danger" disabled={busy !== null || !running} onClick={() => void act('cancel')} data-bgs-admin-action="cancel">
            Остановить
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy !== null || running || !archive?.exists}
            onClick={() => void act('cleanup')}
            title="Удалить скачанный архив дампа с диска"
            data-bgs-admin-action="cleanup"
          >
            <IconTrash size={12} /> Удалить архив
          </button>
        </div>

        {archive && (
          <div style={{ fontSize: 12, color: MUTED, marginBottom: 10 }} data-bgs-admin-archive="">
            Архив на диске:{' '}
            {archive.exists
              ? <>{formatBgsBytes(archive.bytes)}{archive.partial ? ' — скачан не полностью, следующий запуск докачает' : archive.complete ? ` — скачан целиком${archive.lastModified ? ` (дамп от ${archive.lastModified})` : ''}` : ''}</>
              : 'нет'}
            {archive.freeBytes != null ? ` · свободно на диске ${formatBgsBytes(archive.freeBytes)}` : ''}
            <div style={{ fontSize: 11, color: DIM, marginTop: 2, overflowWrap: 'anywhere' }}><code>{archive.path}</code></div>
          </div>
        )}

        {progress ? (
          <div data-bgs-admin-progress={progress.phase}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12, color: MUTED, marginBottom: 4, flexWrap: 'wrap' }}>
              <span style={{ color: progress.phase === 'running' ? RUN : progress.phase === 'error' ? '#ef4444' : progress.phase === 'cancelled' ? '#e67e22' : '#22c55e' }}>
                {progress.phase === 'running' ? 'Идёт загрузка' : `Последняя загрузка: ${BGS_PHASE_LABEL[progress.phase]}`}
                {' · '}{progress.percent.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} %
              </span>
              <span>
                <IconClock size={11} /> {formatBgsDuration(elapsed)} · {formatTime(progress.startedAt)}
              </span>
            </div>
            <ProgressBar
              fraction={progress.percent / 100}
              color={progress.phase === 'error' ? '#ef4444' : progress.phase === 'cancelled' ? '#e67e22' : progress.phase === 'running' ? RUN : '#22c55e'}
              height={10}
              label="Общий ход загрузки"
            />
            <div style={{ fontSize: 12, color: TEXT, marginTop: 6 }} data-bgs-admin-message="">{progress.message}</div>
            <div style={{ fontSize: 11, color: DIM, marginTop: 2 }}>
              Запуск: {BGS_TRIGGER_LABEL[progress.trigger]}{progress.force ? ' · принудительно' : ''}
            </div>

            <ol style={{ listStyle: 'none', margin: '10px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 7 }} aria-label="Этапы загрузки">
              {BGS_SYNC_STAGES.map((def) => {
                const stage = progress.stages.find((item) => item.id === def.id);
                if (!stage) return null;
                const color = STAGE_COLORS[stage.status];
                const indeterminate = stage.status === 'running' && !(stage.total && stage.total > 0);
                return (
                  <li key={def.id} data-bgs-admin-stage={def.id} data-status={stage.status} style={{ display: 'grid', gridTemplateColumns: '170px minmax(0, 1fr) 90px', gap: 8, alignItems: 'center', fontSize: 12 }}>
                    <span style={{ color: stage.status === 'pending' ? DIM : TEXT, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      {stage.status === 'done' ? <IconCheckCircle size={12} color={color} /> : stage.status === 'error' ? <IconXCircle size={12} color={color} /> : (
                        <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: color, marginLeft: 2, marginRight: 2 }} />
                      )}
                      {def.label}
                    </span>
                    <span style={{ minWidth: 0 }}>
                      <ProgressBar fraction={bgsStageFraction(stage)} color={color} height={6} indeterminate={indeterminate} label={def.label} />
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
                В базе {formatBgsCount(progress.result.systems)} систем и {formatBgsCount(progress.result.factions)} фракций · удалено
                пропавших систем {formatBgsCount(progress.result.deletedSystems)} · не тронуто (у пилотов свежее){' '}
                {formatBgsCount(progress.result.stale)} · за {formatBgsDuration(progress.result.durationMs)}
              </div>
            )}
            {progress.phase === 'not_modified' && (
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', color: '#22c55e', fontSize: 13, marginTop: 10 }}>
                <IconCheckCircle size={14} color="#22c55e" />
                Дамп EDSM тот же, что при прошлом импорте, — данные актуальны. «Импортировать принудительно» загрузит его ещё раз.
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
            Прошлая загрузка оборвалась вместе с процессом сайта (обновление или перезапуск). Скачанная часть дампа на диске —
            «Загрузить сейчас» продолжит с того же места; задача factions-sync сделает это сама при следующем запуске.
          </div>
        )}

        <div style={{ fontSize: 12, color: MUTED, lineHeight: 1.6, marginTop: 12 }}>
          Источник: <code>{status?.config.dumpUrl ?? 'https://www.edsm.net/dump/systemsPopulated.json.gz'}</code> — ночной дамп
          EDSM: все населённые системы с минорными фракциями (влияние, состояния), ≈0,5 ГБ gzip. Дамп скачивается на диск в
          {` ${status?.config.segments ?? 4} `}соединения с докачкой, затем разбирается потоком и пишется в базу пачками по
          {` ${status?.config.batchSize ?? 250} `}систем; после удачного импорта архив{status?.config.archiveKeep ? ' остаётся на диске (FACTIONS_ARCHIVE_KEEP=1)' : ' удаляется с диска'}.
          <br />
          Свежее наблюдение побеждает: системы, которые пилоты прислали позже даты дампа, импорт не трогает. Пропавшие из дампа
          системы удаляются, если пилоты не присылали их {status?.config.keepDays ?? 30} дней. Защита: меньше
          {` ${formatBgsCount(status?.config.minSystems ?? 1000)} `}систем или дамп меньше половины прошлого — удаление пропавших не
          выполняется.
          <br />
          Автоматически: задача <code>factions-sync</code> раз в сутки
          {status?.config.nextScheduledRun ? <> (ближайший запуск — {formatUtc(status.config.nextScheduledRun)})</> : null} обновляет
          данные старше {status?.config.refreshDays ?? 7} дн. (<code>FACTIONS_REFRESH_DAYS</code>) и продолжает оборванный импорт;
          первый импорт — только отсюда.
          {decision ? <> Сейчас задача: <strong style={{ color: TEXT }}>{SCHEDULE_REASON[decision.reason] ?? decision.reason}</strong>.</> : null}
        </div>
      </div>

      {/* ── Обновления от пилотов ── */}
      <div style={cardStyle} data-bgs-admin-updates="">
        <div style={labelStyle}>Обновления от пилотов (Colonial Helper и загрузка журналов на сайте)</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10, marginBottom: 10 }}>
          <Stat label="Пачек за 24 ч" value={summary ? formatBgsCount(summary.updates24h) : '—'} title={summary ? `применено систем: ${summary.applied24h}` : undefined} />
          <Stat label="Систем обновлено за 24 ч" value={summary ? formatBgsCount(summary.applied24h) : '—'} />
          <Stat label="Систем за 7 дней" value={summary ? formatBgsCount(summary.applied7d) : '—'} />
          <Stat label="Пилотов за 7 дней" value={summary ? formatBgsCount(summary.reporters7d) : '—'} />
          <Stat label="Последнее обновление" value={formatTime(summary?.lastUpdate)} small />
        </div>
        {status?.updates.length ? (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }} aria-label="Последние обновления от пилотов">
            <thead>
              <tr style={{ color: DIM, textAlign: 'left' }}>
                <th style={{ padding: '4px 6px', fontWeight: 500 }}>Когда</th>
                <th style={{ padding: '4px 6px', fontWeight: 500 }}>Откуда</th>
                <th style={{ padding: '4px 6px', fontWeight: 500 }}>Пилот</th>
                <th style={{ padding: '4px 6px', fontWeight: 500, textAlign: 'right' }} title="Пришло / применено / устарело / новых систем">Систем</th>
                <th style={{ padding: '4px 6px', fontWeight: 500 }}>Системы</th>
              </tr>
            </thead>
            <tbody>
              {status.updates.map((row, index) => (
                <tr key={`${row.received_at}-${index}`} data-bgs-admin-update={row.source} style={{ borderTop: '1px solid #24272a' }}>
                  <td style={{ padding: '4px 6px', whiteSpace: 'nowrap' }}>{formatTime(row.received_at)}</td>
                  <td style={{ padding: '4px 6px', whiteSpace: 'nowrap' }}>{BGS_SOURCE_LABEL[normalizeSource(row.source)]}</td>
                  <td style={{ padding: '4px 6px', color: TEXT }}>{row.cmdr ?? '—'}</td>
                  <td style={{ padding: '4px 6px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }} title="пришло / применено / устарело / новых">
                    {row.received} / <span style={{ color: '#22c55e' }}>{row.applied}</span> / {row.stale}{row.created ? <> / <span style={{ color: ACCENT }}>+{row.created}</span></> : null}
                    {row.invalid ? <span style={{ color: '#e67e22' }}> · отброшено {row.invalid}</span> : null}
                  </td>
                  <td style={{ padding: '4px 6px', color: MUTED, overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 280, whiteSpace: 'nowrap' }} title={row.systems.join(', ')}>
                    {row.systems.slice(0, 4).join(', ')}{row.systems.length > 4 ? ` и ещё ${row.systems.length - 4}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div style={{ fontSize: 12, color: DIM }}>
            Обновлений пока не было. Colonial Helper 2.16+ отправляет состояние фракций после каждого прыжка в населённую систему,
            загрузчик журналов в личном кабинете — по загруженным журналам.
          </div>
        )}
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
            data-bgs-admin-log=""
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
      </div>

      {message && (
        <div style={{ fontSize: 13, color: isError ? '#ef4444' : '#22c55e' }} role="status">{message}</div>
      )}
    </div>
  );
}
