import { NextResponse } from 'next/server';

import { readBlob, readBlobGzip } from '@/lib/uploaderStore';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const SHA256 = /^[0-9a-f]{64}$/;

function notFound() {
  return new NextResponse('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
}

/**
 * Файл пакета по его sha256.
 *
 * Адрес неизменяем по построению (содержимое = имя), поэтому ответ кэшируется
 * навсегда: повторно один и тот же модуль не поедет ни через nginx, ни через
 * браузерный кэш, ни к пилоту. Одинаковые между версиями файлы лежат на диске
 * в одном экземпляре.
 *
 * Модули — это текст на Python, и он ужимается в разы, поэтому при
 * `Accept-Encoding: gzip` отдаётся сжатая копия. Клиент считает sha256 уже
 * распакованных байт, так что проверка целостности от этого не зависит.
 */
export async function GET(request: Request, context: { params: Promise<{ hash: string }> }) {
  const { hash } = await context.params;
  if (!SHA256.test(hash)) return notFound();

  const wantsGzip = /\bgzip\b/i.test(request.headers.get('accept-encoding') ?? '');
  const packed = wantsGzip ? await readBlobGzip(hash) : null;
  const data = packed ?? (await readBlob(hash));
  if (!data) return notFound();

  return new NextResponse(new Uint8Array(data), {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(data.length),
      'Cache-Control': 'public, max-age=31536000, immutable',
      // У сжатого и несжатого представления разные ETag: иначе промежуточный
      // кэш может отдать gzip клиенту, который его не просил.
      ETag: packed ? `"${hash}-gz"` : `"${hash}"`,
      Vary: 'Accept-Encoding',
      'X-Content-Type-Options': 'nosniff',
      ...(packed ? { 'Content-Encoding': 'gzip' } : {}),
    },
  });
}
