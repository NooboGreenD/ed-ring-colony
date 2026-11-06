'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { authFetch } from '@/lib/supabaseClient';
import { useI18n } from '@/lib/i18n/I18nContext';
import type { TFn } from '@/lib/i18n/gameLabels';
import ArchiveUploadControl from '@/components/Admin/ArchiveUploadControl';
import { IconAlert, IconCheckCircle, IconClock, IconCopy, IconPower, IconRefresh, IconTrash, IconXCircle } from '@/components/Icons';
import { POWER_ALLEGIANCE_LABEL, formatPowerplayDate, powerInfo } from '@/lib/powerplay';
import {
  POWERPLAY_MODE_LABEL,
  POWERPLAY_PHASE_LABEL,
  POWERPLAY_SYNC_STAGES,
  POWERPLAY_TRIGGER_LABEL,
  formatPowerplayBytes,
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
 * а здесь видно, загружено ли что-нибудь, и можно запустить загрузку вручную.
 * Загрузка устроена как у фракций и «Каталога систем», шаги по очереди: архив
 * скачивается на сервер целиком → разбивается на куски → куски пишутся в
 * базу; каждый шаг можно запустить отдельно (карточки архива и кусков), а
 * серверу, которому EDSM недоступен, архив можно загрузить с компьютера.
 * Этапы с прогресс-барами, общий процент и журнал процесса.
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

type RunMode = 'full' | 'download' | 'split' | 'import';
type Action = 'start' | 'force' | 'download' | 'split' | 'import' | 'cancel' | 'cleanup' | 'eddn-start' | 'eddn-stop';

interface AdminStatus {
  running: boolean;
  mode?: RunMode | null;
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
  archive?: {
    path: string;
    exists: boolean;
    bytes: number;
    downloaded?: number;
    total?: number | null;
    partial: boolean;
    complete: boolean;
    lastModified: string | null;
    freeBytes: number | null;
    uploaded?: boolean;
    uploadName?: string | null;
    manual?: boolean;
  };
  upload?: { active: boolean; name: string | null; size: number; received: number; startedAt: string | null; chunkBytes?: number };
  shards?: {
    dir: string;
    exists: boolean;
    complete: boolean;
    shards: number;
    imported: number;
    systems: number;
    importedSystems: number;
    files: number;
    bytes: number;
    completedAt: string | null;
  };
  writer?: { backend: 'pg' | 'postgrest'; host: string | null; disabled: boolean };
  config: {
    dumpUrl: string;
    archiveKeep?: boolean;
    segments?: number;
    maxSegments?: number;
    pieceBytes?: number;
    stallSeconds?: number;
    shortRequests?: 'auto' | 'off' | number;
    shardSystems?: number;
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

const SEGMENT_CHOICES = [1, 2, 4, 6, 8, 12, 16];

const RUNNING_PILL: Record<RunMode, string> = {
  full: 'ppAdmin.runningFull',
  download: 'ppAdmin.runningDownload',
  split: 'ppAdmin.runningSplit',
  import: 'ppAdmin.runningImport',
};

const innerCardStyle = { background: '#101214', border: '1px solid #26292d', borderRadius: 4, padding: '8px 10px', fontSize: 12, color: MUTED } as const;

function formatTime(value: string | null | undefined, locale: string): string {
  if (!value) return '—';
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toLocaleString(locale) : value;
}

function formatClock(value: string, locale: string): string {
  const at = Date.parse(value);
  return Number.isFinite(at)
    ? new Date(at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '';
}

function formatUtc(value: string | null | undefined, locale: string): string {
  if (!value) return '—';
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return value;
  const date = new Date(at);
  return `${formatTime(value, locale)} (${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')} UTC)`;
}

function stageStatusLabel(
  t: TFn,
  stage: PowerplayStageProgress,
  phase: PowerplaySyncProgress['phase'],
): string {
  switch (stage.status) {
    case 'running':
      return t('ppAdmin.stageRunning');
    case 'done':
      return t('ppAdmin.stageDone');
    case 'skipped':
      return t('ppAdmin.stageSkipped');
    case 'error':
      return phase === 'cancelled' ? t('ppAdmin.stageStopped') : t('ppAdmin.stageError');
    default:
      return t('ppAdmin.stageWaiting');
  }
}

function stageDuration(stage: PowerplayStageProgress, serverNow: number): string {
  if (!stage.startedAt) return '';
  const start = Date.parse(stage.startedAt);
  const end = stage.finishedAt ? Date.parse(stage.finishedAt) : serverNow;
  return Number.isFinite(start) && Number.isFinite(end) ? formatPowerplayDuration(Math.max(0, end - start)) : '';
}

function phasePill(t: TFn, status: AdminStatus | null): { text: string; color: string } {
  if (!status) return { text: t('ppAdmin.pillLoading'), color: MUTED };
  if (status.running) return { text: t(RUNNING_PILL[status.mode ?? 'full'] ?? RUNNING_PILL.full), color: PP };
  if (status.interrupted) return { text: t('ppAdmin.pillInterrupted'), color: '#e67e22' };
  if (status.state.status === 'error') {
    return {
      text: status.state.rows_total > 0 ? t('ppAdmin.pillErrorLast') : t('ppAdmin.pillErrorNoData'),
      color: '#ef4444',
    };
  }
  if (status.state.rows_total > 0) return { text: t('ppAdmin.pillLoaded'), color: '#22c55e' };
  return { text: t('ppAdmin.pillNoData'), color: MUTED };
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
  const { t, locale } = useI18n();
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [isError, setIsError] = useState(false);
  const [copied, setCopied] = useState(false);
  const [segments, setSegments] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);
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

  const connections = segments ?? status?.config.segments ?? 4;

  const act = async (action: Action) => {
    if (action === 'cleanup' && !window.confirm(t('ppAdmin.confirmCleanup'))) return;
    setBusy(action);
    setMessage('');
    setIsError(false);
    const force = action === 'force';
    const body: Record<string, unknown> = { action: force ? 'start' : action, force };
    if (action === 'start' || action === 'force' || action === 'download') body.segments = connections;
    try {
      const response = await authFetch('/api/admin/powerplay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => null);
      if (response.status === 409) {
        setMessage(payload?.reason || t('ppAdmin.importRunning'));
      } else if (!response.ok || payload?.success === false) {
        throw new Error(payload?.error || `HTTP ${response.status}`);
      } else if (action === 'cancel') {
        setMessage(payload?.cancelled
          ? t('ppAdmin.cancelStarted')
          : t('ppAdmin.cancelNothing'));
      } else if (action === 'cleanup') {
        setMessage(payload?.removed
          ? t('ppAdmin.cleanupDone', { freed: formatPowerplayBytes(payload?.freed) })
          : t('ppAdmin.cleanupNothing'));
      } else if (action === 'eddn-start') {
        setMessage(t('ppAdmin.eddnOn'));
      } else if (action === 'eddn-stop') {
        setMessage(t('ppAdmin.eddnStatusOff'));
      } else if (action === 'download') {
        setMessage(t('ppAdmin.downloadStarted', { connections }));
      } else if (action === 'split') {
        setMessage(t('ppAdmin.splitStarted'));
      } else if (action === 'import') {
        setMessage(t('ppAdmin.importStarted'));
      } else {
        setMessage(force
          ? t('ppAdmin.startForced')
          : status?.archive?.uploaded && status.archive.complete
            ? t('ppAdmin.startUploaded')
            : t('ppAdmin.startFull', { connections }));
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

  const pill = phasePill(t, status);
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
  const archive = status?.archive ?? null;
  const shards = status?.shards ?? null;
  const writer = status?.writer ?? null;
  const maxSegments = status?.config.maxSegments ?? 16;
  const segmentChoices = SEGMENT_CHOICES.filter((n) => n <= maxSegments);
  if (!segmentChoices.includes(connections)) segmentChoices.push(connections);
  segmentChoices.sort((a, b) => a - b);
  const archiveDownloaded = archive ? archive.downloaded ?? archive.bytes : 0;
  const archiveTotal = archive?.total ?? null;
  const pieceBytes = status?.config.pieceBytes ?? 256 * 1024;
  const shardSystems = status?.config.shardSystems ?? 2000;
  const stallSeconds = status?.config.stallSeconds ?? 15;
  const shortRequests = status?.config.shortRequests ?? 'auto';
  const splitting = running && progress?.stages.find((stage) => stage.id === 'split')?.status === 'running';
  const dumpUrl = status?.config.dumpUrl ?? 'https://www.edsm.net/dump/powerPlay.json.gz';

  return (
    <div data-powerplay-admin="">
      <style>{'@keyframes pp-admin-indeterminate { 0% { left: -30%; } 100% { left: 100%; } }'}</style>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <IconPower size={16} color={PP} /> {t('ppAdmin.title')}
        </h3>
        <span style={{ fontSize: 12, color: pill.color }} data-pp-admin-pill="">● {pill.text}</span>
        <button type="button" className="btn" style={{ fontSize: 12, padding: '3px 8px' }} onClick={() => void load()}>
          <IconRefresh size={12} color="#9ca3af" /> {t('mon.refresh')}
        </button>
      </div>

      {loadError && (
        <div style={{ ...cardStyle, borderColor: '#7f1d1d', color: '#fca5a5', fontSize: 13 }} role="alert">
          <IconXCircle size={14} color="#ef4444" /> {loadError}
        </div>
      )}

      {/* ── Что сейчас на сайте ── */}
      <div style={cardStyle} data-pp-admin-data="">
        <div style={labelStyle}>{t('ppAdmin.dataOnSite')}</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 10 }}>
          <Stat
            label={t('ppAdmin.systemsInDb')}
            value={formatPowerplayCount(total)}
            color={total > 0 ? '#22c55e' : MUTED}
          />
          <Stat
            label={t('ppAdmin.powersCount')}
            value={summary ? String(summary.powers.filter((row) => row.total > 0).length) : '—'}
          />
          {basesKnown && (
            <Stat
              label={t('ppAdmin.unknownOwner')}
              value={formatPowerplayCount(unknownOwners)}
              color={unknownOwners > 0 ? '#fbbf24' : '#22c55e'}
            />
          )}
          <Stat label={t('ppAdmin.dumpFrom')} value={formatTime(status?.state.dump_generated_at, locale)} small />
          <Stat label={t('ppAdmin.savedToSite')} value={formatTime(status?.state.synced_at, locale)} small />
          <Stat label={t('ppAdmin.checkedBySource')} value={formatTime(status?.state.checked_at, locale)} small />
        </div>
        {total > 0 && summary && (
          <div style={{ fontSize: 12, color: MUTED, marginBottom: 8 }}>
            {t('ppAdmin.stateTotals', {
              stronghold: formatPowerplayCount(stateTotals.Stronghold),
              fortified: formatPowerplayCount(stateTotals.Fortified),
              exploited: formatPowerplayCount(stateTotals.Exploited),
            })}
            {summary.oldestObservation && summary.newestObservation && (
              <>
                {t('ppAdmin.pilotObservations', {
                  from: formatPowerplayDate(summary.oldestObservation),
                  to: formatPowerplayDate(summary.newestObservation),
                })}
              </>
            )}
          </div>
        )}
        {basesKnown && total > 0 && (
          <div style={{ fontSize: 12, color: MUTED, marginBottom: 8, lineHeight: 1.5 }} data-pp-admin-bases="">
            {t('ppAdmin.basesLine', {
              journal: formatPowerplayCount(summary?.bases?.journal ?? 0),
              sole: formatPowerplayCount(summary?.bases?.sole ?? 0),
              kept: formatPowerplayCount(summary?.bases?.kept ?? 0),
              unknown: formatPowerplayCount(unknownOwners),
            })}
            {legacyRows > 0 && t('ppAdmin.legacyBasis', { count: formatPowerplayCount(legacyRows) })}
            {unknownOwners > 0 && (
              <div style={{ color: DIM, marginTop: 2 }}>{t('ppAdmin.unknownHint')}</div>
            )}
          </div>
        )}
        {summary && (pilotRows > 0 || (summary.vacated ?? 0) > 0) && (
          <div style={{ fontSize: 12, color: MUTED, marginBottom: 8 }} data-pp-admin-pilots="">
            {t('ppAdmin.pilotRows', { count: formatPowerplayCount(pilotRows) })}
            {(summary.vacated ?? 0) > 0 && t('ppAdmin.vacated', { count: formatPowerplayCount(summary.vacated ?? 0) })}
          </div>
        )}
        {status && total === 0 && !running && (
          <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: 13, color: '#fbbf24', marginBottom: 8 }}>
            <IconAlert size={14} color="#fbbf24" />
            <span>{t('ppAdmin.emptyDb')}</span>
          </div>
        )}
        {status?.state.status === 'error' && status.state.error && (
          <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: 13, color: '#ef4444', marginBottom: 8 }} data-pp-admin-error="">
            <IconXCircle size={14} color="#ef4444" />
            <span>
              {t('ppAdmin.lastLoadFailed', { error: status.state.error })}
              {status.state.rows_total > 0 ? t('ppAdmin.lastLoadKept') : ''}
            </span>
          </div>
        )}
        {status?.summaryError && <div style={{ fontSize: 12, color: '#e67e22', marginBottom: 8 }}>{status.summaryError}</div>}

        {summary && summary.powers.length > 0 && (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }} aria-label={t('ppAdmin.powersTableAria')}>
            <thead>
              <tr style={{ color: DIM, textAlign: 'left' }}>
                <th style={{ padding: '4px 6px', fontWeight: 500 }}>{t('ppAdmin.colPower')}</th>
                <th style={{ padding: '4px 6px', fontWeight: 500, textAlign: 'right' }}>{t('ppAdmin.colStronghold')}</th>
                <th style={{ padding: '4px 6px', fontWeight: 500, textAlign: 'right' }}>{t('ppAdmin.colFortified')}</th>
                <th style={{ padding: '4px 6px', fontWeight: 500, textAlign: 'right' }}>{t('ppAdmin.colExploitedShort')}</th>
                <th style={{ padding: '4px 6px', fontWeight: 500, textAlign: 'right' }}>{t('ppAdmin.colTotal')}</th>
                {basesKnown && (
                  <th
                    style={{ padding: '4px 6px', fontWeight: 500, textAlign: 'right' }}
                    title={t('ppAdmin.colContestedTitle')}
                  >
                    {t('ppAdmin.colContested')}
                  </th>
                )}
                {basesKnown && <th style={{ padding: '4px 6px', fontWeight: 500 }}>{t('ppAdmin.colBasis')}</th>}
                <th style={{ padding: '4px 6px', width: '18%' }} aria-hidden="true" />
              </tr>
            </thead>
            <tbody>
              {summary.powers.map((row) => {
                const info = powerInfo(row.power);
                const basisParts = [
                  row.journal ? t('ppAdmin.journalNote', { count: formatPowerplayCount(row.journal) }) : '',
                  row.sole ? `EDSM ${formatPowerplayCount(row.sole)}` : '',
                  row.kept ? t('ppAdmin.pastNote', { count: formatPowerplayCount(row.kept) }) : '',
                  row.legacy ? t('ppAdmin.legacyNote', { count: formatPowerplayCount(row.legacy) }) : '',
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
                    {t('ppAdmin.unknownOwner')}
                  </td>
                  <td style={{ padding: '4px 6px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{formatPowerplayCount(summary.unknown.Stronghold)}</td>
                  <td style={{ padding: '4px 6px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{formatPowerplayCount(summary.unknown.Fortified)}</td>
                  <td style={{ padding: '4px 6px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{formatPowerplayCount(summary.unknown.Exploited)}</td>
                  <td style={{ padding: '4px 6px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{formatPowerplayCount(summary.unknown.total)}</td>
                  <td style={{ padding: '4px 6px' }} />
                  <td style={{ padding: '4px 6px', color: DIM, fontSize: 11 }}>{t('ppAdmin.edsmMulti')}</td>
                  <td style={{ padding: '4px 6px' }}>
                    <ProgressBar fraction={summary.unknown.total / maxPower} color={powerInfo('?').color} height={6} label={t('ppAdmin.unknownLabel', { count: summary.unknown.total })} />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Загрузка дампа EDSM: архив → куски → база ── */}
      <div style={cardStyle} data-pp-admin-sync="">
        <div style={labelStyle}>{t('ppAdmin.dumpSection')}</div>
        <div style={{ fontSize: 12, color: MUTED, marginBottom: 10, lineHeight: 1.5 }}>
          {t('ppAdmin.stepsIntro')} <strong style={{ color: TEXT }}>{t('ppAdmin.stepArchive')}</strong> →{' '}
          <strong style={{ color: TEXT }}>{t('ppAdmin.stepShards')}</strong> {t('ppAdmin.stepShardsCount', { count: formatPowerplayCount(shardSystems) })} →{' '}
          <strong style={{ color: TEXT }}>{t('ppAdmin.stepDb')}</strong>. {t('ppAdmin.stepsEach')}
          {t('ppAdmin.stepsTail')}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10, alignItems: 'center' }}>
          <button type="button" className="btn btn-cyan" disabled={busy !== null || running || uploading} onClick={() => void act('start')} data-pp-admin-action="start">
            {t(total > 0 ? 'ppAdmin.loadNow' : 'ppAdmin.loadData')}
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy !== null || running || uploading}
            onClick={() => void act('force')}
            title={t('ppAdmin.forceHint')}
            data-pp-admin-action="force"
          >
            {t('ppAdmin.force')}
          </button>
          <button type="button" className="btn btn-danger" disabled={busy !== null || !running} onClick={() => void act('cancel')} data-pp-admin-action="cancel">
            {t('atlas.ui.stop')}
          </button>
          <label style={{ fontSize: 12, color: MUTED, display: 'inline-flex', alignItems: 'center', gap: 6 }} title={t('ppAdmin.connectionsHint')}>
            {t('ppAdmin.connectionsLabel')}
            <select
              value={connections}
              disabled={busy !== null || running}
              onChange={(event) => setSegments(Number(event.target.value))}
              data-pp-admin-segments=""
              style={{ background: '#101214', color: TEXT, border: '1px solid #323538', borderRadius: 3, padding: '2px 4px', fontSize: 12 }}
            >
              {segmentChoices.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 10, marginBottom: 10 }}>
          {archive && (
            <div style={innerCardStyle} data-pp-admin-archive="">
              <div style={{ ...labelStyle, marginBottom: 4 }}>{t('ppAdmin.step1')}</div>
              {archive.exists ? (
                archive.complete ? (
                  <div style={{ color: '#22c55e' }} data-pp-admin-archive-state={archive.uploaded ? 'uploaded' : 'complete'}>
                    {archive.uploaded
                      ? <>{t('ppAdmin.uploadedWhole')} {formatPowerplayBytes(archive.bytes)}{archive.uploadName ? ` (${archive.uploadName})` : ''}</>
                      : <>{t('ppAdmin.downloadWhole')} {formatPowerplayBytes(archive.bytes)}{archive.lastModified ? ' ' + t('ppAdmin.dumpOf', { date: archive.lastModified }) : ''}</>}
                  </div>
                ) : archive.manual ? (
                  <div style={{ color: '#fbbf24' }} data-pp-admin-archive-state="manual">
                    {t('ppAdmin.manualFile', { size: formatPowerplayBytes(archive.bytes) })} {t('ppAdmin.manualFileTail')}
                  </div>
                ) : (
                  <>
                    <div style={{ color: running ? PP : '#fbbf24' }} data-pp-admin-archive-state="partial">
                      {t(running ? 'ppAdmin.downloading' : 'ppAdmin.partial')}: {formatPowerplayBytes(archiveDownloaded)}
                      {archiveTotal ? ' ' + t('ppAdmin.totalOf', { size: formatPowerplayBytes(archiveTotal), percent: Math.floor((archiveDownloaded / Math.max(1, archiveTotal)) * 100) }) : ''}
                      {running ? '' : t('ppAdmin.nextRunFinish')}
                    </div>
                    {archiveTotal ? (
                      <div style={{ marginTop: 4 }}>
                        <ProgressBar fraction={archiveDownloaded / Math.max(1, archiveTotal)} color={running ? PP : '#fbbf24'} height={5} label={t('ppAdmin.archiveDownloadedLabel')} />
                      </div>
                    ) : null}
                  </>
                )
              ) : (
                <div>{t('ppAdmin.noArchive')}</div>
              )}
              <div style={{ marginTop: 2 }}>
                {t('ppAdmin.segmentsLine', { connections, size: formatPowerplayBytes(pieceBytes) })}
                {archive.freeBytes != null ? t('ppAdmin.freeDisk', { size: formatPowerplayBytes(archive.freeBytes) }) : ''}
              </div>
              <div style={{ fontSize: 11, color: DIM, marginTop: 2, overflowWrap: 'anywhere' }}><code>{archive.path}</code></div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                <button
                  type="button"
                  className="btn"
                  style={{ fontSize: 12, padding: '3px 8px' }}
                  disabled={busy !== null || running || uploading}
                  onClick={() => void act('download')}
                  title={t('ppAdmin.downloadOnlyHint')}
                  data-pp-admin-action="download"
                >
                  {t(archive.exists && !archive.complete ? 'ppAdmin.reDownload' : 'ppAdmin.downloadArchive')}
                </button>
                <button
                  type="button"
                  className="btn"
                  style={{ fontSize: 12, padding: '3px 8px' }}
                  disabled={busy !== null || running || uploading || !(archive.exists || shards?.exists)}
                  onClick={() => void act('cleanup')}
                  title={t('ppAdmin.cleanupHint')}
                  data-pp-admin-action="cleanup"
                >
                  <IconTrash size={12} /> {t('ppAdmin.cleanupButton')}
                </button>
              </div>
              <ArchiveUploadControl
                endpoint="/api/admin/powerplay/upload"
                prefix="pp-admin"
                sourceName="powerPlay.json.gz"
                dumpUrl={dumpUrl}
                disabled={busy !== null || running}
                pending={status?.upload}
                accent={PP}
                onUploadingChange={setUploading}
                onMessage={(text, error) => {
                  setMessage(text);
                  setIsError(error);
                }}
                onSettled={async () => {
                  stickToBottom.current = true;
                  await load();
                }}
              />
            </div>
          )}
          <div style={innerCardStyle} data-pp-admin-shards="">
            <div style={{ ...labelStyle, marginBottom: 4 }}>{t('ppAdmin.step2')}</div>
            {shards?.exists && (shards.shards > 0 || shards.complete) ? (
              <>
                <div style={{ color: shards.complete ? TEXT : splitting ? PP : '#fbbf24' }}>
                  {t('ppAdmin.shardCounts', { shards: formatPowerplayCount(shards.shards), systems: formatPowerplayCount(shards.systems), size: formatPowerplayBytes(shards.bytes) })}
                  {shards.complete ? t('ppAdmin.shardDone') : splitting ? t('ppAdmin.shardSplitting') : t('ppAdmin.shardNotDone')}
                </div>
                <div style={{ color: shards.imported === shards.shards && shards.complete ? '#22c55e' : MUTED, marginTop: 2 }}>
                  {t('ppAdmin.importedOf', { imported: formatPowerplayCount(shards.imported), shards: formatPowerplayCount(shards.shards), systems: formatPowerplayCount(shards.importedSystems) })}
                </div>
                {shards.shards > 0 && (
                  <div style={{ marginTop: 4 }}>
                    <ProgressBar fraction={shards.imported / Math.max(1, shards.shards)} color={shards.imported === shards.shards ? '#22c55e' : PP} height={5} label={t('ppAdmin.shardsInDbLabel')} />
                  </div>
                )}
              </>
            ) : (
              <div>
                {archive?.complete
                  ? t('ppAdmin.noShardsReady')
                  : running
                    ? t('ppAdmin.noShardsRunning')
                    : t('ppAdmin.noShardsIdle')}
              </div>
            )}
            <div style={{ marginTop: 2 }} data-pp-admin-writer="">
              {t('ppAdmin.writerLabel')}{' '}
              {writer?.backend === 'pg'
                ? <>{(writer.host ? t('ppAdmin.writerDirectHost', { host: writer.host }) : t('ppAdmin.writerDirect')) + t('ppAdmin.writerDirectTail')}</>
                : <>{t('ppAdmin.writerPostgrest', { size: formatPowerplayCount(status?.config.batchSize ?? 2000) })}{writer?.disabled ? ' (POWERPLAY_DB_DIRECT=0)' : ''}</>}
            </div>
            {shards?.dir && <div style={{ fontSize: 11, color: DIM, marginTop: 2, overflowWrap: 'anywhere' }}><code>{shards.dir}</code></div>}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
              <button
                type="button"
                className="btn"
                style={{ fontSize: 12, padding: '3px 8px' }}
                disabled={busy !== null || running || uploading || !archive?.complete}
                onClick={() => void act('split')}
                title={archive?.complete ? t('ppAdmin.splitHint') : t('ppAdmin.splitFirst')}
                data-pp-admin-action="split"
              >
                {t('ppAdmin.splitButton')}
              </button>
              <button
                type="button"
                className="btn"
                style={{ fontSize: 12, padding: '3px 8px' }}
                disabled={busy !== null || running || uploading || !(archive?.complete || shards?.complete)}
                onClick={() => void act('import')}
                title={t('ppAdmin.importHint')}
                data-pp-admin-action="import"
              >
                {t('ppAdmin.importButton')}
              </button>
            </div>
          </div>
        </div>

        {progress ? (
          <div data-pp-admin-progress={progress.phase}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12, color: MUTED, marginBottom: 4, flexWrap: 'wrap' }}>
              <span style={{ color: progress.phase === 'running' ? PP : progress.phase === 'error' ? '#ef4444' : progress.phase === 'cancelled' ? '#e67e22' : '#22c55e' }}>
                {progress.phase === 'running'
                  ? t('ppAdmin.runningLoad')
                  : progress.phase === 'ok' && progress.mode === 'download'
                    ? t('ppAdmin.lastDownload')
                    : progress.phase === 'ok' && progress.mode === 'split'
                      ? t('ppAdmin.lastSplit')
                      : t('ppAdmin.lastLoad', { phase: POWERPLAY_PHASE_LABEL[progress.phase] })}
                {' · '}{progress.percent.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} %
              </span>
              <span>
                <IconClock size={11} /> {formatPowerplayDuration(elapsed)} · {formatTime(progress.startedAt, locale)}
              </span>
            </div>
            <ProgressBar
              fraction={progress.percent / 100}
              color={progress.phase === 'error' ? '#ef4444' : progress.phase === 'cancelled' ? '#e67e22' : progress.phase === 'running' ? PP : '#22c55e'}
              height={10}
              label={t('ppAdmin.overallProgress')}
            />
            <div style={{ fontSize: 12, color: TEXT, marginTop: 6 }} data-pp-admin-message="">{progress.message}</div>
            <div style={{ fontSize: 11, color: DIM, marginTop: 2 }}>
              {t('ppAdmin.triggerLine', { trigger: POWERPLAY_TRIGGER_LABEL[progress.trigger], mode: POWERPLAY_MODE_LABEL[progress.mode] ?? POWERPLAY_MODE_LABEL.full })}{progress.force ? t('ppAdmin.forced') : ''}
            </div>

            <ol style={{ listStyle: 'none', margin: '10px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 7 }} aria-label={t('ppAdmin.stagesAria')}>
              {POWERPLAY_SYNC_STAGES.map((def) => {
                const stage = progress.stages.find((item) => item.id === def.id);
                if (!stage) return null;
                const color = STAGE_COLORS[stage.status];
                const indeterminate = stage.status === 'running' && !(stage.total && stage.total > 0);
                return (
                  <li key={def.id} data-pp-admin-stage={def.id} data-status={stage.status} style={{ display: 'grid', gridTemplateColumns: '205px minmax(0, 1fr) 90px', gap: 8, alignItems: 'center', fontSize: 12 }}>
                    <span style={{ color: stage.status === 'pending' ? DIM : TEXT, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      {stage.status === 'done' ? <IconCheckCircle size={12} color={color} /> : stage.status === 'error' ? <IconXCircle size={12} color={color} /> : (
                        <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: color, marginLeft: 2, marginRight: 2 }} />
                      )}
                      {def.label}
                    </span>
                    <span style={{ minWidth: 0 }}>
                      <ProgressBar fraction={stage.status === 'skipped' ? 0 : powerplayStageFraction(stage)} color={color} height={6} indeterminate={indeterminate} label={def.label} />
                      <span
                        style={{ display: 'block', fontSize: 11, color: MUTED, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                        title={stage.detail || undefined}
                      >
                        {stage.detail || stageStatusLabel(t, stage, progress.phase)}
                      </span>
                    </span>
                    <span style={{ fontSize: 11, color: DIM, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                      {stageStatusLabel(t, stage, progress.phase)}
                      {stageDuration(stage, serverNow) ? <><br />{stageDuration(stage, serverNow)}</> : null}
                    </span>
                  </li>
                );
              })}
            </ol>

            {progress.phase === 'ok' && progress.result && (progress.mode === 'download' || progress.mode === 'split') && (
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', color: '#22c55e', fontSize: 13, marginTop: 10 }} data-pp-admin-result="">
                <IconCheckCircle size={14} color="#22c55e" />
                {progress.mode === 'download'
                  ? <>{t('ppAdmin.resultDownload', { size: formatPowerplayBytes(progress.result.archiveBytes), duration: formatPowerplayDuration(progress.result.durationMs) })}</>
                  : <>{t('ppAdmin.resultSplit', { shards: formatPowerplayCount(progress.result.shards), systems: formatPowerplayCount(progress.result.systems), duration: formatPowerplayDuration(progress.result.durationMs) })}</>}
              </div>
            )}
            {progress.phase === 'ok' && progress.result && progress.mode !== 'download' && progress.mode !== 'split' && (
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', color: '#22c55e', fontSize: 13, marginTop: 10 }} data-pp-admin-result="">
                <IconCheckCircle size={14} color="#22c55e" />
                {t('ppAdmin.resultImported', { rows: formatPowerplayCount(progress.result.rows), deleted: formatPowerplayCount(progress.result.deleted), total: formatPowerplayCount(progress.result.total) })}
                {progress.result.shards ? <>{' '}{t('ppAdmin.resultShardTail', { shards: formatPowerplayCount(progress.result.shards) })}</> : null}{' '}
                {t('ppAdmin.resultDuration', { duration: formatPowerplayDuration(progress.result.durationMs) })}
              </div>
            )}
            {progress.phase === 'not_modified' && (
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', color: '#22c55e', fontSize: 13, marginTop: 10 }} data-pp-admin-result="">
                <IconCheckCircle size={14} color="#22c55e" />
                {t('ppAdmin.notModified')}
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
            {status ? t('ppAdmin.noLoadsYet') : t('ppAdmin.loadingState')}
          </div>
        )}

        {status?.interrupted && (
          <div style={{ fontSize: 12, color: '#e67e22', marginTop: 8 }} data-pp-admin-interrupted="">
            {t('ppAdmin.interrupted')}
          </div>
        )}

        <div style={{ fontSize: 12, color: MUTED, lineHeight: 1.6, marginTop: 12 }}>
          <code>{dumpUrl}</code> {t('ppAdmin.src1')}
          {t('ppAdmin.src2')}
          {t('ppAdmin.src3', { connections, size: formatPowerplayBytes(pieceBytes), stall: stallSeconds })}
          {shortRequests === 'off'
            ? t('ppAdmin.srcShortOff')
            : typeof shortRequests === 'number'
              ? t('ppAdmin.srcShortOn', { size: formatPowerplayBytes(shortRequests) })
              : t('ppAdmin.srcShortAuto')}
          {t('ppAdmin.srcSplit', { shards: formatPowerplayCount(shardSystems) })}
          {status?.config.archiveKeep ? t('ppAdmin.srcKeep') : t('ppAdmin.srcDelete')}
          <br />
          {t('ppAdmin.srcAuto', { stale: status?.config.staleAfterHours ?? 26, retry: status?.config.retryAfterMinutes ?? 30 })}
          {status?.config.nextScheduledRun ? <> {t('ppAdmin.srcAutoNext', { time: formatUtc(status.config.nextScheduledRun, locale) })}{status?.config.nextLazyAttempt ? <> {' '}{t('ppAdmin.srcAutoRetry', { time: formatTime(status.config.nextLazyAttempt, locale) })}</> : null}</> : null}
          {t('ppAdmin.srcAutoTail')}
          <br />
          {t('ppAdmin.srcGuard', { min: status?.config.minRows ?? 100 })}
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
          <div style={{ ...labelStyle, marginBottom: 0 }}>{t('ppAdmin.logTitle')}{status?.log.length ? ` (${status.log.length})` : ''}</div>
          <button type="button" className="btn" style={{ fontSize: 11, padding: '2px 8px' }} onClick={() => void copyLog()} disabled={!status?.log.length}>
            <IconCopy size={11} /> {t(copied ? 'ppAdmin.logCopied' : 'ppAdmin.logCopy')}
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
                <span style={{ color: DIM }}>{formatClock(line.at, locale)}</span> {line.text}
              </div>
            ))}
          </pre>
        ) : (
          <div style={{ fontSize: 12, color: DIM }}>{t('ppAdmin.logEmpty')}</div>
        )}
        {status && !status.progressPersisted && !running && (
          <div style={{ fontSize: 11, color: DIM, marginTop: 6 }}>
            {t('ppAdmin.logMigrationNote')}
          </div>
        )}
      </div>

      {message && (
        <div style={{ fontSize: 13, color: isError ? '#ef4444' : '#22c55e' }} role="status">{message}</div>
      )}
    </div>
  );
}

const EDDN_STATUS_COLOR: Record<EddnAdminStatus['status'], string> = {
  off: MUTED,
  connecting: PP,
  connected: '#22c55e',
  waiting: '#fbbf24',
};

const EDDN_STATUS_KEY: Record<EddnAdminStatus['status'], string> = {
  off: 'ppAdmin.eddnStatusOff',
  connecting: 'ppAdmin.eddnConnecting',
  connected: 'ppAdmin.eddnConnected',
  waiting: 'ppAdmin.eddnWaiting',
};

function EddnCard({ eddn, busy, onStart, onStop }: { eddn: EddnAdminStatus; busy: string | null; onStart: () => void; onStop: () => void }) {
  const { t, locale } = useI18n();
  const stats = eddn.stats ?? {};
  const pill = eddn.running
    ? { text: t(EDDN_STATUS_KEY[eddn.status] ?? 'ppAdmin.eddnStatusOff'), color: EDDN_STATUS_COLOR[eddn.status] ?? MUTED }
    : { text: t(eddn.enabled ? 'ppAdmin.eddnEnabledNoListener' : 'ppAdmin.eddnStatusOff'), color: eddn.enabled ? '#fbbf24' : MUTED };
  const log = (eddn.log ?? []).slice(-15);
  const count = (value: number | undefined) => formatPowerplayCount(value ?? 0);
  return (
    <div style={cardStyle} data-pp-admin-eddn={eddn.running ? eddn.status : eddn.enabled ? 'enabled' : 'off'}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
        <div style={{ ...labelStyle, marginBottom: 0 }}>{t('ppAdmin.eddnTitle')}</div>
        <span style={{ fontSize: 12, color: pill.color }}>● {pill.text}</span>
      </div>
      <div style={{ fontSize: 12, color: MUTED, lineHeight: 1.5, marginBottom: 8 }}>
        {t('ppAdmin.eddnLead')}
        <br />
        <span style={{ color: DIM }}>{t('ppAdmin.eddnTraffic')}</span>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        {eddn.enabled ? (
          <button type="button" className="btn btn-danger" disabled={busy !== null} onClick={onStop} data-pp-admin-action="eddn-stop">
            {t('ppAdmin.eddnStop')}
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-cyan"
            disabled={busy !== null || !eddn.supported || eddn.forbidden}
            onClick={onStart}
            data-pp-admin-action="eddn-start"
          >
            {t('ppAdmin.eddnStart')}
          </button>
        )}
        <span style={{ fontSize: 11, color: DIM, alignSelf: 'center' }}>{t('ppAdmin.eddnRelay', { relay: eddn.relay })}</span>
      </div>
      {!eddn.supported && (
        <div style={{ fontSize: 12, color: '#fbbf24', marginBottom: 8 }}>
          {t('ppAdmin.eddnNoTable')}
        </div>
      )}
      {eddn.forbidden && (
        <div style={{ fontSize: 12, color: '#fbbf24', marginBottom: 8 }}>
          {t('ppAdmin.eddnForbidden')}
        </div>
      )}
      {(eddn.running || (stats.messages ?? 0) > 0) && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8, marginBottom: 8 }} data-pp-admin-eddn-stats="">
          <Stat label={t('ppAdmin.statMessages')} value={count(stats.messages)} small />
          <Stat label={t('ppAdmin.statObservations')} value={count(stats.observations)} small />
          <Stat label={t('ppAdmin.statPpApplied')} value={count(stats.powerplay?.applied)} small color="#22c55e" />
          <Stat label={t('ppAdmin.statResolved')} value={count(stats.powerplay?.resolved)} small color="#22c55e" />
          <Stat label={t('ppAdmin.statFactions')} value={count(stats.factions?.applied)} small />
          <Stat label={t('ppAdmin.statBytes')} value={formatBytesShort(t, locale, stats.bytes ?? 0)} small />
          <Stat label={t('ppAdmin.statSessions')} value={`${count(stats.sessions)} / ${count(stats.stalls)}`} small />
          <Stat label={t('ppAdmin.statLastMessage')} value={formatTime(stats.lastMessageAt, locale)} small />
        </div>
      )}
      {eddn.running && (eddn.pending ?? 0) > 0 && (
        <div style={{ fontSize: 11, color: DIM, marginBottom: 6 }}>{t('ppAdmin.statQueue', { count: count(eddn.pending) })}</div>
      )}
      {eddn.running && eddn.status === 'waiting' && eddn.nextAttemptAt && (
        <div style={{ fontSize: 11, color: DIM, marginBottom: 6 }}>{t('ppAdmin.statNextAttempt', { time: formatTime(eddn.nextAttemptAt, locale) })}</div>
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
              <span style={{ color: DIM }}>{formatClock(line.at, locale)}</span> {line.text}
            </div>
          ))}
        </pre>
      )}
    </div>
  );
}

function formatBytesShort(t: TFn, locale: string, value: number): string {
  if (value < 1024 * 1024) return t('ppAdmin.bytesKb', { value: String(Math.round(value / 1024)) });
  if (value < 1024 * 1024 * 1024) {
    return t('ppAdmin.bytesMb', { value: (value / 1024 / 1024).toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) });
  }
  return t('ppAdmin.bytesGb', { value: (value / 1024 / 1024 / 1024).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) });
}

function Stat({ label, value, color, small = false }: { label: string; value: string; color?: string; small?: boolean }) {
  return (
    <div style={{ background: '#101214', border: '1px solid #26292d', borderRadius: 4, padding: '8px 10px' }}>
      <div style={{ fontSize: 10, color: DIM, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: small ? 13 : 20, color: color ?? TEXT, fontWeight: 600, marginTop: 2, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
    </div>
  );
}
