import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';

import { NextResponse } from 'next/server';

import { readSetup, setupBinaryFile } from '@/lib/uploaderStore';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Установщик Colonial Helper для первичной установки.
 *
 * По этой ссылке ходят меню профиля и страница пилота: пилот скачивает один
 * файл и запускает его. Обновления после установки приезжают отдельно —
 * маленькими пакетами кода, поэтому установщик нужен редко.
 *
 * Адрес не зависит от версии: `setup/win64` остаётся тем же, меняется только
 * файл за ним. Поэтому кэш короткий, а имя файла содержит номер версии.
 *
 * Файл отдаётся потоком, а не буфером целиком: установщик весит 200–300 МиБ,
 * и чтение его в память на контейнере с ограниченным лимитом заканчивалось
 * ответом 500 вместо загрузки. Размер берём из метаданных, чтобы `Content-Length`
 * совпадал с тем, что лежит на диске.
 */
export async function GET(_request: Request, context: { params: Promise<{ platform: string }> }) {
  const { platform } = await context.params;
  const normalized = String(platform ?? '').trim().toLowerCase();
  const info = await readSetup(normalized);
  const file = setupBinaryFile(normalized);
  let size = 0;
  if (info && file) {
    try {
      size = (await stat(file)).size;
    } catch {
      size = 0;
    }
  }
  if (!info || !file || !size) {
    return NextResponse.json(
      {
        ok: false,
        error: 'Установщик Colonial Helper ещё не опубликован на сервере',
        platform: normalized,
      },
      { status: 404, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  const body = Readable.toWeb(createReadStream(file)) as ReadableStream<Uint8Array>;
  return new NextResponse(body, {
    headers: {
      'Content-Type': 'application/vnd.microsoft.portable-executable',
      'Content-Length': String(size),
      'Content-Disposition': `attachment; filename="ColonialHelperSetup-${info.version}.exe"`,
      'Cache-Control': 'public, max-age=300, stale-while-revalidate=900',
      ETag: `"${info.sha256}"`,
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
