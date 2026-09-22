/**
 * Client-side view of `GET /api/galaxy/stats` — what the "all systems" map
 * layer needs before it dares to download ~36 MB of points.
 *
 * The catalog is empty until somebody runs the Spansh import, and an empty
 * catalog used to surface as a bare `404 (Not Found)` in the browser console.
 * The map now asks for the status first and explains what to do instead.
 */

export type GalaxyImportPhase = 'idle' | 'running' | 'done' | 'failed' | 'cancelled';

export interface GalaxyCatalogImport {
  phase: GalaxyImportPhase;
  /** The import task is alive in the web process right now. */
  live: boolean;
  /** Persisted `running` without a live task: the process restarted mid-import. */
  interrupted: boolean;
  percent: number | null;
  backend: 'pg' | 'supabase' | null;
  can_import: boolean;
  source: string | null;
  started_at: string | null;
  updated_at: string | null;
  finished_at: string | null;
  bytes_done: number;
  bytes_total: number | null;
  resume_offset: number;
  processed: number;
  written: number;
  invalid: number;
  /** Records a resumed pass skipped because they were already stored. */
  skipped: number;
  /** Rows in `galaxy_systems` after the last finished import. */
  systems_count: number;
  points_count: number | null;
  points_bytes: number | null;
  points_uploaded: boolean;
  points_error: string | null;
  error: string | null;
  attempts: number;
}

export interface GalaxyCatalogStatus {
  ready: boolean;
  systems_count: number;
  imported_at: string | null;
  source: string | null;
  points: {
    available: boolean;
    uploaded: boolean;
    count: number | null;
    bytes: number | null;
  };
  import: GalaxyCatalogImport | null;
}

export interface CatalogNote {
  /** Shown in red: the cloud cannot be loaded and somebody must act. */
  error: string;
  /** Shown in amber: progress or a recoverable state. */
  info: string;
  /** Keep polling `/api/galaxy/stats` — the state is expected to change. */
  retry: boolean;
}

export async function fetchGalaxyCatalogStatus(signal?: AbortSignal): Promise<GalaxyCatalogStatus> {
  const response = await fetch('/api/galaxy/stats', { signal, cache: 'no-store' });
  if (!response.ok) throw new Error(`Не удалось получить статус каталога (HTTP ${response.status})`);
  const data = (await response.json()) as Partial<GalaxyCatalogStatus>;
  return {
    ready: data.ready === true,
    systems_count: Number(data.systems_count ?? 0),
    imported_at: data.imported_at ?? null,
    source: data.source ?? null,
    points: {
      available: data.points?.available === true,
      uploaded: data.points?.uploaded === true,
      count: data.points?.count ?? null,
      bytes: data.points?.bytes ?? null,
    },
    import: (data.import as GalaxyCatalogImport | null) ?? null,
  };
}

function formatCount(value: number): string {
  return value.toLocaleString('ru-RU');
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 Б';
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  const scaled = value / 1024 ** index;
  return `${scaled >= 100 ? scaled.toFixed(0) : scaled.toFixed(1)} ${units[index]}`;
}

const ADMIN_HINT = 'Админка → «Каталог систем»';

/** Human-readable state of the catalog for the map panel. */
export function catalogNote(status: GalaxyCatalogStatus): CatalogNote {
  if (status.points.available) return { error: '', info: '', retry: false };

  const state = status.import;
  const running = !!state && (state.live || (state.phase === 'running' && !state.interrupted));

  if (running && state) {
    const percent = state.percent != null ? `${state.percent.toFixed(1)}%` : '…';
    const bytes = state.bytes_total
      ? `${formatBytes(state.bytes_done)} из ${formatBytes(state.bytes_total)}`
      : formatBytes(state.bytes_done);
    const skipped = state.skipped ? `, пропущено ${formatCount(state.skipped)} уже записанных` : '';
    return {
      error: '',
      info: `Импорт каталога: ${percent} (${bytes}, записано ${formatCount(state.written)}${skipped}). Облако появится после завершения.`,
      retry: true,
    };
  }

  if (state?.phase === 'running' && state.interrupted) {
    return {
      error: '',
      info: `Импорт каталога прерван перезапуском сервера (записано ${formatCount(state.written)} систем). Продолжите: ${ADMIN_HINT}.`,
      retry: true,
    };
  }

  if (state?.phase === 'failed') {
    return {
      error: `Импорт каталога не удался: ${state.error || 'неизвестная ошибка'}. Повторите: ${ADMIN_HINT}.`,
      info: '',
      retry: false,
    };
  }

  if (state?.phase === 'cancelled') {
    return {
      error: '',
      info: `Импорт каталога остановлен (записано ${formatCount(state.written)} систем). Продолжите: ${ADMIN_HINT}.`,
      retry: false,
    };
  }

  if (status.systems_count > 0) {
    return {
      error: `В каталоге ${formatCount(status.systems_count)} систем, но облако точек недоступно. Пересоберите его: ${ADMIN_HINT}.`,
      info: '',
      retry: false,
    };
  }

  return {
    error: `Каталог всех систем пуст — запустите импорт дампа Spansh (${ADMIN_HINT}).`,
    info: '',
    retry: false,
  };
}
