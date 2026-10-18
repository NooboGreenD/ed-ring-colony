/**
 * Импорт минорных фракций из ночного дампа EDSM `systemsPopulated.json.gz`.
 *
 * Дамп большой (≈0,5 ГБ gzip, несколько ГБ JSON — почти всё станции и тела),
 * поэтому порядок не такой, как у маленького дампа PowerPlay:
 *
 *   1. probe    — HEAD к EDSM: размер, дата, поддержка Range. Тот же дамп,
 *                 что в прошлый удачный импорт, второй раз не качается;
 *   2. download — на диск (`data/spansh/factions`, тот же диск, что у каталога
 *                 систем) в несколько Range-соединений, с докачкой после
 *                 обрыва или перезапуска сайта (`downloadDump` каталога);
 *   3. import   — потоком: gunzip → строки → разбор (`bgsDump.ts`) → запись
 *                 пачками в `bgs_apply_snapshots`. В памяти — одна пачка;
 *   4. finish   — удалить системы, пропавшие из дампа (если пилоты не
 *                 присылали их последние 30 дней), пересчитать фракции,
 *                 записать состояние; архив удаляется с диска.
 *
 * Правило слияния в базе — «свежее наблюдение побеждает»: данные пилота из
 * Colonial Helper новее дампа не затираются.
 *
 * Запускают импорт администратор (Админка → Игровые данные → Фракции,
 * `/api/admin/factions`) и задача `factions-sync` (раз в сутки проверяет,
 * не пора ли обновить; первый импорт — решение администратора). Ход этапов и
 * журнал — в памяти процесса и копией в `bgs_sync_state`.
 */

import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { createGunzip } from 'node:zlib';

import { snapshotToRpcRow, type BgsSnapshot } from './bgs.ts';
import { BgsDumpCounter, parseEdsmPopulatedLine, type BgsDumpStats } from './bgsDump.ts';
import {
  BGS_TRIGGER_LABEL,
  createBgsProgress,
  finishBgsProgress,
  finishBgsStage,
  formatBgsBytes,
  formatBgsCount,
  formatBgsDuration,
  formatBgsSpeed,
  pushBgsLog,
  sanitizeBgsLog,
  sanitizeBgsProgress,
  startBgsStage,
  updateBgsStage,
  type BgsLogLevel,
  type BgsLogLine,
  type BgsStageId,
  type BgsSyncProgress,
  type BgsSyncTrigger,
} from './bgsProgress.ts';
import { downloadDump, galaxyArchiveDir, galaxyDownloadSegments, probeDumpSource, segmentStatePath } from './galaxyImport.ts';

type Svc = any;

export const DEFAULT_BGS_DUMP_URL = 'https://www.edsm.net/dump/systemsPopulated.json.gz';
const USER_AGENT = 'ED-Ring-Colony/2 (+https://edringcolony.ru; minor factions layer)';
export const BGS_ARCHIVE_FILE = 'edsm-systemsPopulated.json.gz';
const META_SUFFIX = '.meta.json';

/** Систем в пачке записи: ≈1,5 КБ JSON каждая, пачка — несколько сотен КБ. */
export const BGS_BATCH_SIZE = 250;
/** Населённых систем в настоящем дампе десятки тысяч. */
export const BGS_MIN_SYSTEMS = 1000;
/** Новый дамп меньше половины прошлого — скорее сбой источника. */
export const BGS_SHRINK_GUARD = 0.5;
/** Пропавшие из дампа системы живут, пока пилоты присылали их не позже этого. */
export const BGS_KEEP_DAYS = 30;
/** Задача `factions-sync` обновляет данные, если прошлый импорт старше этого. */
export const BGS_DEFAULT_REFRESH_DAYS = 7;
/** «running» без живого прогона и старше этого — оборванный импорт. */
const RUNNING_STALE_MS = 6 * 60 * 60 * 1000;
const PERSIST_EVERY_MS = 1000;
/** Запас свободного места сверх размера дампа. */
const DISK_RESERVE_BYTES = 256 * 1024 * 1024;
/** Строка дампа длиннее — это не дамп, а что-то сломанное. */
const MAX_LINE_CHARS = 64 * 1024 * 1024;
/** Завершение импорта короткими вызовами: столько строк / id за раз (делится пополам при таймауте). */
const DELETE_STEP = 2000;
const RECOUNT_STEP = 5000;
const PRUNE_STEP = 5000;

/**
 * Расписание задачи `factions-sync` (копия из scripts/job-schedule.mjs — тест
 * следит, чтобы они не разошлись): раз в сутки в 07:10 UTC, после того как
 * EDSM выложил свежие дампы.
 */
export const BGS_SCHEDULE = { periodMs: 24 * 60 * 60 * 1000, offsetMs: (7 * 60 + 10) * 60 * 1000 } as const;

export const BGS_CANCEL_MESSAGE = 'Импорт остановлен администратором';

/* ── Настройки ─────────────────────────────────────────────────────────── */

export function bgsDumpUrl(env: Record<string, string | undefined> = process.env): string {
  const raw = env.FACTIONS_DUMP_URL?.trim();
  if (!raw) return DEFAULT_BGS_DUMP_URL;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : DEFAULT_BGS_DUMP_URL;
  } catch {
    return DEFAULT_BGS_DUMP_URL;
  }
}

/** Каталог архива: по умолчанию рядом с дампами каталога систем (отдельный диск). */
export function bgsArchiveDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.FACTIONS_ARCHIVE_DIR?.trim() || join(galaxyArchiveDir(env), 'factions');
}

export function bgsArchivePath(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(bgsArchiveDir(env), BGS_ARCHIVE_FILE);
}

/** `FACTIONS_ARCHIVE_KEEP=1` — не удалять архив после удачного импорта. */
export function bgsArchiveKeep(env: Record<string, string | undefined> = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env.FACTIONS_ARCHIVE_KEEP?.trim() ?? '');
}

export function bgsBatchSize(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.FACTIONS_BATCH_SIZE);
  return Number.isFinite(raw) && raw > 0 ? Math.max(20, Math.min(1000, Math.floor(raw))) : BGS_BATCH_SIZE;
}

/** `FACTIONS_MIN_SYSTEMS` — меньше систем в дампе считается сбоем источника (для зеркал с выборкой). */
export function bgsMinSystems(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.FACTIONS_MIN_SYSTEMS);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : BGS_MIN_SYSTEMS;
}

export function bgsRefreshDays(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.FACTIONS_REFRESH_DAYS);
  return Number.isFinite(raw) && raw > 0 ? Math.max(1, Math.min(60, Math.floor(raw))) : BGS_DEFAULT_REFRESH_DAYS;
}

/* ── Состояние ─────────────────────────────────────────────────────────── */

export interface BgsSyncState {
  status: 'idle' | 'running' | 'ok' | 'error';
  source_url: string | null;
  etag: string | null;
  last_modified: string | null;
  dump_generated_at: string | null;
  dump_bytes: number | null;
  run_id: string | null;
  systems_total: number;
  factions_total: number;
  presence_total: number;
  stats: Record<string, unknown> | null;
  error: string | null;
  attempt_at: string | null;
  checked_at: string | null;
  synced_at: string | null;
  progress: BgsSyncProgress | null;
  log: BgsLogLine[];
}

const EMPTY_STATE: BgsSyncState = {
  status: 'idle',
  source_url: null,
  etag: null,
  last_modified: null,
  dump_generated_at: null,
  dump_bytes: null,
  run_id: null,
  systems_total: 0,
  factions_total: 0,
  presence_total: 0,
  stats: null,
  error: null,
  attempt_at: null,
  checked_at: null,
  synced_at: null,
  progress: null,
  log: [],
};

function count(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

export async function readBgsSyncState(svc: Svc): Promise<BgsSyncState> {
  const { data, error } = await svc.from('bgs_sync_state').select('*').eq('id', 1).maybeSingle();
  if (error) throw new Error(error.message);
  return {
    ...EMPTY_STATE,
    ...(data ?? {}),
    dump_bytes: data?.dump_bytes == null ? null : count(data.dump_bytes),
    systems_total: count(data?.systems_total),
    factions_total: count(data?.factions_total),
    presence_total: count(data?.presence_total),
    progress: sanitizeBgsProgress(data?.progress),
    log: sanitizeBgsLog(data?.log),
  };
}

async function writeState(svc: Svc, patch: Partial<BgsSyncState>): Promise<void> {
  const { error } = await svc
    .from('bgs_sync_state')
    .upsert({ id: 1, ...patch, updated_at: new Date().toISOString() }, { onConflict: 'id' });
  if (error) throw new Error(error.message);
}

function shortError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\s+/g, ' ').trim().slice(0, 500) || 'неизвестная ошибка';
}

function headerDate(value: string | null): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/* ── Архив на диске ────────────────────────────────────────────────────── */

/**
 * Метка архива рядом с файлом: какой дамп качается (пишется в начале
 * скачивания) и скачан ли он целиком (`completedAt`). Без неё нельзя понять,
 * чья недокачанная часть лежит на диске: дописать к ней хвост другого дампа —
 * значит получить битый gzip.
 */
interface ArchiveMeta {
  url: string;
  etag: string | null;
  lastModified: string | null;
  total: number | null;
  completedAt: string | null;
}

function readArchiveMeta(dest: string): ArchiveMeta | null {
  try {
    const raw = JSON.parse(readFileSync(`${dest}${META_SUFFIX}`, 'utf8')) as Partial<ArchiveMeta>;
    if (!raw || typeof raw.url !== 'string') return null;
    return {
      url: raw.url,
      etag: typeof raw.etag === 'string' ? raw.etag : null,
      lastModified: typeof raw.lastModified === 'string' ? raw.lastModified : null,
      total: typeof raw.total === 'number' && raw.total > 0 ? raw.total : null,
      completedAt: typeof raw.completedAt === 'string' && raw.completedAt ? raw.completedAt : null,
    };
  } catch {
    return null;
  }
}

function writeArchiveMeta(dest: string, meta: ArchiveMeta): void {
  try {
    writeFileSync(`${dest}${META_SUFFIX}`, JSON.stringify(meta, null, 1));
  } catch {
    // Без метки архив просто скачается заново в следующий раз.
  }
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function removeArchive(dest: string): number {
  const bytes = fileSize(dest);
  for (const path of [dest, segmentStatePath(dest), `${dest}${META_SUFFIX}`]) rmSync(path, { force: true });
  return bytes;
}

function freeBytes(dir: string): number | null {
  try {
    mkdirSync(dir, { recursive: true });
    const stats = statfsSync(dir);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

export interface BgsArchiveInfo {
  path: string;
  exists: boolean;
  bytes: number;
  /** Скачивание не закончено (есть план сегментов) — следующий запуск докачает. */
  partial: boolean;
  /** Архив скачан целиком (есть метка), дата дампа. */
  complete: boolean;
  lastModified: string | null;
  freeBytes: number | null;
}

export function bgsArchiveInfo(path = bgsArchivePath()): BgsArchiveInfo {
  const exists = existsSync(path);
  const meta = exists ? readArchiveMeta(path) : null;
  const bytes = exists ? fileSize(path) : 0;
  return {
    path,
    exists,
    bytes,
    partial: existsSync(segmentStatePath(path)),
    complete: Boolean(meta?.completedAt && meta.total === bytes),
    lastModified: meta?.lastModified ?? null,
    freeBytes: freeBytes(dirname(path)),
  };
}

/* ── Один импорт за раз на процесс ─────────────────────────────────────── */

interface LiveRun {
  progress: BgsSyncProgress;
  log: BgsLogLine[];
  controller: AbortController;
  cancelled: boolean;
  persistedAt: number;
}

export interface BgsRunSnapshot {
  progress: BgsSyncProgress;
  log: BgsLogLine[];
}

type SyncGlobal = typeof globalThis & {
  edrcBgsSync?: Promise<BgsSyncResult> | null;
  edrcBgsLive?: LiveRun | null;
  edrcBgsLastRun?: BgsRunSnapshot | null;
  edrcBgsLayerGeneration?: number;
  edrcBgsJournalGeneration?: number;
};
const shared = globalThis as SyncGlobal;

export function isBgsSyncRunning(): boolean {
  return Boolean(shared.edrcBgsSync);
}

/** Счётчик завершённых импортов дампа: кэш слоя сбрасывается, когда он меняется. */
export function bgsLayerGeneration(): number {
  return shared.edrcBgsLayerGeneration ?? 0;
}

/** Счётчик пачек от пилотов, поменявших слой (новые системы, смена власти). */
export function bgsJournalGeneration(): number {
  return shared.edrcBgsJournalGeneration ?? 0;
}

export function bumpBgsJournalGeneration(): void {
  shared.edrcBgsJournalGeneration = bgsJournalGeneration() + 1;
}

function snapshot(run: { progress: BgsSyncProgress; log: BgsLogLine[] }): BgsRunSnapshot {
  return JSON.parse(JSON.stringify({ progress: run.progress, log: run.log })) as BgsRunSnapshot;
}

export function getBgsLiveRun(): BgsRunSnapshot | null {
  return shared.edrcBgsLive ? snapshot(shared.edrcBgsLive) : null;
}

export function getBgsLastRun(): BgsRunSnapshot | null {
  return shared.edrcBgsLastRun ? snapshot(shared.edrcBgsLastRun) : null;
}

/** Для тестов: забыть историю прогонов. */
export function resetBgsSyncRuntime(): void {
  shared.edrcBgsLastRun = null;
  if (!shared.edrcBgsSync) shared.edrcBgsLive = null;
}

export function cancelBgsSync(reason = BGS_CANCEL_MESSAGE): boolean {
  const run = shared.edrcBgsLive;
  if (!run || run.cancelled) return false;
  run.cancelled = true;
  pushBgsLog(run.log, 'warn', `${reason} — обрываю текущий шаг`);
  run.controller.abort(new Error(reason));
  return true;
}

export interface BgsSyncOptions {
  fetchImpl?: typeof fetch;
  /** Импортировать, даже если дамп тот же, и принять «усохший» дамп. */
  force?: boolean;
  url?: string;
  archivePath?: string;
  segments?: number;
  batchSize?: number;
  minSystems?: number;
  keepArchive?: boolean;
  trigger?: BgsSyncTrigger;
}

export interface BgsSyncResult {
  status: 'ok' | 'not_modified' | 'error' | 'cancelled';
  error?: string;
  systems?: number;
  factions?: number;
  presence?: number;
  applied?: number;
  stale?: number;
  deletedSystems?: number;
  stats?: BgsDumpStats;
  dumpGeneratedAt?: string | null;
  durationMs: number;
}

export function runBgsSync(svc: Svc, options: BgsSyncOptions = {}): Promise<BgsSyncResult> {
  if (shared.edrcBgsSync) return shared.edrcBgsSync;
  const job = syncOnce(svc, options).finally(() => {
    shared.edrcBgsSync = null;
  });
  shared.edrcBgsSync = job;
  return job;
}

/** Запуск фоном: ответ возвращается сразу, ход виден в админке. */
export function startBgsSync(svc: Svc, options: BgsSyncOptions = {}): { started: boolean; reason?: string } {
  if (isBgsSyncRunning()) return { started: false, reason: 'Импорт уже идёт — его ход виден ниже' };
  void runBgsSync(svc, { ...options, trigger: options.trigger ?? 'admin' }).catch(() => undefined);
  return { started: true };
}

async function persistRun(svc: Svc, run: LiveRun, force = false): Promise<void> {
  const now = Date.now();
  if (!force && now - run.persistedAt < PERSIST_EVERY_MS) return;
  run.persistedAt = now;
  try {
    const { error } = await svc
      .from('bgs_sync_state')
      .update({ progress: run.progress, log: run.log, updated_at: new Date(now).toISOString() })
      .eq('id', 1);
    if (error) throw new Error(error.message);
  } catch {
    // Копия хода в базе — для админки после перезапуска; импорт от неё не зависит.
  }
}

function withUserAgent(fetchImpl: typeof fetch): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1] = {}) => {
    const headers = new Headers(init?.headers ?? {});
    if (!headers.has('user-agent')) headers.set('User-Agent', USER_AGENT);
    return fetchImpl(input, { ...init, headers });
  }) as typeof fetch;
}

/** Строки gzip-файла потоком, с обратным давлением: пока пишем пачку, чтение стоит. */
async function forEachGzipLine(
  path: string,
  signal: AbortSignal,
  onLine: (line: string) => void | Promise<void>,
  onChunk: (bytesRead: number) => void | Promise<void>,
): Promise<void> {
  const source = createReadStream(path, { highWaterMark: 1 << 20 });
  const gunzip = createGunzip();
  source.on('error', (error) => gunzip.destroy(error));
  source.pipe(gunzip);
  const abort = () => {
    source.destroy();
    gunzip.destroy(new Error(BGS_CANCEL_MESSAGE));
  };
  if (signal.aborted) abort();
  signal.addEventListener('abort', abort, { once: true });
  const decoder = new StringDecoder('utf8');
  let parts: string[] = [];
  let partsLength = 0;
  try {
    for await (const chunk of gunzip) {
      const text = decoder.write(chunk as Buffer);
      let start = 0;
      for (;;) {
        const newline = text.indexOf('\n', start);
        if (newline < 0) break;
        const piece = text.slice(start, newline);
        const line = parts.length ? parts.join('') + piece : piece;
        parts = [];
        partsLength = 0;
        const pending = onLine(line);
        if (pending) await pending;
        start = newline + 1;
      }
      if (start < text.length) {
        const rest = text.slice(start);
        parts.push(rest);
        partsLength += rest.length;
        if (partsLength > MAX_LINE_CHARS) throw new Error('Строка дампа длиннее 64 МБ — файл не похож на дамп EDSM');
      }
      const pending = onChunk(source.bytesRead);
      if (pending) await pending;
    }
    const tail = parts.join('') + decoder.end();
    if (tail.trim()) {
      const pending = onLine(tail);
      if (pending) await pending;
    }
  } finally {
    signal.removeEventListener('abort', abort);
    source.destroy();
  }
}

/** PostgREST оборвал запрос по statement_timeout (57014): пачку надо уменьшить. */
export function isStatementTimeout(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown } | null;
  return e?.code === '57014' || /statement timeout|canceling statement/i.test(String(e?.message ?? ''));
}

/** Повторять вызов, пока он удаляет полную пачку; при таймауте — пачку меньше. */
async function deleteInSteps(
  call: (limit: number) => Promise<{ data: unknown; error: { message: string; code?: string } | null }>,
  label: string,
  start: number,
  onStep?: (total: number) => void | Promise<void>,
): Promise<number> {
  let limit = start;
  let total = 0;
  for (;;) {
    const { data, error } = await call(limit);
    if (error) {
      if (isStatementTimeout(error) && limit > 50) {
        limit = Math.max(50, Math.floor(limit / 2));
        continue;
      }
      throw new Error(`${label}: ${error.message}`);
    }
    const removed = count(data);
    total += removed;
    await onStep?.(total);
    if (removed < limit) return total;
  }
}

/** Счётчики всех фракций — пачками по id, чтобы каждый вызов был коротким. */
export async function recountAllFactions(
  svc: Svc,
  onStep?: (done: number) => void | Promise<void>,
): Promise<number> {
  let after = 0;
  let step = RECOUNT_STEP;
  let changed = 0;
  let done = 0;
  for (;;) {
    const { data, error } = await svc.rpc('bgs_recount_factions_batch', { p_after: after, p_limit: step });
    if (error) {
      if (isStatementTimeout(error) && step > 250) {
        step = Math.max(250, Math.floor(step / 2));
        continue;
      }
      throw new Error(`Пересчёт фракций: ${error.message}`);
    }
    const result = (typeof data === 'string' ? JSON.parse(data) : data ?? {}) as Record<string, unknown>;
    const rows = count(result.rows);
    if (rows === 0) return changed;
    changed += count(result.changed);
    done += rows;
    const last = Number(result.last_id);
    if (!Number.isFinite(last) || last <= after) return changed;
    after = last;
    await onStep?.(done);
  }
}

function isArchiveCorruption(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'Z_DATA_ERROR' || code === 'Z_BUF_ERROR') return true;
  return /unexpected end of file|incorrect header check|invalid (block|stored|distance|code)|не похож на дамп/i.test(shortError(error));
}

function describeStats(stats: BgsDumpStats): string[] {
  const allegiances = Object.entries(stats.allegiances).sort((a, b) => b[1] - a[1]);
  const lines = [
    `Разобрано записей: ${formatBgsCount(stats.records)} · населённых систем с фракциями: ${formatBgsCount(stats.systems)}`
      + ` · фракций: ${formatBgsCount(stats.factions)} (игроков: ${formatBgsCount(stats.playerFactions)})`
      + ` · присутствий: ${formatBgsCount(stats.presence)}`,
    `Отброшено: битых записей ${formatBgsCount(stats.skipped.invalid)}, без фракций ${formatBgsCount(stats.skipped.no_factions)}`,
  ];
  if (allegiances.length) {
    lines.push(`По принадлежности: ${allegiances.map(([name, n]) => `${name} ${formatBgsCount(n)}`).join(', ')}`);
  }
  if (stats.oldestObservation && stats.newestObservation) {
    lines.push(`Наблюдения EDSM: ${stats.oldestObservation.slice(0, 10)} – ${stats.newestObservation.slice(0, 10)}`);
  }
  return lines;
}

async function syncOnce(svc: Svc, options: BgsSyncOptions): Promise<BgsSyncResult> {
  const started = Date.now();
  const url = options.url ?? bgsDumpUrl();
  const dest = resolve(options.archivePath ?? bgsArchivePath());
  const fetchImpl = withUserAgent(options.fetchImpl ?? fetch);
  const minSystems = options.minSystems ?? bgsMinSystems();
  const batchSize = options.batchSize ?? bgsBatchSize();
  const segments = options.segments ?? galaxyDownloadSegments();
  const keepArchive = options.keepArchive ?? bgsArchiveKeep();
  const trigger = options.trigger ?? 'manual';
  let previous = EMPTY_STATE;
  let written = 0;

  const run: LiveRun = {
    progress: createBgsProgress({ id: randomUUID(), trigger, force: options.force === true, now: started }),
    log: [],
    controller: new AbortController(),
    cancelled: false,
    persistedAt: 0,
  };
  const history = shared.edrcBgsLastRun?.log ?? [];
  run.log.push(...history.slice(-150));
  shared.edrcBgsLive = run;

  const log = (level: BgsLogLevel, text: string) => {
    pushBgsLog(run.log, level, text);
  };
  const begin = async (stage: BgsStageId, init: { total?: number | null; done?: number; detail?: string } = {}) => {
    startBgsStage(run.progress, stage, init);
    await persistRun(svc, run, true);
  };
  const advance = async (stage: BgsStageId, patch: { done?: number; total?: number | null; detail?: string }) => {
    updateBgsStage(run.progress, stage, patch);
    await persistRun(svc, run);
  };
  const complete = (stage: BgsStageId, detail?: string, status: 'done' | 'skipped' = 'done') => {
    finishBgsStage(run.progress, stage, { detail, status });
  };
  const checkCancelled = () => {
    if (run.cancelled) throw new Error(BGS_CANCEL_MESSAGE);
  };

  log('info', `Запуск импорта: ${BGS_TRIGGER_LABEL[trigger]}${options.force ? ' · принудительно (тот же дамп импортируется заново, «усохший» принимается)' : ''}`);
  log('info', `Источник: ${url}`);

  try {
    previous = await readBgsSyncState(svc);
    if (history.length === 0 && previous.log.length > 0) run.log.unshift(...previous.log.slice(-150));
    await begin('probe', { detail: 'HEAD-запрос к EDSM' });
    await writeState(svc, { status: 'running', attempt_at: new Date().toISOString(), source_url: url, error: null });

    const probeStarted = Date.now();
    const probe = await probeDumpSource(url, { fetchImpl, signal: run.controller.signal });
    checkCancelled();
    log(
      'info',
      `Ответ EDSM за ${formatBgsDuration(Date.now() - probeStarted)}: ${probe.total ? formatBgsBytes(probe.total) : 'размер неизвестен'}`
        + `${probe.lastModified ? ` · дамп от ${probe.lastModified}` : ''}`
        + ` · докачка (Range): ${probe.acceptsRanges ? 'да' : 'нет'}`,
    );

    const sameDump = previous.systems_total > 0
      && previous.source_url === url
      && ((probe.etag && previous.etag === probe.etag) || (!probe.etag && probe.lastModified && previous.last_modified === probe.lastModified));
    if (sameDump && !options.force) {
      complete('probe', 'дамп не менялся');
      await writeState(svc, { status: 'ok', checked_at: new Date().toISOString(), error: null });
      const durationMs = Date.now() - started;
      log('info', `Дамп не менялся с прошлого импорта — данные актуальны (${formatBgsCount(previous.systems_total)} систем). Готово за ${formatBgsDuration(durationMs)}`);
      finishBgsProgress(run.progress, 'not_modified', {
        message: 'Дамп не менялся — данные актуальны',
        result: { systems: previous.systems_total, factions: previous.factions_total, durationMs },
      });
      return { status: 'not_modified', systems: previous.systems_total, durationMs };
    }
    complete('probe', `${probe.total ? formatBgsBytes(probe.total) : 'размер неизвестен'}${probe.lastModified ? ` · от ${probe.lastModified}` : ''}`);

    /* ── Скачивание на диск ── */
    const signature = probe.etag || probe.lastModified || null;
    const meta = readArchiveMeta(dest);
    const archiveMatches = Boolean(
      meta && meta.url === url
      && (!signature || signature === (meta.etag || meta.lastModified))
      && (!probe.total || !meta.total || meta.total === probe.total),
    );
    const onDisk = fileSize(dest);
    const reusable = archiveMatches && Boolean(meta?.completedAt) && existsSync(dest) && !existsSync(segmentStatePath(dest)) && meta!.total === onDisk;
    let lastModified = probe.lastModified;
    if (reusable) {
      await begin('download', { total: onDisk, done: onDisk, detail: 'архив этого дампа уже на диске' });
      complete('download', `уже на диске: ${formatBgsBytes(onDisk)}`);
      log('info', `Архив этого дампа уже на диске (${formatBgsBytes(onDisk)}, ${dest}) — скачивание не нужно`);
    } else {
      if (!archiveMatches && (existsSync(dest) || existsSync(segmentStatePath(dest)))) {
        // Часть другого (вчерашнего) дампа или файл без метки: дописывать к нему
        // нельзя — начать заново.
        const freed = removeArchive(dest);
        log('info', `На диске был архив другого дампа (${formatBgsBytes(freed)}) — удалён, качаю заново`);
      }
      const free = freeBytes(dirname(dest));
      writeArchiveMeta(dest, { url, etag: probe.etag, lastModified: probe.lastModified, total: probe.total, completedAt: null });
      const need = Math.max(0, (probe.total ?? 600 * 1024 * 1024) - fileSize(dest)) + DISK_RESERVE_BYTES;
      if (free != null && free < need) {
        throw new Error(`Недостаточно места на диске для дампа: свободно ${formatBgsBytes(free)}, нужно ~${formatBgsBytes(need)} (${dirname(dest)})`);
      }
      const resumeFrom = fileSize(dest);
      log('info', `Скачиваю дамп на диск: ${dest}${resumeFrom > 0 ? ` (часть уже скачана — докачка)` : ''}, соединений до ${segments}`);
      await begin('download', { total: probe.total ?? null, done: 0, detail: 'соединение' });
      const downloadStarted = Date.now();
      let firstBytes: number | null = null;
      const result = await downloadDump({
        url,
        dest,
        segments,
        signal: run.controller.signal,
        retries: Infinity,
        maxStagnantFailures: 12,
        verify: false,
        fetchImpl,
        progressIntervalMs: 1000,
        log: (line) => log(/обрыв|не удалось|недоступн/i.test(line) ? 'warn' : 'info', `Скачивание: ${line}`),
        onProgress: (info) => {
          if (firstBytes == null) firstBytes = info.received;
          const seconds = Math.max(1, (Date.now() - downloadStarted) / 1000);
          const speed = Math.max(0, info.received - firstBytes) / seconds;
          const left = info.total && speed > 0 ? ((info.total - info.received) / speed) * 1000 : null;
          return advance('download', {
            done: info.received,
            total: info.total,
            detail: `${formatBgsBytes(info.received)}${info.total ? ` из ${formatBgsBytes(info.total)}` : ''}`
              + (speed > 0 ? ` · ${formatBgsSpeed(speed)}` : '')
              + (left != null ? ` · осталось ~${formatBgsDuration(left)}` : '')
              + (info.failures > 0 ? ` · обрывов: ${info.failures}` : ''),
          });
        },
      });
      checkCancelled();
      lastModified = result.lastModified ?? probe.lastModified;
      writeArchiveMeta(dest, {
        url,
        etag: probe.etag,
        lastModified,
        total: result.bytes,
        completedAt: new Date().toISOString(),
      });
      const took = Date.now() - downloadStarted;
      complete('download', `${formatBgsBytes(result.bytes)} за ${formatBgsDuration(took)}`);
      log('info', `Скачано ${formatBgsBytes(result.bytes)} за ${formatBgsDuration(took)} (${result.segments} соедин.)`);
    }

    /* ── Разбор и запись потоком ── */
    const runId = randomUUID();
    const archiveBytes = fileSize(dest);
    const counter = new BgsDumpCounter();
    let batch: BgsSnapshot[] = [];
    let batches = 0;
    let applied = 0;
    let stale = 0;
    const importStarted = Date.now();
    log('info', `Разбор и запись: пачками по ${formatBgsCount(batchSize)} систем, источник «edsm», метка импорта ${runId}`);
    await begin('import', { total: archiveBytes, done: 0, detail: 'распаковка' });

    // Пачка, не уложившаяся в statement_timeout PostgREST, делится пополам.
    const writeRows = async (rows: Record<string, unknown>[]): Promise<{ applied: number; stale: number }> => {
      const { data, error } = await svc.rpc('bgs_apply_snapshots', { p_rows: rows, p_source: 'edsm', p_run: runId, p_recount: false });
      if (error) {
        if (rows.length > 1 && isStatementTimeout(error)) {
          log('warn', `Пачка из ${rows.length} систем не уложилась в statement_timeout базы — делю пополам`);
          const middle = Math.ceil(rows.length / 2);
          const left = await writeRows(rows.slice(0, middle));
          const right = await writeRows(rows.slice(middle));
          return { applied: left.applied + right.applied, stale: left.stale + right.stale };
        }
        throw new Error(`Запись фракций в базу (пачка ${batches + 1}): ${error.message}`);
      }
      const result = (typeof data === 'string' ? JSON.parse(data) : data ?? {}) as Record<string, unknown>;
      return { applied: count(result.applied), stale: count(result.stale) };
    };

    const flush = async () => {
      if (batch.length === 0) return;
      const rows = batch.map(snapshotToRpcRow);
      batch = [];
      const result = await writeRows(rows);
      batches += 1;
      written += rows.length;
      applied += result.applied;
      stale += result.stale;
      if (batches === 1 || batches % 20 === 0) {
        log('info', `Пачка ${batches}: записано ${formatBgsCount(written)} систем (свежее у пилотов — ${formatBgsCount(stale)})`);
      }
    };

    await forEachGzipLine(
      dest,
      run.controller.signal,
      (line) => {
        if (run.cancelled) throw new Error(BGS_CANCEL_MESSAGE);
        const parsed = parseEdsmPopulatedLine(line);
        counter.add(parsed);
        if (parsed.kind !== 'system') return;
        batch.push(parsed.snapshot);
        if (batch.length >= batchSize) return flush();
        return undefined;
      },
      (bytesRead) => advance('import', {
        done: Math.min(bytesRead, archiveBytes),
        detail: `${formatBgsBytes(Math.min(bytesRead, archiveBytes))} из ${formatBgsBytes(archiveBytes)} · систем ${formatBgsCount(counter.stats.systems)}`
          + ` · фракций ${formatBgsCount(counter.stats.factions)} · пачек ${formatBgsCount(batches)}`,
      }),
    );
    checkCancelled();
    await flush();
    const stats = counter.stats;
    complete('import', `${formatBgsCount(stats.systems)} систем · ${formatBgsCount(stats.factions)} фракций за ${formatBgsDuration(Date.now() - importStarted)}`);
    for (const line of describeStats(stats)) log('info', line);
    log('info', `Записано ${formatBgsCount(written)} систем пачками (${formatBgsCount(batches)} шт.), из них ${formatBgsCount(stale)} не тронуты — у пилотов наблюдение свежее`);

    if (stats.systems < minSystems) {
      throw new Error(`В дампе всего ${stats.systems} населённых систем (записей ${stats.records}) — похоже на сбой источника; пропавшие системы не удалялись`);
    }
    if (!options.force && previous.systems_total >= minSystems && stats.systems < previous.systems_total * BGS_SHRINK_GUARD) {
      throw new Error(`Дамп подозрительно мал: ${stats.systems} систем против ${previous.systems_total} в базе — пропавшие системы не удалялись (принудительный запуск примет дамп)`);
    }

    /* ── Завершение ── */
    // Короткими вызовами: PostgREST даёт запросу лишь несколько секунд.
    await begin('finish', { total: 4, done: 0, detail: 'удаляю системы, пропавшие из дампа' });
    const deletedSystems = await deleteInSteps(
      (limit) => svc.rpc('bgs_delete_missing', { p_run: runId, p_keep_days: BGS_KEEP_DAYS, p_limit: limit }),
      'Удаление пропавших систем',
      DELETE_STEP,
    );
    await advance('finish', { done: 1, detail: `удалено систем: ${formatBgsCount(deletedSystems)} · пересчитываю фракции` });
    const recounted = await recountAllFactions(svc, (done) => advance('finish', {
      done: 1 + Math.min(0.95, done / Math.max(1, stats.factions)),
      detail: `пересчёт фракций: ${formatBgsCount(done)}`,
    }));
    await advance('finish', { done: 2, detail: 'удаляю фракции без систем' });
    const deletedFactions = await deleteInSteps(
      (limit) => svc.rpc('bgs_prune_factions', { p_limit: limit }),
      'Удаление фракций без систем',
      PRUNE_STEP,
    );
    await advance('finish', { done: 3, detail: 'записываю состояние' });
    const dumpGeneratedAt = headerDate(lastModified);
    const { data: finished, error: finishError } = await svc.rpc('bgs_finish_sync', {
      p_run: runId,
      p_state: {
        source_url: url,
        etag: probe.etag,
        last_modified: lastModified,
        dump_generated_at: dumpGeneratedAt,
        dump_bytes: archiveBytes,
        stats: { ...stats, applied, stale, batches, deleted_systems: deletedSystems, deleted_factions: deletedFactions },
      },
    });
    if (finishError) throw new Error(`Завершение импорта фракций: ${finishError.message}`);
    shared.edrcBgsLayerGeneration = bgsLayerGeneration() + 1;
    const summary = (typeof finished === 'string' ? JSON.parse(finished) : finished ?? {}) as Record<string, unknown>;
    const systems = count(summary.systems);
    const factions = count(summary.factions);
    const presence = count(summary.presence);
    log('info', `Удалено систем, пропавших из дампа: ${formatBgsCount(deletedSystems)}, фракций без систем: ${formatBgsCount(deletedFactions)} · пересчитано фракций: ${formatBgsCount(recounted)}`);
    if (!keepArchive) {
      const freed = removeArchive(dest);
      log('info', `Архив удалён с диска — освобождено ${formatBgsBytes(freed)} (FACTIONS_ARCHIVE_KEEP=1 оставляет его)`);
    }
    complete('finish', `в базе ${formatBgsCount(systems)} систем · ${formatBgsCount(factions)} фракций`);
    const durationMs = Date.now() - started;
    log('info', `Готово за ${formatBgsDuration(durationMs)}: на карте ${formatBgsCount(systems)} систем, ${formatBgsCount(factions)} фракций, ${formatBgsCount(presence)} присутствий`);
    finishBgsProgress(run.progress, 'ok', {
      message: `Загружено ${formatBgsCount(systems)} систем и ${formatBgsCount(factions)} фракций`,
      result: { systems, factions, presence, applied, stale, deletedSystems, durationMs },
    });
    return { status: 'ok', systems, factions, presence, applied, stale, deletedSystems, stats, dumpGeneratedAt, durationMs };
  } catch (error) {
    const cancelled = run.cancelled;
    const message = cancelled ? BGS_CANCEL_MESSAGE : shortError(error);
    const durationMs = Date.now() - started;
    if (cancelled) {
      log('warn', run.progress.stage === 'download'
        ? `${BGS_CANCEL_MESSAGE}: скачанная часть осталась на диске — следующий запуск докачает дамп`
        : run.progress.stage === 'import' || run.progress.stage === 'finish'
          ? `${BGS_CANCEL_MESSAGE}: часть систем уже обновлена, пропавшие из дампа не удалялись — следующий импорт доведёт базу до конца`
          : `${BGS_CANCEL_MESSAGE}: база не тронута`);
    } else {
      log('error', `Ошибка: ${message}`);
      if (run.progress.stage === 'import' && isArchiveCorruption(error)) {
        removeArchive(dest);
        log('warn', 'Архив повреждён — удалён с диска, следующий запуск скачает дамп заново');
      }
    }
    if (written > 0) {
      // Новые фракции из записанных пачек должны находиться поиском и без finish.
      try {
        await recountAllFactions(svc);
      } catch {
        // счётчики пересчитает следующий импорт
      }
      shared.edrcBgsLayerGeneration = bgsLayerGeneration() + 1;
    }
    finishBgsProgress(run.progress, cancelled ? 'cancelled' : 'error', {
      message: cancelled ? BGS_CANCEL_MESSAGE : message,
      result: { error: message, durationMs },
    });
    try {
      await writeState(svc, { status: 'error', error: message });
    } catch {
      // Состояние не записалось — ошибка всё равно уйдёт в ответ и в журнал.
    }
    return { status: cancelled ? 'cancelled' : 'error', error: message, durationMs };
  } finally {
    await persistRun(svc, run, true);
    shared.edrcBgsLastRun = snapshot(run);
    if (shared.edrcBgsLive === run) shared.edrcBgsLive = null;
  }
}

/** Удалить скачанный архив (и план докачки). Во время импорта — нельзя. */
export function cleanupBgsArchive(path = bgsArchivePath()): { removed: boolean; freed: number; reason?: string } {
  if (isBgsSyncRunning()) return { removed: false, freed: 0, reason: 'Идёт импорт — архив нужен ему' };
  const exists = existsSync(path) || existsSync(segmentStatePath(path));
  const freed = removeArchive(path);
  return { removed: exists, freed };
}

/* ── Сводка для админки ────────────────────────────────────────────────── */

export interface BgsTableSummary {
  systems: number;
  factions: number;
  playerFactions: number;
  presence: number;
  allegiances: Record<string, number>;
  sources: Record<string, number>;
  oldestObservation: string | null;
  newestObservation: string | null;
  fresh7d: number;
  updates24h: number;
  applied24h: number;
  updates7d: number;
  applied7d: number;
  reporters7d: number;
  lastUpdate: string | null;
}

function isoOrNull(value: unknown): string | null {
  if (value == null) return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function countMap(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!value || typeof value !== 'object') return out;
  for (const [key, n] of Object.entries(value as Record<string, unknown>)) out[key] = count(n);
  return out;
}

export async function readBgsSummary(svc: Svc): Promise<BgsTableSummary> {
  const { data, error } = await svc.rpc('bgs_admin_summary');
  if (error) throw new Error(error.message);
  const raw = (typeof data === 'string' ? JSON.parse(data) : data ?? {}) as Record<string, unknown>;
  return {
    systems: count(raw.systems),
    factions: count(raw.factions),
    playerFactions: count(raw.player_factions),
    presence: count(raw.presence),
    allegiances: countMap(raw.allegiances),
    sources: countMap(raw.sources),
    oldestObservation: isoOrNull(raw.oldest_observation),
    newestObservation: isoOrNull(raw.newest_observation),
    fresh7d: count(raw.fresh_7d),
    updates24h: count(raw.updates_24h),
    applied24h: count(raw.applied_24h),
    updates7d: count(raw.updates_7d),
    applied7d: count(raw.applied_7d),
    reporters7d: count(raw.reporters_7d),
    lastUpdate: isoOrNull(raw.last_update),
  };
}

/** Ближайший запуск задачи `factions-sync` по расписанию планировщика (UTC). */
export function nextBgsScheduledRun(nowMs = Date.now()): string {
  const { periodMs, offsetMs } = BGS_SCHEDULE;
  const next = Math.floor((nowMs - offsetMs) / periodMs + 1) * periodMs + offsetMs;
  return new Date(next).toISOString();
}

function age(value: string | null, nowMs: number): number {
  const ms = value ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? nowMs - ms : Infinity;
}

/** Импорт оборвался вместе с процессом сайта (состояние «running», а живого прогона нет). */
export function bgsSyncInterrupted(state: BgsSyncState, nowMs = Date.now()): boolean {
  return !isBgsSyncRunning() && state.status === 'running' && age(state.attempt_at, nowMs) < 7 * 24 * 3600_000;
}

export type BgsScheduleDecision =
  | { action: 'start'; reason: 'stale' | 'interrupted' | 'forced' }
  | { action: 'skip'; reason: 'running' | 'not_initialized' | 'fresh' | 'running_elsewhere' };

/**
 * Что делать задаче `factions-sync`. Первый импорт (≈0,5 ГБ) — решение
 * администратора: задача только поддерживает данные свежими после него и
 * докачивает импорт, оборванный перезапуском сайта.
 */
export function decideBgsScheduledSync(
  state: BgsSyncState,
  options: { nowMs?: number; refreshDays?: number; force?: boolean } = {},
): BgsScheduleDecision {
  const nowMs = options.nowMs ?? Date.now();
  if (isBgsSyncRunning()) return { action: 'skip', reason: 'running' };
  if (options.force) return { action: 'start', reason: 'forced' };
  if (state.status === 'running') {
    // Свежее «running» без живого прогона в этом процессе — возможно, идёт в другом.
    return age(state.attempt_at, nowMs) < RUNNING_STALE_MS && age(state.progress?.updatedAt ?? null, nowMs) < 10 * 60_000
      ? { action: 'skip', reason: 'running_elsewhere' }
      : { action: 'start', reason: 'interrupted' };
  }
  if (!state.synced_at) return { action: 'skip', reason: 'not_initialized' };
  const refreshMs = (options.refreshDays ?? bgsRefreshDays()) * 24 * 3600_000;
  return age(state.synced_at, nowMs) >= refreshMs ? { action: 'start', reason: 'stale' } : { action: 'skip', reason: 'fresh' };
}
