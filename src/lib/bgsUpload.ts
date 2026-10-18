/**
 * Архив дампа EDSM, загруженный в админке с компьютера администратора.
 *
 * Зачем: серверу EDSM может быть недоступен. EDSM стоит за Cloudflare, а сеть
 * российского сервера «замораживает» TCP-сессии к зарубежным CDN после
 * ~16 КБ: архив в 0,5 ГБ так не скачать. Компьютер администратора (другая
 * сеть, VPN) скачивает его за минуту — дальше файл нужно только передать на
 * сервер, а входящие соединения к серверу эта фильтрация не трогает.
 *
 * Как устроено (`/api/admin/factions/upload`):
 *   * `start` — браузер называет файл (имя, размер, дата). Тот же файл, что
 *     грузился раньше, продолжается с того байта, на котором оборвался;
 *   * `PUT ?offset=N` — кусок файла (8 МБ: меньше лимитов nginx и Next.js)
 *     дописывается во временный `<архив>.upload`, если N — ровно его размер;
 *     иначе 409 с настоящим размером, и браузер продолжает с него;
 *   * `finish` — файл целиком, это gzip с дампом EDSM → он становится архивом
 *     (`<архив>.meta.json` с `uploaded: true`). Если размер совпал с дампом на
 *     EDSM, архив получает его ETag и дату: это тот же самый дамп. Дальше
 *     «Загрузить данные» разбивает его на куски и пишет в базу, не обращаясь к
 *     EDSM;
 *   * `cancel` — временный файл удаляется.
 */

import { appendFile } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { constants as zlibConstants, gunzipSync } from 'node:zlib';

import { formatBgsBytes } from './bgsProgress.ts';
import { clearBgsShards, readBgsShardManifest, sameBgsDumpSource, writeFileAtomic, type BgsDumpSource } from './bgsShards.ts';
import {
  bgsArchivePath,
  bgsDumpUrl,
  bgsEdsmFetch,
  bgsShardsDirFor,
  freeBytes,
  isBgsSyncRunning,
  readArchiveMeta,
  readFileHead,
  removeArchive,
  uploadedDumpEtag,
  writeArchiveMeta,
} from './bgsSync.ts';
import { probeDumpSource } from './galaxyImport.ts';

/** Кусок, который браузер шлёт за раз: меньше `client_max_body_size 25m` nginx и `proxyClientMaxBodySize` Next.js. */
export const BGS_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
/** Дамп весит ≈0,5 ГБ; больше 4 ГБ — точно не он. */
export const BGS_UPLOAD_MAX_BYTES = 4 * 1024 ** 3;
const MIN_UPLOAD_BYTES = 32;
const DISK_RESERVE_BYTES = 256 * 1024 * 1024;

/** Ошибка с HTTP-статусом для маршрута; `offset` — настоящий размер принятого (409). */
export class BgsUploadError extends Error {
  status: number;
  offset?: number;

  constructor(message: string, status = 400, offset?: number) {
    super(message);
    this.name = 'BgsUploadError';
    this.status = status;
    if (offset != null) this.offset = offset;
  }
}

interface UploadMeta {
  name: string;
  size: number;
  /** `File.lastModified` в браузере (мс). */
  lastModified: number | null;
  startedAt: string;
}

export function bgsUploadFile(archive = bgsArchivePath()): string {
  return `${archive}.upload`;
}

function uploadMetaPath(archive: string): string {
  return `${archive}.upload.json`;
}

function readUploadMeta(archive: string): UploadMeta | null {
  try {
    const raw = JSON.parse(readFileSync(uploadMetaPath(archive), 'utf8')) as Partial<UploadMeta>;
    if (!raw || typeof raw.name !== 'string' || !(Number(raw.size) > 0)) return null;
    return {
      name: raw.name,
      size: Math.floor(Number(raw.size)),
      lastModified: Number.isFinite(Number(raw.lastModified)) && raw.lastModified != null ? Number(raw.lastModified) : null,
      startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export interface BgsUploadInfo {
  /** Есть незаконченная загрузка. */
  active: boolean;
  name: string | null;
  size: number;
  received: number;
  startedAt: string | null;
}

export function bgsUploadInfo(archive = bgsArchivePath()): BgsUploadInfo {
  const meta = readUploadMeta(archive);
  if (!meta) return { active: false, name: null, size: 0, received: 0, startedAt: null };
  return { active: true, name: meta.name, size: meta.size, received: sizeOf(bgsUploadFile(archive)), startedAt: meta.startedAt };
}

function cleanName(value: unknown): string {
  const name = String(value ?? '').replace(/[\\/]/g, '_').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 200);
  return name || 'systemsPopulated.json.gz';
}

/**
 * Начать (или продолжить) загрузку файла. Тот же файл — то же имя, размер и
 * дата — продолжается с того места, где оборвался.
 */
export function startBgsUpload(
  input: { name?: unknown; size?: unknown; lastModified?: unknown },
  archive = bgsArchivePath(),
): { offset: number; size: number; resumed: boolean } {
  if (isBgsSyncRunning()) throw new BgsUploadError('Идёт загрузка данных — дождитесь её конца или остановите', 409);
  const size = Math.floor(Number(input.size));
  if (!Number.isFinite(size) || size < MIN_UPLOAD_BYTES) throw new BgsUploadError('Файл пустой');
  if (size > BGS_UPLOAD_MAX_BYTES) throw new BgsUploadError(`Файл больше ${formatBgsBytes(BGS_UPLOAD_MAX_BYTES)} — это не дамп systemsPopulated`);
  const name = cleanName(input.name);
  if (!/\.gz$/i.test(name)) throw new BgsUploadError('Нужен архив .json.gz (systemsPopulated.json.gz с EDSM), а не распакованный файл');
  const lastModified = Number.isFinite(Number(input.lastModified)) && input.lastModified != null ? Number(input.lastModified) : null;
  const file = bgsUploadFile(archive);
  const previous = readUploadMeta(archive);
  if (previous && previous.name === name && previous.size === size && previous.lastModified === lastModified && existsSync(file)) {
    const offset = Math.min(sizeOf(file), size);
    return { offset, size, resumed: offset > 0 };
  }
  const dir = dirname(archive);
  mkdirSync(dir, { recursive: true });
  rmSync(file, { force: true });
  const free = freeBytes(dir);
  // Старый архив уступит место новому, но до конца загрузки лежат оба.
  if (free != null && free < size + DISK_RESERVE_BYTES) {
    throw new BgsUploadError(`Недостаточно места на диске: свободно ${formatBgsBytes(free)}, нужно ~${formatBgsBytes(size + DISK_RESERVE_BYTES)} (${dir})`, 507);
  }
  const meta: UploadMeta = { name, size, lastModified, startedAt: new Date().toISOString() };
  writeFileAtomic(uploadMetaPath(archive), JSON.stringify(meta, null, 1));
  writeFileAtomic(file, Buffer.alloc(0));
  return { offset: 0, size, resumed: false };
}

type UploadGlobal = typeof globalThis & { edrcBgsUploadLock?: Promise<unknown> };

/** Куски пишутся строго по одному: повтор запроса не допишет байты дважды. */
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const holder = globalThis as UploadGlobal;
  const run = (holder.edrcBgsUploadLock ?? Promise.resolve()).catch(() => undefined).then(task);
  holder.edrcBgsUploadLock = run.catch(() => undefined);
  return run;
}

/** Дописать кусок, если `offset` — ровно размер уже принятого. */
export function appendBgsUpload(
  offset: number,
  body: Uint8Array,
  archive = bgsArchivePath(),
): Promise<{ offset: number; size: number; complete: boolean }> {
  return serialized(async () => {
    const meta = readUploadMeta(archive);
    const file = bgsUploadFile(archive);
    if (!meta || !existsSync(file)) throw new BgsUploadError('Загрузка не начата или отменена — выберите файл заново', 409, 0);
    const current = sizeOf(file);
    if (!Number.isFinite(offset) || offset !== current) {
      throw new BgsUploadError(`Сервер принял ${current} байт, а кусок начинается с ${offset}`, 409, current);
    }
    if (body.length === 0) throw new BgsUploadError('Пустой кусок');
    if (current + body.length > meta.size) {
      throw new BgsUploadError(`Кусок выходит за конец файла (${meta.size} байт)`, 400, current);
    }
    await appendFile(file, body);
    const now = sizeOf(file);
    return { offset: now, size: meta.size, complete: now === meta.size };
  });
}

/** Первые мегабайты распакованного дампа: это массив систем EDSM? */
function looksLikeEdsmDump(head: Buffer): string | null {
  if (head.length < 2 || head[0] !== 0x1f || head[1] !== 0x8b) return 'это не gzip';
  let text: string;
  try {
    // Начало файла без конца: Z_SYNC_FLUSH распаковывает, не требуя хвоста gzip.
    text = gunzipSync(head, { finishFlush: zlibConstants.Z_SYNC_FLUSH }).subarray(0, 256 * 1024).toString('utf8');
  } catch (error) {
    return `gzip не распаковывается (${(error as Error).message})`;
  }
  const start = text.trimStart();
  if (!start.startsWith('[')) return 'внутри не JSON-массив';
  const first = start.slice(1).trimStart();
  if (first.startsWith(']')) return 'дамп пустой';
  if (!first.startsWith('{') || !/"id64"\s*:/.test(first.slice(0, 4096)) || !/"name"\s*:/.test(first.slice(0, 4096))) {
    return 'внутри не системы EDSM (нет id64 и name)';
  }
  return null;
}

export interface BgsUploadResult {
  bytes: number;
  name: string;
  /** Размер совпал с дампом на EDSM — архиву даны его ETag и дата. */
  sameAsEdsm: boolean;
  source: BgsDumpSource;
}

/**
 * Файл загружен целиком: проверить, что это дамп EDSM, и сделать его архивом.
 * `probe` — запрос к EDSM за размером и ETag текущего дампа (недоступен — не
 * беда: архив получит свою метку).
 */
export async function finishBgsUpload(
  options: { archive?: string; url?: string; fetchImpl?: typeof fetch; probeTimeoutMs?: number } = {},
): Promise<BgsUploadResult> {
  const archive = options.archive ?? bgsArchivePath();
  const url = options.url ?? bgsDumpUrl();
  return serialized(async () => {
    if (isBgsSyncRunning()) throw new BgsUploadError('Идёт загрузка данных — дождитесь её конца или остановите', 409);
    const meta = readUploadMeta(archive);
    const file = bgsUploadFile(archive);
    if (!meta || !existsSync(file)) throw new BgsUploadError('Загрузка не начата или отменена — выберите файл заново', 409, 0);
    const size = sizeOf(file);
    if (size !== meta.size) throw new BgsUploadError(`Файл загружен не до конца: ${size} из ${meta.size} байт`, 409, size);
    const head = readFileHead(file, 1024 * 1024);
    const problem = looksLikeEdsmDump(head);
    if (problem) {
      rmSync(file, { force: true });
      rmSync(uploadMetaPath(archive), { force: true });
      throw new BgsUploadError(`Файл не похож на systemsPopulated.json.gz с EDSM: ${problem}. Загрузка удалена`, 422);
    }

    let sameAsEdsm = false;
    let source: BgsDumpSource = {
      url,
      etag: uploadedDumpEtag(size, head),
      lastModified: new Date(meta.lastModified ?? Date.now()).toUTCString(),
      total: size,
    };
    try {
      const probe = await probeDumpSource(url, {
        fetchImpl: bgsEdsmFetch(options.fetchImpl),
        signal: AbortSignal.timeout(Math.max(1000, options.probeTimeoutMs ?? 15_000)),
      });
      if (probe.total === size) {
        // Байт в байт размер сегодняшнего дампа: это он и есть.
        sameAsEdsm = true;
        source = { url, etag: probe.etag, lastModified: probe.lastModified ?? source.lastModified, total: size };
      }
    } catch {
      // EDSM не ответил — архив остаётся со своей меткой.
    }

    removeArchive(archive);
    const shardsDir = bgsShardsDirFor(archive);
    const manifest = readBgsShardManifest(shardsDir);
    if (manifest && !sameBgsDumpSource(manifest.source, source)) clearBgsShards(shardsDir);
    renameSync(file, archive);
    rmSync(uploadMetaPath(archive), { force: true });
    writeArchiveMeta(archive, { ...source, completedAt: new Date().toISOString(), uploaded: true, uploadName: meta.name });
    const written = readArchiveMeta(archive);
    if (!written?.completedAt) throw new BgsUploadError('Не удалось записать метку архива — проверьте права на каталог', 500);
    return { bytes: size, name: meta.name, sameAsEdsm, source };
  });
}

/** Отменить незаконченную загрузку. */
export function cancelBgsUpload(archive = bgsArchivePath()): { removed: boolean; freed: number } {
  const file = bgsUploadFile(archive);
  const existed = existsSync(file) || existsSync(uploadMetaPath(archive));
  const freed = sizeOf(file);
  rmSync(file, { force: true });
  rmSync(uploadMetaPath(archive), { force: true });
  return { removed: existed, freed };
}
