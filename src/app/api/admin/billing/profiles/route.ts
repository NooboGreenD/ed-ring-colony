import { NextResponse } from 'next/server';
import { requireStaff, errorResponse } from '@/lib/billing/auth';
import { searchProfiles } from '@/lib/billing/profiles';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: Request) {
  try {
    const auth = await requireStaff(req);
    if ('response' in auth) return auth.response;
    const q = new URL(req.url).searchParams.get('q') || '';
    return NextResponse.json({ success: true, profiles: await searchProfiles(q) });
  } catch (err) {
    return errorResponse(err);
  }
}
