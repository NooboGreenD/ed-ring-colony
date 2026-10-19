import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabaseServer';
import { SQUADRON_IMAGE_LIMITS } from '@/lib/imageLimits';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

/** Public squadron branding only; the bytea table is closed to browser roles. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string; kind: string }> }) {
  const { id, kind } = await params;
  const squadronId = Number(id);
  const notFound = () => new NextResponse('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  if (!/^\d+$/.test(id) || !Number.isSafeInteger(squadronId) || squadronId <= 0 || (kind !== 'logo' && kind !== 'banner')) return notFound();
  try {
    const { data, error } = await createServiceClient().from('squadron_images')
      .select('mime, bytes, checksum').eq('squadron_id', squadronId).eq('kind', kind).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data || !MIME.has(data.mime) || typeof data.bytes !== 'string') return notFound();
    const version = new URL(req.url).searchParams.get('v');
    // One current image per kind. Never cache new bytes under an old version URL.
    if (version && version !== data.checksum) return notFound();
    const hex = data.bytes.startsWith('\\x') ? data.bytes.slice(2) : data.bytes;
    if (!hex || hex.length % 2 || hex.length > SQUADRON_IMAGE_LIMITS[kind] * 2 || !/^[0-9a-f]+$/i.test(hex)) return notFound();
    const bytes = Buffer.from(hex, 'hex');
    const etag = `"${data.checksum}"`;
    const headers = {
      ETag: etag,
      'Cache-Control': version ? 'public, max-age=31536000, immutable' : 'public, max-age=0, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
    };
    if (req.headers.get('if-none-match') === etag) return new NextResponse(null, { status: 304, headers });
    return new NextResponse(new Uint8Array(bytes), {
      headers: { ...headers, 'Content-Type': data.mime, 'Content-Length': String(bytes.length) },
    });
  } catch (error) {
    console.error('[squadron images GET]', error);
    return new NextResponse('Image unavailable', { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '60' } });
  }
}
