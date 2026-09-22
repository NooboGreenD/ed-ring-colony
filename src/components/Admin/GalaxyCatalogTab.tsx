'use client';

import { useCallback, useEffect, useState } from 'react';

import { authFetch } from '@/lib/supabaseClient';
import { IconCheckCircle, IconRefresh, IconXCircle } from '@/components/Icons';
import type { GalaxyCatalogImport } from '@/lib/galaxyCatalogStatus';

/**
 * Админка → «Каталог систем».
 *
 * Полный каталог Spansh (~1.3M систем, дамп ~6 ГиБ) живет в таблице
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

interface Status {
  state: GalaxyCatalogImport;
  live: boolean;
  interrupted: boolean;
  percent: number | null;
  log: string[];
  backends: { backend: 'pg' | 'supabase' | null; dbUrl: boolean; supabase: boolean };
  stats: CatalogStats | null;
  dump_url: string;
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
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [running, load]);

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
      else setMessage('Импорт запущен в фоне. Страницу можно закрыть — процесс продолжится.');
      await load();
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

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0 }}>Каталог всех систем (Spansh)</h3>
        <span style={{ fontSize: 12, color: phase.color }}>● {phase.text}</span>
        <button type="button" className="btn" style={{ fontSize: 12, padding: '3px 8px' }} onClick={() => void load()}>
          <IconRefresh size={12} color="#9ca3af" /> Обновить
        </button>
      </div>

      <div style={cardStyle}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
          <div>
            <div style={labelStyle}>Систем в таблице</div>
            <div style={{ fontSize: 16, color: '#e5e7eb' }}>{formatCount(status?.stats?.systems_count)}</div>
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
        <div style={labelStyle}>Импорт</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
          <button
            type="button"
            className="btn btn-cyan"
            disabled={busy !== null || running || backendMissing}
            onClick={() => void act('start', canResume ? {} : { fresh: true })}
          >
            {canResume ? 'Продолжить импорт' : 'Запустить импорт'}
          </button>
          {canResume && (
            <button type="button" className="btn" disabled={busy !== null} onClick={() => void act('start', { fresh: true })}>
              Начать заново
            </button>
          )}
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

        <div style={{ fontSize: 12, color: '#9ca3af', lineHeight: 1.6 }}>
          Режим записи: <strong style={{ color: '#e5e7eb' }}>{status?.backends.backend ?? 'недоступен'}</strong>
          {status?.backends.backend === 'supabase' && ' (PostgREST, медленнее — добавьте SUPABASE_DB_URL для прямого Postgres)'}
          <br />
          Скачивается ночной дамп <code>systems.json.gz</code> (~6 ГиБ) потоком, без записи на диск; RAM &lt; 1 ГБ,
          время — от 20 минут до нескольких часов в зависимости от канала. Прерванный импорт продолжается: дамп
          скачивается заново (gzip нельзя начать с середины), но уже записанные системы пропускаются, поэтому
          повторная запись в базу не идёт. Повторы одной системы в дампе (то же имя или тот же id64 в одной пачке)
          схлопываются в одну строку — иначе Postgres обрывает upsert ошибкой «cannot affect row a second time».
          После завершения файл точек (~36 МБ) загружается в бакет
          <code> galaxy-data</code>, и слой «Все системы» на карте начинает работать. Счётчики каталога ниже
          могут отставать на минуту — их отдаёт кэш.
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
