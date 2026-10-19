/**
 * Куски (шарды) дампа EDSM `powerPlay.json.gz` — как у минорных фракций и
 * «Каталога систем»: архив скачан на сервер целиком → разбит на куски →
 * куски пишутся в базу по одному. Общий механизм кусков — `dumpShards.ts`.
 *
 * Отличие от фракций: записи одной системы в дампе разбросаны по всему файлу
 * (EDSM выгружает его, отсортировав по номеру державы, затем по дате), а
 * владельца решают ВСЕ записи системы вместе (`powerplayDump.ts`). Поэтому
 * разбивка читает скачанный архив целиком, собирает записи по системам и
 * только потом раскладывает системы по кускам `pp-00001.ndjson.gz` — готовые
 * строки для `powerplay_apply_batch`. Архив маленький (≈3,6 МБ, ≈25 МБ JSON):
 * разбивка занимает доли секунды, продолжать её с середины не нужно.
 *
 * gzip определяется по сигнатуре, а не по имени файла: архив, распакованный
 * по пути (прокси с `Content-Encoding: gzip`), читается как JSON.
 */

import { readFile } from 'node:fs/promises';
import { mkdirSync, statSync } from 'node:fs';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';

import {
  clearShards,
  createShardManifest,
  readShardManifest,
  shardFileName,
  shardsInfo,
  writeShardFile,
  writeShardManifest,
  type DumpSource,
  type ShardEntry,
  type ShardManifest,
  type ShardsInfo,
} from './dumpShards.ts';
import { parseEdsmPowerplayDump, type PowerplayDumpRow, type PowerplayDumpStats } from './powerplayDump.ts';

const gunzipAsync = promisify(gunzip);

/** Куски PowerPlay: `pp-00001.ndjson.gz`. */
export const POWERPLAY_SHARD_PREFIX = 'pp';
/** Систем в куске (≈250 Б строки на систему — кусок ≈60 КБ в gzip); столько же, сколько в пачке записи раньше. */
export const DEFAULT_POWERPLAY_SHARD_SYSTEMS = 2000;
/** Сжатый дамп сейчас ≈3,6 МБ, распакованный ≈25 МБ: пределы с большим запасом. */
export const POWERPLAY_MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
export const POWERPLAY_MAX_TEXT_BYTES = 512 * 1024 * 1024;

export const POWERPLAY_SPLIT_ABORTED = 'Разбивка остановлена';

export type PowerplayShardManifest = ShardManifest<PowerplayDumpStats>;
export type PowerplayShardsInfo = ShardsInfo;

export function powerplayShardFileName(index: number): string {
  return shardFileName(POWERPLAY_SHARD_PREFIX, index);
}

export function createPowerplayShardManifest(options: {
  source: DumpSource;
  runId: string;
  systemsPerShard?: number;
  now?: number;
}): PowerplayShardManifest {
  return createShardManifest<PowerplayDumpStats>({ ...options, systemsPerShard: options.systemsPerShard ?? DEFAULT_POWERPLAY_SHARD_SYSTEMS });
}

/** Манифест с диска; чужое или битое — «кусков нет». */
export function readPowerplayShardManifest(dir: string): PowerplayShardManifest | null {
  return readShardManifest<PowerplayDumpStats>(dir, POWERPLAY_SHARD_PREFIX, DEFAULT_POWERPLAY_SHARD_SYSTEMS);
}

export function writePowerplayShardManifest(dir: string, manifest: PowerplayShardManifest): void {
  writeShardManifest(dir, manifest);
}

/** Удалить куски PowerPlay и манифест. Возвращает освобождённые байты. */
export function clearPowerplayShards(dir: string): number {
  return clearShards(dir, POWERPLAY_SHARD_PREFIX);
}

export function powerplayShardsInfo(dir: string): PowerplayShardsInfo {
  return shardsInfo(dir, POWERPLAY_SHARD_PREFIX, DEFAULT_POWERPLAY_SHARD_SYSTEMS);
}

/**
 * Текст дампа. gzip — по сигнатуре: прокси может выставить
 * `Content-Encoding: gzip`, и тело придёт уже распакованным.
 */
export async function decodePowerplayDump(buffer: Buffer): Promise<string> {
  if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
    const text = await gunzipAsync(buffer, { maxOutputLength: POWERPLAY_MAX_TEXT_BYTES });
    return text.toString('utf8');
  }
  if (buffer.length > POWERPLAY_MAX_TEXT_BYTES) throw new Error('Дамп PowerPlay слишком большой');
  return buffer.toString('utf8');
}

/** Строка куска — строка для `powerplay_apply_batch`. */
export function powerplayRowToDb(row: PowerplayDumpRow): Record<string, unknown> {
  return {
    id64: row.id64,
    name: row.name,
    x: row.x,
    y: row.y,
    z: row.z,
    // Пусто — держав в дампе несколько, владельца решит база (прежний точный
    // владелец или «не определён»). База без миграции 20261021120000 такие
    // строки просто пропустит, а не припишет системе случайную державу.
    power: row.power ?? '',
    powers: row.powers,
    power_state: row.state,
    allegiance: row.allegiance,
    government: row.government,
    observed_at: row.observedAt,
  };
}

export interface PowerplaySplitProgress {
  /** Сжатых байт архива прочитано. */
  bytesRead: number;
  /** Записей дампа разобрано. */
  records: number;
  systems: number;
  shards: number;
}

export interface SplitPowerplayArchiveOptions {
  /** Скачанный (или загруженный с компьютера) целиком архив. */
  archive: string;
  dir: string;
  /** Новый манифест этого дампа — меняется на месте. */
  manifest: PowerplayShardManifest;
  signal: AbortSignal;
  onShard?: (entry: ShardEntry, manifest: PowerplayShardManifest) => void | Promise<void>;
  onProgress?: (progress: PowerplaySplitProgress) => void | Promise<void>;
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  return reason instanceof Error ? reason : new Error(POWERPLAY_SPLIT_ABORTED);
}

/**
 * Прочитать архив, собрать записи по системам и разложить системы по кускам.
 * Испорченный архив (обрезанный, с неверной CRC) обрывает разбивку ошибкой
 * zlib, файл не похожий на дамп — ошибкой разбора; куски тогда не пишутся.
 */
export async function splitPowerplayArchive(options: SplitPowerplayArchiveOptions): Promise<PowerplayShardManifest> {
  const { archive, dir, manifest, signal } = options;
  const check = () => {
    if (signal.aborted) throw abortError(signal);
  };
  check();
  const size = statSync(archive).size;
  if (size > POWERPLAY_MAX_ARCHIVE_BYTES) throw new Error(`Дамп PowerPlay слишком большой: ${size} байт`);
  const buffer = await readFile(archive);
  check();
  await options.onProgress?.({ bytesRead: buffer.length, records: 0, systems: 0, shards: 0 });
  const text = await decodePowerplayDump(buffer);
  check();
  const { rows, stats } = parseEdsmPowerplayDump(text);
  check();
  await options.onProgress?.({ bytesRead: buffer.length, records: stats.records, systems: 0, shards: 0 });

  mkdirSync(dir, { recursive: true });
  const perShard = Math.max(1, manifest.systemsPerShard);
  manifest.shards = [];
  manifest.systems = 0;
  for (let offset = 0; offset < rows.length; offset += perShard) {
    check();
    const part = rows.slice(offset, offset + perShard);
    const file = powerplayShardFileName(manifest.shards.length + 1);
    const bytes = await writeShardFile(dir, file, part.map((row) => JSON.stringify(powerplayRowToDb(row))));
    const entry: ShardEntry = { file, systems: part.length, bytes, imported: false, applied: 0, stale: 0 };
    manifest.shards.push(entry);
    manifest.systems += entry.systems;
    await options.onShard?.(entry, manifest);
    await options.onProgress?.({ bytesRead: buffer.length, records: stats.records, systems: manifest.systems, shards: manifest.shards.length });
  }
  manifest.recordsRead = stats.records;
  manifest.bytesRead = buffer.length;
  manifest.complete = true;
  manifest.completedAt = new Date().toISOString();
  manifest.stats = JSON.parse(JSON.stringify(stats)) as PowerplayDumpStats;
  // Манифест — последним: куски без него считаются недоразбитыми и удаляются.
  writePowerplayShardManifest(dir, manifest);
  return manifest;
}
