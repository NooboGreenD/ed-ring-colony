/**
 * Архив дампа EDSM, загруженный в админке с компьютера администратора, —
 * общий механизм для импортов «архив → куски → база»: минорные фракции
 * (`bgsUpload.ts`, `systemsPopulated.json.gz`) и PowerPlay
 * (`powerplayUpload.ts`, `powerPlay.json.gz`).
 *
 * Зачем: серверу EDSM может быть недоступен. EDSM стоит за Cloudflare, а сеть
 * российского сервера «замораживает» TCP-сессии к зарубежным CDN после
 * ~16 КБ. Компьютер администратора (другая сеть, VPN) скачивает дамп за
 * минуту — дальше файл нужно только передать на сервер, а входящие соединения
 * к серверу эта фильтрация не трогает.
 *
 * Как устроено (маршрут `…/upload` каждого импорта):
 *   * `start` — браузер называет файл (имя, размер, дата). Тот же файл, что
 *     грузился раньше, продолжается с того байта, на котором оборвался;
 *   * `PUT ?offset=N` — кусок файла (8 МБ: меньше лимитов nginx и Next.js)
 *     дописывается во временный `<архив>.upload`, если N — ровно его размер;
 *     иначе 409 с настоящим размером, и браузер продолжает с него;
 *   * `finish` — файл целиком, это gzip с нужным дампом EDSM → он становится
 *     архивом (`<архив>.meta.json` с `uploaded: true`). Если размер совпал с
 *     дампом на EDSM, архив получает его ETag и дату: это тот же самый дамп.
 *     Дальше «Загрузить данные» разбивает его на куски и пишет в базу, не
 *     обращаясь к EDSM;
 *   * `cancel` — временный файл удаляется.
 */

import { appendFile } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { constants as zlibConstants, gunzipSync } from 'node:zlib';

import { freeBytes, readArchiveMeta, readFileHead, removeArchive, uploadedDumpEtag, writeArchiveMeta } from './dumpArchive.ts';
import { sameDumpSource, writeFileAtomic, type DumpSource } from './dumpShards.ts';
import { probeDumpSource } from './galaxyImport.ts';
import { formatImportBytes } from './importProgress.ts';

/** Кусок, который браузер шлёт за раз: меньше `client_max_body_size 25m` nginx и `proxyClientMaxBodySize` Next.js. */
export const DUMP_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
const MIN_UPLOAD_BYTES = 32;
const DISK_RESERVE_BYTES = 256 * 1024 * 1024;

/** Ошибка с HTTP-статусом для маршрута; `offset` — настоящий размер принятого (409). */
export class DumpUploadError extends Error {
  status: number;
  offset?: number;

  constructor(message: string, status = 400, offset?: number) {
    super(message);
    this.name = 'DumpUploadError';
    this.status = status;
    if (offset != null) this.offset = offset;
  }
}

export interface DumpUploadInfo {
  /** Есть незаконченная загрузка. */
  active: boolean;
  name: string | null;
  size: number;
  received: number;
  startedAt: string | null;
}

export interface DumpUploadResult {
  bytes: number;
  name: string;
  /** Размер совпал с дампом на EDSM — архиву даны его ETag и дата. */
  sameAsEdsm: boolean;
  source: DumpSource;
}

export interface DumpUploadConfig {
  /** Путь архива (по умолчанию для всех действий; читается на каждый вызов — окружение могут поменять). */
  archivePath: () => string;
  /** Ключ в globalThis: куски одного импорта пишутся строго по одному. */
  lockKey: string;
  /** Идёт импорт — архив ему нужен, загрузку не начинать и не завершать. */
  isBusy: () => boolean;
  maxBytes: number;
  /** Имя файла на EDSM для подсказок: `systemsPopulated.json.gz`. */
  sourceName: string;
  /** Как назвать дамп в «это не дамп …»: `systemsPopulated`. */
  dumpLabel: string;
  /** Начало распакованного дампа (до 256 КБ текста): `null` — похоже на нужный дамп, иначе — что не так. */
  inspect: (text: string) => string | null;
  dumpUrl: () => string;
  /** `fetch` для запроса к EDSM (свой User-Agent, новое соединение на запрос). */
  edsmFetch: (fetchImpl?: typeof fetch) => typeof fetch;
  shardsDirFor: (archive: string) => string;
  /** Какой дамп разбит в кусках этого каталога (нет кусков — `null`). */
  shardsSource: (dir: string) => DumpSource | null;
  clearShards: (dir: string) => number;
}

interface UploadMeta {
  name: string;
  size: number;
  /** `File.lastModified` в браузере (мс). */
  lastModified: number | null;
  startedAt: string;
}

/** Временный файл незаконченной загрузки. */
export function dumpUploadFile(archive: string): string {
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

/**
 * Начало распакованного файла: gzip без конца распаковывается с Z_SYNC_FLUSH.
 * Возвращает текст (до `maxChars`) или причину, почему это не gzip-архив.
 */
export function gunzipHeadText(head: Buffer, maxChars = 256 * 1024): { text: string } | { problem: string } {
  if (head.length < 2 || head[0] !== 0x1f || head[1] !== 0x8b) return { problem: 'это не gzip' };
  try {
    return { text: gunzipSync(head, { finishFlush: zlibConstants.Z_SYNC_FLUSH }).subarray(0, maxChars).toString('utf8') };
  } catch (error) {
    return { problem: `gzip не распаковывается (${(error as Error).message})` };
  }
}

/**
 * Начало дампа EDSM — JSON-массив записей, у первой записи должны быть ключи
 * `keys`. Возвращает `null` или что не так.
 */
export function inspectEdsmArrayHead(text: string, keys: readonly string[], missing: string): string | null {
  const start = text.trimStart();
  if (!start.startsWith('[')) return 'внутри не JSON-массив';
  const first = start.slice(1).trimStart();
  if (first.startsWith(']')) return 'дамп пустой';
  const record = first.slice(0, 4096);
  if (!first.startsWith('{') || !keys.every((key) => new RegExp(`"${key}"\\s*:`).test(record))) return missing;
  return null;
}

function cleanName(value: unknown, fallback: string): string {
  const name = String(value ?? '').replace(/[\\/]/g, '_').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 200);
  return name || fallback;
}

type LockGlobal = typeof globalThis & Record<string, Promise<unknown> | undefined>;

export function createDumpUpload(config: DumpUploadConfig) {
  const busyMessage = 'Идёт загрузка данных — дождитесь её конца или остановите';

  /** Куски пишутся строго по одному: повтор запроса не допишет байты дважды. */
  const serialized = <T>(task: () => Promise<T>): Promise<T> => {
    const holder = globalThis as LockGlobal;
    const run = (holder[config.lockKey] ?? Promise.resolve()).catch(() => undefined).then(task);
    holder[config.lockKey] = run.catch(() => undefined);
    return run;
  };

  const info = (archive = config.archivePath()): DumpUploadInfo => {
    const meta = readUploadMeta(archive);
    if (!meta) return { active: false, name: null, size: 0, received: 0, startedAt: null };
    return { active: true, name: meta.name, size: meta.size, received: sizeOf(dumpUploadFile(archive)), startedAt: meta.startedAt };
  };

  /**
   * Начать (или продолжить) загрузку файла. Тот же файл — то же имя, размер и
   * дата — продолжается с того места, где оборвался.
   */
  const start = (
    input: { name?: unknown; size?: unknown; lastModified?: unknown },
    archive = config.archivePath(),
  ): { offset: number; size: number; resumed: boolean } => {
    if (config.isBusy()) throw new DumpUploadError(busyMessage, 409);
    const size = Math.floor(Number(input.size));
    if (!Number.isFinite(size) || size < MIN_UPLOAD_BYTES) throw new DumpUploadError('Файл пустой');
    if (size > config.maxBytes) throw new DumpUploadError(`Файл больше ${formatImportBytes(config.maxBytes)} — это не дамп ${config.dumpLabel}`);
    const name = cleanName(input.name, config.sourceName);
    if (!/\.gz$/i.test(name)) throw new DumpUploadError(`Нужен архив .json.gz (${config.sourceName} с EDSM), а не распакованный файл`);
    const lastModified = Number.isFinite(Number(input.lastModified)) && input.lastModified != null ? Number(input.lastModified) : null;
    const file = dumpUploadFile(archive);
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
    const reserve = Math.min(DISK_RESERVE_BYTES, Math.max(64 * 1024 * 1024, config.maxBytes));
    if (free != null && free < size + reserve) {
      throw new DumpUploadError(`Недостаточно места на диске: свободно ${formatImportBytes(free)}, нужно ~${formatImportBytes(size + reserve)} (${dir})`, 507);
    }
    const meta: UploadMeta = { name, size, lastModified, startedAt: new Date().toISOString() };
    writeFileAtomic(uploadMetaPath(archive), JSON.stringify(meta, null, 1));
    writeFileAtomic(file, Buffer.alloc(0));
    return { offset: 0, size, resumed: false };
  };

  /** Дописать кусок, если `offset` — ровно размер уже принятого. */
  const append = (
    offset: number,
    body: Uint8Array,
    archive = config.archivePath(),
  ): Promise<{ offset: number; size: number; complete: boolean }> => serialized(async () => {
    const meta = readUploadMeta(archive);
    const file = dumpUploadFile(archive);
    if (!meta || !existsSync(file)) throw new DumpUploadError('Загрузка не начата или отменена — выберите файл заново', 409, 0);
    const current = sizeOf(file);
    if (!Number.isFinite(offset) || offset !== current) {
      throw new DumpUploadError(`Сервер принял ${current} байт, а кусок начинается с ${offset}`, 409, current);
    }
    if (body.length === 0) throw new DumpUploadError('Пустой кусок');
    if (current + body.length > meta.size) {
      throw new DumpUploadError(`Кусок выходит за конец файла (${meta.size} байт)`, 400, current);
    }
    await appendFile(file, body);
    const now = sizeOf(file);
    return { offset: now, size: meta.size, complete: now === meta.size };
  });

  /**
   * Файл загружен целиком: проверить, что это нужный дамп EDSM, и сделать его
   * архивом. Запрос к EDSM — за размером и ETag текущего дампа (недоступен —
   * не беда: архив получит свою метку).
   */
  const finish = (
    options: { archive?: string; url?: string; fetchImpl?: typeof fetch; probeTimeoutMs?: number } = {},
  ): Promise<DumpUploadResult> => {
    const archive = options.archive ?? config.archivePath();
    const url = options.url ?? config.dumpUrl();
    return serialized(async () => {
      if (config.isBusy()) throw new DumpUploadError(busyMessage, 409);
      const meta = readUploadMeta(archive);
      const file = dumpUploadFile(archive);
      if (!meta || !existsSync(file)) throw new DumpUploadError('Загрузка не начата или отменена — выберите файл заново', 409, 0);
      const size = sizeOf(file);
      if (size !== meta.size) throw new DumpUploadError(`Файл загружен не до конца: ${size} из ${meta.size} байт`, 409, size);
      const head = readFileHead(file, 1024 * 1024);
      const unpacked = gunzipHeadText(head);
      const problem = 'problem' in unpacked ? unpacked.problem : config.inspect(unpacked.text);
      if (problem) {
        rmSync(file, { force: true });
        rmSync(uploadMetaPath(archive), { force: true });
        throw new DumpUploadError(`Файл не похож на ${config.sourceName} с EDSM: ${problem}. Загрузка удалена`, 422);
      }

      let sameAsEdsm = false;
      let source: DumpSource = {
        url,
        etag: uploadedDumpEtag(size, head),
        lastModified: new Date(meta.lastModified ?? Date.now()).toUTCString(),
        total: size,
      };
      try {
        const probe = await probeDumpSource(url, {
          fetchImpl: config.edsmFetch(options.fetchImpl),
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

      // Пока шёл запрос к EDSM, импорт мог начаться (задача, ленивое
      // обновление): его архив трогать нельзя. Принятый файл остаётся —
      // «Завершить» можно повторить, когда импорт закончится.
      if (config.isBusy()) throw new DumpUploadError(busyMessage, 409);
      removeArchive(archive);
      const shardsDir = config.shardsDirFor(archive);
      const shards = config.shardsSource(shardsDir);
      if (shards && !sameDumpSource(shards, source)) config.clearShards(shardsDir);
      renameSync(file, archive);
      rmSync(uploadMetaPath(archive), { force: true });
      writeArchiveMeta(archive, { ...source, completedAt: new Date().toISOString(), uploaded: true, uploadName: meta.name });
      const written = readArchiveMeta(archive);
      if (!written?.completedAt) throw new DumpUploadError('Не удалось записать метку архива — проверьте права на каталог', 500);
      return { bytes: size, name: meta.name, sameAsEdsm, source };
    });
  };

  /** Отменить незаконченную загрузку. */
  const cancel = (archive = config.archivePath()): { removed: boolean; freed: number } => {
    const file = dumpUploadFile(archive);
    const existed = existsSync(file) || existsSync(uploadMetaPath(archive));
    const freed = sizeOf(file);
    rmSync(file, { force: true });
    rmSync(uploadMetaPath(archive), { force: true });
    return { removed: existed, freed };
  };

  return { info, start, append, finish, cancel };
}
