import { NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/billing/auth';
import {
  CHANNELS,
  createServerRelease,
  saveLauncherBinary,
  type Channel,
} from '@/lib/uploaderStore';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = { headers: { 'Cache-Control': 'no-store' } };

/**
 * Полностью автономный издатель Colonial Helper.
 *
 * Администратор выбирает каталог uploader в браузере; сервер сам строит
 * манифест, считает хеши, подписывает своим ключом, собирает ZIP и переводит
 * канал. GitHub, Actions и внешний CI в этой цепочке не участвуют.
 * Тем же endpoint можно положить базовый exe прямо на диск сервера.
 */
export async function POST(request: Request) {
  const auth = await requireAdmin(request);
  if ('response' in auth) return auth.response;

  try {
    const form = await request.formData();
    const kind = String(form.get('kind') ?? 'bundle');

    if (kind === 'launcher') {
      const upload = form.get('launcher');
      if (!(upload instanceof File)) {
        return NextResponse.json({ ok: false, error: 'Выберите ColonialHelper.exe' }, { status: 400, ...NO_STORE });
      }
      const platform = String(form.get('platform') ?? 'win64').trim().toLowerCase();
      const version = String(form.get('version') ?? '').trim().replace(/^v/i, '');
      // Постоянный URL принадлежит нашему серверу. Origin берём из публичных
      // forwarded-заголовков, а не из имени docker-сервиса web.
      const forwardedHost = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
      const forwardedProto = request.headers.get('x-forwarded-proto') ?? 'https';
      const origin = forwardedHost ? `${forwardedProto}://${forwardedHost}` : new URL(request.url).origin;
      const url = `${origin}/api/uploader/launcher/${encodeURIComponent(platform)}`;
      const result = await saveLauncherBinary(platform, version, Buffer.from(await upload.arrayBuffer()), url);
      return NextResponse.json(result, { status: result.ok ? 200 : 400, ...NO_STORE });
    }

    const version = String(form.get('version') ?? '').trim();
    const channel = String(form.get('channel') ?? 'stable') as Channel;
    if (!(CHANNELS as readonly string[]).includes(channel)) {
      return NextResponse.json({ ok: false, error: 'Неизвестный канал' }, { status: 400, ...NO_STORE });
    }

    const uploads = form.getAll('files');
    let paths: unknown = [];
    try {
      paths = JSON.parse(String(form.get('paths') ?? '[]'));
    } catch {
      paths = [];
    }
    const names = Array.isArray(paths) ? paths.map(String) : [];
    const files = new Map<string, Buffer>();
    for (let index = 0; index < uploads.length; index += 1) {
      const upload = uploads[index];
      if (!(upload instanceof File)) continue;
      files.set(names[index] || upload.name, Buffer.from(await upload.arrayBuffer()));
    }

    const result = await createServerRelease({
      version,
      channel,
      notes: String(form.get('notes') ?? ''),
      minLauncher: String(form.get('minLauncher') ?? '1.0.0'),
      files,
      promote: String(form.get('promote') ?? 'true') !== 'false',
    });
    return NextResponse.json(result, { status: result.ok ? 200 : 400, ...NO_STORE });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const hint = /EACCES|permission denied/i.test(detail)
      ? 'Хранилище недоступно для записи. Пересоздайте web-контейнер или исправьте владельца тома uploader-store.'
      : `Публикация не выполнена: ${detail}`;
    return NextResponse.json({ ok: false, error: hint }, { status: 500, ...NO_STORE });
  }
}
