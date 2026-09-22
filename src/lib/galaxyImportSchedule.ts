import type { GalaxyImportPhase } from './galaxyImportJob.ts';

/**
 * Решение планировщика: запускать ли ночной импорт каталога.
 *
 * Вынесено из маршрута `/api/cron/galaxy-import` в чистую функцию, потому что
 * состояние импорта переживает процесс: запись `phase: "running"` в
 * `galaxy_systems_meta` остаётся после перезапуска контейнера, и наивная
 * проверка «running → уже идёт» навсегда блокировала бы продолжение. Здесь
 * «идёт» означает либо живой прогон в этом процессе, либо свежий прогресс
 * (другой воркер), а устаревший `running` — это прерванный импорт, который
 * нужно продолжить.
 */

/** A finished import younger than this is "today's dump" — skip the run. */
export const FRESH_MS = 20 * 60 * 60 * 1000;
/** After this many consecutive failures the job reports an error instead of retrying. */
export const MAX_ATTEMPTS = 3;
/**
 * A persisted `running` whose progress is older than this belongs to a dead
 * process. A live run rewrites its progress every ~10 s, so the window only
 * matters for deployments with several web replicas.
 */
export const STALE_RUNNING_MS = 5 * 60 * 1000;

export type ScheduledImportDecision =
  | { action: 'skip'; reason: 'running' | 'running_elsewhere' | 'fresh' }
  | { action: 'start'; reason: 'start' | 'resume' | 'restart' }
  | { action: 'fail'; reason: string };

export interface ScheduledImportInput {
  phase: GalaxyImportPhase;
  /** A run is in flight in this process. */
  live: boolean;
  /** Persisted `running` with no live task: the process restarted mid-import. */
  interrupted: boolean;
  /** Uncompressed byte offset of the last flushed record; 0 = nothing stored yet. */
  resume_offset: number;
  attempts: number;
  error: string | null;
  finished_at: string | null;
  updated_at: string | null;
  /** `galaxy_systems` holds a full catalog (≥ 1M rows, not a `--limit` test run). */
  catalog_complete: boolean;
  now?: number;
}

function age(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isFinite(at) ? now - at : null;
}

export function decideScheduledImport(input: ScheduledImportInput): ScheduledImportDecision {
  const now = input.now ?? Date.now();

  if (input.live) return { action: 'skip', reason: 'running' };

  if (input.phase === 'running') {
    // Another replica may own the run: it keeps `updated_at` moving.
    const sinceUpdate = age(input.updated_at, now);
    if (sinceUpdate !== null && sinceUpdate < STALE_RUNNING_MS) {
      return { action: 'skip', reason: 'running_elsewhere' };
    }
    return { action: 'start', reason: input.resume_offset > 0 ? 'resume' : 'restart' };
  }

  if (input.phase === 'done') {
    const sinceFinish = age(input.finished_at, now);
    if (input.catalog_complete && sinceFinish !== null && sinceFinish < FRESH_MS) {
      return { action: 'skip', reason: 'fresh' };
    }
    return { action: 'start', reason: 'start' };
  }

  if (input.phase === 'failed' && input.attempts >= MAX_ATTEMPTS) {
    // Loud: nobody fixes a broken source or missing credentials by retrying.
    return {
      action: 'fail',
      reason: `galaxy import failed ${input.attempts} times: ${input.error || 'unknown error'}`,
    };
  }

  // `failed` below the attempt limit, `cancelled`, `idle`.
  return { action: 'start', reason: input.resume_offset > 0 ? 'resume' : 'start' };
}
