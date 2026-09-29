import { NextResponse } from 'next/server';

import { readLauncher } from '@/lib/uploaderStore';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Постоянная ссылка на скачивание Colonial Helper.
 *
 * Сайт ссылается сюда, а не на страницу релизов: адрес не меняется от версии
 * к версии, ведёт на наш домен и переживает переезд файла внутри сервера.
 * Пилоту не нужно разбираться,
 * какой из ассетов качать.
 *
 * Редирект временный (302): куда он указывает, зависит от того, что сейчас
 * опубликовано, и кэшировать это навсегда нельзя.
 */
export async function GET(request: Request) {
  const platform = (new URL(request.url).searchParams.get('platform') ?? 'win64').trim().toLowerCase();
  const info = await readLauncher(platform);
  if (!info?.url) {
    return NextResponse.json(
      { ok: false, error: 'Colonial Helper пока не опубликован на этом сервере' },
      { status: 404, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  return NextResponse.redirect(info.url, {
    status: 302,
    headers: { 'Cache-Control': 'public, max-age=300' },
  });
}
