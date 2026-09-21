import { runCronTask } from '@/lib/cronAuth';
import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabaseServer';

export const dynamic = 'force-dynamic';

async function handle() {
  const svc = createServiceClient();
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const { error, count } = await svc
    .from('market_prices')
    .delete()
    .lt('reported_at', cutoff);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ deleted: count || 0 });
}

export async function GET(req: Request) {
  return runCronTask(req, 'eddn-cleanup', handle);
}

export const POST = GET;
