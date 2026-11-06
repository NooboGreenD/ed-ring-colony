import { NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/billing/auth';
import {
  assembleLauncherUpload,
  acquireLauncherUploadFinalizeLock,
  cancelLauncherUpload,
  createLauncherUpload,
  getLauncherUploadSession,
  LauncherUploadError,
  releaseLauncherUploadFinalizeLock,
  writeLauncherUploadChunk,
} from '@/lib/launcherUploadSessions';
import { LAUNCHER_UPLOAD_CHUNK_BYTES } from '@/lib/launcherUploadProtocol';
import { publicOrigin } from '@/lib/siteUrl';
import { readSetup, removeSetup, saveSetupBinary } from '@/lib/uploaderStore';
import { apiTranslate } from '@/lib/i18n/apiT';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = { headers: { 'Cache-Control': 'no-store' } };

/**
 * Загрузка установщика `ColonialHelperSetup.exe` в админке.
 *
 * Установщик — это то, что пилот качает с сайта для первой установки. От
 * базовой сборки (`ColonialHelper.exe`, канал обновлений) он отличается и
 * размером, и назначением, поэтому лежит отдельно и не трогает канал.
 *
 * Файл большой, поэтому принимается теми же частями по 4 МиБ, что и базовая
 * сборка: одиночное тело в 200+ МиБ не проходит через прокси.
 */
/**
 * Адрес установщика для пилотов.
 *
 * Строится от настроенного публичного адреса сайта (`NEXT_PUBLIC_SITE_URL`), а
 * не от `Host` запроса: за nginx там приходит `0.0.0.0:3000`, и эта ссылка
 * уезжала в админку, а после загрузки файла — ещё и в метаданные установщика.
 */
function publicSetupUrl(_request: Request, platform: string): string {
  return `${publicOrigin()}/api/uploader/setup/${encodeURIComponent(platform)}`;
}

function jsonError(error: unknown, t: (key: string, params?: Record<string, string | number>) => string, fallback = t('adm.publishFailed')) {
  const status = error instanceof LauncherUploadError ? error.status : 500;
  const detail = error instanceof Error ? error.message : String(error);
  const message = /EACCES|permission denied/i.test(detail)
    ? t('adm.storageNotWritable')
    : `${fallback}: ${detail}`;
  return NextResponse.json({ ok: false, error: message }, { status, ...NO_STORE });
}

async function setupPayload(platform: string, request: Request) {
  const info = await readSetup(platform);
  return {
    ok: true,
    platform,
    setup: info,
    downloadUrl: info ? publicSetupUrl(request, platform) : '',
  };
}

async function readChunkBody(request: Request, t: (key: string, params?: Record<string, string | number>) => string): Promise<Buffer> {
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared < 0) {
      throw new LauncherUploadError(t('adm.chunkLengthInvalid'), 400);
    }
    if (declared > LAUNCHER_UPLOAD_CHUNK_BYTES) {
      throw new LauncherUploadError(t('adm.chunkTooLarge4Mib'), 413);
    }
  }
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > LAUNCHER_UPLOAD_CHUNK_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new LauncherUploadError(t('adm.chunkTooLarge4Mib'), 413);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    try { reader.releaseLock(); } catch { /* поток уже закрыт */ }
  }
  return Buffer.concat(chunks, total);
}

async function postChunk(request: Request, t: (key: string, params?: Record<string, string | number>) => string) {
  const uploadId = request.headers.get('x-helper-upload-id') ?? '';
  const rawIndex = request.headers.get('x-helper-chunk-index') ?? '';
  if (!/^(0|[1-9]\d*)$/.test(rawIndex)) {
    return NextResponse.json({ ok: false, error: t('adm.chunkIndexInvalid') }, { status: 400, ...NO_STORE });
  }
  const data = await readChunkBody(request, t);
  await writeLauncherUploadChunk(uploadId, Number(rawIndex), data);
  return NextResponse.json({ ok: true }, NO_STORE);
}

async function completeUpload(request: Request, uploadId: string, t: (key: string, params?: Record<string, string | number>) => string) {
  await getLauncherUploadSession(uploadId);
  if (!(await acquireLauncherUploadFinalizeLock(uploadId))) {
    return NextResponse.json({ ok: false, error: t('adm.buildAlreadyRunning') }, { status: 409, ...NO_STORE });
  }
  try {
    const { session, data } = await assembleLauncherUpload(uploadId);
    const platform = session.platform;
    const result = await saveSetupBinary(
      platform,
      session.version,
      data,
      publicSetupUrl(request, platform),
    );
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.error || t('adm.setupNotSaved') }, { status: 400, ...NO_STORE });
    }
    // Части больше не нужны: собранный файл уже лежит в хранилище.
    await cancelLauncherUpload(uploadId).catch(() => undefined);
    const info = await readSetup(platform);
    return NextResponse.json({
      ok: true,
      setup: info,
      downloadUrl: publicSetupUrl(request, platform),
    }, NO_STORE);
  } finally {
    await releaseLauncherUploadFinalizeLock(uploadId);
  }
}

export async function GET(request: Request) {
  const t = await apiTranslate();
  const auth = await requireAdmin(request);
  if ('response' in auth) return auth.response;
  const platform = (new URL(request.url).searchParams.get('platform') ?? 'win64').trim().toLowerCase();
  try {
    return NextResponse.json(await setupPayload(platform, request), NO_STORE);
  } catch (error) {
    return jsonError(error, t, 'adm.setupReadFailed');
  }
}

export async function POST(request: Request) {
  const t = await apiTranslate();
  const auth = await requireAdmin(request);
  if ('response' in auth) return auth.response;

  const contentType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  const chunkAction = request.headers.get('x-helper-upload-action')?.toLowerCase();
  if (contentType === 'application/octet-stream') {
    if (chunkAction !== 'chunk') {
      return NextResponse.json({ ok: false, error: t('adm.chunkOperationMissing') }, { status: 400, ...NO_STORE });
    }
    try {
      return await postChunk(request, t);
    } catch (error) {
      return jsonError(error, t, 'adm.setupUploadChunkFailed');
    }
  }

  let body: Record<string, unknown> | null = null;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    body = null;
  }
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ ok: false, error: t('adm.setupUploadRequestInvalid') }, { status: 400, ...NO_STORE });
  }

  const action = String(body.action ?? '');
  if (action === 'begin') {
    try {
      const session = await createLauncherUpload({
        kind: 'setup',
        platform: String(body.platform ?? 'win64').trim().toLowerCase(),
        version: String(body.version ?? '').trim().replace(/^v/i, ''),
        size: Number(body.size),
        chunkSize: Number(body.chunkSize ?? LAUNCHER_UPLOAD_CHUNK_BYTES),
      });
      return NextResponse.json({
        ok: true,
        uploadId: session.id,
        chunkSize: session.chunkSize,
        totalChunks: session.totalChunks,
      }, { status: 201, ...NO_STORE });
    } catch (error) {
      return jsonError(error, t, 'adm.setupUploadStartFailed');
    }
  }

  const uploadId = String(body.uploadId ?? '');
  if (!uploadId) {
    return NextResponse.json({ ok: false, error: t('adm.uploadIdMissing') }, { status: 400, ...NO_STORE });
  }

  if (action === 'complete') {
    try {
      return await completeUpload(request, uploadId, t);
    } catch (error) {
      return jsonError(error, t, 'adm.setupUploadAssembleFailed');
    }
  }

  if (action === 'cancel') {
    try {
      await cancelLauncherUpload(uploadId);
      return NextResponse.json({ ok: true }, NO_STORE);
    } catch (error) {
      return jsonError(error, t, 'adm.setupUploadCancelFailed');
    }
  }

  return NextResponse.json({ ok: false, error: t('adm.setupOpUnknown') }, { status: 400, ...NO_STORE });
}

export async function DELETE(request: Request) {
  const t = await apiTranslate();
  const auth = await requireAdmin(request);
  if ('response' in auth) return auth.response;
  const platform = (new URL(request.url).searchParams.get('platform') ?? 'win64').trim().toLowerCase();
  const info = await readSetup(platform);
  if (!info) {
    return NextResponse.json({ ok: false, error: t('adm.setupNotUploaded') }, { status: 404, ...NO_STORE });
  }
  const removed = await removeSetup(platform);
  return NextResponse.json(removed, { status: removed.ok ? 200 : 400, ...NO_STORE });
}
