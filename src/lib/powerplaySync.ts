/**
 * Импорт систем PowerPlay из ночного дампа EDSM в `powerplay_systems`.
 *
 * Запускают его:
 *   * задача `powerplay-sync` планировщика (`/api/cron/powerplay-sync`, раз в
 *     12 часов — дамп выходит раз в сутки, лишний запрос получает 304);
 *   * `GET /api/powerplay/systems`, если таблица пуста или данные старше
 *     суток (`ensurePowerplayFresh`) — слой работает, даже когда задачу не
 *     добавили в JOBS_ENABLED. Обновление идёт фоном, ответ его не ждёт;
 *   * администратор: Админка → Игровые данные → PowerPlay
 *     (`/api/admin/powerplay`, `startPowerplaySync`).
 *
 * Порядок: условный запрос (ETag / If-Modified-Since) → распаковка gzip с
 * ограничением размера → разбор (`powerplayDump.ts`) → проверки здравого
 * смысла → запись пачками по 2000 строк с меткой импорта → удаление всего,
 * чего в новом дампе нет, одной транзакцией вместе с записью состояния.
 *
 * Каждый шаг отмечается в ходе импорта (`powerplayProgress.ts`): этапы с
 * процентами и журнал процесса. Живой прогон виден из памяти процесса, а
 * копия хода и журнала пишется в `powerplay_sync_state` — после перезапуска
 * сайта админка всё равно покажет, чем закончилась последняя загрузка.
 *
 * Битый или подозрительно маленький дамп таблицу не трогает: карта остаётся
 * со вчерашними данными, а ошибка видна в состоянии и в ответе задачи.
 */

import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import { POWERPLAY_STATE_PLURAL, formatPowerplayDate } from './powerplay.ts';
import { parseEdsmPowerplayDump, type PowerplayDumpRow, type PowerplayDumpStats } from './powerplayDump.ts';
import {
  POWERPLAY_TRIGGER_LABEL,
  createPowerplayProgress,
  finishPowerplayProgress,
  finishPowerplayStage,
  formatPowerplayBytes,
  formatPowerplayCount,
  formatPowerplayDuration,
  pushPowerplayLog,
  sanitizePowerplayLog,
  sanitizePowerplayProgress,
  startPowerplayStage,
  updatePowerplayStage,
  type PowerplayLogLevel,
  type PowerplayLogLine,
  type PowerplayStageId,
  type PowerplaySyncProgress,
  type PowerplaySyncTrigger,
} from './powerplayProgress.ts';

type Svc = any;

export const DEFAULT_POWERPLAY_DUMP_URL = 'https://www.edsm.net/dump/powerPlay.json.gz';
const USER_AGENT = 'ED-Ring-Colony/2 (+https://edringcolony.ru; powerplay layer)';

/** Сжатый дамп сейчас ≈3,6 МБ, распакованный ≈25 МБ: пределы с большим запасом. */
const MAX_COMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_TEXT_BYTES = 512 * 1024 * 1024;
export const POWERPLAY_BATCH_SIZE = 2000;
const DEFAULT_TIMEOUT_MS = 180_000;
/** Копия хода импорта пишется в базу не чаще раза в секунду (и на каждом этапе). */
const PERSIST_EVERY_MS = 1000;

/** Меньше этого систем под контролем в настоящем дампе не бывает (их десятки тысяч). */
export const POWERPLAY_MIN_ROWS = 100;
/** Новый дамп меньше половины прошлого — скорее сбой источника, чем итог недели. */
export const POWERPLAY_SHRINK_GUARD = 0.5;

/** Данные свежие, если источник проверяли меньше суток с запасом назад. */
export const POWERPLAY_STALE_AFTER_MS = 26 * 60 * 60 * 1000;
/** Повторная попытка после неудачи — не чаще раза в полчаса. */
export const POWERPLAY_RETRY_AFTER_MS = 30 * 60 * 1000;
/** «running» старше этого — упавший процесс, а не идущий импорт. */
const RUNNING_STALE_MS = 30 * 60 * 1000;

/**
 * Расписание задачи `powerplay-sync` (копия из scripts/job-schedule.mjs — тест
 * следит, чтобы они не разошлись): каждые 12 часов со сдвигом 5:20 UTC.
 */
export const POWERPLAY_SCHEDULE = { periodMs: 12 * 60 * 60 * 1000, offsetMs: (5 * 60 + 20) * 60 * 1000 } as const;

export const POWERPLAY_CANCEL_MESSAGE = 'Импорт остановлен администратором';

const gunzipAsync = promisify(gunzip);

export interface PowerplaySyncState {
  status: 'idle' | 'running' | 'ok' | 'error';
  source_url: string | null;
  etag: string | null;
  last_modified: string | null;
  dump_generated_at: string | null;
  run_id: string | null;
  rows_total: number;
  stats: Record<string, unknown> | null;
  error: string | null;
  attempt_at: string | null;
  checked_at: string | null;
  synced_at: string | null;
  /** Ход последнего прогона (копия из памяти процесса; нет — миграция не применена). */
  progress: PowerplaySyncProgress | null;
  /** Журнал последних прогонов. */
  log: PowerplayLogLine[];
  /** В строке состояния есть колонки progress/log (миграция 20261018180000 применена). */
  progress_supported: boolean;
}

export interface PowerplaySyncResult {
  status: 'ok' | 'not_modified' | 'error' | 'cancelled';
  error?: string;
  rows?: number;
  deleted?: number;
  total?: number;
  stats?: PowerplayDumpStats;
  dumpGeneratedAt?: string | null;
  durationMs: number;
}

export interface PowerplaySyncOptions {
  fetchImpl?: typeof fetch;
  /** Без условных заголовков и без защиты от «усохшего» дампа (ручной запуск). */
  force?: boolean;
  url?: string;
  timeoutMs?: number;
  minRows?: number;
  /** Кто запустил: попадает в журнал и в ход импорта. */
  trigger?: PowerplaySyncTrigger;
}

const EMPTY_STATE: PowerplaySyncState = {
  status: 'idle',
  source_url: null,
  etag: null,
  last_modified: null,
  dump_generated_at: null,
  run_id: null,
  rows_total: 0,
  stats: null,
  error: null,
  attempt_at: null,
  checked_at: null,
  synced_at: null,
  progress: null,
  log: [],
  progress_supported: false,
};

export function powerplayDumpUrl(env: Record<string, string | undefined> = process.env): string {
  const raw = env.POWERPLAY_DUMP_URL?.trim();
  if (!raw) return DEFAULT_POWERPLAY_DUMP_URL;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : DEFAULT_POWERPLAY_DUMP_URL;
  } catch {
    return DEFAULT_POWERPLAY_DUMP_URL;
  }
}

export async function readPowerplaySyncState(svc: Svc): Promise<PowerplaySyncState> {
  const { data, error } = await svc.from('powerplay_sync_state').select('*').eq('id', 1).maybeSingle();
  if (error) throw new Error(error.message);
  return {
    ...EMPTY_STATE,
    ...(data ?? {}),
    rows_total: Number(data?.rows_total ?? 0) || 0,
    progress: sanitizePowerplayProgress(data?.progress),
    log: sanitizePowerplayLog(data?.log),
    progress_supported: Boolean(data) && Object.prototype.hasOwnProperty.call(data, 'log'),
  };
}

async function writeState(svc: Svc, patch: Partial<PowerplaySyncState>): Promise<void> {
  const { error } = await svc
    .from('powerplay_sync_state')
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

/**
 * Тело ответа целиком, но не больше предела (защита от неожиданно огромного
 * файла). `onChunk` получает число принятых байт и, если известен, размер.
 */
async function readLimited(
  response: Response,
  onChunk?: (received: number, total: number | null) => void | Promise<void>,
): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_COMPRESSED_BYTES) {
    throw new Error(`Дамп PowerPlay слишком большой: ${declared} байт`);
  }
  // При Content-Encoding fetch отдаёт уже распакованные байты — размер из
  // заголовка с ними не сравнить, полоса тогда без «из скольких».
  const total = Number.isFinite(declared) && declared > 0 && !response.headers.get('content-encoding') ? declared : null;
  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    await onChunk?.(buffer.length, total);
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_COMPRESSED_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`Дамп PowerPlay слишком большой: больше ${MAX_COMPRESSED_BYTES} байт`);
    }
    chunks.push(value);
    await onChunk?.(received, total);
  }
  return Buffer.concat(chunks);
}

/**
 * Текст дампа. EDSM отдаёт `.json.gz` как файл, но прокси может выставить
 * `Content-Encoding: gzip`, и тогда fetch уже распаковал тело — сверяемся с
 * сигнатурой gzip, а не с именем файла.
 */
export async function decodePowerplayDump(buffer: Buffer): Promise<string> {
  if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
    const text = await gunzipAsync(buffer, { maxOutputLength: MAX_TEXT_BYTES });
    return text.toString('utf8');
  }
  if (buffer.length > MAX_TEXT_BYTES) throw new Error('Дамп PowerPlay слишком большой');
  return buffer.toString('utf8');
}

function toDbRow(row: PowerplayDumpRow) {
  return {
    id64: row.id64,
    name: row.name,
    x: row.x,
    y: row.y,
    z: row.z,
    power: row.power,
    power_state: row.state,
    allegiance: row.allegiance,
    government: row.government,
    observed_at: row.observedAt,
  };
}

/* ── Один импорт за раз на процесс ─────────────────────────────────────────
 * Маршруты Next собираются отдельными бандлами, и у каждого своя копия
 * модуля, поэтому общий «уже идёт» лежит в globalThis (как замки cronAuth). */

interface LiveRun {
  progress: PowerplaySyncProgress;
  log: PowerplayLogLine[];
  controller: AbortController;
  cancelled: boolean;
  persistedAt: number;
}

export interface PowerplayRunSnapshot {
  progress: PowerplaySyncProgress;
  log: PowerplayLogLine[];
}

type SyncGlobal = typeof globalThis & {
  edrcPowerplaySync?: Promise<PowerplaySyncResult> | null;
  edrcPowerplayLayerVersion?: number;
  /** Счётчик применённых наблюдений пилотов (журналы через Helper, сайт, CAPI). */
  edrcPowerplayJournalVersion?: number;
  edrcPowerplayLive?: LiveRun | null;
  edrcPowerplayLastRun?: PowerplayRunSnapshot | null;
  /** В `powerplay_sync_state` нет колонок progress/log (миграция не применена). */
  edrcPowerplayNoProgressColumns?: boolean;
};
const shared = globalThis as SyncGlobal;

export function isPowerplaySyncRunning(): boolean {
  return Boolean(shared.edrcPowerplaySync);
}

/** Счётчик завершённых импортов: кэш слоя сбрасывается, когда он меняется. */
export function powerplayLayerGeneration(): number {
  return shared.edrcPowerplayLayerVersion ?? 0;
}

/**
 * Счётчик обновлений слоя из журналов пилотов: слой пересобирается не сразу,
 * а не чаще раза в минуту (`powerplayStore.ts`), — прыжки пилотов идут часто.
 */
export function powerplayJournalGeneration(): number {
  return shared.edrcPowerplayJournalVersion ?? 0;
}

export function bumpPowerplayJournalGeneration(): void {
  shared.edrcPowerplayJournalVersion = powerplayJournalGeneration() + 1;
}

function snapshot(run: { progress: PowerplaySyncProgress; log: PowerplayLogLine[] }): PowerplayRunSnapshot {
  // structuredClone не нужен: только JSON-данные.
  return JSON.parse(JSON.stringify({ progress: run.progress, log: run.log })) as PowerplayRunSnapshot;
}

/** Идущий сейчас импорт (копия): ход этапов и журнал. */
export function getPowerplayLiveRun(): PowerplayRunSnapshot | null {
  return shared.edrcPowerplayLive ? snapshot(shared.edrcPowerplayLive) : null;
}

/** Последний завершённый в этом процессе импорт (копия). */
export function getPowerplayLastRun(): PowerplayRunSnapshot | null {
  return shared.edrcPowerplayLastRun ? snapshot(shared.edrcPowerplayLastRun) : null;
}

/** Для тестов: забыть историю прогонов и признак «нет колонок хода импорта». */
export function resetPowerplaySyncRuntime(): void {
  shared.edrcPowerplayLastRun = null;
  shared.edrcPowerplayNoProgressColumns = false;
  if (!shared.edrcPowerplaySync) shared.edrcPowerplayLive = null;
}

/** Остановить идущий импорт. Возвращает false, если останавливать нечего. */
export function cancelPowerplaySync(reason = POWERPLAY_CANCEL_MESSAGE): boolean {
  const run = shared.edrcPowerplayLive;
  if (!run || run.cancelled) return false;
  run.cancelled = true;
  pushPowerplayLog(run.log, 'warn', `${reason} — обрываю текущий шаг`);
  run.controller.abort(new Error(reason));
  return true;
}

export function runPowerplaySync(svc: Svc, options: PowerplaySyncOptions = {}): Promise<PowerplaySyncResult> {
  if (shared.edrcPowerplaySync) return shared.edrcPowerplaySync;
  const job = syncOnce(svc, options).finally(() => {
    shared.edrcPowerplaySync = null;
  });
  shared.edrcPowerplaySync = job;
  return job;
}

/**
 * Запуск из админки: импорт идёт фоном, ответ возвращается сразу. Если импорт
 * уже идёт (задача, ленивое обновление или прошлый клик), второй не начинается.
 */
export function startPowerplaySync(svc: Svc, options: PowerplaySyncOptions = {}): { started: boolean; reason?: string } {
  if (isPowerplaySyncRunning()) return { started: false, reason: 'Импорт уже идёт — его ход виден ниже' };
  void runPowerplaySync(svc, { ...options, trigger: options.trigger ?? 'admin' }).catch(() => undefined);
  return { started: true };
}

/** Копия хода и журнала — в базу; сбой этой записи импорт не роняет. */
async function persistRun(svc: Svc, run: LiveRun, force = false): Promise<void> {
  if (shared.edrcPowerplayNoProgressColumns) return;
  const now = Date.now();
  if (!force && now - run.persistedAt < PERSIST_EVERY_MS) return;
  run.persistedAt = now;
  try {
    const { error } = await svc
      .from('powerplay_sync_state')
      .update({ progress: run.progress, log: run.log, updated_at: new Date(now).toISOString() })
      .eq('id', 1);
    if (error) throw new Error(error.message);
  } catch (error) {
    const message = shortError(error);
    if (/progress|"log"|\blog\b|column|schema cache/i.test(message)) {
      shared.edrcPowerplayNoProgressColumns = true;
      pushPowerplayLog(
        run.log,
        'warn',
        'Ход импорта и журнал не сохраняются в базе: примените миграцию 20261018180000_powerplay_sync_progress.sql — до неё они видны только до перезапуска сайта',
      );
    }
  }
}

function describeStats(stats: PowerplayDumpStats): string[] {
  const lines = [
    `Разобрано записей: ${formatPowerplayCount(stats.records)} · под контролем держав: ${formatPowerplayCount(stats.kept)}`
      + ` (${POWERPLAY_STATE_PLURAL.Stronghold.toLowerCase()} ${formatPowerplayCount(stats.states.Stronghold)},`
      + ` ${POWERPLAY_STATE_PLURAL.Fortified.toLowerCase()} ${formatPowerplayCount(stats.states.Fortified)},`
      + ` ${POWERPLAY_STATE_PLURAL.Exploited.toLowerCase()} ${formatPowerplayCount(stats.states.Exploited)})`,
    `Отброшено: Unoccupied (никем не контролируются) ${formatPowerplayCount(stats.skipped.unoccupied)},`
      + ` неизвестное состояние ${formatPowerplayCount(stats.skipped.unknown_state)},`
      + ` битых записей ${formatPowerplayCount(stats.skipped.invalid)},`
      + ` повторов ${formatPowerplayCount(stats.skipped.duplicate)}`,
  ];
  const powers = Object.entries(stats.powers).sort((a, b) => b[1] - a[1]);
  if (powers.length) {
    lines.push(`Державы в дампе: ${powers.length} — ${powers.map(([power, count]) => `${power} ${formatPowerplayCount(count)}`).join(', ')}`);
  }
  if (stats.oldestObservation && stats.newestObservation) {
    lines.push(`Наблюдения пилотов: ${formatPowerplayDate(stats.oldestObservation)} – ${formatPowerplayDate(stats.newestObservation)} (EDSM хранит ~30 дней)`);
  }
  return lines;
}

async function syncOnce(svc: Svc, options: PowerplaySyncOptions): Promise<PowerplaySyncResult> {
  const started = Date.now();
  const url = options.url ?? powerplayDumpUrl();
  const fetchImpl = options.fetchImpl ?? fetch;
  const minRows = options.minRows ?? POWERPLAY_MIN_ROWS;
  const trigger = options.trigger ?? 'manual';
  let previous = EMPTY_STATE;

  // Ход импорта виден сразу: админка, нажавшая «Загрузить», читает его
  // следующим же запросом, ещё до первого ответа EDSM.
  const run: LiveRun = {
    progress: createPowerplayProgress({ id: randomUUID(), trigger, force: options.force === true, now: started }),
    log: [],
    controller: new AbortController(),
    cancelled: false,
    persistedAt: 0,
  };
  // Журнал продолжается от прошлых прогонов этого процесса: админ видит историю.
  const history = shared.edrcPowerplayLastRun?.log ?? [];
  run.log.push(...history.slice(-120));
  shared.edrcPowerplayLive = run;

  const log = (level: PowerplayLogLevel, text: string) => {
    pushPowerplayLog(run.log, level, text);
  };
  const begin = async (stage: PowerplayStageId, init: { total?: number | null; detail?: string } = {}) => {
    startPowerplayStage(run.progress, stage, init);
    await persistRun(svc, run, true);
  };
  const advance = async (stage: PowerplayStageId, patch: { done?: number; total?: number | null; detail?: string }) => {
    updatePowerplayStage(run.progress, stage, patch);
    await persistRun(svc, run);
  };
  const complete = (stage: PowerplayStageId, detail?: string) => {
    finishPowerplayStage(run.progress, stage, { detail });
  };
  const checkCancelled = () => {
    if (run.cancelled) throw new Error(POWERPLAY_CANCEL_MESSAGE);
  };

  log('info', `Запуск импорта: ${POWERPLAY_TRIGGER_LABEL[trigger]}${options.force ? ' · принудительно (без условного запроса и без защиты от «усохшего» дампа)' : ''}`);
  log('info', `Источник: ${url}`);

  try {
    // Состояние читаем до первой записи хода: иначе журнал этого же прогона
    // вернулся бы из базы как «история» и задвоился.
    previous = await readPowerplaySyncState(svc);
    // Процесс только что поднялся — история прошлых прогонов есть только в базе.
    if (history.length === 0 && previous.log.length > 0) run.log.unshift(...previous.log.slice(-120));
    await begin('request', { detail: 'соединение с EDSM' });
    await writeState(svc, { status: 'running', attempt_at: new Date().toISOString(), source_url: url });

    const headers: Record<string, string> = { 'User-Agent': USER_AGENT, Accept: 'application/gzip, application/json;q=0.9, */*;q=0.5' };
    // Условный запрос — только если прошлые данные на месте: иначе 304 оставил бы пустую карту.
    const haveData = previous.rows_total > 0 && previous.source_url === url;
    if (!options.force && haveData) {
      if (previous.etag) headers['If-None-Match'] = previous.etag;
      if (previous.last_modified) headers['If-Modified-Since'] = previous.last_modified;
    }
    if (headers['If-None-Match'] || headers['If-Modified-Since']) {
      log('info', `Условный запрос: в таблице ${formatPowerplayCount(previous.rows_total)} систем; если дамп не менялся, EDSM ответит 304`);
    } else if (!options.force) {
      log('info', previous.rows_total > 0 ? 'Безусловный запрос: источник сменился или нет заголовков прошлой загрузки' : 'Безусловный запрос: в таблице пока нет систем');
    }

    const signal = AbortSignal.any([AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS), run.controller.signal]);
    const requestStarted = Date.now();
    const response = await fetchImpl(url, { headers, redirect: 'follow', signal });
    checkCancelled();
    const declared = Number(response.headers.get('content-length'));
    log(
      response.ok || response.status === 304 ? 'info' : 'error',
      `Ответ EDSM: HTTP ${response.status} за ${formatPowerplayDuration(Date.now() - requestStarted)}`
        + (Number.isFinite(declared) && declared > 0 ? ` · ${formatPowerplayBytes(declared)}` : '')
        + (response.headers.get('last-modified') ? ` · дамп от ${response.headers.get('last-modified')}` : ''),
    );

    if (response.status === 304) {
      complete('request', 'HTTP 304 — дамп не менялся');
      await writeState(svc, { status: 'ok', checked_at: new Date().toISOString(), error: null });
      const durationMs = Date.now() - started;
      log('info', `Дамп не менялся с прошлой загрузки — данные актуальны (${formatPowerplayCount(previous.rows_total)} систем). Готово за ${formatPowerplayDuration(durationMs)}`);
      finishPowerplayProgress(run.progress, 'not_modified', {
        message: 'Дамп не менялся — данные актуальны',
        result: { total: previous.rows_total, durationMs },
      });
      return { status: 'not_modified', total: previous.rows_total, durationMs };
    }
    if (!response.ok) throw new Error(`EDSM ответил HTTP ${response.status}`);
    complete('request', `HTTP ${response.status}`);

    await begin('download', { total: Number.isFinite(declared) && declared > 0 ? declared : null, detail: 'начало' });
    const downloadStarted = Date.now();
    const buffer = await readLimited(response, (received, total) => advance('download', {
      done: received,
      total,
      detail: total ? `${formatPowerplayBytes(received)} из ${formatPowerplayBytes(total)}` : formatPowerplayBytes(received),
    }));
    checkCancelled();
    complete('download', formatPowerplayBytes(buffer.length));
    log('info', `Скачано ${formatPowerplayBytes(buffer.length)} за ${formatPowerplayDuration(Date.now() - downloadStarted)}`);

    await begin('decode', { detail: buffer[0] === 0x1f && buffer[1] === 0x8b ? 'gzip' : 'уже распакован' });
    const text = await decodePowerplayDump(buffer);
    checkCancelled();
    const textBytes = Buffer.byteLength(text);
    complete('decode', formatPowerplayBytes(textBytes));
    log('info', buffer[0] === 0x1f && buffer[1] === 0x8b
      ? `Распаковано: ${formatPowerplayBytes(textBytes)} JSON`
      : `Тело уже распаковано по пути (Content-Encoding): ${formatPowerplayBytes(textBytes)} JSON`);

    await begin('parse', { detail: 'разбираю строки дампа' });
    const { rows, stats } = parseEdsmPowerplayDump(text);
    updatePowerplayStage(run.progress, 'parse', { done: stats.records, total: stats.records });
    complete('parse', `${formatPowerplayCount(stats.records)} записей → ${formatPowerplayCount(rows.length)} систем`);
    for (const line of describeStats(stats)) log('info', line);
    checkCancelled();

    if (rows.length < minRows) {
      throw new Error(`В дампе всего ${rows.length} систем под контролем (записей ${stats.records}) — похоже на сбой источника, данные не тронуты`);
    }
    if (!options.force && previous.rows_total >= minRows * 10 && rows.length < previous.rows_total * POWERPLAY_SHRINK_GUARD) {
      throw new Error(`Дамп подозрительно мал: ${rows.length} систем против ${previous.rows_total} в прошлый раз — данные не тронуты (ручной запуск с force=1 примет его)`);
    }

    const runId = randomUUID();
    const batches = Math.ceil(rows.length / POWERPLAY_BATCH_SIZE);
    log('info', `Запись в базу: ${formatPowerplayCount(rows.length)} систем, пачками по ${formatPowerplayCount(POWERPLAY_BATCH_SIZE)} (${batches} шт.)`);
    await begin('write', { total: rows.length, detail: `пачка 0 из ${batches}` });
    let written = 0;
    for (let offset = 0, batch = 1; offset < rows.length; offset += POWERPLAY_BATCH_SIZE, batch += 1) {
      checkCancelled();
      const slice = rows.slice(offset, offset + POWERPLAY_BATCH_SIZE).map(toDbRow);
      const { data, error } = await svc.rpc('powerplay_apply_batch', { p_run: runId, p_rows: slice });
      if (error) throw new Error(`Запись систем PowerPlay (пачка ${batch} из ${batches}): ${error.message}`);
      written += Number(data) || 0;
      const done = Math.min(rows.length, offset + slice.length);
      log('info', `Пачка ${batch}/${batches}: записано ${formatPowerplayCount(done)} из ${formatPowerplayCount(rows.length)}`);
      await advance('write', { done, detail: `пачка ${batch} из ${batches} · ${formatPowerplayCount(done)} из ${formatPowerplayCount(rows.length)}` });
    }
    complete('write', `${formatPowerplayCount(written)} строк`);
    checkCancelled();

    await begin('finish', { detail: 'удаляю системы, пропавшие из дампа' });
    const dumpGeneratedAt = headerDate(response.headers.get('last-modified'));
    const { data: finished, error: finishError } = await svc.rpc('powerplay_finish_sync', {
      p_run: runId,
      p_state: {
        source_url: url,
        etag: response.headers.get('etag'),
        last_modified: response.headers.get('last-modified'),
        dump_generated_at: dumpGeneratedAt,
        stats,
      },
    });
    if (finishError) throw new Error(`Завершение импорта PowerPlay: ${finishError.message}`);

    shared.edrcPowerplayLayerVersion = powerplayLayerGeneration() + 1;
    const summary = (finished ?? {}) as { deleted?: number; total?: number };
    const deleted = Number(summary.deleted ?? 0);
    const total = Number(summary.total ?? rows.length);
    complete('finish', `удалено ${formatPowerplayCount(deleted)} · всего ${formatPowerplayCount(total)}`);
    log('info', `Удалено систем, пропавших из дампа: ${formatPowerplayCount(deleted)} · всего в таблице: ${formatPowerplayCount(total)}`);
    const durationMs = Date.now() - started;
    log('info', `Готово за ${formatPowerplayDuration(durationMs)}: на карте ${formatPowerplayCount(total)} систем держав`);
    finishPowerplayProgress(run.progress, 'ok', {
      message: `Загружено ${formatPowerplayCount(total)} систем`,
      result: { rows: written, deleted, total, durationMs },
    });
    return {
      status: 'ok',
      rows: written,
      deleted,
      total,
      stats,
      dumpGeneratedAt,
      durationMs,
    };
  } catch (error) {
    const cancelled = run.cancelled;
    const message = cancelled ? POWERPLAY_CANCEL_MESSAGE : shortError(error);
    const durationMs = Date.now() - started;
    if (cancelled) {
      log('warn', run.progress.stage === 'write' || run.progress.stage === 'finish'
        ? `${POWERPLAY_CANCEL_MESSAGE}: часть систем уже обновлена, пропавшие из дампа не удалялись — следующая загрузка доведёт таблицу до конца`
        : `${POWERPLAY_CANCEL_MESSAGE}: таблица не тронута`);
    } else {
      log('error', `Ошибка: ${message}`);
    }
    finishPowerplayProgress(run.progress, cancelled ? 'cancelled' : 'error', {
      message: cancelled ? POWERPLAY_CANCEL_MESSAGE : message,
      result: { error: message, durationMs },
    });
    try {
      await writeState(svc, { status: 'error', error: message });
    } catch {
      // Состояние не записалось — ошибка всё равно уйдёт в ответ и в лог.
    }
    return { status: cancelled ? 'cancelled' : 'error', error: message, durationMs };
  } finally {
    await persistRun(svc, run, true);
    shared.edrcPowerplayLastRun = snapshot(run);
    if (shared.edrcPowerplayLive === run) shared.edrcPowerplayLive = null;
  }
}

/* ── Сводка для админки ────────────────────────────────────────────────── */

export interface PowerplayPowerSummary {
  power: string;
  Stronghold: number;
  Fortified: number;
  Exploited: number;
  total: number;
}

export interface PowerplayTableSummary {
  total: number;
  powers: PowerplayPowerSummary[];
  /** Системы под контролем по источнику: edsm (дамп), helper, web (журнал/CAPI через сайт), eddn. */
  sources: Record<string, number>;
  /** Системы, которые пилоты увидели свободными после дампа (слой их не показывает). */
  vacated: number;
  oldestObservation: string | null;
  newestObservation: string | null;
  lastChange: string | null;
}

function count(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

function isoOrNull(value: unknown): string | null {
  if (value == null) return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Что сейчас в таблице: по державам и состояниям (RPC `powerplay_admin_summary`). */
export async function readPowerplaySummary(svc: Svc): Promise<PowerplayTableSummary> {
  const { data, error } = await svc.rpc('powerplay_admin_summary');
  if (error) throw new Error(error.message);
  const raw = (typeof data === 'string' ? JSON.parse(data) : data ?? {}) as Record<string, unknown>;
  const powers = Array.isArray(raw.powers)
    ? raw.powers
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && typeof (item as { power?: unknown }).power === 'string')
        .map((item) => ({
          power: String(item.power),
          Stronghold: count(item.Stronghold),
          Fortified: count(item.Fortified),
          Exploited: count(item.Exploited),
          total: count(item.total),
        }))
    : [];
  const sources: Record<string, number> = {};
  if (raw.sources && typeof raw.sources === 'object' && !Array.isArray(raw.sources)) {
    for (const [source, value] of Object.entries(raw.sources as Record<string, unknown>)) {
      if (/^[a-z-]{1,24}$/.test(source)) sources[source] = count(value);
    }
  }
  return {
    total: count(raw.total),
    powers,
    sources,
    vacated: count(raw.vacated),
    oldestObservation: isoOrNull(raw.oldest_observation),
    newestObservation: isoOrNull(raw.newest_observation),
    lastChange: isoOrNull(raw.last_change),
  };
}

/** Ближайший запуск задачи `powerplay-sync` по расписанию планировщика (UTC). */
export function nextPowerplayScheduledRun(nowMs = Date.now()): string {
  const { periodMs, offsetMs } = POWERPLAY_SCHEDULE;
  const next = Math.floor((nowMs - offsetMs) / periodMs + 1) * periodMs + offsetMs;
  return new Date(next).toISOString();
}

/* ── Ленивое обновление из API слоя ────────────────────────────────────── */

export interface PowerplayFreshness {
  /** Импорт идёт (только что запущен или уже шёл). */
  refreshing: boolean;
  /** Нужен ли импорт по возрасту данных. */
  stale: boolean;
}

function age(value: string | null, nowMs: number): number {
  const ms = value ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? nowMs - ms : Infinity;
}

export function powerplayNeedsRefresh(state: PowerplaySyncState, nowMs = Date.now()): { stale: boolean; allowed: boolean } {
  const stale = state.rows_total === 0 || age(state.checked_at, nowMs) > POWERPLAY_STALE_AFTER_MS;
  const runningElsewhere = state.status === 'running' && age(state.attempt_at, nowMs) < RUNNING_STALE_MS;
  const allowed = !runningElsewhere && age(state.attempt_at, nowMs) > POWERPLAY_RETRY_AFTER_MS;
  return { stale, allowed };
}

/** Когда ленивое обновление снова попробует источник после неудачи (ISO) или null. */
export function powerplayNextLazyAttempt(state: PowerplaySyncState, nowMs = Date.now()): string | null {
  const { stale, allowed } = powerplayNeedsRefresh(state, nowMs);
  if (!stale) {
    const checked = state.checked_at ? Date.parse(state.checked_at) : NaN;
    return Number.isFinite(checked) ? new Date(checked + POWERPLAY_STALE_AFTER_MS).toISOString() : null;
  }
  if (allowed) return new Date(nowMs).toISOString();
  const attempt = state.attempt_at ? Date.parse(state.attempt_at) : NaN;
  return Number.isFinite(attempt) ? new Date(attempt + POWERPLAY_RETRY_AFTER_MS).toISOString() : null;
}

/**
 * Запустить импорт фоном, если данных нет или они устарели. Не ждёт его и не
 * бросает: слой отдаётся с тем, что есть, а клиент перезапросит позже.
 */
export function ensurePowerplayFresh(
  svc: Svc,
  state: PowerplaySyncState,
  options: PowerplaySyncOptions & { nowMs?: number } = {},
): PowerplayFreshness {
  if (isPowerplaySyncRunning()) return { refreshing: true, stale: true };
  const { stale, allowed } = powerplayNeedsRefresh(state, options.nowMs ?? Date.now());
  if (!stale) return { refreshing: false, stale: false };
  if (!allowed) return { refreshing: state.status === 'running', stale: true };
  void runPowerplaySync(svc, { ...options, trigger: options.trigger ?? 'lazy' }).catch(() => undefined);
  return { refreshing: true, stale: true };
}
