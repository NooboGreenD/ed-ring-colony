import { NextResponse } from 'next/server';

import { readSetup, readSetupBinary } from '@/lib/uploaderStore';

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
 */
export async function GET(_request: Request, context: { params: Promise<{ platform: string }> }) {
  const { platform } = await context.params;
  const normalized = String(platform ?? '').trim().toLowerCase();
  const [data, info] = await Promise.all([
    readSetupBinary(normalized),
    readSetup(normalized),
  ]);
  if (!data || !info) {
    return NextResponse.json(
      {
        ok: false,
        error: 'Установщик Colonial Helper ещё не опубликован на сервере',
        platform: normalized,
      },
      { status: 404, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  return new NextResponse(new Uint8Array(data), {
    headers: {
      'Content-Type': 'application/vnd.microsoft.portable-executable',
      'Content-Length': String(data.length),
      'Content-Disposition': `attachment; filename="ColonialHelperSetup-${info.version}.exe"`,
      'Cache-Control': 'public, max-age=300, stale-while-revalidate=900',
      ETag: `"${info.sha256}"`,
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
