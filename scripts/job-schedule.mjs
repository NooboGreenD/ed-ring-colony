/**
 * Shared schedule definition for the server-side job runner and the private
 * monitoring agent. All offsets are UTC milliseconds from Unix epoch.
 */
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

export const JOBS = [
  { name: 'capi-sync', period: 5 * MINUTE, offset: 0, path: '/api/cron/capi-sync', timeout: 15 * MINUTE },
  { name: 'update-progress', period: 30 * MINUTE, offset: 0, path: '/api/cron/update-progress', timeout: 20 * MINUTE },
  { name: 'cg-check', period: 6 * HOUR, offset: 0, path: '/api/cron/cg-check', timeout: 5 * MINUTE },
  { name: 'eddn-cleanup', period: 6 * HOUR, offset: 30 * MINUTE, path: '/api/cron/eddn-cleanup', timeout: 5 * MINUTE },
  { name: 'galnet-sync', period: 24 * HOUR, offset: 6 * HOUR + 20 * MINUTE, path: '/api/galnet', timeout: 15 * MINUTE },
  { name: 'translate', period: 6 * HOUR, offset: 40 * MINUTE, path: '/api/cron/translate', timeout: 15 * MINUTE },
  // The full Spansh import is deliberately opt-in: it downloads a ~6 GiB dump.
  { name: 'galaxy-import', period: 24 * HOUR, offset: 2 * HOUR, path: '/api/cron/galaxy-import', timeout: 10 * MINUTE },
];

/** Jobs enabled when JOBS_ENABLED is not specified. */
export const DEFAULT_JOBS = JOBS.filter((job) => job.name !== 'galaxy-import').map((job) => job.name);
