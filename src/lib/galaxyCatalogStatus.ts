/**
 * Client-side view of `GET /api/galaxy/stats` — what the "all systems" map
 * layer needs before it dares to download a point cloud (its size is not a
 * constant: it is the smaller of the bucket's `file_size_limit` and the byte
 * budget of `POINTS_FILE_BUDGET`, so the labels come from the server, never
 * from a number written here).
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
  /**
   * Where the published file actually is: `storage` (canonical, every
   * process), `disk` (the data directory — this server serves it, a rebuilt
   * container does not) or `none`. `points_uploaded` stays the storage marker.
   */
  points_published?: 'storage' | 'disk' | 'none' | null;
  points_error: string | null;
  error: string | null;
  attempts: number;
  /** Which Spansh file the last pass imported: `full` or a delta (`1day`…). */
  variant?: string | null;
  /** `stream` (gzip archive) or `shards` (unpacked, O(1) resume). */
  mode?: 'stream' | 'shards' | null;
  /** Shards already stored (shard mode). */
  shard_index?: number;
  shards_total?: number | null;
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
    /** Source rows per point in the published cloud (1 = every system). */
    stride: number | null;
    /** True when the cloud is a uniform sample of the catalog. */
    sampled: boolean;
    /** Where the file lives (see `GalaxyCatalogImport.points_published`). */
    published: GalaxyCatalogImport['points_published'];
  };
  import: GalaxyCatalogImport | null;
}

/**
 * The server sends the publish record (`{ target, uploaded, path, at }`) or, in
 * older builds, nothing at all — the client model is only the target, plus the
 * legacy storage flag as a fallback so a pre-migration server still reads as
 * "published".
 */
function normalizePointsTarget(
  value: unknown,
  uploaded: boolean,
): GalaxyCatalogImport['points_published'] {
  const target = typeof value === 'string' ? value : (value as { target?: unknown } | null)?.target;
  if (target === 'storage' || target === 'disk' || target === 'none') return target;
  return uploaded ? 'storage' : null;
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
      stride: data.points?.stride ?? null,
      sampled: data.points?.sampled === true,
      published: normalizePointsTarget(data.points?.published, data.points?.uploaded === true),
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
  if (status.points.available) {
    // The map will work, but the first cold start pays for it: without a
    // published file `/api/galaxy/all-systems` reads the catalog table.
    if (status.points.uploaded || status.points.published === 'disk') return { error: '', info: '', retry: false };
    return {
      error: '',
      info:
        `Файла облака в хранилище нет — при первом включении слоя карта соберёт его из ${formatCount(status.systems_count)} строк каталога, это минуты. ` +
        `Быстрее сделать это один раз: ${ADMIN_HINT} → «Собрать облако точек из таблицы».`,
      retry: false,
    };
  }

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
