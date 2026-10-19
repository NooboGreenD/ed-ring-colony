/**
 * Архив ночного дампа на диске сервера — общее для импортов, устроенных как
 * «Каталог систем»: минорные фракции (`bgsSync.ts`, `systemsPopulated.json.gz`
 * ≈0,5 ГБ) и PowerPlay (`powerplaySync.ts`, `powerPlay.json.gz` ≈3,6 МБ).
 *
 * Архив скачивается на сервер ЦЕЛИКОМ (`downloadDump` в `galaxyImport.ts`:
 * куски файла в несколько соединений, докачка через Range, короткие запросы
 * для сети, «замораживающей» TCP-сессии), и только потом его разбивают на
 * куски. Рядом с файлом лежат:
 *   * `<архив>.meta.json` — какой это дамп (адрес, размер, ETag,
 *     Last-Modified), скачан ли целиком, загружен ли с компьютера;
 *   * `<архив>.parts.json` — план докачки недокачанного файла (пишет
 *     `downloadDump`).
 *
 * Без метки нельзя понять, чья недокачанная часть лежит на диске: дописать к
 * ней хвост другого дампа — значит получить битый gzip.
 */

import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, statfsSync } from 'node:fs';
import { dirname } from 'node:path';

import { writeFileAtomic, type DumpSource } from './dumpShards.ts';
import { downloadedBytesOnDisk, segmentStatePath } from './galaxyImport.ts';

export const ARCHIVE_META_SUFFIX = '.meta.json';

/**
 * Метка архива рядом с файлом: какой дамп качается (пишется в начале
 * скачивания) и скачан ли он целиком (`completedAt`).
 */
export interface ArchiveMeta {
  url: string;
  etag: string | null;
  lastModified: string | null;
  total: number | null;
  completedAt: string | null;
  /** Архив загружен в админке с компьютера (или положен на сервер вручную), а не скачан с EDSM. */
  uploaded?: boolean;
  /** Имя загруженного файла. */
  uploadName?: string | null;
}

export function archiveMetaPath(dest: string): string {
  return `${dest}${ARCHIVE_META_SUFFIX}`;
}

export function readArchiveMeta(dest: string): ArchiveMeta | null {
  try {
    const raw = JSON.parse(readFileSync(archiveMetaPath(dest), 'utf8')) as Partial<ArchiveMeta>;
    if (!raw || typeof raw.url !== 'string') return null;
    return {
      url: raw.url,
      etag: typeof raw.etag === 'string' ? raw.etag : null,
      lastModified: typeof raw.lastModified === 'string' ? raw.lastModified : null,
      total: typeof raw.total === 'number' && raw.total > 0 ? raw.total : null,
      completedAt: typeof raw.completedAt === 'string' && raw.completedAt ? raw.completedAt : null,
      ...(raw.uploaded === true ? { uploaded: true, uploadName: typeof raw.uploadName === 'string' ? raw.uploadName.slice(0, 200) : null } : {}),
    };
  } catch {
    return null;
  }
}

export function writeArchiveMeta(dest: string, meta: ArchiveMeta): void {
  try {
    mkdirSync(dirname(dest), { recursive: true });
    writeFileAtomic(archiveMetaPath(dest), JSON.stringify(meta, null, 1));
  } catch {
    // Без метки архив просто скачается заново в следующий раз.
  }
}

/** Какой дамп описывает метка архива. */
export function archiveMetaSource(meta: ArchiveMeta | null): DumpSource | null {
  return meta ? { url: meta.url, etag: meta.etag, lastModified: meta.lastModified, total: meta.total } : null;
}

export function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** Архив скачан целиком: есть метка с `completedAt`, размер сходится, плана докачки нет. */
export function archiveIsComplete(dest: string, meta: ArchiveMeta | null): boolean {
  return Boolean(meta?.completedAt && existsSync(dest) && !existsSync(segmentStatePath(dest)) && meta.total === fileSize(dest));
}

/** Удалить архив, план докачки и метку. Возвращает освобождённые байты. */
export function removeArchive(dest: string): number {
  const partial = downloadedBytesOnDisk(dest);
  const bytes = partial ? partial.done : fileSize(dest);
  for (const path of [dest, segmentStatePath(dest), archiveMetaPath(dest)]) rmSync(path, { force: true });
  return bytes;
}

/** Есть ли на диске хоть что-то от архива: файл, план докачки или метка. */
export function archiveLeftovers(dest: string): boolean {
  return existsSync(dest) || existsSync(segmentStatePath(dest)) || existsSync(archiveMetaPath(dest));
}

export function freeBytes(dir: string): number | null {
  try {
    mkdirSync(dir, { recursive: true });
    const stats = statfsSync(dir);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

export interface DumpArchiveInfo {
  path: string;
  exists: boolean;
  /** Размер файла на диске (у недокачанного параллельного — уже полный размер: файл выделен заранее). */
  bytes: number;
  /** Сколько реально скачано. */
  downloaded: number;
  /** Размер дампа у источника, если известен. */
  total: number | null;
  /** Скачивание не закончено — следующий запуск докачает. */
  partial: boolean;
  /** Архив скачан целиком (есть метка), дата дампа. */
  complete: boolean;
  lastModified: string | null;
  freeBytes: number | null;
  /** Загружен в админке с компьютера (или положен вручную и уже принят). */
  uploaded: boolean;
  uploadName: string | null;
  /** Файл без метки и без плана докачки — положен на сервер вручную; загрузка примет его. */
  manual: boolean;
}

/** Что админка показывает об архиве на сервере. */
export function dumpArchiveInfo(path: string): DumpArchiveInfo {
  const exists = existsSync(path);
  const meta = exists ? readArchiveMeta(path) : null;
  const bytes = exists ? fileSize(path) : 0;
  const plan = exists ? downloadedBytesOnDisk(path) : null;
  const complete = archiveIsComplete(path, meta);
  const manual = exists && !meta && !plan;
  return {
    path,
    exists,
    bytes,
    downloaded: plan ? plan.done : bytes,
    total: plan?.total ?? meta?.total ?? (complete || manual ? bytes : null),
    partial: Boolean(plan) || (exists && !complete && !manual),
    complete,
    lastModified: meta?.lastModified ?? null,
    freeBytes: freeBytes(dirname(path)),
    uploaded: Boolean(meta?.uploaded),
    uploadName: meta?.uploaded ? meta.uploadName ?? null : null,
    manual,
  };
}

/** Метка для архива, который не скачан с EDSM: размер и начало файла вместо ETag. */
export function uploadedDumpEtag(size: number, head: Buffer): string {
  return `"upload-${size.toString(16)}-${createHash('sha1').update(head).digest('hex').slice(0, 12)}"`;
}

/** Начало файла (для метки и проверки «это gzip»). */
export function readFileHead(path: string, bytes = 1024 * 1024): Buffer {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const buffer = Buffer.alloc(bytes);
    const read = readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, read);
  } catch {
    return Buffer.alloc(0);
  } finally {
    if (fd != null) closeSync(fd);
  }
}

/**
 * Файл дампа, положенный на сервер вручную (scp в каталог архива), — без
 * метки и плана докачки. Если это gzip, он принимается как загруженный:
 * получает метку, и дальше с ним работают как с архивом, загруженным в админке.
 */
export function adoptManualArchive(dest: string, url: string): ArchiveMeta | null {
  if (!existsSync(dest) || existsSync(archiveMetaPath(dest)) || existsSync(segmentStatePath(dest))) return null;
  const size = fileSize(dest);
  const head = readFileHead(dest);
  if (size <= 0 || head[0] !== 0x1f || head[1] !== 0x8b) return null;
  let mtime = Date.now();
  try {
    mtime = statSync(dest).mtimeMs;
  } catch {
    // дата файла неизвестна — сейчас
  }
  const meta: ArchiveMeta = {
    url,
    etag: uploadedDumpEtag(size, head),
    lastModified: new Date(mtime).toUTCString(),
    total: size,
    completedAt: new Date().toISOString(),
    uploaded: true,
    uploadName: 'положен на сервер вручную',
  };
  writeArchiveMeta(dest, meta);
  return readArchiveMeta(dest);
}
