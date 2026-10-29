import { MAX_SETUP_UPLOAD_BYTES } from '@/lib/launcherUploadProtocol';

/**
 * Загрузка установщика частями.
 *
 * Протокол тот же, что у базовой сборки (`launcherChunkUpload`): ни один
 * прокси не видит файл целиком в одном теле запроса. Отличается адрес и то,
 * что сервер отвечает метаданными установщика, а не задачей публикации:
 * канал обновлений установщик не трогает.
 */
const SETUP_ENDPOINT = '/api/admin/uploader/setup';
const CHUNK_SIZES = [4 * 1024 * 1024, 2 * 1024 * 1024, 1024 * 1024];
const MIN_CHUNK_BYTES = 1024 * 1024;

export interface SetupInfo {
  platform: string;
  version: string;
  url: string;
  sha256: string;
  size: number;
  updated_at?: string;
}

type AuthenticatedFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type RequestStage = 'begin' | 'chunk' | 'complete';

interface UploadResponse {
  ok?: boolean;
  error?: string;
  uploadId?: string;
  chunkSize?: number;
  totalChunks?: number;
  setup?: SetupInfo | null;
  downloadUrl?: string;
}

class SetupUploadHttpError extends Error {
  constructor(message: string, readonly status: number, readonly stage: RequestStage) {
    super(message);
    this.name = 'SetupUploadHttpError';
  }
}

async function checkedJson(response: Response, stage: RequestStage): Promise<UploadResponse> {
  const body = await response.json().catch(() => null) as UploadResponse | null;
  if (!response.ok || !body || body.ok !== true) {
    const message = body?.error || (response.status === 413
      ? 'HTTP 413 — прокси отклонил часть ColonialHelperSetup.exe.'
      : `HTTP ${response.status || 0}`);
    throw new SetupUploadHttpError(message, response.status, stage);
  }
  return body;
}

async function cancelSession(fetcher: AuthenticatedFetch, uploadId: string): Promise<void> {
  await fetcher(SETUP_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'cancel', uploadId }),
  }).catch(() => undefined);
}

async function uploadAttempt(input: {
  file: Blob;
  version: string;
  platform: string;
  chunkSize: number;
  fetcher: AuthenticatedFetch;
  onProgress?: (uploadedBytes: number, totalBytes: number, completedChunks: number, totalChunks: number) => void;
}): Promise<{ setup: SetupInfo | null; downloadUrl: string }> {
  const { file, fetcher } = input;
  let uploadId = '';
  try {
    const startResponse = await fetcher(SETUP_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'begin',
        platform: input.platform,
        version: input.version,
        size: file.size,
        chunkSize: input.chunkSize,
      }),
    });
    const started = await checkedJson(startResponse, 'begin');
    if (!started.uploadId || !Number.isSafeInteger(started.chunkSize) || !Number.isSafeInteger(started.totalChunks)) {
      throw new Error('Сервер вернул неполные параметры загрузки установщика.');
    }
    uploadId = started.uploadId;
    const chunkSize = Number(started.chunkSize);
    const totalChunks = Number(started.totalChunks);
    if (
      chunkSize < MIN_CHUNK_BYTES
      || chunkSize > input.chunkSize
      || totalChunks !== Math.ceil(file.size / chunkSize)
    ) {
      throw new Error('Версия протокола загрузки на сервере не совпадает с сайтом.');
    }

    input.onProgress?.(0, file.size, 0, totalChunks);
    for (let index = 0; index < totalChunks; index += 1) {
      const start = index * chunkSize;
      const end = Math.min(file.size, start + chunkSize);
      const response = await fetcher(SETUP_ENDPOINT, {
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

    const completeResponse = await fetcher(SETUP_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'complete', uploadId }),
    });
    const completed = await checkedJson(completeResponse, 'complete');
    return { setup: completed.setup ?? null, downloadUrl: completed.downloadUrl ?? '' };
  } catch (error) {
    if (uploadId) await cancelSession(fetcher, uploadId);
    throw error;
  }
}

/**
 * Загрузить установщик. Если прокси не пропускает 4 МиБ, размер части
 * уменьшается автоматически — как у базовой сборки.
 */
export async function uploadSetupInChunks(input: {
  file: Blob;
  version: string;
  platform?: string;
  fetcher: AuthenticatedFetch;
  onProgress?: (uploadedBytes: number, totalBytes: number, completedChunks: number, totalChunks: number) => void;
}): Promise<{ setup: SetupInfo | null; downloadUrl: string }> {
  const { file, fetcher } = input;
  if (file.size > MAX_SETUP_UPLOAD_BYTES) {
    throw new Error(`Размер ColonialHelperSetup.exe превышает ${Math.round(MAX_SETUP_UPLOAD_BYTES / (1024 * 1024))} МиБ.`);
  }

  const sizes = CHUNK_SIZES.filter((size, index, all) => size >= MIN_CHUNK_BYTES && all.indexOf(size) === index);
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
      if (error instanceof SetupUploadHttpError && error.status === 413 && error.stage === 'chunk') {
        if (sizes[index + 1]) continue;
        throw new Error(`HTTP 413 — прокси отклонил установщик даже при размере части ${Math.round(chunkSize / (1024 * 1024))} МиБ.`);
      }
      throw error;
    }
  }
  throw new Error('Не удалось подобрать размер части для загрузки установщика.');
}
