import { NextResponse } from 'next/server';

import { readLauncher } from '@/lib/uploaderStore';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Куда вести пилота, пока базовая сборка не опубликована на сервере. */
const FALLBACK_URL = 'https://github.com/NooboGreenD/ed-ring-colony/releases/latest';

/**
 * Постоянная ссылка на скачивание Colonial Helper.
 *
 * Сайт ссылается сюда, а не на страницу релизов: адрес не меняется от версии
 * к версии, ведёт на наш домен и переживает переезд файла (GitHub Releases
 * сейчас, диск сервера или зеркало завтра). Пилоту не нужно разбираться,
 * какой из ассетов качать.
 *
 * Редирект временный (302): куда он указывает, зависит от того, что сейчас
 * опубликовано, и кэшировать это навсегда нельзя.
 */
export async function GET(request: Request) {
  const platform = (new URL(request.url).searchParams.get('platform') ?? 'win64').trim().toLowerCase();
  const info = await readLauncher(platform);
  const target = info?.url || FALLBACK_URL;

  return NextResponse.redirect(target, {
    status: 302,
    headers: { 'Cache-Control': 'public, max-age=300' },
  });
}
