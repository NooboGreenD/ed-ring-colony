import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabaseServer';

export const dynamic = 'force-dynamic';

/**
 * Отдача аватара, сохранённого в базе.
 *
 * Сюда ведут ссылки вида `/api/avatars/<user_id>?v=<хэш>`, которые ставит
 * `POST /api/account/avatar`, когда Supabase Storage недоступен. Картинка
 * маленькая (≤ 1 МБ) и меняется редко, поэтому ответ кэшируется надолго:
 * версия в адресе гарантирует, что новая аватарка появится сразу.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

/** PostgREST отдаёт bytea как `\x…`; бинарь восстанавливаем из hex. */
function decodeBytea(value: unknown): Buffer | null {
  if (typeof value !== 'string') return null;
  const hex = value.startsWith('\\x') ? value.slice(2) : value;
  if (!hex || !/^[0-9a-f]*$/i.test(hex) || hex.length % 2 !== 0) return null;
  const buffer = Buffer.from(hex, 'hex');
  return buffer.byteLength > 0 ? buffer : null;
}

export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!UUID.test(id)) return new NextResponse('Not found', { status: 404 });

  // Маршрут отдаёт картинку: любая внутренняя ошибка должна оставаться
  // короткой и предсказуемой, а не превращаться в HTML-страницу ошибки.
  let data: { mime?: unknown; bytes?: unknown; checksum?: unknown } | null = null;
  try {
    const svc = createServiceClient();
    const result = await svc
      .from('profile_avatars')
      .select('mime, bytes, checksum, updated_at')
      .eq('user_id', id)
      .maybeSingle();
    if (result.error) throw new Error(result.error.message);
    data = result.data;
  } catch (err) {
    console.error('[avatars GET]', err instanceof Error ? err.message : err);
    return new NextResponse('Avatar unavailable', {
      status: 503,
      headers: { 'Cache-Control': 'no-store', 'Retry-After': '60' },
    });
  }
  if (!data) return new NextResponse('Not found', { status: 404 });

  const buffer = decodeBytea(data.bytes);
  if (!buffer) return new NextResponse('Not found', { status: 404 });

  const etag = `"${String(data.checksum ?? '').slice(0, 32)}"`;
  if (req.headers.get('if-none-match') === etag) {
    return new NextResponse(null, { status: 304, headers: { ETag: etag } });
  }

  const mime = ALLOWED_MIME.has(String(data.mime)) ? String(data.mime) : 'application/octet-stream';
  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      'Content-Type': mime,
      'Content-Length': String(buffer.byteLength),
      ETag: etag,
      // Адрес содержит версию (?v=…), поэтому кэшировать можно смело.
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
