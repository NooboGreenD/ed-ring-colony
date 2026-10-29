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
 *
 * `Location` намеренно относительный. Абсолютный адрес пришлось бы собирать
 * из запроса, а за nginx `Host` — это `0.0.0.0:3000` (`proxy_pass` подставляет
 * `$proxy_host`): ссылка «Скачать Colonial Helper» из меню профиля уводила
 * пилота на `https://0.0.0.0:3000/api/uploader/setup/win64`, и загрузка не
 * начиналась. Относительный `Location` оставляет браузер на том домене, с
 * которого он пришёл, — и на localhost, и на боевом сервере.
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

  return new Response(null, {
    status: 302,
    headers: {
      Location: `/api/uploader/setup/${encodeURIComponent(platform)}`,
      'Cache-Control': 'no-store',
    },
  });
}
