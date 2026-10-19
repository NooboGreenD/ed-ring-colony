/**
 * Браузерная часть «Загрузить архив с компьютера» — общая для админки
 * фракций (`/api/admin/factions/upload`) и PowerPlay
 * (`/api/admin/powerplay/upload`); серверная — `dumpUpload.ts`.
 *
 * Файл уходит кусками по `chunkBytes` (8 МБ — меньше лимитов nginx и
 * Next.js), каждый со своим смещением. Обрыв — повтор куска с паузой; 409 —
 * сервер говорит, сколько у него на самом деле, и загрузка продолжается с
 * этого места (в том числе после перезагрузки страницы: тот же файл
 * продолжается, а не начинается заново). В конце — `finish`: сервер
 * проверяет файл и делает его архивом.
 *
 * Только стираемый TypeScript без зависимостей: `fetch` передаёт вызывающий
 * (в админке — `authFetch` с токеном сессии).
 */

/** Ответ, которого достаточно циклу загрузки (настоящий `Response` подходит). */
export interface ArchiveUploadResponse {
  ok: boolean;
  status: number;
  json(): Promise<any>;
}

export type ArchiveUploadFetch = (url: string, init: RequestInit) => Promise<ArchiveUploadResponse>;

/** Ошибка ответа сервера: текст из `error` и HTTP-статус (0 — сеть). */
export class ArchiveUploadHttpError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ArchiveUploadHttpError';
    this.status = status;
  }
}

export const ARCHIVE_UPLOAD_CHUNK_FALLBACK = 8 * 1024 * 1024;
/** Попыток на кусок при обрыве и ответах 5xx/408/429. */
const CHUNK_ATTEMPTS = 6;

/** Загружаемый файл: `File` браузера (имя, размер, дата, `slice`). */
export interface ArchiveUploadFile {
  name: string;
  size: number;
  lastModified: number;
  slice(start?: number, end?: number): Blob;
}

/** Ход загрузки для полосы в админке. */
export interface ArchiveUploadSession {
  name: string;
  size: number;
  sent: number;
  /** С какого байта началась эта сессия (продолжение незаконченной загрузки). */
  startOffset: number;
  startedAt: number;
}

/** POST в маршрут загрузки (`start` / `finish` / `cancel`); не `success` — исключение с текстом сервера. */
export async function postArchiveUpload(
  endpoint: string,
  body: Record<string, unknown>,
  fetchImpl: ArchiveUploadFetch,
): Promise<Record<string, any>> {
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || payload.success === false) {
    throw new ArchiveUploadHttpError(payload?.error || `HTTP ${response.status}`, response.status);
  }
  return payload;
}

/**
 * Передать файл на сервер. Возвращает ответ `finish` (`bytes`, `sameAsEdsm`,
 * `name`). Остановка — `signal`: запрос обрывается, принятое остаётся на
 * сервере, исключение пробрасывается (вызывающий отличает его по
 * `signal.aborted`).
 */
export async function uploadArchiveFile(options: {
  endpoint: string;
  file: ArchiveUploadFile;
  fetchImpl: ArchiveUploadFetch;
  signal: AbortSignal;
  onStart?: (session: ArchiveUploadSession) => void;
  onProgress?: (sent: number) => void;
  sleep?: (ms: number) => Promise<void>;
}): Promise<Record<string, any>> {
  const { endpoint, file, fetchImpl, signal } = options;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const started = await postArchiveUpload(endpoint, { action: 'start', name: file.name, size: file.size, lastModified: file.lastModified }, fetchImpl);
  let offset = Math.max(0, Number(started.offset) || 0);
  const chunkBytes = Math.max(1024, Number(started.chunkBytes) || ARCHIVE_UPLOAD_CHUNK_FALLBACK);
  options.onStart?.({ name: file.name, size: file.size, sent: offset, startOffset: offset, startedAt: Date.now() });
  while (offset < file.size) {
    const end = Math.min(file.size, offset + chunkBytes);
    for (let attempt = 1; ; attempt++) {
      if (signal.aborted) throw new Error('stopped');
      try {
        const response = await fetchImpl(`${endpoint}?offset=${offset}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: file.slice(offset, end),
          signal,
        });
        const payload = await response.json().catch(() => null);
        if (response.status === 409 && typeof payload?.offset === 'number') {
          offset = payload.offset;
          break;
        }
        if (!response.ok || !payload?.success) throw new ArchiveUploadHttpError(payload?.error || `HTTP ${response.status}`, response.status);
        offset = Number(payload.offset);
        break;
      } catch (error) {
        if (signal.aborted) throw error;
        const status = (error as ArchiveUploadHttpError).status ?? 0;
        const retryable = status === 0 || status >= 500 || status === 408 || status === 429;
        if (!retryable || attempt >= CHUNK_ATTEMPTS) throw error;
        await sleep(1500 * attempt);
      }
    }
    options.onProgress?.(offset);
  }
  return postArchiveUpload(endpoint, { action: 'finish' }, fetchImpl);
}
