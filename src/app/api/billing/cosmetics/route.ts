import { NextResponse } from 'next/server';
import { billingRepo } from '@/lib/billingData';
import { errorResponse } from '@/lib/billing/auth';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * Public read-model of equipped cosmetics for rendering avatars/callsigns
 * across the site. GET ?ids=uuid1,uuid2  or POST { ids: [...] }.
 */
async function handle(ids: string[]) {
  const clean = Array.from(new Set(ids.map((s) => String(s).trim()).filter(Boolean))).slice(0, 200);
  const cosmetics = await billingRepo.getPublicCosmetics(clean);
  return NextResponse.json({ success: true, cosmetics }, { headers: { 'Cache-Control': 'private, max-age=15' } });
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    return await handle((searchParams.get('ids') || '').split(','));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    return await handle(Array.isArray(body.ids) ? body.ids : []);
  } catch (err) {
    return errorResponse(err);
  }
}
