'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { authFetch } from '@/lib/supabaseClient';
import { IconAlert, IconCheckCircle, IconClock, IconCopy, IconRefresh, IconShieldHalf, IconTrash, IconUpload, IconXCircle } from '@/components/Icons';
import { BGS_ALLEGIANCE_COLOR, BGS_SOURCE_LABEL, allegianceLabel, formatBgsDate, normalizeSource } from '@/lib/bgs';
import {
  BGS_MODE_LABEL,
  BGS_PHASE_LABEL,
  BGS_SYNC_STAGES,
  BGS_TRIGGER_LABEL,
  bgsStageFraction,
  formatBgsBytes,
  formatBgsCount,
  formatBgsDuration,
  formatBgsSpeed,
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
 *     населённых систем. Загрузка устроена как у «Каталога систем», шаги идут
 *     по очереди: архив скачивается на сервер целиком в несколько соединений,
 *     затем разбивается на куски по тысяче систем, затем куски пишутся в базу.
 *     Серверу, которому EDSM недоступен, архив можно загрузить с компьютера.
 *     Здесь — карточки архива и кусков (каждый шаг можно запустить отдельно),
 *     этапы с прогресс-барами, общий процент, журнал, остановка и очистка;
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

type RunMode = 'full' | 'download' | 'split' | 'import';
type Action = 'start' | 'force' | 'download' | 'split' | 'import' | 'cancel' | 'cleanup';

interface AdminStatus {
  running: boolean;
  mode?: RunMode | null;
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
    source: { url: string; lastModified: string | null; total: number | null } | null;
    completedAt: string | null;
  };
  writer?: { backend: 'pg' | 'postgrest'; host: string | null; disabled: boolean };
  config: {
    dumpUrl: string;
    archiveKeep: boolean;
    segments: number;
    maxSegments?: number;
    pieceBytes?: number;
    stallSeconds?: number;
    shortRequests?: 'auto' | 'off' | number;
    shardSystems?: number;
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

const SEGMENT_CHOICES = [1, 2, 4, 6, 8, 12, 16];

const RUNNING_PILL: Record<RunMode, string> = {
  full: 'идёт загрузка дампа',
  download: 'идёт скачивание архива на сервер',
  split: 'идёт разбивка архива на куски',
  import: 'идёт запись кусков в базу',
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
  if (status.running) return { text: RUNNING_PILL[status.mode ?? 'full'] ?? RUNNING_PILL.full, color: RUN };
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

interface UploadState {
  name: string;
  size: number;
  sent: number;
  /** С какого байта началась эта сессия (продолжение незаконченной загрузки). */
  startOffset: number;
  startedAt: number;
}

class UploadHttpError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const UPLOAD_CHUNK_FALLBACK = 8 * 1024 * 1024;

async function postUpload(body: Record<string, unknown>): Promise<Record<string, any>> {
  const response = await authFetch('/api/admin/factions/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || payload.success === false) {
    throw new UploadHttpError(payload?.error || `HTTP ${response.status}`, response.status);
  }
  return payload;
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
  const [segments, setSegments] = useState<number | null>(null);
  const [upload, setUpload] = useState<UploadState | null>(null);
  const uploadAbort = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
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

  const connections = segments ?? status?.config.segments ?? 8;

  const act = async (action: Action) => {
    if (action === 'cleanup' && !window.confirm('Удалить архив дампа и куски с сервера? Следующая загрузка скачает дамп заново.')) return;
    setBusy(action);
    setMessage('');
    setIsError(false);
    const force = action === 'force';
    const body: Record<string, unknown> = { action: force ? 'start' : action, force };
    if (action === 'start' || action === 'force' || action === 'download') body.segments = connections;
    try {
      const response = await authFetch('/api/admin/factions', {
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
          ? 'Останавливаю… Скачанное и разбитое останется на сервере — следующий запуск продолжит с того же места.'
          : 'Импорт не выполнялся');
      } else if (action === 'cleanup') {
        setMessage(payload?.removed
          ? `Архив и куски удалены с сервера — освобождено ${formatBgsBytes(payload?.freed)}`
          : 'На сервере нет ни архива, ни кусков');
      } else if (action === 'download') {
        setMessage(`Архив скачивается на сервер в ${connections} соедин. Страницу можно закрыть: при обрыве или перезапуске скачивание продолжится с того же места.`);
      } else if (action === 'split') {
        setMessage('Разбивка архива на куски запущена — она не обращается к EDSM.');
      } else if (action === 'import') {
        setMessage('Запись в базу запущена: то, что уже на сервере, без обращения к EDSM.');
      } else {
        setMessage(force
          ? 'Загрузка запущена принудительно: дамп загружается, даже если он тот же, и принимается, даже если он заметно меньше прошлого.'
          : status?.archive.uploaded && status.archive.complete
            ? 'Загрузка запущена: архив, загруженный с компьютера, разбивается на куски, затем куски пишутся в базу — без EDSM.'
            : `Загрузка запущена: архив целиком скачивается на сервер (${connections} соедин.), затем разбивается на куски, затем куски пишутся в базу. Если дамп тот же, что в прошлый раз, загрузка закончится сразу.`);
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

  /**
   * Архив с компьютера: кусками по 8 МБ, каждый со своим смещением. Обрыв —
   * повтор куска; 409 — сервер говорит, сколько у него на самом деле, и
   * загрузка продолжается с этого места (в том числе после перезагрузки
   * страницы: тот же файл продолжается, а не начинается заново).
   */
  const uploadArchive = async (file: File) => {
    const controller = new AbortController();
    uploadAbort.current = controller;
    setMessage('');
    setIsError(false);
    try {
      const started = await postUpload({ action: 'start', name: file.name, size: file.size, lastModified: file.lastModified });
      let offset = Math.max(0, Number(started.offset) || 0);
      const chunkBytes = Math.max(1024, Number(started.chunkBytes) || UPLOAD_CHUNK_FALLBACK);
      setUpload({ name: file.name, size: file.size, sent: offset, startOffset: offset, startedAt: Date.now() });
      while (offset < file.size) {
        const end = Math.min(file.size, offset + chunkBytes);
        for (let attempt = 1; ; attempt++) {
          if (controller.signal.aborted) throw new Error('stopped');
          try {
            const response = await authFetch(`/api/admin/factions/upload?offset=${offset}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/octet-stream' },
              body: file.slice(offset, end),
              signal: controller.signal,
            });
            const payload = await response.json().catch(() => null);
            if (response.status === 409 && typeof payload?.offset === 'number') {
              offset = payload.offset;
              break;
            }
            if (!response.ok || !payload?.success) throw new UploadHttpError(payload?.error || `HTTP ${response.status}`, response.status);
            offset = Number(payload.offset);
            break;
          } catch (error) {
            if (controller.signal.aborted) throw error;
            const status = (error as UploadHttpError).status ?? 0;
            const retryable = status === 0 || status >= 500 || status === 408 || status === 429;
            if (!retryable || attempt >= 6) throw error;
            await new Promise((resolve) => window.setTimeout(resolve, 1500 * attempt));
          }
        }
        setUpload((current) => (current ? { ...current, sent: offset } : current));
      }
      const done = await postUpload({ action: 'finish' });
      setMessage(
        `Архив загружен на сервер: ${formatBgsBytes(done.bytes)}${done.sameAsEdsm ? ' — это тот же дамп, что сейчас на EDSM' : ''}. `
          + 'Нажмите «Загрузить данные»: архив разобьётся на куски и запишется в базу, EDSM не понадобится.',
      );
    } catch (error) {
      if (controller.signal.aborted) {
        setMessage('Загрузка архива остановлена. Принятое осталось на сервере — выберите тот же файл, и загрузка продолжится.');
      } else {
        setMessage(`Архив не загружен: ${(error as Error).message}`);
        setIsError(true);
      }
    } finally {
      uploadAbort.current = null;
      setUpload(null);
      if (fileInput.current) fileInput.current.value = '';
      stickToBottom.current = true;
      await load();
    }
  };

  const discardUpload = async () => {
    if (!window.confirm('Удалить незаконченную загрузку архива с сервера?')) return;
    try {
      const result = await postUpload({ action: 'cancel' });
      setMessage(result.removed ? `Незаконченная загрузка удалена — освобождено ${formatBgsBytes(result.freed)}` : 'Незаконченной загрузки нет');
      setIsError(false);
    } catch (error) {
      setMessage((error as Error).message);
      setIsError(true);
    }
    await load();
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
  const shards = status?.shards ?? null;
  const writer = status?.writer ?? null;
  const decision = status?.config.scheduleDecision ?? null;
  const maxSegments = status?.config.maxSegments ?? 16;
  const segmentChoices = SEGMENT_CHOICES.filter((n) => n <= maxSegments);
  if (!segmentChoices.includes(connections)) segmentChoices.push(connections);
  segmentChoices.sort((a, b) => a - b);
  const archiveDownloaded = archive ? archive.downloaded ?? archive.bytes : 0;
  const archiveTotal = archive?.total ?? null;
  const pieceMb = Math.round((status?.config.pieceBytes ?? 8 * 1024 * 1024) / (1024 * 1024));
  const shardSystems = status?.config.shardSystems ?? 1000;
  const stallSeconds = status?.config.stallSeconds ?? 15;
  const shortRequests = status?.config.shortRequests ?? 'auto';
  const uploading = upload !== null;
  const splitting = running && progress?.stages.find((stage) => stage.id === 'split')?.status === 'running';
  const pendingUpload = !uploading && status?.upload?.active ? status.upload : null;
  const uploadSpeed = upload ? (upload.sent - upload.startOffset) / Math.max(1, (Date.now() - upload.startedAt) / 1000) : 0;
  const dumpUrl = status?.config.dumpUrl ?? 'https://www.edsm.net/dump/systemsPopulated.json.gz';

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
        <div style={{ fontSize: 12, color: MUTED, marginBottom: 10, lineHeight: 1.5 }}>
          Как в «Каталоге систем», шаги по очереди: <strong style={{ color: TEXT }}>архив скачивается на сервер целиком</strong> →{' '}
          <strong style={{ color: TEXT }}>затем разбивается на куски</strong> по {formatBgsCount(shardSystems)} систем →{' '}
          <strong style={{ color: TEXT }}>затем куски загружаются в базу</strong>. Каждый шаг начинается, когда предыдущий закончен, и
          его можно запустить отдельно — кнопками в карточках ниже. Серверу, которому EDSM недоступен, архив можно загрузить с компьютера.
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10, alignItems: 'center' }}>
          <button type="button" className="btn btn-cyan" disabled={busy !== null || running || uploading} onClick={() => void act('start')} data-bgs-admin-action="start">
            {systems > 0 ? 'Загрузить сейчас' : 'Загрузить данные'}
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy !== null || running || uploading}
            onClick={() => void act('force')}
            title="Загрузить дамп, даже если он тот же, что в прошлый раз, и принять его, даже если он заметно меньше"
            data-bgs-admin-action="force"
          >
            Импортировать принудительно
          </button>
          <button type="button" className="btn btn-danger" disabled={busy !== null || !running} onClick={() => void act('cancel')} data-bgs-admin-action="cancel">
            Остановить
          </button>
          <label style={{ fontSize: 12, color: MUTED, display: 'inline-flex', alignItems: 'center', gap: 6 }} title="Сколько параллельных соединений к EDSM открывать для скачивания архива: канал сервера режет скорость одного соединения, поэтому несколько соединений качают быстрее">
            Соединений к EDSM:
            <select
              value={connections}
              disabled={busy !== null || running}
              onChange={(event) => setSegments(Number(event.target.value))}
              data-bgs-admin-segments=""
              style={{ background: '#101214', color: TEXT, border: '1px solid #323538', borderRadius: 3, padding: '2px 4px', fontSize: 12 }}
            >
              {segmentChoices.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 10, marginBottom: 10 }}>
          {archive && (
            <div style={{ background: '#101214', border: '1px solid #26292d', borderRadius: 4, padding: '8px 10px', fontSize: 12, color: MUTED }} data-bgs-admin-archive="">
              <div style={{ ...labelStyle, marginBottom: 4 }}>1 · Архив на сервере</div>
              {archive.exists ? (
                archive.complete ? (
                  <div style={{ color: '#22c55e' }} data-bgs-admin-archive-state={archive.uploaded ? 'uploaded' : 'complete'}>
                    {archive.uploaded
                      ? <>Загружен с компьютера целиком: {formatBgsBytes(archive.bytes)}{archive.uploadName ? ` (${archive.uploadName})` : ''}</>
                      : <>Скачан целиком: {formatBgsBytes(archive.bytes)}{archive.lastModified ? ` (дамп от ${archive.lastModified})` : ''}</>}
                  </div>
                ) : archive.manual ? (
                  <div style={{ color: '#fbbf24' }} data-bgs-admin-archive-state="manual">
                    Файл архива без метки ({formatBgsBytes(archive.bytes)}) — похоже, положен на сервер вручную: «Загрузить данные» примет его
                    как загруженный с компьютера
                  </div>
                ) : (
                  <>
                    <div style={{ color: running ? RUN : '#fbbf24' }}>
                      {running ? 'Качается' : 'Скачан не полностью'}: {formatBgsBytes(archiveDownloaded)}
                      {archiveTotal ? ` из ${formatBgsBytes(archiveTotal)} (${Math.floor((archiveDownloaded / Math.max(1, archiveTotal)) * 100)} %)` : ''}
                      {running ? '' : ' — следующий запуск докачает'}
                    </div>
                    {archiveTotal ? (
                      <div style={{ marginTop: 4 }}>
                        <ProgressBar fraction={archiveDownloaded / Math.max(1, archiveTotal)} color={running ? RUN : '#fbbf24'} height={5} label="Скачано архива" />
                      </div>
                    ) : null}
                  </>
                )
              ) : (
                <div>Архива нет — «Загрузить данные» или «Скачать архив» скачают его</div>
              )}
              <div style={{ marginTop: 2 }}>
                до {connections} соединений, куски файла по {pieceMb} МБ
                {archive.freeBytes != null ? ` · свободно на диске ${formatBgsBytes(archive.freeBytes)}` : ''}
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
                  data-bgs-admin-action="download"
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
                  data-bgs-admin-action="cleanup"
                >
                  <IconTrash size={12} /> Удалить архив и куски
                </button>
              </div>
              <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px dashed #2d3136' }} data-bgs-admin-upload="">
                {upload ? (
                  <>
                    <div style={{ color: RUN }} data-bgs-admin-upload-progress="">
                      Загружаю {upload.name}: {formatBgsBytes(upload.sent)} из {formatBgsBytes(upload.size)}
                      {` (${Math.floor((upload.sent / Math.max(1, upload.size)) * 100)} %)`}
                      {uploadSpeed > 0 ? ` · ${formatBgsSpeed(uploadSpeed)}` : ''}
                    </div>
                    <div style={{ marginTop: 4 }}>
                      <ProgressBar fraction={upload.sent / Math.max(1, upload.size)} color={RUN} height={5} label="Загружено с компьютера" />
                    </div>
                    <button
                      type="button"
                      className="btn btn-danger"
                      style={{ fontSize: 12, padding: '3px 8px', marginTop: 6 }}
                      onClick={() => uploadAbort.current?.abort()}
                      data-bgs-admin-action="upload-stop"
                    >
                      Остановить загрузку
                    </button>
                  </>
                ) : (
                  <>
                    {pendingUpload && (
                      <div style={{ color: '#fbbf24', marginBottom: 6 }} data-bgs-admin-upload-pending="">
                        Незаконченная загрузка: {pendingUpload.name} — {formatBgsBytes(pendingUpload.received)} из {formatBgsBytes(pendingUpload.size)}.
                        Выберите тот же файл — загрузка продолжится с этого места.{' '}
                        <button type="button" className="btn" style={{ fontSize: 11, padding: '1px 6px' }} onClick={() => void discardUpload()} data-bgs-admin-action="upload-discard">
                          Удалить
                        </button>
                      </div>
                    )}
                    <button
                      type="button"
                      className="btn"
                      style={{ fontSize: 12, padding: '3px 8px' }}
                      disabled={busy !== null || running}
                      onClick={() => fileInput.current?.click()}
                      title="Передать на сервер systemsPopulated.json.gz, скачанный на этом компьютере"
                      data-bgs-admin-action="upload"
                    >
                      <IconUpload size={12} /> Загрузить архив с компьютера
                    </button>
                    <input
                      ref={fileInput}
                      type="file"
                      accept=".gz,application/gzip,application/x-gzip"
                      style={{ display: 'none' }}
                      data-bgs-admin-upload-input=""
                      onChange={(event) => {
                        const file = event.currentTarget.files?.[0];
                        if (file) void uploadArchive(file);
                      }}
                    />
                    <div style={{ fontSize: 11, color: DIM, marginTop: 4, lineHeight: 1.5 }}>
                      Серверу не скачать архив с EDSM (в журнале соединения «замолкают» или «замирают»)? Скачайте{' '}
                      <a href={dumpUrl} target="_blank" rel="noreferrer" style={{ color: ACCENT }}>systemsPopulated.json.gz</a> на этом
                      компьютере и загрузите его сюда — дальше «Загрузить данные» разобьёт его на куски и запишет в базу без EDSM.
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
          <div style={{ background: '#101214', border: '1px solid #26292d', borderRadius: 4, padding: '8px 10px', fontSize: 12, color: MUTED }} data-bgs-admin-shards="">
            <div style={{ ...labelStyle, marginBottom: 4 }}>2 · Куски (шарды) → 3 · база</div>
            {shards?.exists && (shards.shards > 0 || shards.complete) ? (
              <>
                <div style={{ color: shards.complete ? TEXT : splitting ? RUN : '#fbbf24' }}>
                  {formatBgsCount(shards.shards)} кусков · {formatBgsCount(shards.systems)} систем · {formatBgsBytes(shards.bytes)}
                  {shards.complete
                    ? ' — архив разбит до конца'
                    : splitting
                      ? ' — разбивка идёт'
                      : running
                        ? ' — разбит не до конца, разбивка продолжится в свою очередь'
                        : ' — разбит не до конца, следующий запуск продолжит'}
                </div>
                <div style={{ color: shards.imported === shards.shards && shards.complete ? '#22c55e' : MUTED, marginTop: 2 }}>
                  В базе: {formatBgsCount(shards.imported)} из {formatBgsCount(shards.shards)} кусков ({formatBgsCount(shards.importedSystems)} систем)
                </div>
                {shards.shards > 0 && (
                  <div style={{ marginTop: 4 }}>
                    <ProgressBar fraction={shards.imported / Math.max(1, shards.shards)} color={shards.imported === shards.shards ? '#22c55e' : RUN} height={5} label="Кусков в базе" />
                  </div>
                )}
              </>
            ) : (
              <div>
                {archive?.complete
                  ? 'Кусков нет — архив скачан: «Разбить на куски» или «Загрузить данные» разобьют его'
                  : running
                    ? 'Кусков пока нет — архив разобьётся на куски, когда скачается целиком'
                    : 'Кусков нет — они появятся, когда архив будет на сервере целиком'}
              </div>
            )}
            <div style={{ marginTop: 2 }} data-bgs-admin-writer="">
              Запись в базу:{' '}
              {writer?.backend === 'pg'
                ? <>прямой Postgres{writer.host ? ` (${writer.host})` : ''} — кусок одним вызовом</>
                : <>PostgREST — пачками по {formatBgsCount(status?.config.batchSize ?? 250)} систем{writer?.disabled ? ' (FACTIONS_DB_DIRECT=0)' : ''}</>}
            </div>
            {shards?.dir && <div style={{ fontSize: 11, color: DIM, marginTop: 2, overflowWrap: 'anywhere' }}><code>{shards.dir}</code></div>}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
              <button
                type="button"
                className="btn"
                style={{ fontSize: 12, padding: '3px 8px' }}
                disabled={busy !== null || running || uploading || !archive?.complete}
                onClick={() => void act('split')}
                title={archive?.complete ? 'Разбить скачанный архив на куски (без EDSM и без записи в базу)' : 'Сначала скачайте архив целиком'}
                data-bgs-admin-action="split"
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
                data-bgs-admin-action="import"
              >
                Загрузить куски в базу
              </button>
            </div>
          </div>
        </div>

        {progress ? (
          <div data-bgs-admin-progress={progress.phase}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12, color: MUTED, marginBottom: 4, flexWrap: 'wrap' }}>
              <span style={{ color: progress.phase === 'running' ? RUN : progress.phase === 'error' ? '#ef4444' : progress.phase === 'cancelled' ? '#e67e22' : '#22c55e' }}>
                {progress.phase === 'running'
                  ? 'Идёт загрузка'
                  : progress.phase === 'ok' && progress.mode === 'download'
                    ? 'Последний запуск: архив скачан'
                    : progress.phase === 'ok' && progress.mode === 'split'
                      ? 'Последний запуск: архив разбит на куски'
                      : `Последняя загрузка: ${BGS_PHASE_LABEL[progress.phase]}`}
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
              Запуск: {BGS_TRIGGER_LABEL[progress.trigger]} · {BGS_MODE_LABEL[progress.mode] ?? BGS_MODE_LABEL.full}{progress.force ? ' · принудительно' : ''}
            </div>

            <ol style={{ listStyle: 'none', margin: '10px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 7 }} aria-label="Этапы загрузки">
              {BGS_SYNC_STAGES.map((def) => {
                const stage = progress.stages.find((item) => item.id === def.id);
                if (!stage) return null;
                const color = STAGE_COLORS[stage.status];
                const indeterminate = stage.status === 'running' && !(stage.total && stage.total > 0);
                return (
                  <li key={def.id} data-bgs-admin-stage={def.id} data-status={stage.status} style={{ display: 'grid', gridTemplateColumns: '205px minmax(0, 1fr) 90px', gap: 8, alignItems: 'center', fontSize: 12 }}>
                    <span style={{ color: stage.status === 'pending' ? DIM : TEXT, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      {stage.status === 'done' ? <IconCheckCircle size={12} color={color} /> : stage.status === 'error' ? <IconXCircle size={12} color={color} /> : (
                        <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: color, marginLeft: 2, marginRight: 2 }} />
                      )}
                      {def.label}
                    </span>
                    <span style={{ minWidth: 0 }}>
                      <ProgressBar fraction={stage.status === 'skipped' ? 0 : bgsStageFraction(stage)} color={color} height={6} indeterminate={indeterminate} label={def.label} />
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
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', color: '#22c55e', fontSize: 13, marginTop: 10 }} data-bgs-admin-result="">
                <IconCheckCircle size={14} color="#22c55e" />
                {progress.mode === 'download'
                  ? <>Архив на сервере: {formatBgsBytes(progress.result.archiveBytes)} · за {formatBgsDuration(progress.result.durationMs)} — в базу пока ничего не записано</>
                  : <>Кусков: {formatBgsCount(progress.result.shards)} · систем {formatBgsCount(progress.result.systems)} · за {formatBgsDuration(progress.result.durationMs)} — в базу пока ничего не записано</>}
              </div>
            )}
            {progress.phase === 'ok' && progress.result && progress.mode !== 'download' && progress.mode !== 'split' && (
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', color: '#22c55e', fontSize: 13, marginTop: 10 }} data-bgs-admin-result="">
                <IconCheckCircle size={14} color="#22c55e" />
                В базе {formatBgsCount(progress.result.systems)} систем и {formatBgsCount(progress.result.factions)} фракций · удалено
                пропавших систем {formatBgsCount(progress.result.deletedSystems)} · не тронуто (у пилотов свежее){' '}
                {formatBgsCount(progress.result.stale)}
                {progress.result.shards ? <> · кусков {formatBgsCount(progress.result.shards)}</> : null} · за {formatBgsDuration(progress.result.durationMs)}
              </div>
            )}
            {progress.phase === 'not_modified' && (
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', color: '#22c55e', fontSize: 13, marginTop: 10 }} data-bgs-admin-result="">
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
          <div style={{ fontSize: 12, color: '#e67e22', marginTop: 8 }} data-bgs-admin-interrupted="">
            Прошлая загрузка оборвалась вместе с процессом сайта (обновление или перезапуск). Скачанное и разбитое осталось на
            сервере — «Загрузить сейчас» продолжит с того же места (уже записанные куски повторно не пишутся); задача
            factions-sync сделает это сама при следующем запуске.
          </div>
        )}

        <div style={{ fontSize: 12, color: MUTED, lineHeight: 1.6, marginTop: 12 }}>
          Источник: <code>{status?.config.dumpUrl ?? 'https://www.edsm.net/dump/systemsPopulated.json.gz'}</code> — ночной дамп
          EDSM: все населённые системы с минорными фракциями (влияние, состояния), ≈0,5 ГБ gzip. Архив качается на сервер
          целиком в{` ${connections} `}соединений (<code>FACTIONS_DOWNLOAD_SEGMENTS</code>), куски файла по {pieceMb} МБ; обрыв и
          перезапуск сайта не теряют скачанного. Соединение, молчащее {stallSeconds} с (<code>FACTIONS_STALL_SECONDS</code>),
          переподключается сразу, а не через 70 с ожидания ОС.
          {shortRequests === 'off'
            ? ' Короткие запросы выключены (FACTIONS_REQUEST_KB=off).'
            : typeof shortRequests === 'number'
              ? ` Запросы — по ${formatBgsBytes(shortRequests)}, каждый в новом соединении (FACTIONS_REQUEST_KB).`
              : ' Если соединения замирают, успев передать лишь несколько килобайт (так сеть сервера режет сессии к зарубежным CDN, а EDSM — за Cloudflare), загрузка сама переходит на короткие запросы меньше этого порога, каждый в новом соединении.'}
          {' '}Когда архив скачан, он разбирается в куски по {formatBgsCount(shardSystems)} систем (станции и тела отбрасываются — от
          0,5 ГБ остаются мегабайты), затем куски пишутся в базу; кусок — единица продолжения. Если EDSM пересоберёт дамп посреди
          скачивания (около 04:50 UTC), скачивание начнётся заново со свежим дампом — половинки двух дампов не склеиваются. После
          удачной загрузки архив и куски
          {status?.config.archiveKeep ? ' остаются на сервере (FACTIONS_ARCHIVE_KEEP=1)' : ' удаляются с сервера'}.
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
                  color: line.level === 'error' ? '#f87171' : line.level === 'warn' ? '#fbbf24' : /^Запуск( импорта)?:/.test(line.text) ? TEXT : MUTED,
                  borderTop: /^Запуск( импорта)?:/.test(line.text) && index > 0 ? '1px dashed #2d3136' : undefined,
                  paddingTop: /^Запуск( импорта)?:/.test(line.text) && index > 0 ? 4 : undefined,
                  marginTop: /^Запуск( импорта)?:/.test(line.text) && index > 0 ? 4 : undefined,
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
