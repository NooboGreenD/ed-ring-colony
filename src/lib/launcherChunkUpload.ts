import type { HelperReleaseJob } from '@/types/helperRelease';
import {
  LAUNCHER_UPLOAD_CHUNK_BYTES,
  MAX_LAUNCHER_UPLOAD_BYTES,
  MIN_LAUNCHER_UPLOAD_CHUNK_BYTES,
} from '@/lib/launcherUploadProtocol';

const RELEASE_ENDPOINT = '/api/admin/uploader/release';
const FALLBACK_CHUNK_SIZES = [
  LAUNCHER_UPLOAD_CHUNK_BYTES,
  2 * 1024 * 1024,
  MIN_LAUNCHER_UPLOAD_CHUNK_BYTES,
];

type AuthenticatedFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type RequestStage = 'begin' | 'chunk' | 'complete';

interface UploadResponse {
  ok?: boolean;
  error?: string;
  uploadId?: string;
  chunkSize?: number;
  totalChunks?: number;
  job?: HelperReleaseJob | null;
}

class LauncherUploadHttpError extends Error {
  constructor(message: string, readonly status: number, readonly stage: RequestStage) {
    super(message);
    this.name = 'LauncherUploadHttpError';
  }
}

async function checkedJson(response: Response, stage: RequestStage): Promise<UploadResponse> {
  const body = await response.json().catch(() => null) as UploadResponse | null;
  if (!response.ok || !body || body.ok !== true) {
    const message = body?.error || (response.status === 413
      ? 'HTTP 413 — прокси отклонил часть ColonialHelper.exe.'
      : `HTTP ${response.status || 0}`);
    throw new LauncherUploadHttpError(message, response.status, stage);
  }
  return body;
}

async function cancelSession(fetcher: AuthenticatedFetch, uploadId: string): Promise<void> {
  await fetcher(RELEASE_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'launcher', action: 'cancel', uploadId }),
  }).catch(() => undefined);
}

async function uploadAttempt(input: {
  file: Blob;
  version: string;
  platform: string;
  chunkSize: number;
  fetcher: AuthenticatedFetch;
  onProgress?: (uploadedBytes: number, totalBytes: number, completedChunks: number, totalChunks: number) => void;
}): Promise<HelperReleaseJob> {
  const { file, fetcher, chunkSize: requestedChunkSize } = input;
  let uploadId = '';
  try {
    const startResponse = await fetcher(RELEASE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'launcher',
        action: 'begin',
        platform: input.platform,
        version: input.version,
        size: file.size,
        chunkSize: requestedChunkSize,
      }),
    });
    const started = await checkedJson(startResponse, 'begin');
    if (!started.uploadId || !Number.isSafeInteger(started.chunkSize) || !Number.isSafeInteger(started.totalChunks)) {
      throw new Error('Сервер вернул неполные параметры загрузки ColonialHelper.exe.');
    }
    uploadId = started.uploadId;
    const chunkSize = Number(started.chunkSize);
    const totalChunks = Number(started.totalChunks);
    if (
      chunkSize < MIN_LAUNCHER_UPLOAD_CHUNK_BYTES
      || chunkSize > requestedChunkSize
      || totalChunks !== Math.ceil(file.size / chunkSize)
    ) {
      throw new Error('Версия протокола загрузки на сервере не совпадает с сайтом.');
    }

    input.onProgress?.(0, file.size, 0, totalChunks);
    for (let index = 0; index < totalChunks; index += 1) {
      const start = index * chunkSize;
      const end = Math.min(file.size, start + chunkSize);
      const response = await fetcher(RELEASE_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Helper-Upload-Action': 'chunk',
          'X-Helper-Upload-Id': uploadId,
          'X-Helper-Chunk-Index': String(index),
        },
        body: file.slice(start, end),
      });
      await checkedJson(response, 'chunk');
      input.onProgress?.(end, file.size, index + 1, totalChunks);
    }

    const completeResponse = await fetcher(RELEASE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'launcher', action: 'complete', uploadId }),
    });
    const completed = await checkedJson(completeResponse, 'complete');
    if (!completed.job) throw new Error('Сервер не вернул задачу публикации ColonialHelper.exe.');
    return completed.job;
  } catch (error) {
    if (uploadId) await cancelSession(fetcher, uploadId);
    throw error;
  }
}

/**
 * Upload the launcher as independent raw-byte requests, so no proxy ever sees
 * the full 25+ MiB EXE as one request body. If an ingress has a lower cap than
 * 4 MiB, retry the upload with progressively smaller chunks automatically.
 */
export async function uploadLauncherInChunks(input: {
  file: Blob;
  version: string;
  platform?: string;
  fetcher: AuthenticatedFetch;
  onProgress?: (uploadedBytes: number, totalBytes: number, completedChunks: number, totalChunks: number) => void;
  onRetry?: (nextChunkSize: number) => void;
}): Promise<HelperReleaseJob> {
  const { file, fetcher } = input;
  if (file.size > MAX_LAUNCHER_UPLOAD_BYTES) {
    throw new Error('Размер ColonialHelper.exe превышает 128 МиБ.');
  }

  const sizes = FALLBACK_CHUNK_SIZES.filter((size, index, all) => size >= MIN_LAUNCHER_UPLOAD_CHUNK_BYTES && all.indexOf(size) === index);
  for (let index = 0; index < sizes.length; index += 1) {
    const chunkSize = sizes[index];
    try {
      return await uploadAttempt({
        file,
        version: input.version,
        platform: input.platform ?? 'win64',
        chunkSize,
        fetcher,
        onProgress: input.onProgress,
      });
    } catch (error) {
      if (error instanceof LauncherUploadHttpError && error.status === 413 && error.stage === 'chunk') {
        const next = sizes[index + 1];
        if (next) {
          input.onRetry?.(next);
          continue;
        }
        throw new Error(`HTTP 413 — прокси отклонил EXE даже при размере части ${Math.round(chunkSize / (1024 * 1024))} МиБ.`);
      }
      throw error;
    }
  }
  throw new Error('Не удалось подобрать размер части для загрузки ColonialHelper.exe.');
}
