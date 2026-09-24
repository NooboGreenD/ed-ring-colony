'use client';

import { useCallback, useEffect, useState } from 'react';

import { authFetch } from '@/lib/supabaseClient';
import { IconCheckCircle, IconRefresh, IconXCircle } from '@/components/Icons';
import type { GalaxyCatalogImport } from '@/lib/galaxyCatalogStatus';

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
  direct: { configured: boolean; host: string | null; ok: boolean; message: string; database: string | null };
  postgrest: { configured: boolean };
  backend: 'pg' | 'supabase' | null;
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

function formatBytes(value: number | null | undefined): string {
  const bytes = Number(value ?? 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 Б';
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const scaled = bytes / 1024 ** index;
  return `${scaled >= 100 ? scaled.toFixed(0) : scaled.toFixed(1)} ${units[index]}`;
}

function formatCount(value: number | null | undefined): string {
  return Number(value ?? 0).toLocaleString('ru-RU');
}

function formatTime(value: string | null | undefined): string {
  if (!value) return '—';
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toLocaleString('ru-RU') : value;
}

function phaseLabel(status: Status): { text: string; color: string } {
  const { state, live, interrupted } = status;
  if (live || (state.phase === 'running' && !interrupted)) return { text: 'идёт импорт', color: '#ffd166' };
  if (state.phase === 'running' && interrupted) return { text: 'прерван (перезапуск процесса)', color: '#e67e22' };
  if (state.phase === 'done') return { text: 'завершён', color: '#22c55e' };
  if (state.phase === 'failed') return { text: 'ошибка', color: '#ef4444' };
  if (state.phase === 'cancelled') return { text: 'остановлен вручную', color: '#e67e22' };
  return { text: 'не запускался', color: '#9ca3af' };
}

export default function GalaxyCatalogTab() {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [isError, setIsError] = useState(false);
  const [dbCheck, setDbCheck] = useState<DbCheck | null>(null);

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
  const downloadRunning = !!archive && (archive.live || (archive.state.phase === 'downloading' && !archive.interrupted));
  const interruptedDownload = !!archive && archive.state.phase === 'downloading' && !archive.live && archive.interrupted;
  useEffect(() => {
    if (!running && !downloadRunning) return;
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [running, downloadRunning, load]);

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
      if (response.status === 409) setMessage(payload?.reason || 'Импорт уже запущен');
      else if (action === 'cancel') setMessage(payload?.cancelled ? 'Импорт остановлен' : 'Импорт не выполнялся');
      else if (action === 'cancel-download') setMessage(payload?.cancelled ? 'Скачивание остановлено' : 'Скачивание не выполнялось');
      else if (action === 'download') setMessage('Архив скачивается в фоне. Страницу можно закрыть — скачивание продолжится, а при обрыве подхватит с сохранённого байта.');
      else setMessage('Импорт запущен в фоне. Страницу можно закрыть — процесс продолжится.');
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

  const phase = status ? phaseLabel(status) : { text: 'загрузка…', color: '#9ca3af' };
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
        <h3 style={{ margin: 0 }}>Каталог всех систем (Spansh)</h3>
        <span style={{ fontSize: 12, color: phase.color }}>● {phase.text}</span>
        <button type="button" className="btn" style={{ fontSize: 12, padding: '3px 8px' }} onClick={() => void load()}>
          <IconRefresh size={12} color="#9ca3af" /> Обновить
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
            Запись идёт через PostgREST — полный каталог так не импортируется
          </div>
          PostgREST пишет пачками по 200 строк, и на полном дампе (~2×10⁸ систем) база рано или поздно
          начинает отвечать «canceling statement due to statement timeout» даже на одну строку — импорт
          падает на несколько процентов (в этой панели это выглядело как «supabase upsert failed: …
          statement timeout (имя / id64)» на 2.7%). Через PostgREST дамп идёт сутки; кнопка «Продолжить»
          повторит то же самое.
          <div style={{ marginTop: 6 }}>
            <strong style={{ color: '#e5e7eb' }}>Решение:</strong> задайте веб-процессу прямую ссылку на
            Postgres и подключите <code>web</code> к docker-сети стека Supabase:
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
            Оба значения и сеть проставляет сам <code>deploy/start-monitoring.sh</code> (<code>npm run
            monitoring:up</code>). После перезапуска нажмите «Проверить подключение к БД» — должно быть
            «прямой Postgres (db) — подключение работает» и «Режим записи: pg». Уже записанные строки не
            потеряются: «Продолжить импорт» продолжит с сохранённой точки, архив перескачиваться не будет.
          </div>
        </div>
      )}

      <div style={cardStyle}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
          <div>
            <div style={labelStyle}>Систем в таблице</div>
            <div style={{ fontSize: 16, color: '#e5e7eb' }}>{formatCount(tableCount)}</div>
            {partialRows > 0 && (
              <div style={{ fontSize: 11, color: '#e67e22', marginTop: 2 }}>
                счётчик обновляется после успешного импорта; в таблице уже {formatCount(partialRows)} строк
                из незавершённого прохода
              </div>
            )}
          </div>
          <div>
            <div style={labelStyle}>Импортировано</div>
            <div style={{ fontSize: 13, color: '#e5e7eb' }}>{formatTime(status?.stats?.imported_at)}</div>
          </div>
          <div>
            <div style={labelStyle}>Источник</div>
            <div style={{ fontSize: 12, color: '#9ca3af', wordBreak: 'break-all' }}>
              {status?.stats?.source || status?.dump_url || '—'}
            </div>
          </div>
          <div>
            <div style={labelStyle}>Облако точек</div>
            <div style={{ fontSize: 13, color: status?.stats?.points_uploaded ? '#22c55e' : '#e67e22' }}>
              {status?.stats?.points_uploaded
                ? `${formatCount(status?.stats?.points_count)} точек, ${formatBytes(status?.stats?.points_bytes)} в storage`
                : 'не загружено в storage'}
            </div>
          </div>
        </div>
        {status?.stats?.partial && (
          <div style={{ marginTop: 8, fontSize: 12, color: '#e67e22' }}>
            Последняя загрузка была частичной (--limit): Атлас и поиск маршрута продолжают ходить в EDSM.
          </div>
        )}
      </div>

      <div style={cardStyle}>
        <div style={labelStyle}>Архив дампа на диске</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
          <button
            type="button"
            className={downloadRunning ? 'btn' : 'btn btn-cyan'}
            disabled={busy !== null || downloadRunning || running}
            onClick={() => void act('download')}
            title={running ? 'Дождитесь окончания импорта: он читает этот файл' : undefined}
          >
            {interruptedDownload ? 'Продолжить скачивание' : 'Скачать архив'}
          </button>
          <button type="button" className="btn" disabled={busy !== null || !downloadRunning} onClick={() => void act('cancel-download')}>
            Остановить скачивание
          </button>
        </div>

        {archive && downloadRunning && archive.percent != null && (
          <div style={{ marginBottom: 8 }}>
            <div style={{ height: 8, background: '#22252a', borderRadius: 4, overflow: 'hidden' }}>
              <div style={{ width: `${archive.percent}%`, height: '100%', background: '#38bdf8', transition: 'width 0.6s' }} />
            </div>
            <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 4 }}>
              {archive.percent.toFixed(1)}% — {formatBytes(archive.state.bytes_done)}
              {archive.state.bytes_total ? ` из ${formatBytes(archive.state.bytes_total)}` : ''}
            </div>
          </div>
        )}

        {archive?.state.phase === 'done' && (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', color: '#22c55e', fontSize: 13, marginBottom: 8 }}>
            <IconCheckCircle size={14} color="#22c55e" />
            <span>
              На диске: {formatBytes(archive.state.bytes_done)}
              {archive.state.downloaded_at ? `, скачан ${formatTime(archive.state.downloaded_at)}` : ''}
            </span>
          </div>
        )}
        {archive?.state.phase === 'failed' && archive.state.error && (
          <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', color: '#ef4444', fontSize: 13, marginBottom: 8 }}>
            <IconXCircle size={14} color="#ef4444" />
            <span>Скачивание: {archive.state.error}</span>
          </div>
        )}
        {interruptedDownload && (
          <div style={{ fontSize: 12, color: '#e67e22', marginBottom: 8 }}>
            Скачивание прервано перезапуском процесса — уже скачанные байты на месте, нажмите «Продолжить скачивание».
          </div>
        )}

        <div style={{ fontSize: 12, color: '#9ca3af', lineHeight: 1.6 }}>
          Дамп <code>systems.json.gz</code> (~6 ГиБ) хранится в <code>{status?.archive_dir || 'data/spansh'}</code>
          (в контейнере — томовый volume, переживает пересборку образа). Импорт всегда читает дамп <strong>с диска</strong>:
          при обрыве соединения скачивание продолжает с сохранённого байта (HTTP Range), а «Продолжить импорт»
          перечитывает локальный файл и пропускает уже записанные системы — заново скачивать 6 ГиБ не нужно.
          Повреждённый архив определяется проверкой gzip и скачивается заново.
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
          </div>
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
          (~36 МБ) загружается в бакет <code>galaxy-data</code>, и слой «Все системы» на карте начинает
          работать. Счётчики каталога ниже могут отставать на минуту — их отдаёт кэш.
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
