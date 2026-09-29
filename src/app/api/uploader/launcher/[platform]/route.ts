import { NextResponse } from 'next/server';

import { readLauncher, readLauncherBinary } from '@/lib/uploaderStore';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Базовый exe хранится и раздаётся нашим сервером, без GitHub Releases. */
export async function GET(_request: Request, context: { params: Promise<{ platform: string }> }) {
  const { platform } = await context.params;
  const [data, info] = await Promise.all([readLauncherBinary(platform), readLauncher(platform)]);
  if (!data || !info) {
    return new NextResponse('Базовая сборка не опубликована', {
      status: 404,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
  return new NextResponse(new Uint8Array(data), {
    headers: {
      'Content-Type': 'application/vnd.microsoft.portable-executable',
      'Content-Length': String(data.length),
      'Content-Disposition': `attachment; filename="ColonialHelper-${info.version}.exe"`,
      'Cache-Control': 'public, max-age=3600',
      ETag: `"${info.sha256}"`,
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
