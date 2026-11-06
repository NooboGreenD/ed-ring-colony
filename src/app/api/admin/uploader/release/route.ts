import { NextResponse } from 'next/server';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { requireAdmin } from '@/lib/billing/auth';
import {
  cancelHelperReleaseJob,
  getHelperReleaseJob,
  getLatestHelperReleaseJob,
  startHelperReleaseJob,
} from '@/lib/helperReleaseJobs';
import {
  assembleLauncherUpload,
  acquireLauncherUploadFinalizeLock,
  cancelLauncherUpload,
  createLauncherUpload,
  getLauncherUploadSession,
  LauncherUploadError,
  markLauncherUploadCompleted,
  releaseLauncherUploadFinalizeLock,
  writeLauncherUploadChunk,
} from '@/lib/launcherUploadSessions';
import { LAUNCHER_UPLOAD_CHUNK_BYTES } from '@/lib/launcherUploadProtocol';
import { publicOrigin } from '@/lib/siteUrl';
import {
  CHANNELS,
  createServerRelease,
  saveLauncherBinary,
  type Channel,
} from '@/lib/uploaderStore';
import { apiTranslate } from '@/lib/i18n/apiT';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = { headers: { 'Cache-Control': 'no-store' } };
const SERVER_SOURCE_EXCLUDE = new Set(['build_exe.py', 'build_bundle.py', 'launcher.py', 'updater.py']);

/**
 * Собрать исходники прямо из установленной вместе с сайтом папки uploader.
 * Номер VERSION меняется только в содержимом релиза: администратору не нужно
 * править файл на сервере или предварительно собирать каталог на компьютере.
 */
async function serverSourceFiles(version: string, t: (key: string, params?: Record<string, string | number>) => string): Promise<Map<string, Buffer>> {
  const root = join(process.cwd(), 'uploader');
  const entries = await readdir(root, { withFileTypes: true });
  const files = new Map<string, Buffer>();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.py') || SERVER_SOURCE_EXCLUDE.has(entry.name)) continue;
    let data = await readFile(join(root, entry.name));
    if (entry.name === 'colonial_helper.py') {
      const source = data.toString('utf8');
      if (!/^VERSION\s*=\s*["'][^"']+["']/m.test(source)) {
        throw new Error(t('adm.sourceVersionMissing'));
      }
      data = Buffer.from(source.replace(/^VERSION\s*=\s*["'][^"']+["']/m, `VERSION = "${version}"`), 'utf8');
    }
    files.set(entry.name, data);
  }
  if (files.size === 0) throw new Error(t('adm.sourceDirEmpty', { root }));
  return files;
}

function jsonError(error: unknown, t: (key: string, params?: Record<string, string | number>) => string, fallbackKey?: string) {
  const fallback = fallbackKey ? t(fallbackKey) : t('adm.publishFailed');
  const status = error instanceof LauncherUploadError ? error.status : 500;
  const detail = error instanceof Error ? error.message : String(error);
  const message = /EACCES|permission denied/i.test(detail)
    ? t('adm.storageNotWritable')
    : `${fallback}: ${detail}`;
  return NextResponse.json({ ok: false, error: message }, { status, ...NO_STORE });
}

/**
 * Адрес базовой сборки — тот, что уезжает в канал и в метаданные.
 *
 * Только настроенный публичный адрес сайта: `Host` за nginx — это
 * `0.0.0.0:3000`, а по этой ссылке лаунчер скачивает новый exe.
 */
function publicLauncherUrl(_request: Request, platform: string): string {
  return `${publicOrigin()}/api/uploader/launcher/${encodeURIComponent(platform)}`;
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
    try { reader.releaseLock(); } catch { /* stream already closed */ }
  }
  return Buffer.concat(chunks, total);
}

async function postLauncherChunk(request: Request, t: (key: string, params?: Record<string, string | number>) => string) {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/octet-stream') {
    return NextResponse.json({ ok: false, error: t('adm.exeOctetStream') }, { status: 415, ...NO_STORE });
  }
  const uploadId = request.headers.get('x-helper-upload-id') ?? '';
  const rawIndex = request.headers.get('x-helper-chunk-index') ?? '';
  if (!/^(0|[1-9]\d*)$/.test(rawIndex)) {
    return NextResponse.json({ ok: false, error: t('adm.chunkIndexInvalid') }, { status: 400, ...NO_STORE });
  }
  const data = await readChunkBody(request, t);
  await writeLauncherUploadChunk(uploadId, Number(rawIndex), data);
  return NextResponse.json({ ok: true }, NO_STORE);
}

async function getCompletedJob(uploadId: string) {
  const job = await getHelperReleaseJob(uploadId);
  if (job) return NextResponse.json({ ok: true, job }, { status: 202, ...NO_STORE });
  return null;
}

async function completeLauncherUpload(request: Request, uploadId: string, t: (key: string, params?: Record<string, string | number>) => string) {
  // Upload UUID doubles as the release-job idempotency key. A retry after a
  // lost HTTP response returns the already-created job instead of publishing
  // the same EXE twice.
  const existing = await getCompletedJob(uploadId);
  if (existing) return existing;

  await getLauncherUploadSession(uploadId);
  const acquired = await acquireLauncherUploadFinalizeLock(uploadId);
  if (!acquired) {
    const job = await getCompletedJob(uploadId);
    if (job) return job;
    return NextResponse.json({ ok: false, error: t('adm.buildAlreadyRunning') }, { status: 409, ...NO_STORE });
  }

  try {
    const concurrent = await getCompletedJob(uploadId);
    if (concurrent) return concurrent;
    const { session, data } = await assembleLauncherUpload(uploadId);
    const url = publicLauncherUrl(request, session.platform);
    let job: Awaited<ReturnType<typeof startHelperReleaseJob>>;
    try {
      job = await startHelperReleaseJob({
        kind: 'launcher',
        platform: session.platform,
        version: session.version,
        publicUrl: url,
        data,
      }, uploadId);
    } catch (error) {
      return NextResponse.json({
        ok: false,
        error: error instanceof Error ? error.message : t('adm.queueFailed'),
      }, { status: 409, ...NO_STORE });
    }
    await markLauncherUploadCompleted(uploadId, job.id);
    return NextResponse.json({ ok: true, job }, { status: 202, ...NO_STORE });
  } finally {
    await releaseLauncherUploadFinalizeLock(uploadId);
  }
}

async function postLauncherControl(request: Request, t: (key: string, params?: Record<string, string | number>) => string) {
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object' || body.kind !== 'launcher') {
    return NextResponse.json({ ok: false, error: t('adm.exeUploadRequestInvalid') }, { status: 400, ...NO_STORE });
  }

  const action = String(body.action ?? '');
  if (action === 'begin') {
    try {
      const session = await createLauncherUpload({
        platform: String(body.platform ?? 'win64'),
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
      return jsonError(error, t, 'adm.exeUploadStartFailed');
    }
  }

  const uploadId = String(body.uploadId ?? '');
  if (!uploadId) {
    return NextResponse.json({ ok: false, error: t('adm.uploadIdMissing') }, { status: 400, ...NO_STORE });
  }

  if (action === 'complete') {
    try {
      return await completeLauncherUpload(request, uploadId, t);
    } catch (error) {
      return jsonError(error, t, 'adm.exeUploadAssembleFailed');
    }
  }

  if (action === 'cancel') {
    try {
      const completed = await getCompletedJob(uploadId);
      if (completed) return completed;
      await cancelLauncherUpload(uploadId);
      return NextResponse.json({ ok: true }, NO_STORE);
    } catch (error) {
      return jsonError(error, t, 'adm.exeUploadCancelFailed');
    }
  }

  return NextResponse.json({ ok: false, error: t('adm.exeOpUnknown') }, { status: 400, ...NO_STORE });
}

/**
 * Полностью автономный издатель Colonial Helper.
 *
 * Администратор выбирает каталог uploader в браузере; сервер сам строит
 * манифест, считает хеши, подписывает своим ключом, собирает ZIP и переводит
 * канал. GitHub, Actions и внешний CI в этой цепочке не участвуют.
 * Тем же endpoint можно положить базовый exe прямо на диск сервера.
 */
export async function GET(request: Request) {
  const t = await apiTranslate();
  const auth = await requireAdmin(request);
  if ('response' in auth) return auth.response;
  const url = new URL(request.url);
  const id = url.searchParams.get('job');
  const job = id ? await getHelperReleaseJob(id) : await getLatestHelperReleaseJob();
  if (!job) return NextResponse.json({ ok: true, job: null }, NO_STORE);
  return NextResponse.json({ ok: true, job }, NO_STORE);
}

export async function DELETE(request: Request) {
  const t = await apiTranslate();
  const auth = await requireAdmin(request);
  if ('response' in auth) return auth.response;
  const id = new URL(request.url).searchParams.get('job') || '';
  const result = await cancelHelperReleaseJob(id);
  return NextResponse.json(result, { status: result.ok ? 200 : 404, ...NO_STORE });
}

export async function POST(request: Request) {
  const t = await apiTranslate();
  const auth = await requireAdmin(request);
  if ('response' in auth) return auth.response;

  const contentType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  const chunkAction = request.headers.get('x-helper-upload-action')?.toLowerCase();
  if (chunkAction === 'chunk' || contentType === 'application/octet-stream') {
    if (chunkAction !== 'chunk') {
      return NextResponse.json({ ok: false, error: t('adm.chunkOperationMissing') }, { status: 400, ...NO_STORE });
    }
    try {
      return await postLauncherChunk(request, t);
    } catch (error) {
      return jsonError(error, t, 'adm.exeUploadChunkFailed');
    }
  }
  if (contentType === 'application/json') return postLauncherControl(request, t);

  try {
    const form = await request.formData();
    const kind = String(form.get('kind') ?? 'bundle');
    const asyncRequested = String(form.get('async') ?? '') === 'true';

    if (kind === 'launcher') {
      const upload = form.get('launcher');
      if (!(upload instanceof File)) {
        return NextResponse.json({ ok: false, error: t('adm.exePick') }, { status: 400, ...NO_STORE });
      }
      const platform = String(form.get('platform') ?? 'win64').trim().toLowerCase();
      const version = String(form.get('version') ?? '').trim().replace(/^v/i, '');
      const url = publicLauncherUrl(request, platform);
      const binary = Buffer.from(await upload.arrayBuffer());
      if (asyncRequested) {
        try {
          const job = await startHelperReleaseJob({ kind: 'launcher', platform, version, publicUrl: url, data: binary });
          return NextResponse.json({ ok: true, job }, { status: 202, ...NO_STORE });
        } catch (error) {
          return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : t('adm.queueFailed') }, { status: 409, ...NO_STORE });
        }
      }
      const result = await saveLauncherBinary(platform, version, binary, url);
      return NextResponse.json(result, { status: result.ok ? 200 : 400, ...NO_STORE });
    }

    const version = String(form.get('version') ?? '').trim();
    const channel = String(form.get('channel') ?? 'stable') as Channel;
    if (!(CHANNELS as readonly string[]).includes(channel)) {
      return NextResponse.json({ ok: false, error: t('adm.unknownChannel') }, { status: 400, ...NO_STORE });
    }

    const source = String(form.get('source') ?? 'upload');
    let files: Map<string, Buffer>;
    if (source === 'server') {
      files = await serverSourceFiles(version.replace(/^v/i, ''), t);
    } else {
      const uploads = form.getAll('files');
      let paths: unknown = [];
      try {
        paths = JSON.parse(String(form.get('paths') ?? '[]'));
      } catch {
        paths = [];
      }
      const names = Array.isArray(paths) ? paths.map(String) : [];
      files = new Map<string, Buffer>();
      for (let index = 0; index < uploads.length; index += 1) {
        const upload = uploads[index];
        if (!(upload instanceof File)) continue;
        files.set(names[index] || upload.name, Buffer.from(await upload.arrayBuffer()));
      }
    }

    const notes = String(form.get('notes') ?? '');
    const minLauncher = String(form.get('minLauncher') ?? '1.0.0');
    const promote = String(form.get('promote') ?? 'true') !== 'false';
    const allowUntrustedKey = String(form.get('allowUntrustedKey') ?? '') === 'true';
    if (asyncRequested) {
      try {
        const job = await startHelperReleaseJob({ kind: 'bundle', version, channel, notes, minLauncher, files, promote, allowUntrustedKey });
        return NextResponse.json({ ok: true, job }, { status: 202, ...NO_STORE });
      } catch (error) {
        return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : t('adm.queueFailed') }, { status: 409, ...NO_STORE });
      }
    }
    const result = await createServerRelease({ version, channel, notes, minLauncher, files, promote, allowUntrustedKey });
    return NextResponse.json(result, { status: result.ok ? 200 : 400, ...NO_STORE });
  } catch (error) {
    return jsonError(error, t);
  }
}
