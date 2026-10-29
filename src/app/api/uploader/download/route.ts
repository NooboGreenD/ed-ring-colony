import { NextResponse } from 'next/server';

import { readSetup } from '@/lib/uploaderStore';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Постоянная ссылка «Скачать Colonial Helper».
 *
 * Сайт ссылается сюда, а не на страницу релизов: адрес не меняется от версии
 * к версии и ведёт на наш домен. Отдаём установщик (`ColonialHelperSetup.exe`),
 * а не базовую сборку: пилоту для первой установки нужен именно он —
 * установщик раскладывает программу, создаёт ярлыки и запускает Helper.
 * Базовая сборка остаётся внутренним делом канала обновлений.
 *
 * Редирект временный (302): куда он указывает, зависит от того, что сейчас
 * опубликовано, и кэшировать это навсегда нельзя.
 */
export async function GET(request: Request) {
  const platform = (new URL(request.url).searchParams.get('platform') ?? 'win64').trim().toLowerCase();
  const info = await readSetup(platform);
  if (!info) {
    return NextResponse.json(
      { ok: false, error: 'Установщик Colonial Helper пока не опубликован на этом сервере' },
      { status: 404, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  return NextResponse.redirect(
    new URL(`/api/uploader/setup/${encodeURIComponent(platform)}`, request.url),
    { status: 302, headers: { 'Cache-Control': 'no-store' } },
  );
}
