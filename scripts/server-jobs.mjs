#!/usr/bin/env node
/** Dependency-free self-hosted scheduler. All calendars are UTC, independent of host TZ.
 * --list: inspect configuration; --once NAME: explicit manual run; no arguments: daemon.
 * Only CRON_SECRET is needed here. Supabase/Yandex/Inara credentials stay in web.
 */
import { readFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
export const JOBS = [
  { name: 'capi-sync', period: 5 * MINUTE, offset: 0, path: '/api/cron/capi-sync', timeout: 15 * MINUTE },
  { name: 'update-progress', period: 30 * MINUTE, offset: 0, path: '/api/cron/update-progress', timeout: 20 * MINUTE },
  { name: 'cg-check', period: 6 * HOUR, offset: 0, path: '/api/cron/cg-check', timeout: 5 * MINUTE },
  { name: 'eddn-cleanup', period: 6 * HOUR, offset: 30 * MINUTE, path: '/api/cron/eddn-cleanup', timeout: 5 * MINUTE },
  { name: 'galnet-sync', period: 24 * HOUR, offset: 6 * HOUR + 20 * MINUTE, path: '/api/galnet', timeout: 15 * MINUTE },
  { name: 'translate', period: 6 * HOUR, offset: 40 * MINUTE, path: '/api/cron/translate', timeout: 15 * MINUTE },
];

export function scheduleSlot(job, now = Date.now()) {
  return Math.floor((now - job.offset) / job.period);
}

function boundedInt(value, fallback, max) {
  if (value === undefined || value === '') return fallback;
  const result = Number(value);
  if (!Number.isInteger(result) || result < 1 || result > max) throw new Error('Invalid job limit');
  return result;
}

export function jobConfig(env = process.env) {
  const base = new URL(env.JOBS_BASE_URL || 'http://web:3000');
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password ||
      base.search || base.hash || base.pathname !== '/') throw new Error('JOBS_BASE_URL must be an origin');
  const enabled = (env.JOBS_ENABLED ?? JOBS.map(job => job.name).join(','))
    .split(',').map(name => name.trim()).filter(Boolean);
  for (const name of enabled) {
    if (!JOBS.some(job => job.name === name)) throw new Error(`Unknown job: ${name}`);
  }
  return {
    baseUrl: base.origin,
    secret: env.CRON_SECRET || '',
    jobs: JOBS.filter(job => enabled.includes(job.name)),
    stateFile: env.JOBS_STATE_FILE || '/data/jobs-state.json',
    feedLimit: boundedInt(env.GALNET_FEED_LIMIT, 30, 100),
    translateLimit: boundedInt(env.GALNET_TRANSLATE_LIMIT, 10, 50),
    translatePasses: boundedInt(env.JOBS_TRANSLATE_PASSES, 4, 10),
  };
}

export async function callEndpoint(config, job, fetchImpl = fetch, signal) {
  if (!config.secret.trim()) throw new Error('CRON_SECRET is required');
  const url = new URL(job.path, config.baseUrl);
  if (job.name === 'galnet-sync') {
    // Preserve the previous daily budget: fresh articles + up to four drain
    // batches. Disabling the translate job also disables Galnet translations.
    url.searchParams.set('translate', config.jobs.some(item => item.name === 'translate') ? '1' : '0');
    url.searchParams.set('translateLimit', String(config.translateLimit));
    url.searchParams.set('limit', String(config.feedLimit));
  }
  if (job.name === 'translate') url.searchParams.set('limit', String(config.translateLimit));
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.secret}`, Accept: 'application/json' },
      // A redirect must never forward the maintenance secret to a different host.
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(job.timeout)]) : AbortSignal.timeout(job.timeout),
    });
  } catch {
    throw new Error('Network error, redirect or timeout');
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  let result;
  try { result = await response.json(); } catch { throw new Error('Non-JSON response'); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid job response');
  if (result.ok === false || result.success === false || result.error || result.failed > 0) {
    // Do not dump response bodies: they may contain upstream credentials or PII.
    throw new Error('Job reported failure; check web logs');
  }
  if (job.name === 'galnet-sync' && result.fetched === 0) {
    throw new Error('Galnet feed is empty; check parser or upstream');
  }
  return result;
}

export async function executeJob(config, job, fetchImpl = fetch, signal) {
  const result = await callEndpoint(config, job, fetchImpl, signal);
  if (job.name === 'galnet-sync' && config.jobs.some(item => item.name === 'translate')) {
    const translate = JOBS.find(item => item.name === 'translate');
    let translation;
    for (let pass = 0; pass < config.translatePasses; pass++) {
      translation = await callEndpoint(config, translate, fetchImpl, signal);
      if (translation.skipped || !(translation.remaining > 0)) break;
    }
    return { ...result, translation };
  }
  // The old 6-hour auto-translate Action processed ONE batch, not four.
  // Keep that budget; extra draining belongs only to the daily Galnet job.
  return result;
}

export async function loadState(file) {
  try {
    const value = JSON.parse(await readFile(file, 'utf8'));
    if (value?.version !== 1 || !value.jobs || typeof value.jobs !== 'object' || Array.isArray(value.jobs)) {
      throw new Error('Invalid scheduler state');
    }
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, jobs: {} };
    // Do not silently replay everything on unreadable/corrupt state.
    throw new Error('Cannot read scheduler state; check volume permissions or restore its backup');
  }
}

export async function saveState(file, state) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, JSON.stringify(state, null, 2), { mode: 0o600 });
  await rename(`${file}.tmp`, file);
}

/** A sequential tick means tasks never overlap or create an unbounded backlog.
 * Persist successful slots; retry failures with backoff, even in the same slot.
 * After downtime catch up once, not once for every missed interval.
 */
export async function runTick({ config, state, retries, run = executeJob, persist = saveState,
  log = console.log, now = Date.now, signal }) {
  for (const job of config.jobs) {
    if (signal?.aborted) break;
    const slot = scheduleSlot(job, now());
    const previous = state.jobs[job.name];
    if (Number.isInteger(previous?.slot) && previous.slot >= slot) continue;
    if ((retries[job.name]?.nextAt ?? 0) > now()) continue;
    const started = now();
    log(JSON.stringify({ job: job.name, event: 'start', at: new Date(started).toISOString() }));
    let result;
    try {
      result = await run(config, job, undefined, signal);
    } catch (error) {
      const failures = (retries[job.name]?.failures ?? 0) + 1;
      const delay = Math.min(5 * MINUTE, MINUTE * 2 ** Math.min(failures - 1, 3));
      retries[job.name] = { failures, nextAt: now() + delay };
      log(JSON.stringify({ job: job.name, event: 'failed', error: error.message, retryInSeconds: delay / 1000 }));
      continue;
    }
    // Persist outside the job catch. A broken state volume is fatal, not a
    // reason to rerun a successful job and spend translation quota again.
    state.jobs[job.name] = { slot, lastSuccess: new Date(now()).toISOString() };
    await persist(config.stateFile, state);
    delete retries[job.name];
    log(JSON.stringify({ job: job.name, event: result?.skipped ? 'skipped' : 'success',
      durationMs: now() - started, ...(result?.skipped ? { reason: result.reason } : {}) }));
  }
}

async function main() {
  const config = jobConfig();
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--list') {
    console.log(JSON.stringify(config.jobs.map(({ name, path, period, offset }) => ({
      name, path, everyMinutes: period / MINUTE, offsetMinutesUTC: offset / MINUTE,
    })), null, 2));
    return;
  }
  if (!config.secret.trim()) throw new Error('CRON_SECRET is required');
  if (args.length === 2 && args[0] === '--once') {
    const job = config.jobs.find(job => job.name === args[1]);
    if (!job) throw new Error('Job is unknown or disabled');
    const result = await executeJob(config, job);
    console.log(JSON.stringify({ job: job.name, event: result.skipped ? 'skipped' : 'success' }));
    return; // Manual execution deliberately does not change scheduler state.
  }
  if (args.length) throw new Error('Usage: server-jobs.mjs [--list | --once NAME]');
  const state = await loadState(config.stateFile);
  await saveState(config.stateFile, state); // Fail before any work if the volume is unwritable.
  const retries = {};
  const controller = new AbortController();
  for (const event of ['SIGTERM', 'SIGINT']) process.once(event, () => controller.abort());
  console.log(JSON.stringify({ event: 'scheduler-start', timezone: 'UTC', jobs: config.jobs.map(job => job.name) }));
  while (!controller.signal.aborted) {
    await runTick({ config, state, retries, signal: controller.signal });
    try { await sleep(15_000, undefined, { signal: controller.signal }); } catch { break; }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error('[jobs]', error.message); process.exitCode = 1; });
}
