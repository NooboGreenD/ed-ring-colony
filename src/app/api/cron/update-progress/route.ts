import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabaseServer';
import { runCronTask } from '@/lib/cronAuth';
import { syncProgress } from '../../../../../scripts/lib/progress-sync.mjs';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request) {
  return runCronTask(request, 'update-progress', async () => {
    const result = await syncProgress({ supabase: createServiceClient() });
    return NextResponse.json(result, { status: result.ok ? 200 : 502 });
  });
}

export const GET = POST;
