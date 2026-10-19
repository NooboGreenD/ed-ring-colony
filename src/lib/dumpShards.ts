/**
 * Куски (шарды) ночного дампа на диске сервера — общее для импортов,
 * устроенных как «Каталог систем» (`galaxyShards.ts`): минорные фракции
 * (`bgsShards.ts`, куски `bgs-00001.ndjson.gz`) и PowerPlay
 * (`powerplayShards.ts`, куски `pp-00001.ndjson.gz`).
 *
 * Шаги импорта идут по очереди: архив скачивается на сервер ЦЕЛИКОМ → затем
 * разбивается на куски — готовые строки для записи в базу → затем куски
 * пишутся в базу. Кусок — единица продолжения: после остановки или
 * перезапуска сайта записываются только незаписанные куски той же метки
 * импорта (`runId`), архив повторно не скачивается и не разбирается.
 *
 * `manifest.json` рядом с кусками говорит, из какого дампа они (адрес,
 * размер, Last-Modified/ETag), сколько записей архива разобрано и какие куски
 * уже в базе. Файлы обычные: `zcat bgs-00001.ndjson.gz | head` показывает
 * строки как есть.
 *
 * Только встроенные модули Node: модуль импортируют тесты напрямую.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gunzip as gunzipCallback, gzip as gzipCallback } from 'node:zlib';

const gzip = promisify(gzipCallback);
const gunzip = promisify(gunzipCallback);

export const SHARD_MANIFEST_VERSION = 1;
export const SHARD_MANIFEST = 'manifest.json';
const TMP_FILE = /\.tmp-\d+$/;

/* ── Какой дамп ────────────────────────────────────────────────────────── */

/** Дамп, которому принадлежат архив и куски: адрес, размер, валидаторы HTTP. */
export interface DumpSource {
  url: string;
  etag: string | null;
  lastModified: string | null;
  total: number | null;
}

function sameDate(a: string, b: string): boolean {
  const left = Date.parse(a);
  const right = Date.parse(b);
  return Number.isFinite(left) && Number.isFinite(right) ? left === right : a.trim() === b.trim();
}

/**
 * Один и тот же дамп? Размер решает сразу; дальше ETag, без него —
 * Last-Modified (у статического файла EDSM они меняются вместе).
 * Без валидаторов совпадение не доказать.
 */
export function sameDumpSource(a: DumpSource | null | undefined, b: DumpSource | null | undefined): boolean {
  if (!a || !b || a.url !== b.url) return false;
  if (a.total != null && b.total != null && a.total !== b.total) return false;
  if (a.etag && b.etag) return a.etag.replace(/^W\//i, '') === b.etag.replace(/^W\//i, '');
  if (a.lastModified && b.lastModified) return sameDate(a.lastModified, b.lastModified);
  return false;
}

/** Дамп из JSON (манифест, метка архива); всё непонятное — `null`. */
export function cleanDumpSource(value: unknown): DumpSource | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.url !== 'string' || !raw.url) return null;
  const total = Number(raw.total);
  return {
    url: raw.url,
    etag: typeof raw.etag === 'string' && raw.etag ? raw.etag : null,
    lastModified: typeof raw.lastModified === 'string' && raw.lastModified ? raw.lastModified : null,
    total: Number.isFinite(total) && total > 0 ? Math.round(total) : null,
  };
}

/** Атомарная запись: обрыв посреди записи не оставляет полфайла. */
export function writeFileAtomic(path: string, data: string | Buffer): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

/* ── Манифест ──────────────────────────────────────────────────────────── */

export interface ShardEntry {
  file: string;
  systems: number;
  /** Размер файла (gzip). */
  bytes: number;
  /** Кусок записан в базу (с меткой импорта `runId`). */
  imported: boolean;
  /** Сколько строк куска база применила. */
  applied: number;
  /** Строки куска, у которых наблюдение пилотов свежее дампа. */
  stale: number;
}

export interface ShardManifest<Stats = unknown> {
  version: number;
  source: DumpSource;
  /** Метка импорта (`sync_run` в таблице): у продолжения та же. */
  runId: string;
  createdAt: string;
  completedAt: string | null;
  systemsPerShard: number;
  /** Записей архива (включая отброшенные), разложенных по закрытым кускам, — точка продолжения разбивки. */
  recordsRead: number;
  /** Сжатых байт архива, прочитанных к этому моменту (для процента). */
  bytesRead: number;
  systems: number;
  shards: ShardEntry[];
  /** Архив разобран до конца. */
  complete: boolean;
  /** Итоги разбора архива (когда `complete`). */
  stats: Stats | null;
}

export function shardFileName(prefix: string, index: number): string {
  return `${prefix}-${String(index).padStart(5, '0')}.ndjson.gz`;
}

/** Имя файла куска этого вида: `bgs-00001.ndjson.gz`, `pp-00001.ndjson.gz`. */
export function shardFilePattern(prefix: string): RegExp {
  return new RegExp(`^${prefix.replace(/[^a-z0-9_]/gi, '')}-\\d{5}\\.ndjson\\.gz$`);
}

export function shardManifestPath(dir: string): string {
  return join(dir, SHARD_MANIFEST);
}

function count(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

export function createShardManifest<Stats = unknown>(options: {
  source: DumpSource;
  runId: string;
  systemsPerShard: number;
  now?: number;
}): ShardManifest<Stats> {
  return {
    version: SHARD_MANIFEST_VERSION,
    source: { ...options.source },
    runId: options.runId,
    createdAt: new Date(options.now ?? Date.now()).toISOString(),
    completedAt: null,
    systemsPerShard: Math.max(1, Math.floor(options.systemsPerShard)),
    recordsRead: 0,
    bytesRead: 0,
    systems: 0,
    shards: [],
    complete: false,
    stats: null,
  };
}

/** Манифест с диска; всё, что не похоже на наш формат (и чужие куски), — «кусков нет». */
export function readShardManifest<Stats = unknown>(dir: string, prefix: string, defaultPerShard: number): ShardManifest<Stats> | null {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(shardManifestPath(dir), 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!raw || raw.version !== SHARD_MANIFEST_VERSION || !Array.isArray(raw.shards) || typeof raw.runId !== 'string' || !raw.runId) return null;
  const source = cleanDumpSource(raw.source);
  if (!source) return null;
  const pattern = shardFilePattern(prefix);
  const shards: ShardEntry[] = [];
  for (const item of raw.shards) {
    const entry = item as Record<string, unknown> | null;
    if (!entry || typeof entry.file !== 'string' || !pattern.test(entry.file)) return null;
    shards.push({
      file: entry.file,
      systems: count(entry.systems),
      bytes: count(entry.bytes),
      imported: entry.imported === true,
      applied: count(entry.applied),
      stale: count(entry.stale),
    });
  }
  return {
    version: SHARD_MANIFEST_VERSION,
    source,
    runId: raw.runId,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date(0).toISOString(),
    completedAt: typeof raw.completedAt === 'string' ? raw.completedAt : null,
    systemsPerShard: Math.max(1, count(raw.systemsPerShard) || defaultPerShard),
    recordsRead: count(raw.recordsRead),
    bytesRead: count(raw.bytesRead),
    systems: shards.reduce((sum, entry) => sum + entry.systems, 0),
    shards,
    complete: raw.complete === true,
    stats: raw.stats && typeof raw.stats === 'object' ? (raw.stats as Stats) : null,
  };
}

export function writeShardManifest(dir: string, manifest: ShardManifest<unknown>): void {
  mkdirSync(dir, { recursive: true });
  writeFileAtomic(shardManifestPath(dir), JSON.stringify(manifest, null, 1));
}

/** Удалить все куски этого вида и манифест. Возвращает освобождённые байты. */
export function clearShards(dir: string, prefix: string): number {
  if (!existsSync(dir)) return 0;
  const pattern = shardFilePattern(prefix);
  let freed = 0;
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!pattern.test(name) && name !== SHARD_MANIFEST && !TMP_FILE.test(name)) continue;
    const path = join(dir, name);
    try {
      freed += statSync(path).size;
    } catch {
      // уже нет
    }
    rmSync(path, { force: true });
  }
  return freed;
}

export interface ShardsInfo {
  dir: string;
  /** Есть манифест. */
  exists: boolean;
  /** Архив разобран до конца. */
  complete: boolean;
  shards: number;
  imported: number;
  systems: number;
  importedSystems: number;
  /** Файлов кусков на диске и их объём. */
  files: number;
  bytes: number;
  source: DumpSource | null;
  createdAt: string | null;
  completedAt: string | null;
}

/** Что админка показывает о кусках. */
export function shardsInfo(dir: string, prefix: string, defaultPerShard = 1000): ShardsInfo {
  const manifest = readShardManifest(dir, prefix, defaultPerShard);
  const pattern = shardFilePattern(prefix);
  let files = 0;
  let bytes = 0;
  try {
    for (const name of readdirSync(dir)) {
      if (!pattern.test(name)) continue;
      files += 1;
      bytes += statSync(join(dir, name)).size;
    }
  } catch {
    // каталога ещё нет — нули честны
  }
  const imported = manifest?.shards.filter((entry) => entry.imported) ?? [];
  return {
    dir,
    exists: Boolean(manifest),
    complete: Boolean(manifest?.complete),
    shards: manifest?.shards.length ?? 0,
    imported: imported.length,
    systems: manifest?.systems ?? 0,
    importedSystems: imported.reduce((sum, entry) => sum + entry.systems, 0),
    files,
    bytes,
    source: manifest?.source ?? null,
    createdAt: manifest?.createdAt ?? null,
    completedAt: manifest?.completedAt ?? null,
  };
}

/** Строки одного куска — готовые строки для записи в базу. */
export async function readShardRows(file: string): Promise<Record<string, unknown>[]> {
  const body = await gunzip(readFileSync(file));
  const rows: Record<string, unknown>[] = [];
  for (const line of body.toString('utf8').split('\n')) {
    if (!line) continue;
    rows.push(JSON.parse(line) as Record<string, unknown>);
  }
  return rows;
}

/** Записать кусок (строки JSON) сжатым и атомарно. Возвращает размер файла. */
export async function writeShardFile(dir: string, file: string, lines: readonly string[]): Promise<number> {
  mkdirSync(dir, { recursive: true });
  const body = await gzip(Buffer.from(`${lines.join('\n')}\n`, 'utf8'), { level: 6 });
  writeFileAtomic(join(dir, file), body);
  return body.length;
}
