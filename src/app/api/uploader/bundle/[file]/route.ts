import { NextResponse } from 'next/server';

import { readBundleArchive } from '@/lib/uploaderStore';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ARCHIVE = /^(\d+(?:\.\d+){0,3}(?:-[0-9A-Za-z.-]{1,40})?)\.zip$/;

/**
 * Полный пакет версии одним архивом.
 *
 * Нужен в двух случаях: первая установка (на диске ещё нечего переиспользовать)
 * и «Восстановить установку», когда локальные файлы испорчены и пофайловой
 * дельте верить нельзя. Клиент всё равно сверяет каждый файл из архива с
 * подписанным манифестом, поэтому архив — это удобство, а не доверенный вход.
 */
export async function GET(_request: Request, context: { params: Promise<{ file: string }> }) {
  const { file } = await context.params;
  const match = ARCHIVE.exec(file);
  if (!match) {
    return new NextResponse('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }

  const archive = await readBundleArchive(match[1]);
  if (!archive) {
    return new NextResponse('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }

  return new NextResponse(new Uint8Array(archive), {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Length': String(archive.length),
      'Content-Disposition': `attachment; filename="ColonialHelper-${match[1]}.zip"`,
      // Архив версии тоже неизменяем: версия публикуется один раз.
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}
