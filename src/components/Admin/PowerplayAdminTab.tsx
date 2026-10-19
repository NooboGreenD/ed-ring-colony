'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { authFetch } from '@/lib/supabaseClient';
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
  full: 'идёт загрузка дампа',
  download: 'идёт скачивание архива на сервер',
  split: 'идёт разбивка архива на куски',
  import: 'идёт запись кусков в базу',
};

const innerCardStyle = { background: '#101214', border: '1px solid #26292d', borderRadius: 4, padding: '8px 10px', fontSize: 12, color: MUTED } as const;

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
  if (status.running) return { text: RUNNING_PILL[status.mode ?? 'full'] ?? RUNNING_PILL.full, color: PP };
  if (status.interrupted) return { text: 'загрузка прервана перезапуском сайта', color: '#e67e22' };
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
    if (action === 'cleanup' && !window.confirm('Удалить архив дампа PowerPlay и куски с сервера? Следующая загрузка скачает дамп заново.')) return;
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
        setMessage(payload?.reason || 'Импорт уже идёт');
      } else if (!response.ok || payload?.success === false) {
        throw new Error(payload?.error || `HTTP ${response.status}`);
      } else if (action === 'cancel') {
        setMessage(payload?.cancelled
          ? 'Останавливаю импорт… Скачанное и разбитое останется на сервере — следующий запуск продолжит с того же места.'
          : 'Импорт не выполнялся');
      } else if (action === 'cleanup') {
        setMessage(payload?.removed
          ? `Архив и куски удалены с сервера — освобождено ${formatPowerplayBytes(payload?.freed)}`
          : 'На сервере нет ни архива, ни кусков');
      } else if (action === 'eddn-start') {
        setMessage('Живые данные EDDN включены: слушатель подключается к реле. Флаг сохранён — после перезапуска сайта слушатель поднимется сам.');
      } else if (action === 'eddn-stop') {
        setMessage('Живые данные EDDN выключены: накопленные наблюдения дописаны, подписка закрыта.');
      } else if (action === 'download') {
        setMessage(`Архив скачивается на сервер в ${connections} соедин. При обрыве или перезапуске скачивание продолжится с того же места.`);
      } else if (action === 'split') {
        setMessage('Разбивка архива на куски запущена — она не обращается к EDSM.');
      } else if (action === 'import') {
        setMessage('Запись в базу запущена: то, что уже на сервере, без обращения к EDSM.');
      } else {
        setMessage(force
          ? 'Загрузка запущена принудительно: дамп загружается, даже если он тот же, что в прошлый раз, и принимается, даже если он заметно меньше прошлого.'
          : status?.archive?.uploaded && status.archive.complete
            ? 'Загрузка запущена: архив, загруженный с компьютера, разбивается на куски, затем куски пишутся в базу — без EDSM.'
            : `Загрузка запущена: архив целиком скачивается на сервер (${connections} соедин.), затем разбивается на куски, затем куски пишутся в базу. Если дамп тот же, что в прошлый раз, загрузка закончится сразу — данные актуальны.`);
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
              Систем PowerPlay в базе нет — вкладка «PowerPlay» в Atlas пуста. Нажмите «Загрузить данные» ниже: дамп EDSM весит
              ≈3,6 МБ, загрузка обычно занимает секунды, ход виден по этапам и в журнале. Если сеть сервера не пускает к EDSM —
              загрузите архив с компьютера.
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

      {/* ── Загрузка дампа EDSM: архив → куски → база ── */}
      <div style={cardStyle} data-pp-admin-sync="">
        <div style={labelStyle}>Загрузка из EDSM (powerPlay.json.gz)</div>
        <div style={{ fontSize: 12, color: MUTED, marginBottom: 10, lineHeight: 1.5 }}>
          Как у фракций и в «Каталоге систем», шаги по очереди: <strong style={{ color: TEXT }}>архив скачивается на сервер целиком</strong> →{' '}
          <strong style={{ color: TEXT }}>затем разбивается на куски</strong> по {formatPowerplayCount(shardSystems)} систем →{' '}
          <strong style={{ color: TEXT }}>затем куски загружаются в базу</strong>. Каждый шаг начинается, когда предыдущий закончен, и
          его можно запустить отдельно — кнопками в карточках ниже. Серверу, которому EDSM недоступен, архив можно загрузить с компьютера.
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10, alignItems: 'center' }}>
          <button type="button" className="btn btn-cyan" disabled={busy !== null || running || uploading} onClick={() => void act('start')} data-pp-admin-action="start">
            {total > 0 ? 'Загрузить сейчас' : 'Загрузить данные'}
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy !== null || running || uploading}
            onClick={() => void act('force')}
            title="Загрузить дамп, даже если он тот же, что в прошлый раз, и принять его, даже если он заметно меньше прошлого"
            data-pp-admin-action="force"
          >
            Перекачать принудительно
          </button>
          <button type="button" className="btn btn-danger" disabled={busy !== null || !running} onClick={() => void act('cancel')} data-pp-admin-action="cancel">
            Остановить
          </button>
          <label style={{ fontSize: 12, color: MUTED, display: 'inline-flex', alignItems: 'center', gap: 6 }} title="Сколько параллельных соединений к EDSM открывать для скачивания архива: если сеть сервера режет соединения, несколько соединений коротких запросов качают быстрее">
            Соединений к EDSM:
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
              <div style={{ ...labelStyle, marginBottom: 4 }}>1 · Архив на сервере</div>
              {archive.exists ? (
                archive.complete ? (
                  <div style={{ color: '#22c55e' }} data-pp-admin-archive-state={archive.uploaded ? 'uploaded' : 'complete'}>
                    {archive.uploaded
                      ? <>Загружен с компьютера целиком: {formatPowerplayBytes(archive.bytes)}{archive.uploadName ? ` (${archive.uploadName})` : ''}</>
                      : <>Скачан целиком: {formatPowerplayBytes(archive.bytes)}{archive.lastModified ? ` (дамп от ${archive.lastModified})` : ''}</>}
                  </div>
                ) : archive.manual ? (
                  <div style={{ color: '#fbbf24' }} data-pp-admin-archive-state="manual">
                    Файл архива без метки ({formatPowerplayBytes(archive.bytes)}) — похоже, положен на сервер вручную: «Загрузить данные» примет его
                    как загруженный с компьютера
                  </div>
                ) : (
                  <>
                    <div style={{ color: running ? PP : '#fbbf24' }} data-pp-admin-archive-state="partial">
                      {running ? 'Качается' : 'Скачан не полностью'}: {formatPowerplayBytes(archiveDownloaded)}
                      {archiveTotal ? ` из ${formatPowerplayBytes(archiveTotal)} (${Math.floor((archiveDownloaded / Math.max(1, archiveTotal)) * 100)} %)` : ''}
                      {running ? '' : ' — следующий запуск докачает'}
                    </div>
                    {archiveTotal ? (
                      <div style={{ marginTop: 4 }}>
                        <ProgressBar fraction={archiveDownloaded / Math.max(1, archiveTotal)} color={running ? PP : '#fbbf24'} height={5} label="Скачано архива" />
                      </div>
                    ) : null}
                  </>
                )
              ) : (
                <div>Архива нет — «Загрузить данные» или «Скачать архив» скачают его (после удачной загрузки архив удаляется)</div>
              )}
              <div style={{ marginTop: 2 }}>
                до {connections} соединений, куски файла по {formatPowerplayBytes(pieceBytes)}
                {archive.freeBytes != null ? ` · свободно на диске ${formatPowerplayBytes(archive.freeBytes)}` : ''}
              </div>
              <div style={{ fontSize: 11, color: DIM, marginTop: 2, overflowWrap: 'anywhere' }}><code>{archive.path}</code></div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                <button
                  type="button"
                  className="btn"
                  style={{ fontSize: 12, padding: '3px 8px' }}
                  disabled={busy !== null || running || uploading}
                  onClick={() => void act('download')}
                  title="Только скачать архив на сервер (в базу ничего не пишется)"
                  data-pp-admin-action="download"
                >
                  {archive.exists && !archive.complete ? 'Докачать архив' : 'Скачать архив'}
                </button>
                <button
                  type="button"
                  className="btn"
                  style={{ fontSize: 12, padding: '3px 8px' }}
                  disabled={busy !== null || running || uploading || !(archive.exists || shards?.exists)}
                  onClick={() => void act('cleanup')}
                  title="Удалить архив и куски с сервера"
                  data-pp-admin-action="cleanup"
                >
                  <IconTrash size={12} /> Удалить архив и куски
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
            <div style={{ ...labelStyle, marginBottom: 4 }}>2 · Куски (шарды) → 3 · база</div>
            {shards?.exists && (shards.shards > 0 || shards.complete) ? (
              <>
                <div style={{ color: shards.complete ? TEXT : splitting ? PP : '#fbbf24' }}>
                  {formatPowerplayCount(shards.shards)} кусков · {formatPowerplayCount(shards.systems)} систем · {formatPowerplayBytes(shards.bytes)}
                  {shards.complete ? ' — архив разбит до конца' : splitting ? ' — разбивка идёт' : ' — разбит не до конца, следующий запуск разобьёт заново'}
                </div>
                <div style={{ color: shards.imported === shards.shards && shards.complete ? '#22c55e' : MUTED, marginTop: 2 }}>
                  В базе: {formatPowerplayCount(shards.imported)} из {formatPowerplayCount(shards.shards)} кусков ({formatPowerplayCount(shards.importedSystems)} систем)
                </div>
                {shards.shards > 0 && (
                  <div style={{ marginTop: 4 }}>
                    <ProgressBar fraction={shards.imported / Math.max(1, shards.shards)} color={shards.imported === shards.shards ? '#22c55e' : PP} height={5} label="Кусков в базе" />
                  </div>
                )}
              </>
            ) : (
              <div>
                {archive?.complete
                  ? 'Кусков нет — архив на сервере: «Разбить на куски» или «Загрузить данные» разобьют его'
                  : running
                    ? 'Кусков пока нет — архив разобьётся на куски, когда будет на сервере целиком'
                    : 'Кусков нет — они появятся, когда архив будет на сервере целиком'}
              </div>
            )}
            <div style={{ marginTop: 2 }} data-pp-admin-writer="">
              Запись в базу:{' '}
              {writer?.backend === 'pg'
                ? <>прямой Postgres{writer.host ? ` (${writer.host})` : ''} — кусок одним вызовом</>
                : <>PostgREST — пачками по {formatPowerplayCount(status?.config.batchSize ?? 2000)} систем{writer?.disabled ? ' (POWERPLAY_DB_DIRECT=0)' : ''}</>}
            </div>
            {shards?.dir && <div style={{ fontSize: 11, color: DIM, marginTop: 2, overflowWrap: 'anywhere' }}><code>{shards.dir}</code></div>}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
              <button
                type="button"
                className="btn"
                style={{ fontSize: 12, padding: '3px 8px' }}
                disabled={busy !== null || running || uploading || !archive?.complete}
                onClick={() => void act('split')}
                title={archive?.complete ? 'Разбить архив на куски (без EDSM и без записи в базу)' : 'Сначала скачайте архив целиком или загрузите его с компьютера'}
                data-pp-admin-action="split"
              >
                Разбить на куски
              </button>
              <button
                type="button"
                className="btn"
                style={{ fontSize: 12, padding: '3px 8px' }}
                disabled={busy !== null || running || uploading || !(archive?.complete || shards?.complete)}
                onClick={() => void act('import')}
                title="Записать в базу то, что уже на сервере (архив или куски), без обращения к EDSM"
                data-pp-admin-action="import"
              >
                Загрузить куски в базу
              </button>
            </div>
          </div>
        </div>

        {progress ? (
          <div data-pp-admin-progress={progress.phase}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12, color: MUTED, marginBottom: 4, flexWrap: 'wrap' }}>
              <span style={{ color: progress.phase === 'running' ? PP : progress.phase === 'error' ? '#ef4444' : progress.phase === 'cancelled' ? '#e67e22' : '#22c55e' }}>
                {progress.phase === 'running'
                  ? 'Идёт загрузка'
                  : progress.phase === 'ok' && progress.mode === 'download'
                    ? 'Последний запуск: архив скачан'
                    : progress.phase === 'ok' && progress.mode === 'split'
                      ? 'Последний запуск: архив разбит на куски'
                      : `Последняя загрузка: ${POWERPLAY_PHASE_LABEL[progress.phase]}`}
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
              Запуск: {POWERPLAY_TRIGGER_LABEL[progress.trigger]} · {POWERPLAY_MODE_LABEL[progress.mode] ?? POWERPLAY_MODE_LABEL.full}{progress.force ? ' · принудительно' : ''}
            </div>

            <ol style={{ listStyle: 'none', margin: '10px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 7 }} aria-label="Этапы загрузки">
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

            {progress.phase === 'ok' && progress.result && (progress.mode === 'download' || progress.mode === 'split') && (
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', color: '#22c55e', fontSize: 13, marginTop: 10 }} data-pp-admin-result="">
                <IconCheckCircle size={14} color="#22c55e" />
                {progress.mode === 'download'
                  ? <>Архив на сервере: {formatPowerplayBytes(progress.result.archiveBytes)} · за {formatPowerplayDuration(progress.result.durationMs)} — в базу пока ничего не записано</>
                  : <>Кусков: {formatPowerplayCount(progress.result.shards)} · систем {formatPowerplayCount(progress.result.systems)} · за {formatPowerplayDuration(progress.result.durationMs)} — в базу пока ничего не записано</>}
              </div>
            )}
            {progress.phase === 'ok' && progress.result && progress.mode !== 'download' && progress.mode !== 'split' && (
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', color: '#22c55e', fontSize: 13, marginTop: 10 }} data-pp-admin-result="">
                <IconCheckCircle size={14} color="#22c55e" />
                Записано {formatPowerplayCount(progress.result.rows)} систем, удалено пропавших {formatPowerplayCount(progress.result.deleted)},
                всего на карте {formatPowerplayCount(progress.result.total)}
                {progress.result.shards ? <> · кусков {formatPowerplayCount(progress.result.shards)}</> : null} · за {formatPowerplayDuration(progress.result.durationMs)}
              </div>
            )}
            {progress.phase === 'not_modified' && (
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', color: '#22c55e', fontSize: 13, marginTop: 10 }} data-pp-admin-result="">
                <IconCheckCircle size={14} color="#22c55e" />
                Дамп EDSM тот же, что при прошлой загрузке, — данные на сайте актуальны. «Перекачать принудительно» загрузит его ещё раз.
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
          <div style={{ fontSize: 12, color: '#e67e22', marginTop: 8 }} data-pp-admin-interrupted="">
            Прошлая загрузка оборвалась вместе с процессом сайта (обновление или перезапуск). Скачанное и разбитое осталось на
            сервере — «Загрузить сейчас» продолжит с того же места (уже записанные куски повторно не пишутся); задача
            powerplay-sync и открытие вкладки PowerPlay сделают это сами.
          </div>
        )}

        <div style={{ fontSize: 12, color: MUTED, lineHeight: 1.6, marginTop: 12 }}>
          Источник: <code>{dumpUrl}</code> — ночной дамп EDSM (≈3–4 МБ gzip): все системы, о состоянии PowerPlay которых пилоты
          сообщали за последние ~30 дней. На сайт попадают системы под контролем (оплоты, укреплённые, эксплуатируемые);
          Unoccupied отбрасываются. Архив качается на сервер целиком в{` ${connections} `}соединений (<code>POWERPLAY_DOWNLOAD_SEGMENTS</code>),
          куски файла по {formatPowerplayBytes(pieceBytes)}; обрыв и перезапуск сайта не теряют скачанного. Соединение, молчащее
          {` ${stallSeconds} `}с (<code>POWERPLAY_STALL_SECONDS</code>), переподключается сразу, а не через 70 с ожидания ОС.
          {shortRequests === 'off'
            ? ' Короткие запросы выключены (POWERPLAY_REQUEST_KB=off).'
            : typeof shortRequests === 'number'
              ? ` Запросы — по ${formatPowerplayBytes(shortRequests)}, каждый в новом соединении (POWERPLAY_REQUEST_KB).`
              : ' Если соединения замирают, успев передать лишь несколько килобайт (так сеть сервера режет сессии к зарубежным CDN, а EDSM — за Cloudflare), загрузка сама переходит на короткие запросы меньше этого порога, каждый в новом соединении.'}
          {' '}Когда архив на сервере, записи одной системы собираются вместе (EDSM пишет по записи на каждую державу в системе) и
          системы раскладываются в куски по {formatPowerplayCount(shardSystems)}, затем куски пишутся в базу; кусок — единица
          продолжения. Если EDSM пересоберёт дамп посреди скачивания, скачивание начнётся заново со свежим дампом. После удачной
          загрузки архив и куски
          {status?.config.archiveKeep ? ' остаются на сервере (POWERPLAY_ARCHIVE_KEEP=1)' : ' удаляются с сервера'}.
          <br />
          Автоматически: задача планировщика <code>powerplay-sync</code> раз в 12 часов
          {status?.config.nextScheduledRun ? <> (ближайший запуск — {formatUtc(status.config.nextScheduledRun)}, если задача включена в <code>JOBS_ENABLED</code>)</> : null},
          а также при открытии вкладки PowerPlay, если данных нет или они старше {status?.config.staleAfterHours ?? 26} ч
          (после неудачи — не чаще раза в {status?.config.retryAfterMinutes ?? 30} мин
          {status?.config.nextLazyAttempt ? <>, следующая попытка не раньше {formatTime(status.config.nextLazyAttempt)}</> : null}).
          Тот же дамп, что в прошлый раз, второй раз не качается.
          <br />
          Защита данных: битый gzip, ошибка HTTP, меньше {status?.config.minRows ?? 100} систем или дамп меньше половины прошлого
          таблицу не трогают — карта остаётся со вчерашними данными. «Перекачать принудительно» загружает тот же дамп ещё раз и
          снимает проверку на «усохший» дамп.
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
