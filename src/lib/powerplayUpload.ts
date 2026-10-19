/**
 * Архив дампа EDSM `powerPlay.json.gz`, загруженный в админке с компьютера
 * администратора (Игровые данные → PowerPlay → «Загрузить архив с
 * компьютера»).
 *
 * Зачем: EDSM стоит за Cloudflare, а сеть российского сервера «замораживает»
 * TCP-сессии к зарубежным CDN после ~16 КБ. Даже 3,6 МБ дампа PowerPlay так
 * качаются минутами короткими запросами, а если сеть замораживает и их — не
 * качаются вовсе. Компьютер администратора (другая сеть, VPN) скачивает файл
 * за секунды; входящие соединения к серверу фильтрация не трогает.
 *
 * Механизм общий с минорными фракциями (`dumpUpload.ts`), маршрут —
 * `/api/admin/powerplay/upload`: `start` → `PUT ?offset=N` кусками по 8 МБ
 * (409 — продолжить с принятого сервером) → `finish` (проверка: gzip, внутри
 * массив записей PowerPlay EDSM; размер совпал с дампом на EDSM — архив
 * получает его ETag и дату) → дальше «Загрузить данные» разбивает архив на
 * куски и пишет в базу без EDSM. `cancel` удаляет незаконченную загрузку.
 */

import {
  DUMP_UPLOAD_CHUNK_BYTES,
  createDumpUpload,
  dumpUploadFile,
  inspectEdsmArrayHead,
  type DumpUploadInfo,
  type DumpUploadResult,
} from './dumpUpload.ts';
import { POWERPLAY_MAX_ARCHIVE_BYTES, clearPowerplayShards, readPowerplayShardManifest } from './powerplayShards.ts';
import {
  POWERPLAY_ARCHIVE_SOURCE_NAME,
  isPowerplaySyncRunning,
  powerplayArchivePath,
  powerplayDumpUrl,
  powerplayEdsmFetch,
  powerplayShardsDirFor,
} from './powerplaySync.ts';

export { DumpUploadError as PowerplayUploadError } from './dumpUpload.ts';

/** Кусок, который браузер шлёт за раз: меньше `client_max_body_size 25m` nginx и `proxyClientMaxBodySize` Next.js. */
export const POWERPLAY_UPLOAD_CHUNK_BYTES = DUMP_UPLOAD_CHUNK_BYTES;
/** Дамп весит ≈3,6 МБ; больше 64 МБ — точно не он (тот же предел, что у разбивки). */
export const POWERPLAY_UPLOAD_MAX_BYTES = POWERPLAY_MAX_ARCHIVE_BYTES;

export type PowerplayUploadInfo = DumpUploadInfo;
export type PowerplayUploadResult = DumpUploadResult;

const upload = createDumpUpload({
  archivePath: () => powerplayArchivePath(),
  lockKey: 'edrcPowerplayUploadLock',
  isBusy: isPowerplaySyncRunning,
  maxBytes: POWERPLAY_UPLOAD_MAX_BYTES,
  sourceName: POWERPLAY_ARCHIVE_SOURCE_NAME,
  dumpLabel: 'powerPlay',
  // Запись дампа PowerPlay — система и одна из держав в ней: power и powerState обязательны.
  // Так отсекается и systemsPopulated.json.gz, загруженный сюда по ошибке.
  inspect: (text) => inspectEdsmArrayHead(text, ['power', 'powerState', 'name'], 'внутри не системы PowerPlay EDSM (нет power, powerState и name)'),
  dumpUrl: () => powerplayDumpUrl(),
  edsmFetch: powerplayEdsmFetch,
  shardsDirFor: powerplayShardsDirFor,
  shardsSource: (dir) => readPowerplayShardManifest(dir)?.source ?? null,
  clearShards: clearPowerplayShards,
});

export function powerplayUploadFile(archive = powerplayArchivePath()): string {
  return dumpUploadFile(archive);
}

export function powerplayUploadInfo(archive = powerplayArchivePath()): PowerplayUploadInfo {
  return upload.info(archive);
}

/** Начать (или продолжить тот же файл — имя, размер, дата — с принятого байта). */
export function startPowerplayUpload(
  input: { name?: unknown; size?: unknown; lastModified?: unknown },
  archive = powerplayArchivePath(),
): { offset: number; size: number; resumed: boolean } {
  return upload.start(input, archive);
}

/** Дописать кусок, если `offset` — ровно размер уже принятого (иначе 409 с настоящим размером). */
export function appendPowerplayUpload(
  offset: number,
  body: Uint8Array,
  archive = powerplayArchivePath(),
): Promise<{ offset: number; size: number; complete: boolean }> {
  return upload.append(offset, body, archive);
}

/** Файл целиком: проверить, что это дамп PowerPlay EDSM, и сделать его архивом. */
export function finishPowerplayUpload(
  options: { archive?: string; url?: string; fetchImpl?: typeof fetch; probeTimeoutMs?: number } = {},
): Promise<PowerplayUploadResult> {
  return upload.finish(options);
}

/** Отменить незаконченную загрузку. */
export function cancelPowerplayUpload(archive = powerplayArchivePath()): { removed: boolean; freed: number } {
  return upload.cancel(archive);
}
