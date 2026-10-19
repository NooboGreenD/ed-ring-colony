/**
 * Куски (шарды) дампа EDSM `systemsPopulated.json.gz` — так же, как архив
 * каталога систем раскладывается в шарды (`galaxyShards.ts`).
 *
 * Зачем: архив весит ≈0,5 ГБ, а разбор и запись в базу — дольше всего и
 * обрываются перезапуском сайта. Поэтому шаги идут по очереди:
 *
 *   * **разбивка** начинается, когда архив скачан на сервер ЦЕЛИКОМ, читает
 *     его один раз и раскладывает населённые системы по маленьким файлам
 *     `bgs-00001.ndjson.gz` (по тысяче систем) с готовыми строками для
 *     `bgs_apply_snapshots` (станции и тела дампа сюда не попадают: от 0,5 ГБ
 *     остаются мегабайты);
 *   * **загрузка в базу** идёт по кускам после разбивки; кусок — единица
 *     продолжения: после обрыва записываются только незаписанные куски той же
 *     метки импорта (`runId`), архив повторно не разбирается;
 *   * `manifest.json` рядом с кусками говорит, из какого дампа они (адрес,
 *     размер, Last-Modified/ETag), сколько записей архива уже разобрано и какие
 *     куски уже в базе.
 *
 * Файлы обычные: `zcat bgs-00001.ndjson.gz | head` показывает строки как есть.
 */

import { createReadStream, mkdirSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { createGunzip } from 'node:zlib';

import { snapshotToRpcRow } from './bgs.ts';
import { parseEdsmPopulatedLine, type BgsDumpCounter, type BgsDumpStats } from './bgsDump.ts';
import {
  SHARD_MANIFEST,
  SHARD_MANIFEST_VERSION,
  clearShards,
  createShardManifest,
  readShardManifest,
  readShardRows,
  sameDumpSource,
  shardFileName,
  shardManifestPath,
  shardsInfo,
  writeShardFile,
  writeShardManifest,
  type DumpSource,
  type ShardEntry,
  type ShardManifest,
  type ShardsInfo,
} from './dumpShards.ts';

export { writeFileAtomic } from './dumpShards.ts';

export const BGS_SHARD_VERSION = SHARD_MANIFEST_VERSION;
export const BGS_SHARD_MANIFEST = SHARD_MANIFEST;
/** Систем в куске: ≈1,5 КБ строки на систему — кусок ≈0,3 МБ в gzip. */
export const DEFAULT_BGS_SHARD_SYSTEMS = 1000;
/** Куски фракций: `bgs-00001.ndjson.gz`. */
const PREFIX = 'bgs';
/** Строка дампа длиннее — это не дамп, а что-то сломанное. */
const MAX_LINE_CHARS = 64 * 1024 * 1024;

export const BGS_SPLIT_ABORTED = 'Разбивка остановлена';

/* ── Какой дамп и манифест — общие с PowerPlay (`dumpShards.ts`) ───────── */

/** Дамп, которому принадлежат архив и куски: адрес, размер, валидаторы HTTP. */
export type BgsDumpSource = DumpSource;

/**
 * Один и тот же дамп? Размер решает сразу; дальше ETag, без него —
 * Last-Modified (как и прежде: у статического файла EDSM они меняются вместе).
 * Без валидаторов совпадение не доказать.
 */
export const sameBgsDumpSource = sameDumpSource;

export type BgsShardEntry = ShardEntry;
export type BgsShardManifest = ShardManifest<BgsDumpStats>;

export function bgsShardFileName(index: number): string {
  return shardFileName(PREFIX, index);
}

export function bgsShardManifestPath(dir: string): string {
  return shardManifestPath(dir);
}

export function createBgsShardManifest(options: {
  source: BgsDumpSource;
  runId: string;
  systemsPerShard?: number;
  now?: number;
}): BgsShardManifest {
  return createShardManifest<BgsDumpStats>({ ...options, systemsPerShard: options.systemsPerShard ?? DEFAULT_BGS_SHARD_SYSTEMS });
}

/** Манифест с диска; всё, что не похоже на наш формат, — «кусков нет». */
export function readBgsShardManifest(dir: string): BgsShardManifest | null {
  return readShardManifest<BgsDumpStats>(dir, PREFIX, DEFAULT_BGS_SHARD_SYSTEMS);
}

export function writeBgsShardManifest(dir: string, manifest: BgsShardManifest): void {
  writeShardManifest(dir, manifest);
}

/** Удалить все куски и манифест. Возвращает освобождённые байты. */
export function clearBgsShards(dir: string): number {
  return clearShards(dir, PREFIX);
}

export type BgsShardsInfo = ShardsInfo;

/** Что админка показывает о кусках. */
export function bgsShardsInfo(dir: string): BgsShardsInfo {
  return shardsInfo(dir, PREFIX, DEFAULT_BGS_SHARD_SYSTEMS);
}

/** Строки одного куска — готовые строки для `bgs_apply_snapshots`. */
export const readBgsShardRows = readShardRows;

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  return reason instanceof Error ? reason : new Error(BGS_SPLIT_ABORTED);
}

/* ── Разбивка архива на куски ──────────────────────────────────────────── */

export interface BgsSplitProgress {
  /** Сжатых байт архива прочитано. */
  bytesRead: number;
  /** Записей дампа разобрано в этом проходе (с начала файла). */
  records: number;
  systems: number;
  shards: number;
}

export interface SplitBgsArchiveOptions {
  /** Скачанный целиком архив. */
  archive: string;
  dir: string;
  /** Манифест этого дампа (новый или для продолжения) — меняется на месте. */
  manifest: BgsShardManifest;
  /** Счётчик итогов: при продолжении в него попадают и уже разложенные записи. */
  counter: BgsDumpCounter;
  signal: AbortSignal;
  onShard?: (entry: BgsShardEntry, manifest: BgsShardManifest) => void | Promise<void>;
  onProgress?: (progress: BgsSplitProgress) => void | Promise<void>;
  progressIntervalMs?: number;
}

/**
 * Прочитать скачанный архив и разложить системы по кускам.
 *
 * Продолжение: gzip нельзя начать с середины, поэтому архив перечитывается с
 * начала, но записи, уже лежащие в кусках (`manifest.recordsRead`), только
 * считаются для итогов — повторно не пишутся. Испорченный архив (обрезанный,
 * с неверной CRC) обрывает разбивку ошибкой zlib.
 */
export async function splitBgsArchive(options: SplitBgsArchiveOptions): Promise<BgsShardManifest> {
  const { archive, dir, manifest, counter, signal } = options;
  mkdirSync(dir, { recursive: true });
  const perShard = Math.max(1, manifest.systemsPerShard);
  const skip = manifest.recordsRead;
  const progressIntervalMs = Math.max(100, options.progressIntervalMs ?? 1000);
  let seen = 0;
  let pending: string[] = [];
  let position = 0;
  let lastProgressAt = 0;

  const snapshot = (): BgsSplitProgress => ({
    bytesRead: position,
    records: seen,
    systems: manifest.systems + pending.length,
    shards: manifest.shards.length,
  });
  const report = async (force = false) => {
    const at = Date.now();
    if (!force && at - lastProgressAt < progressIntervalMs) return;
    lastProgressAt = at;
    if (options.onProgress) await options.onProgress(snapshot());
  };

  const closeShard = async () => {
    if (pending.length === 0) return;
    const file = bgsShardFileName(manifest.shards.length + 1);
    const bytes = await writeShardFile(dir, file, pending);
    const entry: BgsShardEntry = { file, systems: pending.length, bytes, imported: false, applied: 0, stale: 0 };
    pending = [];
    manifest.shards.push(entry);
    manifest.systems += entry.systems;
    manifest.recordsRead = seen;
    manifest.bytesRead = position;
    writeBgsShardManifest(dir, manifest);
    if (options.onShard) await options.onShard(entry, manifest);
    await report(true);
  };

  const source = createReadStream(archive, { highWaterMark: 1 << 20 });
  source.on('data', (chunk) => {
    position += chunk.length;
  });
  const gunzipStream = createGunzip();
  source.on('error', (error) => gunzipStream.destroy(error));
  source.pipe(gunzipStream);
  const onAbort = () => {
    source.destroy();
    gunzipStream.destroy(abortError(signal));
  };
  if (signal.aborted) onAbort();
  signal.addEventListener('abort', onAbort, { once: true });

  const handleLine = async (rawLine: string) => {
    const parsed = parseEdsmPopulatedLine(rawLine);
    if (parsed.kind === 'empty') return;
    seen += 1;
    counter.add(parsed);
    if (seen <= skip || parsed.kind !== 'system') return;
    pending.push(JSON.stringify(snapshotToRpcRow(parsed.snapshot)));
    if (pending.length >= perShard) await closeShard();
  };

  const decoder = new StringDecoder('utf8');
  let parts: string[] = [];
  let partsLength = 0;
  try {
    for await (const chunk of gunzipStream) {
      const text = decoder.write(chunk as Buffer);
      let start = 0;
      for (;;) {
        const newline = text.indexOf('\n', start);
        if (newline < 0) break;
        const piece = text.slice(start, newline);
        const line = parts.length ? parts.join('') + piece : piece;
        parts = [];
        partsLength = 0;
        await handleLine(line);
        start = newline + 1;
      }
      if (start < text.length) {
        const rest = text.slice(start);
        parts.push(rest);
        partsLength += rest.length;
        if (partsLength > MAX_LINE_CHARS) throw new Error('Строка дампа длиннее 64 МБ — файл не похож на дамп EDSM');
      }
      await report();
    }
    const tail = parts.join('') + decoder.end();
    if (tail.trim()) await handleLine(tail);
  } finally {
    signal.removeEventListener('abort', onAbort);
    source.destroy();
  }
  if (signal.aborted) throw abortError(signal);

  await closeShard();
  manifest.recordsRead = seen;
  manifest.bytesRead = position;
  manifest.complete = true;
  manifest.completedAt = new Date().toISOString();
  manifest.stats = JSON.parse(JSON.stringify(counter.stats)) as BgsDumpStats;
  writeBgsShardManifest(dir, manifest);
  await report(true);
  return manifest;
}
