/**
 * Импорт систем PowerPlay из ночного дампа EDSM в `powerplay_systems`.
 *
 * Запускают его:
 *   * задача `powerplay-sync` планировщика (`/api/cron/powerplay-sync`, раз в
 *     12 часов — дамп выходит раз в сутки, лишний запрос получает 304);
 *   * `GET /api/powerplay/systems`, если таблица пуста или данные старше
 *     суток (`ensurePowerplayFresh`) — слой работает, даже когда задачу не
 *     добавили в JOBS_ENABLED. Обновление идёт фоном, ответ его не ждёт.
 *
 * Порядок: условный запрос (ETag / If-Modified-Since) → распаковка gzip с
 * ограничением размера → разбор (`powerplayDump.ts`) → проверки здравого
 * смысла → запись пачками по 2000 строк с меткой импорта → удаление всего,
 * чего в новом дампе нет, одной транзакцией вместе с записью состояния.
 *
 * Битый или подозрительно маленький дамп таблицу не трогает: карта остаётся
 * со вчерашними данными, а ошибка видна в состоянии и в ответе задачи.
 */

import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import { parseEdsmPowerplayDump, type PowerplayDumpRow, type PowerplayDumpStats } from './powerplayDump.ts';

type Svc = any;

export const DEFAULT_POWERPLAY_DUMP_URL = 'https://www.edsm.net/dump/powerPlay.json.gz';
const USER_AGENT = 'ED-Ring-Colony/2 (+https://edringcolony.ru; powerplay layer)';

/** Сжатый дамп сейчас ≈3,6 МБ, распакованный ≈25 МБ: пределы с большим запасом. */
const MAX_COMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_TEXT_BYTES = 512 * 1024 * 1024;
const BATCH_SIZE = 2000;
const DEFAULT_TIMEOUT_MS = 180_000;

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
}

export interface PowerplaySyncResult {
  status: 'ok' | 'not_modified' | 'error';
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
  return { ...EMPTY_STATE, ...(data ?? {}), rows_total: Number(data?.rows_total ?? 0) || 0 };
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

/** Тело ответа целиком, но не больше предела (защита от неожиданно огромного файла). */
async function readLimited(response: Response): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_COMPRESSED_BYTES) {
    throw new Error(`Дамп PowerPlay слишком большой: ${declared} байт`);
  }
  if (!response.body) return Buffer.from(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_COMPRESSED_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`Дамп PowerPlay слишком большой: больше ${MAX_COMPRESSED_BYTES} байт`);
    }
    chunks.push(value);
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

type SyncGlobal = typeof globalThis & {
  edrcPowerplaySync?: Promise<PowerplaySyncResult> | null;
  edrcPowerplayLayerVersion?: number;
};
const shared = globalThis as SyncGlobal;

export function isPowerplaySyncRunning(): boolean {
  return Boolean(shared.edrcPowerplaySync);
}

/** Счётчик завершённых импортов: кэш слоя сбрасывается, когда он меняется. */
export function powerplayLayerGeneration(): number {
  return shared.edrcPowerplayLayerVersion ?? 0;
}

export function runPowerplaySync(svc: Svc, options: PowerplaySyncOptions = {}): Promise<PowerplaySyncResult> {
  if (shared.edrcPowerplaySync) return shared.edrcPowerplaySync;
  const job = syncOnce(svc, options).finally(() => {
    shared.edrcPowerplaySync = null;
  });
  shared.edrcPowerplaySync = job;
  return job;
}

async function syncOnce(svc: Svc, options: PowerplaySyncOptions): Promise<PowerplaySyncResult> {
  const started = Date.now();
  const url = options.url ?? powerplayDumpUrl();
  const fetchImpl = options.fetchImpl ?? fetch;
  const minRows = options.minRows ?? POWERPLAY_MIN_ROWS;
  let previous = EMPTY_STATE;

  try {
    previous = await readPowerplaySyncState(svc);
    await writeState(svc, { status: 'running', attempt_at: new Date().toISOString(), source_url: url });

    const headers: Record<string, string> = { 'User-Agent': USER_AGENT, Accept: 'application/gzip, application/json;q=0.9, */*;q=0.5' };
    // Условный запрос — только если прошлые данные на месте: иначе 304 оставил бы пустую карту.
    const haveData = previous.rows_total > 0 && previous.source_url === url;
    if (!options.force && haveData) {
      if (previous.etag) headers['If-None-Match'] = previous.etag;
      if (previous.last_modified) headers['If-Modified-Since'] = previous.last_modified;
    }

    const response = await fetchImpl(url, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });

    if (response.status === 304) {
      await writeState(svc, { status: 'ok', checked_at: new Date().toISOString(), error: null });
      return { status: 'not_modified', total: previous.rows_total, durationMs: Date.now() - started };
    }
    if (!response.ok) throw new Error(`EDSM ответил HTTP ${response.status}`);

    const text = await decodePowerplayDump(await readLimited(response));
    const { rows, stats } = parseEdsmPowerplayDump(text);

    if (rows.length < minRows) {
      throw new Error(`В дампе всего ${rows.length} систем под контролем (записей ${stats.records}) — похоже на сбой источника, данные не тронуты`);
    }
    if (!options.force && previous.rows_total >= minRows * 10 && rows.length < previous.rows_total * POWERPLAY_SHRINK_GUARD) {
      throw new Error(`Дамп подозрительно мал: ${rows.length} систем против ${previous.rows_total} в прошлый раз — данные не тронуты (ручной запуск с force=1 примет его)`);
    }

    const runId = randomUUID();
    let written = 0;
    for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
      const batch = rows.slice(offset, offset + BATCH_SIZE).map(toDbRow);
      const { data, error } = await svc.rpc('powerplay_apply_batch', { p_run: runId, p_rows: batch });
      if (error) throw new Error(`Запись систем PowerPlay: ${error.message}`);
      written += Number(data) || 0;
    }

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
    return {
      status: 'ok',
      rows: written,
      deleted: Number(summary.deleted ?? 0),
      total: Number(summary.total ?? rows.length),
      stats,
      dumpGeneratedAt,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    const message = shortError(error);
    try {
      await writeState(svc, { status: 'error', error: message });
    } catch {
      // Состояние не записалось — ошибка всё равно уйдёт в ответ и в лог.
    }
    return { status: 'error', error: message, durationMs: Date.now() - started };
  }
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
  void runPowerplaySync(svc, options).catch(() => undefined);
  return { refreshing: true, stale: true };
}
