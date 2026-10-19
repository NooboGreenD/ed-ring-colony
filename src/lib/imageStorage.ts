import { getPublicSupabaseUrl } from './supabaseUrl';

export function errorText(error: unknown): string {
  if (!error) return 'неизвестная ошибка';
  if (error instanceof Error) return error.message;
  const record = error as { message?: unknown; error?: unknown };
  if (typeof record.message === 'string') return record.message;
  if (typeof record.error === 'string') return record.error;
  return String(error);
}

/**
 * Недоступность хранилища (в отличие от «файл не подошёл»).
 * 503/502/504 приходят от шлюза, `fetch failed`/таймаут — от самого Node.
 */
function looksUnavailable(error: unknown): boolean {
  const status = Number((error as { statusCode?: unknown; status?: unknown })?.statusCode
    ?? (error as { status?: unknown })?.status);
  if (Number.isFinite(status) && status >= 500) return true;
  const text = errorText(error).toLowerCase();
  return (
    text.includes('fetch failed') ||
    text.includes('service unavailable') ||
    text.includes('econnrefused') ||
    text.includes('enotfound') ||
    text.includes('timeout') ||
    text.includes('aborted') ||
    text.includes('network')
  );
}

interface UploadOutcome {
  url: string | null;
  error: string | null;
  unavailable: boolean;
}

/** Попытка положить файл в бакет; бакет создаётся, если его ещё нет. */
export async function uploadImageToStorage(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  svc: any,
  bucket: string,
  maxBytes: number,
  path: string,
  buffer: Buffer,
  contentType: string,
): Promise<UploadOutcome> {
  const put = async () =>
    svc.storage.from(bucket).upload(path, buffer, { contentType, upsert: true });

  try {
    let { error } = await put();

    // «Bucket not found» — обычное состояние свежей установки, где SQL
    // накатили раньше, чем подняли контейнеры storage.
    if (error && /bucket not found/i.test(errorText(error))) {
      const created = await svc.storage.createBucket(bucket, { public: true, fileSizeLimit: maxBytes, allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] });
      if (!created?.error || /already exists|duplicate/i.test(errorText(created.error))) ({ error } = await put());
      else error = created.error;
    }

    if (error) {
      return { url: null, error: errorText(error), unavailable: looksUnavailable(error) };
    }
    // The service client may use an unencrypted Docker URL (`http://kong:8000`).
    // Never persist that private host: browsers must receive the public
    // same-origin gateway URL instead.
    const url = `${getPublicSupabaseUrl()}/storage/v1/object/public/${bucket}/${path}`;
    return { url, error: null, unavailable: false };
  } catch (err) {
    // Сеть до Storage вообще не установилась — это точно «недоступно».
    return { url: null, error: errorText(err), unavailable: true };
  }
}

