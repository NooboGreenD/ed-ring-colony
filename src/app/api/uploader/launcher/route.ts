import { NextRequest, NextResponse } from 'next/server';

import { readLauncher } from '@/lib/uploaderStore';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const FALLBACK_URL = 'https://github.com/NooboGreenD/ed-ring-colony/releases/latest';

/**
 * Базовая сборка (`ColonialHelper.exe`) — тот самый файл, который теперь
 * качают редко.
 *
 * Пакет кода объявляет `min_launcher`. Если установленный лаунчер старее
 * (появилась новая библиотека, сменился Python), программа спрашивает этот
 * роут и предлагает скачать новую базовую сборку — один раз на квартал, а не
 * на каждую правку кода.
 */
export async function GET(request: NextRequest) {
  const platform = (new URL(request.url).searchParams.get('platform') ?? 'win64').trim().toLowerCase();
  const info = await readLauncher(platform);

  if (!info) {
    return NextResponse.json(
      {
        ok: false,
        platform,
        error: 'Базовая сборка для этой платформы не опубликована',
        // Пилот не должен остаться без файла: страница релизов есть всегда.
        url: FALLBACK_URL,
      },
      { status: 404, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  return NextResponse.json(
    { ok: true, ...info },
    { headers: { 'Cache-Control': 'public, max-age=300, stale-while-revalidate=900' } },
  );
}
