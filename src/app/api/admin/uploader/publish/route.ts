import { NextResponse } from 'next/server';

import { isPublishAuthorized, publishBundle, saveLauncher } from '@/lib/uploaderStore';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = { headers: { 'Cache-Control': 'no-store' } };

/**
 * Публикация пакета кода из CI (`uploader/build_bundle.py --publish`).
 *
 * Авторизация — отдельный токен `UPLOADER_PUBLISH_TOKEN`, не админская сессия:
 * публикует машина, а не человек. Сервер проверяет манифест и его подпись,
 * раскладывает файлы по хешам и переводит канал на новую версию.
 *
 * Тем же роутом публикуются метаданные базовой сборки (exe): её собирает
 * другой workflow и заметно реже.
 */
export async function POST(request: Request) {
  if (!isPublishAuthorized(request)) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401, ...NO_STORE });
  }

  interface PublishBody {
    manifest?: unknown;
    files?: Record<string, string>;
    bundle_base64?: string;
    promote?: boolean;
    launcher?: { platform?: string; version?: string; url?: string; sha256?: string; size?: number };
  }

  const body = (await request.json().catch(() => null)) as PublishBody | null;
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ ok: false, error: 'Тело запроса не JSON' }, { status: 400, ...NO_STORE });
  }

  // Публикация базовой сборки: метаданные exe, сам файл лежит в релизах.
  if (body.launcher && !body.manifest) {
    const result = await saveLauncher({
      platform: String(body.launcher.platform ?? 'win64'),
      version: String(body.launcher.version ?? ''),
      url: String(body.launcher.url ?? ''),
      sha256: String(body.launcher.sha256 ?? ''),
      size: Number(body.launcher.size ?? 0),
    });
    return NextResponse.json(result, { status: result.ok ? 200 : 400, ...NO_STORE });
  }

  const result = await publishBundle({
    manifest: body.manifest,
    files: body.files,
    bundleBase64: body.bundle_base64,
    promote: body.promote !== false,
  });

  if (!result.ok) {
    // «Не хватает файлов» — рабочий ответ, а не поломка: CI дошлёт недостающее.
    const status = result.missing?.length ? 409 : 400;
    return NextResponse.json(
      { ok: false, error: result.error, missing: result.missing ?? [], version: result.version },
      { status, ...NO_STORE },
    );
  }

  return NextResponse.json(
    {
      ok: true,
      version: result.version,
      channel: result.channel,
      stored_blobs: result.storedBlobs,
      signature_checked: result.signatureChecked,
    },
    NO_STORE,
  );
}
