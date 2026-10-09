import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  createServerRelease,
  promoteVersion,
  saveLauncherBinary,
  storeRoot,
  type Channel,
  type HelperReleaseProgress,
} from '@/lib/uploaderStore';
import type {
  HelperReleaseJob,
  HelperReleaseJobStats,
  HelperReleaseLogLevel,
} from '@/types/helperRelease';

// A release is deliberately a persisted job instead of one long HTTP request.
// The admin page can refresh/reconnect and still see the real server progress.
const JOB_DIR_NAME = 'release-jobs';
const MAX_LOG_LINES = 160;
const JOB_ID = /^[0-9a-f-]{36}$/;

const STAGE_LABELS: Record<HelperReleaseProgress['stage'] | 'queued', string> = {
  queued: 'В очереди',
  validate: 'Проверка',
  hash: 'SHA-256',
  sign: 'Подпись',
  archive: 'ZIP-архив',
  publish: 'Публикация',
  complete: 'Готово',
};

export type HelperReleaseInput =
  | {
      kind: 'bundle';
      version: string;
      channel: Channel;
      notes: string;
      minLauncher: string;
      files: Map<string, Buffer>;
      promote: boolean;
      /** Осознанный выпуск ключом, которого нет в TRUSTED_KEYS клиентов. */
      allowUntrustedKey?: boolean;
    }
  | {
      kind: 'launcher';
      version: string;
      platform: string;
      publicUrl: string;
      data: Buffer;
    }
  | {
      kind: 'promote';
      version: string;
      channel: Channel;
    };

interface RuntimeJob {
  state: HelperReleaseJob;
  cancelRequested: boolean;
}

const runtimeJobs = new Map<string, RuntimeJob>();
let activeJobId: string | null = null;

function jobDir() {
  return join(storeRoot(), JOB_DIR_NAME);
}

function jobPath(id: string) {
  return join(jobDir(), `${id}.json`);
}

function now() {
  return new Date().toISOString();
}

function emptyStats(): HelperReleaseJobStats {
  return { files: 0, totalBytes: 0, hashedFiles: 0, storedBlobs: 0, archiveBytes: 0, durationMs: 0 };
}

function safeLine(value: unknown): string {
  return String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, 240);
}

function initialState(input: HelperReleaseInput, id: string = randomUUID()): HelperReleaseJob {
  const createdAt = now();
  const stats = emptyStats();
  if (input.kind === 'bundle') {
    stats.files = input.files.size;
    stats.totalBytes = [...input.files.values()].reduce((sum, file) => sum + file.length, 0);
  } else if (input.kind === 'launcher') {
    stats.files = 1;
    stats.totalBytes = input.data.length;
  }
  return {
    id,
    kind: input.kind,
    state: 'queued',
    active: true,
    version: input.version || null,
    channel: 'channel' in input ? input.channel : null,
    stage: 'queued',
    stageLabel: STAGE_LABELS.queued,
    percent: 0,
    message: 'Задача принята сервером',
    createdAt,
    startedAt: null,
    updatedAt: createdAt,
    finishedAt: null,
    error: null,
    stats,
    log: [{ at: createdAt, level: 'info', line: 'Задача добавлена в очередь' }],
  };
}

async function persist(state: HelperReleaseJob) {
  await mkdir(jobDir(), { recursive: true });
  const target = jobPath(state.id);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
  await rename(temporary, target);
}

function addLog(state: HelperReleaseJob, level: HelperReleaseLogLevel, line: string) {
  const clean = safeLine(line);
  if (!clean || state.log.at(-1)?.line === clean) return;
  state.log = [...state.log, { at: now(), level, line: clean }].slice(-MAX_LOG_LINES);
}

async function updateRuntime(
  id: string,
  changes: Partial<HelperReleaseJob>,
  log?: { level?: HelperReleaseLogLevel; line: string },
) {
  const runtime = runtimeJobs.get(id);
  if (!runtime) throw new Error('Задача публикации больше не существует');
  Object.assign(runtime.state, changes, { updatedAt: now() });
  if (log) addLog(runtime.state, log.level ?? 'info', log.line);
  await persist(runtime.state);
  return runtime.state;
}

async function report(id: string, progress: HelperReleaseProgress) {
  const runtime = runtimeJobs.get(id);
  if (!runtime) throw new Error('Задача публикации больше не существует');
  if (runtime.cancelRequested) throw new JobAbortedError();
  const state = runtime.state;
  const stats = { ...state.stats, ...(progress.stats ?? {}) };
  const percent = Math.max(state.percent, Math.min(100, Math.round(progress.percent)));
  await updateRuntime(id, {
    state: 'running',
    active: true,
    stage: progress.stage,
    stageLabel: STAGE_LABELS[progress.stage],
    percent,
    message: safeLine(progress.message),
    stats,
  }, { line: progress.message });
}

class JobAbortedError extends Error {
  constructor() {
    super('Операция остановлена администратором');
    this.name = 'JobAbortedError';
  }
}

function isJobAborted(error: unknown): error is JobAbortedError {
  return error instanceof JobAbortedError;
}

async function finish(id: string, state: 'succeeded' | 'failed' | 'aborted', error?: string) {
  const runtime = runtimeJobs.get(id);
  if (!runtime) return;
  const finishedAt = now();
  const started = runtime.state.startedAt ? Date.parse(runtime.state.startedAt) : Date.parse(runtime.state.createdAt);
  await updateRuntime(id, {
    state,
    active: false,
    percent: state === 'succeeded' ? 100 : runtime.state.percent,
    stage: state === 'succeeded' ? 'complete' : runtime.state.stage,
    stageLabel: state === 'succeeded' ? STAGE_LABELS.complete : runtime.state.stageLabel,
    finishedAt,
    error: state === 'failed' || state === 'aborted' ? safeLine(error) : null,
    stats: { ...runtime.state.stats, durationMs: Math.max(0, Date.parse(finishedAt) - (Number.isFinite(started) ? started : Date.now())) },
  }, { level: state === 'succeeded' ? 'success' : state === 'aborted' ? 'warning' : 'error', line: state === 'succeeded' ? 'Операция завершена успешно' : (error || 'Операция завершена') });
}

async function run(id: string, input: HelperReleaseInput) {
  const runtime = runtimeJobs.get(id);
  if (!runtime) return;
  activeJobId = id;
  try {
    await updateRuntime(id, {
      state: 'running',
      active: true,
      startedAt: now(),
      stage: 'validate',
      stageLabel: STAGE_LABELS.validate,
      message: 'Запускаю процесс публикации',
    }, { line: 'Процесс запущен' });

    let result;
    if (input.kind === 'bundle') {
      result = await createServerRelease({ ...input, onProgress: (progress) => report(id, progress) });
    } else if (input.kind === 'launcher') {
      result = await saveLauncherBinary(input.platform, input.version, input.data, input.publicUrl, (progress) => report(id, progress));
    } else {
      await report(id, { stage: 'validate', percent: 30, message: `Проверяю опубликованную версию ${input.version}` });
      result = await promoteVersion(input.channel, input.version);
      if (result.ok) await report(id, { stage: 'complete', percent: 100, message: `Канал «${input.channel}» переключён на ${input.version}` });
    }
    if (!result.ok) throw new Error(result.error || 'Операция не выполнена');
    await finish(id, 'succeeded');
  } catch (error) {
    await finish(id, isJobAborted(error) ? 'aborted' : 'failed', error instanceof Error ? error.message : String(error));
  } finally {
    if (activeJobId === id) activeJobId = null;
  }
}

async function readJob(id: string): Promise<HelperReleaseJob | null> {
  if (!JOB_ID.test(id)) return null;
  const runtime = runtimeJobs.get(id);
  if (runtime) return runtime.state;
  try {
    const parsed = JSON.parse(await readFile(jobPath(id), 'utf8')) as HelperReleaseJob;
    // A web-container restart cannot continue an in-memory job. Do not leave
    // the admin with an eternal 74% progress bar that no process owns.
    if (parsed.active && Date.now() - Date.parse(parsed.updatedAt) > 10 * 60_000) {
      const finishedAt = now();
      parsed.active = false;
      parsed.state = 'failed';
      parsed.finishedAt = finishedAt;
      parsed.updatedAt = finishedAt;
      parsed.error = 'Процесс прерван перезапуском сервера';
      parsed.log = [...parsed.log, { at: finishedAt, level: 'error' as const, line: parsed.error }].slice(-MAX_LOG_LINES);
      await persist(parsed);
    }
    return parsed;
  } catch {
    return null;
  }
}

async function latestFromDisk(): Promise<HelperReleaseJob | null> {
  let names: string[];
  try {
    names = await readdir(jobDir());
  } catch {
    return null;
  }
  const jobs = (await Promise.all(names.filter((name) => JOB_ID.test(name.slice(0, -5)) && name.endsWith('.json')).map((name) => readJob(name.slice(0, -5)))))
    .filter((job): job is HelperReleaseJob => job !== null)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return jobs[0] ?? null;
}

export async function startHelperReleaseJob(input: HelperReleaseInput, requestedId?: string): Promise<HelperReleaseJob> {
  const id = requestedId ?? randomUUID();
  if (!JOB_ID.test(id)) throw new Error('Неверный идентификатор задачи Helper');

  // Chunked launcher upload completion may be retried after the HTTP response
  // was lost. Its upload UUID is the idempotency key, so never enqueue the
  // same publication twice.
  const existing = await readJob(id);
  if (existing) return existing;

  if (activeJobId) throw new Error('Другая операция Helper уже выполняется');
  const latest = await latestFromDisk();
  if (latest?.active && Date.now() - Date.parse(latest.updatedAt) < 30 * 60_000) {
    throw new Error('Другая операция Helper уже выполняется');
  }
  const state = initialState(input, id);
  runtimeJobs.set(state.id, { state, cancelRequested: false });
  await persist(state);
  void run(state.id, input);
  return state;
}

export async function getHelperReleaseJob(id: string) {
  return readJob(id);
}

export async function getLatestHelperReleaseJob() {
  return latestFromDisk();
}

export async function cancelHelperReleaseJob(id: string) {
  const runtime = runtimeJobs.get(id);
  if (!runtime || !runtime.state.active) return { ok: false as const, error: 'Активная задача не найдена', job: await readJob(id) };
  runtime.cancelRequested = true;
  await updateRuntime(id, { message: 'Остановка процесса…' }, { level: 'warning', line: 'Получена команда остановки' });
  return { ok: true as const, job: runtime.state };
}
