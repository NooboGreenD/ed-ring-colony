/**
 * Архив дампа EDSM `systemsPopulated.json.gz`, загруженный в админке с
 * компьютера администратора (Игровые данные → Фракции).
 *
 * Зачем: серверу EDSM может быть недоступен. EDSM стоит за Cloudflare, а сеть
 * российского сервера «замораживает» TCP-сессии к зарубежным CDN после
 * ~16 КБ: архив в 0,5 ГБ так не скачать. Компьютер администратора (другая
 * сеть, VPN) скачивает его за минуту — дальше файл нужно только передать на
 * сервер, а входящие соединения к серверу эта фильтрация не трогает.
 *
 * Механизм общий с PowerPlay (`dumpUpload.ts`), маршрут —
 * `/api/admin/factions/upload`:
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

import { clearBgsShards, readBgsShardManifest } from './bgsShards.ts';
import { bgsArchivePath, bgsDumpUrl, bgsEdsmFetch, bgsShardsDirFor, isBgsSyncRunning } from './bgsSync.ts';
import {
  DUMP_UPLOAD_CHUNK_BYTES,
  DumpUploadError,
  createDumpUpload,
  dumpUploadFile,
  inspectEdsmArrayHead,
  type DumpUploadInfo,
  type DumpUploadResult,
} from './dumpUpload.ts';

/** Кусок, который браузер шлёт за раз: меньше `client_max_body_size 25m` nginx и `proxyClientMaxBodySize` Next.js. */
export const BGS_UPLOAD_CHUNK_BYTES = DUMP_UPLOAD_CHUNK_BYTES;
/** Дамп весит ≈0,5 ГБ; больше 4 ГБ — точно не он. */
export const BGS_UPLOAD_MAX_BYTES = 4 * 1024 ** 3;

/** Ошибка с HTTP-статусом для маршрута; `offset` — настоящий размер принятого (409). */
export { DumpUploadError as BgsUploadError };
export type BgsUploadInfo = DumpUploadInfo;
export type BgsUploadResult = DumpUploadResult;

const upload = createDumpUpload({
  archivePath: () => bgsArchivePath(),
  lockKey: 'edrcBgsUploadLock',
  isBusy: isBgsSyncRunning,
  maxBytes: BGS_UPLOAD_MAX_BYTES,
  sourceName: 'systemsPopulated.json.gz',
  dumpLabel: 'systemsPopulated',
  // Первые мегабайты распакованного дампа: это массив систем EDSM?
  inspect: (text) => inspectEdsmArrayHead(text, ['id64', 'name'], 'внутри не системы EDSM (нет id64 и name)'),
  dumpUrl: () => bgsDumpUrl(),
  edsmFetch: bgsEdsmFetch,
  shardsDirFor: bgsShardsDirFor,
  shardsSource: (dir) => readBgsShardManifest(dir)?.source ?? null,
  clearShards: clearBgsShards,
});

export function bgsUploadFile(archive = bgsArchivePath()): string {
  return dumpUploadFile(archive);
}

export function bgsUploadInfo(archive = bgsArchivePath()): BgsUploadInfo {
  return upload.info(archive);
}

/**
 * Начать (или продолжить) загрузку файла. Тот же файл — то же имя, размер и
 * дата — продолжается с того места, где оборвался.
 */
export function startBgsUpload(
  input: { name?: unknown; size?: unknown; lastModified?: unknown },
  archive = bgsArchivePath(),
): { offset: number; size: number; resumed: boolean } {
  return upload.start(input, archive);
}

/** Дописать кусок, если `offset` — ровно размер уже принятого. */
export function appendBgsUpload(
  offset: number,
  body: Uint8Array,
  archive = bgsArchivePath(),
): Promise<{ offset: number; size: number; complete: boolean }> {
  return upload.append(offset, body, archive);
}

/**
 * Файл загружен целиком: проверить, что это дамп EDSM, и сделать его архивом.
 * `probe` — запрос к EDSM за размером и ETag текущего дампа (недоступен — не
 * беда: архив получит свою метку).
 */
export function finishBgsUpload(
  options: { archive?: string; url?: string; fetchImpl?: typeof fetch; probeTimeoutMs?: number } = {},
): Promise<BgsUploadResult> {
  return upload.finish(options);
}

/** Отменить незаконченную загрузку. */
export function cancelBgsUpload(archive = bgsArchivePath()): { removed: boolean; freed: number } {
  return upload.cancel(archive);
}
