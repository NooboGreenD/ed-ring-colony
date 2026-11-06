'use client';

import { useCallback, useEffect, useState } from 'react';

import { authFetch } from '@/lib/supabaseClient';
import { IconCheckCircle, IconRefresh, IconXCircle } from '@/components/Icons';
import type { GalaxyCatalogImport } from '@/lib/galaxyCatalogStatus';
import { useI18n } from '@/lib/i18n/I18nContext';

/**
 * Админка → «Каталог систем».
 *
 * Полный каталог Spansh (~2×10⁸ систем, дамп 5.9 ГиБ) живет в таблице
 * `galaxy_systems`; без него слой «Все системы» на карте и поиск по каталогу
 * не работают. Production-образ Next.js не содержит `scripts/`, поэтому импорт
 * запускается здесь — фоном в веб-процессе, с возобновлением после перезапуска.
 */

/** `getGalaxyStats()` as the admin API returns it (client-safe copy of the type). */
interface CatalogStats {
  systems_count: number;
  imported_at: string | null;
  source: string | null;
  points_uploaded?: boolean;
  points_bytes?: number | null;
  points_count?: number | null;
  points_stride?: number | null;
  points_sampled?: boolean;
  points_published?: {
    target?: 'storage' | 'disk' | 'none';
    uploaded?: boolean;
    path?: string | null;
    at?: string;
    error?: string | null;
  } | null;
  partial?: boolean;
}

interface ArchiveState {
  phase: 'idle' | 'downloading' | 'done' | 'failed' | 'cancelled';
  source: string | null;
  path: string | null;
  bytes_done: number;
  bytes_total: number | null;
  downloaded_at: string | null;
  error: string | null;
  updated_at: string | null;
  variant?: string | null;
  segments?: number | null;
  last_modified?: string | null;
}

/** Какой дамп нужен прямо сейчас — ответ `planGalaxyImport()`. */
interface DumpPlan {
  variant: string;
  reason: string;
  approx_bytes: number;
  segments: number;
  url: string;
  archive: string;
  archive_bytes: number;
  gapMs: number | null;
  skip_points: boolean;
}

interface ShardManifest {
  rows: number;
  invalid: number;
  complete: boolean;
  completed_at: string | null;
  rows_per_shard: number;
  shards: { file: string; rows: number; bytes: number; imported?: boolean }[];
}

interface ShardStatus {
  dir: string;
  live: boolean;
  progress: { rows: number; shards: number; recordsRead: number } | null;
  manifest: ShardManifest | null;
  files: number;
  bytes: number;
  log: string[];
}

/** Диск, на котором живут архивы и шарды (`getGalaxyStorageStatus`). */
interface StorageStatus {
  dir: string;
  shards_dir: string;
  disk: { path: string; total: number; free: number; used: number } | null;
  archives: { variant: string; file: string; path: string; bytes: number; mtime: string | null; partial: boolean }[];
  archives_bytes: number;
  shards_files: number;
  shards_bytes: number;
  total_bytes: number;
  keep_archive: boolean;
}

interface VariantInfo {
  variant: string;
  file: string;
  label: string;
  approx_bytes: number;
}

interface ArchiveStatus {
  state: ArchiveState;
  live: boolean;
  interrupted: boolean;
  percent: number | null;
  log: string[];
}

/** `check-db` as the admin API returns it. */
interface DbCheck {
  direct: {
    configured: boolean;
    host: string | null;
    ok: boolean;
    message: string;
    database: string | null;
    /** Раздельный сетевой диагноз: «timeout expired» сам по себе ничего не говорит. */
    network?: { kind: string; host: string; port: number; addresses: string[]; message: string } | null;
  };
  postgrest: { configured: boolean };
  backend: 'pg' | 'supabase' | null;
}

/** Состояние фоновой сборки облака точек (`build-points`). */
interface PointsBuildState {
  running: boolean;
  started_at: string | null;
  finished_at: string | null;
  ok: boolean | null;
  error: string | null;
  backend: 'pg' | 'supabase' | null;
  count: number | null;
  bytes: number | null;
  rows: number | null;
  stride: number | null;
  uploaded: boolean;
  /** Где облако сейчас: `storage` — канонично, `disk` — только кэш данных. */
  published?: 'storage' | 'disk' | 'none' | null;
  /** Путь локального кэша, когда файл записан туда. */
  path?: string | null;
  /** Попыток загрузки в storage (1 = повезло с первой). */
  attempts?: number;
  /** Потолок точек, который сборка соблюла. */
  max_points?: number | null;
  /** Бюджет файла: лимит бакета ∩ бюджет браузера. */
  budget_bytes?: number | null;
  /** `file_size_limit` бакета galaxy-data (null — узнать не удалось). */
  bucket_bytes?: number | null;
  /** Сколько точек влезает в бюджет при текущих лимитах. */
  ceiling_points?: number | null;
  log: string[];
}

interface Status {
  state: GalaxyCatalogImport;
  live: boolean;
  interrupted: boolean;
  percent: number | null;
  log: string[];
  backends: { backend: 'pg' | 'supabase' | null; dbUrl: boolean; supabase: boolean };
  stats: CatalogStats | null;
  dump_url: string;
  archive_dir: string;
  archive: ArchiveStatus | null;
  plan: DumpPlan | null;
  shards: ShardStatus | null;
  storage: StorageStatus | null;
  variants?: VariantInfo[];
  download_segments?: number;
  points_build?: PointsBuildState;
  points_cache?: PointsCacheInfo | null;
  points_budget?: PointsBudget | null;
}

/** Что лежит в локальном кэше облаков (`GALAXY_POINTS_DIR`). */
interface PointsCacheInfo {
  dir: string;
  exists: boolean;
  bytes: number | null;
  count: number | null;
  mtime_ms: number | null;
  valid: boolean;
}

/** Из чего состоит потолок облака точек прямо сейчас. */
interface PointsBudget {
  max_points: number;
  budget_bytes: number;
  bucket_bytes: number | null;
  limited_by_budget: boolean;
}

/** Пустое поле = «столько, сколько позволяет лимит»; число парсится мягко. */
function maxPointsPayload(value: string): Record<string, unknown> {
  const raw = value.replace(/\s|\u00a0|_/g, '');
  if (!raw) return {};
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? { max_points: Math.floor(parsed) } : {};
}

const POLL_MS = 4000;

const cardStyle = {
  background: '#141618',
  border: '1px solid #323538',
  borderRadius: 4,
  padding: '12px 14px',
  marginBottom: 12,
} as const;

const labelStyle = { fontSize: 11, color: '#9ca3af', textTransform: 'uppercase' as const, marginBottom: 4 };


export default function GalaxyCatalogTab() {
  const { t, locale } = useI18n();

  const formatBytes = (value: number | null | undefined): string => {
    const bytes = Number(value ?? 0);
    const units = [t('gc.unitB'), t('gc.unitKb'), t('gc.unitMb'), t('gc.unitGb')];
    if (!Number.isFinite(bytes) || bytes <= 0) return `0 ${units[0]}`;
    const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    const scaled = bytes / 1024 ** index;
    return `${scaled >= 100 ? scaled.toFixed(0) : scaled.toLocaleString(locale, { maximumFractionDigits: 1, minimumFractionDigits: 1 })} ${units[index]}`;
  };

  const formatCount = (value: number | null | undefined): string => Number(value ?? 0).toLocaleString(locale);

  const formatTime = (value: string | null | undefined): string => {
    if (!value) return '—';
    const at = Date.parse(value);
    return Number.isFinite(at) ? new Date(at).toLocaleString(locale) : value;
  };

  /** Подпись варианта дампа, как её отдал сервер. */
  const variantLabel = (status: Status | null, variant: string | null | undefined): string => {
    if (!variant) return t('gc.unknown');
    const info = status?.variants?.find((item) => item.variant === variant);
    return info ? `${info.label} (${info.file})` : variant;
  };

  const phaseLabel = (status: Status): { text: string; color: string } => {
    const { state, live, interrupted } = status;
    if (live || (state.phase === 'running' && !interrupted)) return { text: t('gc.phaseRunning'), color: '#ffd166' };
    if (state.phase === 'running' && interrupted) return { text: t('gc.phaseInterrupted'), color: '#e67e22' };
    if (state.phase === 'done') return { text: t('gc.phaseDone'), color: '#22c55e' };
    if (state.phase === 'failed') return { text: t('gc.phaseFailed'), color: '#ef4444' };
    if (state.phase === 'cancelled') return { text: t('gc.phaseCancelled'), color: '#e67e22' };
    return { text: t('gc.phaseIdle'), color: '#9ca3af' };
  };
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [isError, setIsError] = useState(false);
  const [dbCheck, setDbCheck] = useState<DbCheck | null>(null);
  // Потолок количества точек для «Собрать облако»: пусто = столько, сколько
  // позволяет текущий лимит бакета (см. points_budget в статусе).
  const [pointsMax, setPointsMax] = useState('');

  const load = useCallback(async () => {
    try {
      const response = await authFetch('/api/admin/galaxy', { cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
      setStatus(payload as Status);
    } catch (error) {
      setMessage((error as Error).message);
      setIsError(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // While the import runs in the web process, poll for progress.
  const running = !!status && (status.live || (status.state.phase === 'running' && !status.interrupted));
  const archive = status?.archive ?? null;
  const shards = status?.shards ?? null;
  const storage = status?.storage ?? null;
  const unpackRunning = !!shards?.live;
  const pointsBuild = status?.points_build ?? null;
  const pointsBuildRunning = !!pointsBuild?.running;
  const pointsCache = status?.points_cache ?? null;
  const pointsBudget = status?.points_budget ?? null;
  const pointsInStorage = status?.stats?.points_uploaded === true;
  // «Собрать облако» уже положило файл на диск данных, а storage его не принял:
  // повторить заливание дёшево и не трогает таблицу.
  const pointsOnDisk = pointsCache?.exists === true && pointsCache.valid !== false;
  const canRepublishPoints = pointsOnDisk && (!pointsInStorage || pointsBuild?.published === 'disk');
  const downloadRunning = !!archive && (archive.live || (archive.state.phase === 'downloading' && !archive.interrupted));
  const interruptedDownload = !!archive && archive.state.phase === 'downloading' && !archive.live && archive.interrupted;
  useEffect(() => {
    if (!running && !downloadRunning && !unpackRunning && !pointsBuildRunning) return;
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [running, downloadRunning, unpackRunning, pointsBuildRunning, load]);

  const act = async (action: string, extra: Record<string, unknown> = {}) => {
    setBusy(action);
    setMessage('');
    setIsError(false);
    try {
      const response = await authFetch('/api/admin/galaxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...extra }),
      });
      const payload = await response.json();
      if (!response.ok && response.status !== 409) throw new Error(payload?.error || `HTTP ${response.status}`);
      if (response.status === 409) setMessage(payload?.reason || t('gc.importRunning'));
      else if (action === 'cancel') setMessage(payload?.cancelled ? t('gc.importStopped') : t('gc.importIdle'));
      else if (action === 'cancel-download') setMessage(payload?.cancelled ? t('gc.downloadStopped') : t('gc.downloadIdle'));
      else if (action === 'download') setMessage(t('gc.downloadStarted'));
      else if (action === 'unpack') setMessage(t('gc.unpackStarted'));
      else if (action === 'cancel-unpack') setMessage(payload?.cancelled ? t('gc.unpackStopped') : t('gc.unpackIdle'));
      else if (action === 'build-points')
        setMessage(
          payload?.started
            ? t('gc.pointsStarted')
            : payload?.reason || t('gc.pointsRunning'),
        );
      else if (action === 'publish-points')
        setMessage(
          payload?.started
            ? t('gc.publishStarted')
            : payload?.reason || t('gc.publishBlocked'),
        );
      else if (action === 'cleanup')
        setMessage(
          payload?.cleaned
            ? payload.freed > 0
              ? t('gc.cleanupFreed', { size: formatBytes(payload.freed), files: (payload.removed ?? []).length })
              : t('gc.cleanupNothing')
            : payload?.reason || t('gc.cleanupBlocked'),
        );
      else setMessage(t('gc.importStarted'));
      await load();
    } catch (error) {
      setMessage((error as Error).message);
      setIsError(true);
    } finally {
      setBusy(null);
    }
  };

  /**
   * Проверка подключения выполняется в веб-процессе (в production-образе нет
   * `scripts/`, а DNS контейнера и хоста — разные вещи), поэтому это единственный
   * способ честно ответить на «getaddrinfo EAI_AGAIN db».
   */
  const checkDb = async () => {
    setBusy('check-db');
    setMessage('');
    setIsError(false);
    try {
      const response = await authFetch('/api/admin/galaxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'check-db' }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
      setDbCheck(payload?.check ?? null);
    } catch (error) {
      setMessage((error as Error).message);
      setIsError(true);
    } finally {
      setBusy(null);
    }
  };

  const phase = status ? phaseLabel(status) : { text: t('gc.phaseLoading'), color: '#9ca3af' };
  const state = status?.state;
  const percent = status?.percent ?? null;
  const canResume = !!state && state.resume_offset > 0 && !running;
  const backendMissing = !!status && status.backends.backend === null;
  // PostgREST-only write path. This is not a "slower" mode for a 6 GiB dump:
  // 200-row batches over HTTP end in «supabase upsert failed: … statement
  // timeout» a few percent in, which is exactly how the import died here
  // (2.7%, ~5.7M rows written). The panel says so before the operator spends a
  // day on it, and the hint survives a page reload because it comes from the
  // process environment, not from the ephemeral log tail.
  const postgrestOnly = !!status && status.backends.backend === 'supabase';
  const tableCount = status?.stats?.systems_count ?? 0;
  // The catalog counters are written by a successful run only, so a failed or
  // interrupted pass leaves «0» next to a table that already holds millions of
  // rows. Show what the last pass actually wrote.
  const partialRows = tableCount === 0 ? (state?.written ?? 0) : 0;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0 }}>{t('gc.title')}</h3>
        <span style={{ fontSize: 12, color: phase.color }}>● {phase.text}</span>
        <button type="button" className="btn" style={{ fontSize: 12, padding: '3px 8px' }} onClick={() => void load()}>
          <IconRefresh size={12} color="#9ca3af" /> {t('gc.refresh')}
        </button>
      </div>

      {postgrestOnly && (
        <div
          style={{
            background: '#2a1f10',
            border: '1px solid #8a5a12',
            borderRadius: 4,
            padding: '12px 14px',
            marginBottom: 12,
            fontSize: 12,
            color: '#f5c169',
            lineHeight: 1.6,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 4, color: '#ffd166' }}>
            {t('gc.postgrestTitle')}
          </div>
          {t('gc.postgrestBody')}
          <div style={{ marginTop: 6 }}>
            <strong style={{ color: '#e5e7eb' }}>{t('gc.solution')}</strong> {t('gc.solutionBody')} <code>web</code> {t('gc.solutionTail')}
          </div>
          <pre
            style={{
              margin: '6px 0 0',
              background: '#0f1113',
              border: '1px solid #3a2f16',
              borderRadius: 4,
              padding: 8,
              fontSize: 11,
              color: '#e5e7eb',
              whiteSpace: 'pre-wrap',
            }}
          >
{`# .env.production (пароль — POSTGRES_PASSWORD из стека Supabase)
SUPABASE_DB_URL=postgresql://postgres:ПАРОЛЬ@db:5432/postgres
SUPABASE_NETWORK=supabase_default   # точное имя: docker network ls

docker compose --env-file .env.production --profile monitoring \\
  -f docker-compose.yml -f deploy/compose.supabase-net.yml up -d`}
          </pre>
          <div style={{ marginTop: 6 }}>
            {t('gc.afterRestart')}
          </div>
        </div>
      )}

      <div style={cardStyle}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
          <div>
            <div style={labelStyle}>{t('gc.systemsInTable')}</div>
            <div style={{ fontSize: 16, color: '#e5e7eb' }}>{formatCount(tableCount)}</div>
            {partialRows > 0 && (
              <div style={{ fontSize: 11, color: '#e67e22', marginTop: 2 }}>
                {t('gc.partialHint', { count: formatCount(partialRows) })}
              </div>
            )}
          </div>
          <div>
            <div style={labelStyle}>{t('gc.imported')}</div>
            <div style={{ fontSize: 13, color: '#e5e7eb' }}>{formatTime(status?.stats?.imported_at)}</div>
          </div>
          <div>
            <div style={labelStyle}>{t('gc.source')}</div>
            <div style={{ fontSize: 12, color: '#9ca3af', wordBreak: 'break-all' }}>
              {status?.stats?.source || status?.dump_url || '—'}
            </div>
          </div>
          <div>
            <div style={labelStyle}>{t('gc.pointsCloud')}</div>
            <div
              style={{
                fontSize: 13,
                color: pointsInStorage ? '#22c55e' : pointsOnDisk ? '#e67e22' : '#9ca3af',
              }}
            >
              {pointsInStorage
                ? t('gc.pointsInStorage', { count: formatCount(status?.stats?.points_count), size: formatBytes(status?.stats?.points_bytes) })
                : pointsOnDisk
                  ? t('gc.pointsOnDisk', { count: formatCount(pointsCache?.count ?? null) })
                  : t('gc.notBuilt')}
            </div>
          </div>
        </div>
        {status?.stats?.partial && (
          <div style={{ marginTop: 8, fontSize: 12, color: '#e67e22' }}>
            {t('gc.partialLoad')}
          </div>
        )}
      </div>

      <div style={cardStyle}>
        <div style={labelStyle}>{t('gc.whatToDownload')}</div>
        {status?.plan ? (
          <>
            <div style={{ fontSize: 14, color: '#e5e7eb', marginBottom: 4 }}>
              {variantLabel(status, status.plan.variant)} — {formatBytes(status.plan.approx_bytes)}
              {status.plan.archive_bytes > 0 && (
                <span style={{ color: '#9ca3af', fontSize: 12 }}> · {t('gc.onDiskAlready', { size: formatBytes(status.plan.archive_bytes) })}</span>
              )}
            </div>
            <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 8, lineHeight: 1.6 }}>{status.plan.reason}</div>
          </>
        ) : (
          <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 8 }}>{t('gc.planCalc')}</div>
        )}

        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
          <button
            type="button"
            className="btn btn-cyan"
            disabled={busy !== null || running || downloadRunning || unpackRunning || backendMissing}
            onClick={() => void act('start', { variant: 'auto' })}
            title={t('gc.autoTitle')}
          >
            {t('gc.autoButton')}
          </button>
          {(status?.variants ?? []).map((info) => (
            <button
              key={info.variant}
              type="button"
              className="btn"
              disabled={busy !== null || running || downloadRunning || unpackRunning || backendMissing}
              onClick={() => void act('start', { variant: info.variant })}
              title={`${info.file} — ${formatBytes(info.approx_bytes)}`}
            >
              {info.label}
            </button>
          ))}
        </div>

        <div style={{ fontSize: 12, color: '#9ca3af', lineHeight: 1.6 }}>
          {t('gc.planBody')}
          {status?.download_segments != null && (
            <>
              <br />
              {t('gc.segmentsBody', { count: status.download_segments })}
            </>
          )}
        </div>
      </div>

      <div style={cardStyle}>
        <div style={labelStyle}>{t('gc.archiveLabel')}</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
          <button
            type="button"
            className={downloadRunning ? 'btn' : 'btn btn-cyan'}
            disabled={busy !== null || downloadRunning || running}
            onClick={() => void act('download')}
            title={running ? t('gc.waitImport') : undefined}
          >
            {interruptedDownload ? t('gc.resumeDownload') : t('gc.downloadArchive')}
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy !== null || downloadRunning || running}
            onClick={() => void act('download', { variant: 'full' })}
            title={t('gc.fullTitle')}
          >
            {t('gc.downloadFull')}
          </button>
          <button type="button" className="btn" disabled={busy !== null || !downloadRunning} onClick={() => void act('cancel-download')}>
            {t('gc.stopDownload')}
          </button>
        </div>

        {archive && downloadRunning && archive.percent != null && (
          <div style={{ marginBottom: 8 }}>
            <div style={{ height: 8, background: '#22252a', borderRadius: 4, overflow: 'hidden' }}>
              <div style={{ width: `${archive.percent}%`, height: '100%', background: '#38bdf8', transition: 'width 0.6s' }} />
            </div>
            <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 4 }}>
              {archive.percent.toFixed(1)}% — {formatBytes(archive.state.bytes_done)}
              {archive.state.bytes_total ? ` ${t('gc.ofSize', { size: formatBytes(archive.state.bytes_total) })}` : ''}
            </div>
          </div>
        )}

        {archive?.state.phase === 'done' && (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', color: '#22c55e', fontSize: 13, marginBottom: 8 }}>
            <IconCheckCircle size={14} color="#22c55e" />
            <span>
              {t('gc.onDisk', { size: formatBytes(archive.state.bytes_done) })}
              {archive.state.downloaded_at ? t('gc.downloadedAt', { time: formatTime(archive.state.downloaded_at) }) : ''}
            </span>
          </div>
        )}
        {archive?.state.phase === 'failed' && archive.state.error && (
          <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', color: '#ef4444', fontSize: 13, marginBottom: 8 }}>
            <IconXCircle size={14} color="#ef4444" />
            <span>{t('gc.downloadError', { error: archive.state.error })}</span>
          </div>
        )}
        {interruptedDownload && (
          <div style={{ fontSize: 12, color: '#e67e22', marginBottom: 8 }}>
            {t('gc.downloadInterrupted')}
          </div>
        )}

        <div style={{ fontSize: 12, color: '#9ca3af', lineHeight: 1.6 }}>
          {t('gc.archiveNote1')}
          <br />
          {t('gc.archiveNote2', { dir: status?.archive_dir || 'data/spansh' })}
        </div>

        {!!archive?.log?.length && (
          <pre
            style={{
              marginTop: 10,
              maxHeight: 140,
              overflow: 'auto',
              background: '#0f1113',
              border: '1px solid #262a2e',
              borderRadius: 4,
              padding: 8,
              fontSize: 11,
              color: '#9ca3af',
              whiteSpace: 'pre-wrap',
            }}
          >
            {archive.log.join('\n')}
          </pre>
        )}
      </div>

      <div style={cardStyle}>
        <div style={labelStyle}>Диск с данными каталога</div>
        {storage ? (
          <>
            <div style={{ fontSize: 13, marginBottom: 6 }}>
              <code>{storage.disk?.path || storage.dir}</code>
              {storage.disk ? (
                <>
                  {' '}— свободно{' '}
                  <strong style={{ color: storage.disk.free < 8 * 1024 ** 3 ? '#e67e22' : '#22c55e' }}>
                    {formatBytes(storage.disk.free)}
                  </strong>{' '}
                  из {formatBytes(storage.disk.total)}
                </>
              ) : (
                <span style={{ color: '#9ca3af' }}> — размер диска недоступен</span>
              )}
            </div>
            {storage.disk && storage.disk.total > 0 && (
              <div style={{ height: 6, background: '#262a2e', borderRadius: 3, overflow: 'hidden', marginBottom: 8 }}>
                <div
                  style={{
                    width: `${Math.min(100, (storage.disk.used / storage.disk.total) * 100)}%`,
                    height: '100%',
                    background: storage.disk.free < 8 * 1024 ** 3 ? '#e67e22' : '#38bdf8',
                  }}
                />
              </div>
            )}
            <div style={{ fontSize: 13, color: '#d1d5db', marginBottom: 8 }}>
              Каталог занимает {formatBytes(storage.total_bytes)}: архивы {formatBytes(storage.archives_bytes)}
              {storage.archives.length > 0 ? ` (${storage.archives.length} шт.)` : ''}, шарды{' '}
              {formatBytes(storage.shards_bytes)}
              {storage.shards_files > 0 ? ` (${storage.shards_files} файл(ов))` : ''}.
            </div>
            {storage.archives.length > 0 && (
              <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 8 }}>
                {storage.archives.map((item) => (
                  <div key={item.path}>
                    <code>{item.file}</code> — {formatBytes(item.bytes)}
                    {item.partial ? ', докачивается' : ''}
                    {item.mtime ? `, ${formatTime(item.mtime)}` : ''}
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
              <button
                type="button"
                className="btn"
                disabled={busy !== null || running || downloadRunning || unpackRunning}
                onClick={() => void act('cleanup')}
                title="Удалить архивы, которые больше не нужны, и шарды без архива"
              >
                Освободить место
              </button>
              <button
                type="button"
                className="btn"
                disabled={busy !== null || running || downloadRunning || unpackRunning || storage.shards_files === 0}
                onClick={() => {
                  if (window.confirm('Удалить распакованные шарды? Для импорта архив придётся распаковать заново.')) {
                    void act('cleanup', { drop_shards: true });
                  }
                }}
                title="Удалить и шарды тоже"
              >
                Удалить шарды
              </button>
            </div>
          </>
        ) : (
          <div style={{ fontSize: 13, color: '#9ca3af', marginBottom: 8 }}>Нет данных о диске.</div>
        )}
        <div style={{ fontSize: 12, color: '#9ca3af', lineHeight: 1.6 }}>
          Архивы и распакованные шарды лежат на отдельном диске сервера (<code>{storage?.dir || status?.archive_dir}</code>,
          шарды — <code>{storage?.shards_dir || '…/shards'}</code>). Старый дамп удаляется перед загрузкой нового, а архив —
          после успешного импорта{storage?.keep_archive ? '; сейчас это отключено через GALAXY_ARCHIVE_KEEP=1' : ''}.
          Загрузка, которой заведомо не хватит места, не стартует: сервер сразу скажет, сколько нужно и сколько есть.
        </div>
      </div>

      <div style={cardStyle}>
        <div style={labelStyle}>Шарды (распакованный архив)</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
          <button
            type="button"
            className="btn"
            disabled={busy !== null || running || unpackRunning}
            onClick={() => void act('unpack')}
            title="Прочитать архив один раз и разложить его в сжатые шарды по 2 млн систем"
          >
            {shards?.manifest && !shards.manifest.complete ? 'Продолжить распаковку' : 'Распаковать архив в шарды'}
          </button>
          <button type="button" className="btn" disabled={busy !== null || !unpackRunning} onClick={() => void act('cancel-unpack')}>
            Остановить распаковку
          </button>
        </div>

        {shards?.manifest ? (
          <div style={{ fontSize: 13, color: shards.manifest.complete ? '#22c55e' : '#e67e22', marginBottom: 8 }}>
            {shards.manifest.complete ? 'Готово: ' : 'В процессе: '}
            {formatCount(shards.manifest.rows)} систем в {shards.manifest.shards.length} шард(ах),
            {' '}{formatBytes(shards.bytes)} на диске
            {shards.manifest.completed_at ? `, ${formatTime(shards.manifest.completed_at)}` : ''}
          </div>
        ) : (
          <div style={{ fontSize: 13, color: '#9ca3af', marginBottom: 8 }}>Архив ещё не распакован.</div>
        )}

        {unpackRunning && shards?.progress && (
          <div style={{ fontSize: 12, color: '#ffd166', marginBottom: 8 }}>
            Распаковано {formatCount(shards.progress.rows)} систем в {shards.progress.shards} шард(ов)…
          </div>
        )}

        <div style={{ fontSize: 12, color: '#9ca3af', lineHeight: 1.6 }}>
          Gzip нельзя раскодировать с середины, поэтому «Продолжить импорт» перечитывает весь архив, чтобы
          пропустить уже записанное — это часы процессора на каждом перезапуске. Распаковка делает это один
          раз: архив превращается в сжатые TSV-шарды по {formatCount(shards?.manifest?.rows_per_shard ?? 2000000)} систем,
          и дальше возобновление стоит O(1) — импорт просто начинает со следующего файла. Шарды можно
          переносить по одному (rsync/scp), раздавать зеркалом и удалять по мере импорта
          (<code>GALAXY_SHARDS_PRUNE=1</code>). Распаковку можно запускать прямо во время скачивания —
          она дочитывает файл по мере его роста.
          {shards?.dir ? <><br />Каталог: <code>{shards.dir}</code></> : null}
        </div>

        {!!shards?.log?.length && (
          <pre
            style={{
              marginTop: 10,
              maxHeight: 140,
              overflow: 'auto',
              background: '#0f1113',
              border: '1px solid #262a2e',
              borderRadius: 4,
              padding: 8,
              fontSize: 11,
              color: '#9ca3af',
              whiteSpace: 'pre-wrap',
            }}
          >
            {shards.log.join('\n')}
          </pre>
        )}
      </div>

      <div style={cardStyle}>
        <div style={labelStyle}>Импорт</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
          <button
            type="button"
            className="btn btn-cyan"
            disabled={busy !== null || running || backendMissing || downloadRunning}
            title={downloadRunning ? 'Дождитесь окончания скачивания архива' : undefined}
            onClick={() => void act('start')}
          >
            {canResume ? 'Продолжить импорт' : 'Запустить импорт'}
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy !== null || running || downloadRunning || backendMissing}
            onClick={() => void act('start', { fresh: true })}
            title="Скачать свежий дамп заново и импортировать с первой записи"
          >
            Начать заново (свежий дамп)
          </button>
          <button type="button" className="btn" disabled={busy !== null || !running} onClick={() => void act('cancel')}>
            Остановить
          </button>
        </div>

        {percent != null && (
          <div style={{ marginBottom: 8 }}>
            <div style={{ height: 8, background: '#22252a', borderRadius: 4, overflow: 'hidden' }}>
              <div style={{ width: `${percent}%`, height: '100%', background: '#ffd166', transition: 'width 0.6s' }} />
            </div>
            <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 4 }}>
              {percent.toFixed(1)}% — {formatBytes(state?.bytes_done)}
              {state?.bytes_total ? ` из ${formatBytes(state.bytes_total)}` : ''}
              {state?.written ? `, записано ${formatCount(state.written)} строк` : ''}
              {state?.skipped ? `, пропущено ${formatCount(state.skipped)} уже записанных` : ''}
              {state?.mode === 'shards' && state?.shards_total
                ? `, шард ${formatCount(state.shard_index ?? 0)} из ${formatCount(state.shards_total)}`
                : ''}
              {state?.variant ? ` · ${variantLabel(status, state.variant)}` : ''}
            </div>
          </div>
        )}

        {state?.error && (
          <div style={{ color: '#ef4444', fontSize: 13, marginBottom: 8 }}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
              <IconXCircle size={14} color="#ef4444" /> <span>{state.error}</span>
            </div>
            {/cannot affect row a second time/i.test(state.error) && (
              <div style={{ marginTop: 6, color: '#e67e22' }}>
                В одной пачке оказалось две системы с одним именем или id64 — Postgres так upsert не принимает.
                Запустите импорт ещё раз: повторы теперь схлопываются, и загрузка из-за этого не обрывается.
              </div>
            )}
            {/statement timeout|57014/i.test(state.error) && (
              <div style={{ marginTop: 6, color: '#e67e22' }}>
                База не успела записать пачку за отведённое время (statement timeout): PostgREST даёт каждому
                запросу лишь несколько секунд. Медленные пачки делятся пополам и повторяются, а строки, которые
                база не берёт даже по одной, откладываются и дописываются в конце прохода. Один раз можно
                просто продолжить импорт с сохранённой точки; если ошибка повторяется регулярно — это потолок
                PostgREST, а не случайность: подключите веб-процессу прямой Postgres (<code>SUPABASE_DB_URL</code>,
                см. предупреждение выше) или запускайте импорт, когда база менее загружена.
              </div>
            )}
          </div>
        )}
        {state?.points_error && (
          <div style={{ color: '#e67e22', fontSize: 12, marginBottom: 8 }}>
            Файл точек не загружен в storage: {state.points_error}. Карта соберёт облако из таблицы при первом
            включении слоя (это медленно, но работает).
          </div>
        )}
        {state?.phase === 'done' && !state.error && (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', color: '#22c55e', fontSize: 13, marginBottom: 8 }}>
            <IconCheckCircle size={14} color="#22c55e" />
            <span>
              Готово {formatTime(state.finished_at)}: {formatCount(state.systems_count)} систем
              {state.points_count ? `, облако ${formatCount(state.points_count)} точек` : ''}
            </span>
          </div>
        )}

        {backendMissing && (
          <div style={{ color: '#ef4444', fontSize: 13, marginBottom: 8 }}>
            Импорт не запустится: веб-процессу нужен <code>DATABASE_URL</code>/<code>SUPABASE_DB_URL</code> (быстрый
            прямой Postgres) либо <code>NEXT_PUBLIC_SUPABASE_URL</code> + <code>SUPABASE_SERVICE_ROLE_KEY</code>.
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
          <button
            type="button"
            className="btn"
            disabled={busy !== null}
            onClick={() => void checkDb()}
            title="Один запрос к Postgres из веб-процесса: показывает, виден ли хост из DATABASE_URL"
          >
            Проверить подключение к БД
          </button>
          {dbCheck && (
            <span style={{ fontSize: 12, color: dbCheck.direct.ok || !dbCheck.direct.configured ? '#22c55e' : '#ef4444' }}>
              {dbCheck.direct.configured
                ? dbCheck.direct.ok
                  ? `прямой Postgres (${dbCheck.direct.host ?? '?'}) — ${dbCheck.direct.message}`
                  : `прямой Postgres (${dbCheck.direct.host ?? '?'}) недоступен`
                : 'прямой Postgres не настроен'}
              {` · PostgREST: ${dbCheck.postgrest.configured ? 'настроен' : 'не настроен'}`}
            </span>
          )}
        </div>

        {dbCheck && !dbCheck.direct.ok && (
          <div style={{ fontSize: 12, color: '#ef4444', lineHeight: 1.6, marginBottom: 10, wordBreak: 'break-word' }}>
            {dbCheck.direct.message}
            {dbCheck.direct.network && (
              <div style={{ color: '#9ca3af', marginTop: 4 }}>
                DNS «{dbCheck.direct.network.host}»:{' '}
                {dbCheck.direct.network.addresses.length
                  ? dbCheck.direct.network.addresses.join(', ')
                  : 'имя не резолвится'}
                {' · '}
                порт {dbCheck.direct.network.port}: {dbCheck.direct.network.kind}
              </div>
            )}
          </div>
        )}

        <div style={{ ...labelStyle, marginTop: 4 }}>Облако точек для карты</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
          <button
            type="button"
            className="btn btn-cyan"
            disabled={busy !== null || pointsBuildRunning || running || backendMissing}
            title="Прочитать таблицу каталога и собрать файл, из которого слой «Все системы» рисует карту. Если систем больше потолка, строки берутся с равномерным шагом прямо в запросе — лишние байты не читаются."
            onClick={() => void act('build-points', maxPointsPayload(pointsMax))}
          >
            {pointsBuildRunning ? 'Сборка облака идёт…' : 'Собрать облако точек из таблицы'}
          </button>
          {canRepublishPoints && (
            <button
              type="button"
              className="btn"
              disabled={busy !== null || pointsBuildRunning}
              title="Облако уже лежит в каталоге данных — нужен только bucket galaxy-data. Файл перечитывается с диска, таблица не трогается."
              onClick={() => void act('publish-points')}
            >
              {busy === 'publish-points' ? 'Загружаю в storage…' : 'Повторить загрузку в storage'}
            </button>
          )}
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#9ca3af' }}>
            максимум точек
            <input
              type="text"
              inputMode="numeric"
              value={pointsMax}
              onChange={(event) => setPointsMax(event.target.value)}
              placeholder={pointsBudget ? String(pointsBudget.max_points) : 'по лимиту'}
              style={{
                width: 120,
                background: '#0f1113',
                border: '1px solid #323538',
                borderRadius: 4,
                color: '#e5e7eb',
                padding: '4px 6px',
                fontSize: 12,
              }}
            />
          </label>
        </div>
        <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 8, lineHeight: 1.6 }}>
          {pointsInStorage
            ? `в хранилище: ${formatCount(status?.stats?.points_count ?? null)} точек${status?.stats?.points_bytes ? `, ${formatBytes(status.stats.points_bytes)}` : ''}${status?.stats?.points_stride && status.stats.points_stride > 1 ? `, шаг ${formatCount(status.stats.points_stride)} строк на точку` : ''}`
            : pointsOnDisk
              ? `в хранилище файла нет — облако лежит в ${pointsCache?.dir} и отдаётся с него; другие процессы (и пересобранный контейнер) его не увидят`
              : 'файла нет ни в хранилище, ни на диске — слой карты соберёт его сам при первом включении (это медленнее)'}
          {pointsBudget && (
            <>
              {' · '}потолок {formatCount(pointsBudget.max_points)} точек ({formatBytes(pointsBudget.budget_bytes)})
              {pointsBudget.bucket_bytes != null &&
                `, лимит бакета galaxy-data ${formatBytes(pointsBudget.bucket_bytes)}`}
            </>
          )}
        </div>
        {pointsBuild && (pointsBuild.ok !== null || pointsBuild.running) && (
          <div
            style={{
              fontSize: 12,
              marginBottom: 8,
              lineHeight: 1.6,
              color: pointsBuild.running
                ? '#ffd166'
                : pointsBuild.published === 'storage' || pointsBuild.ok === true
                  ? pointsBuild.uploaded
                    ? '#22c55e'
                    : '#e67e22'
                  : '#ef4444',
            }}
          >
            {pointsBuild.running
              ? 'Читаю таблицу каталога и собираю облако точек — это может занять несколько минут…'
              : pointsBuild.ok
                ? `${pointsBuild.published === 'storage' ? 'Облако собрано и загружено' : 'Облако собрано и записано в локальный кэш'}: ${formatCount(pointsBuild.count)} точек из ${formatCount(pointsBuild.rows)} строк`
                  + `${pointsBuild.stride && pointsBuild.stride > 1 ? ` (шаг ${formatCount(pointsBuild.stride)})` : ''}`
                  + `${pointsBuild.bytes ? `, файл ${formatBytes(pointsBuild.bytes)}` : ''} · ${formatTime(pointsBuild.finished_at)}`
                  + (pointsBuild.published !== 'storage' && pointsBuild.error
                    ? `. storage не принял файл: ${pointsBuild.error} — кнопка «Повторить загрузку в storage» пробует снова, таблицу перечитывать не нужно`
                    : '')
                : `Облако точек собрать не удалось: ${pointsBuild.error ?? 'неизвестная ошибка'}`}
          </div>
        )}
        {pointsBuild && pointsBuild.log.length > 0 && (
          <details style={{ marginBottom: 10 }}>
            <summary style={{ fontSize: 12, color: '#9ca3af', cursor: 'pointer' }}>
              Журнал сборки облака ({pointsBuild.log.length})
            </summary>
            <pre
              style={{
                fontSize: 11,
                color: '#9ca3af',
                whiteSpace: 'pre-wrap',
                margin: '6px 0 0',
                maxHeight: 180,
                overflowY: 'auto',
              }}
            >
              {pointsBuild.log.join('\n')}
            </pre>
          </details>
        )}

        <div style={{ fontSize: 12, color: '#9ca3af', lineHeight: 1.6 }}>
          Режим записи: <strong style={{ color: '#e5e7eb' }}>{status?.backends.backend ?? 'недоступен'}</strong>
          {status?.backends.backend === 'supabase' && ' (PostgREST, медленнее — добавьте SUPABASE_DB_URL для прямого Postgres)'}
          <br />
          Если архива на диске ещё нет, импорт сначала скачает его (с возобновлением при обрывах), а затем
          прочитает с диска; RAM &lt; 1 ГБ. Прерванный импорт продолжается: дамп перечитывается с диска (сеть
          уже не нужна), уже записанные системы пропускаются, поэтому повторная запись в базу не идёт.
          Повторы одной системы в дампе (то же имя или тот же id64 в одной пачке) схлопываются в одну строку —
          иначе Postgres обрывает upsert ошибкой «cannot affect row a second time». Пачки, не уложившиеся в
          statement timeout базы, автоматически делятся пополам и повторяются. После завершения файл точек
          загружается в бакет <code>galaxy-data</code> (а всегда — в каталог данных, поэтому сбой хранилища
          больше не означает «облака нет»), и слой «Все системы» на карте начинает работать. Счётчики
          каталога ниже могут отставать на минуту — их отдаёт кэш.
        </div>

        {!!status?.log?.length && (
          <pre
            style={{
              marginTop: 10,
              maxHeight: 220,
              overflow: 'auto',
              background: '#0f1113',
              border: '1px solid #262a2e',
              borderRadius: 4,
              padding: 8,
              fontSize: 11,
              color: '#9ca3af',
              whiteSpace: 'pre-wrap',
            }}
          >
            {status.log.join('\n')}
          </pre>
        )}
      </div>

      {message && (
        <div style={{ fontSize: 13, color: isError ? '#ef4444' : '#22c55e' }}>{message}</div>
      )}
    </div>
  );
}
