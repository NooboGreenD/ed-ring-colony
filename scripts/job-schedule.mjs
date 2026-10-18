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
  { name: 'colonisation-cleanup', period: 24 * HOUR, offset: 3 * HOUR + 40 * MINUTE, path: '/api/cron/colonisation-cleanup', timeout: 10 * MINUTE },
  { name: 'galnet-sync', period: 24 * HOUR, offset: 6 * HOUR + 20 * MINUTE, path: '/api/galnet', timeout: 15 * MINUTE },
  { name: 'translate', period: 6 * HOUR, offset: 40 * MINUTE, path: '/api/cron/translate', timeout: 15 * MINUTE },
  // PowerPlay layer of the Atlas map: EDSM publishes the dump once a day, the
  // conditional request turns the second daily run into a cheap 304.
  { name: 'powerplay-sync', period: 12 * HOUR, offset: 5 * HOUR + 20 * MINUTE, path: '/api/cron/powerplay-sync', timeout: 10 * MINUTE },
  // Minor factions (Atlas «Фракции»): the EDSM systemsPopulated dump is ~0.5 GB,
  // so the job never makes the FIRST import (the admin does) — afterwards it
  // refreshes data older than FACTIONS_REFRESH_DAYS and resumes an import cut
  // off by a restart. The request returns at once; the import runs in `web`.
  { name: 'factions-sync', period: 24 * HOUR, offset: 7 * HOUR + 10 * MINUTE, path: '/api/cron/factions-sync', timeout: 5 * MINUTE },
  // The full Spansh import is deliberately opt-in: it downloads a ~6 GiB dump.
  { name: 'galaxy-import', period: 24 * HOUR, offset: 2 * HOUR, path: '/api/cron/galaxy-import', timeout: 10 * MINUTE },
];

/** Jobs enabled when JOBS_ENABLED is not specified. */
export const DEFAULT_JOBS = JOBS.filter((job) => job.name !== 'galaxy-import').map((job) => job.name);
