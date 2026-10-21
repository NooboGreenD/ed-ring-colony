import { runCronTask } from '@/lib/cronAuth';
import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabaseServer';
import { InaraClient } from '@/lib/inara/client';
import { normalizeCommunityGoals } from '@/lib/inara/community-goals.mjs';

export const dynamic = 'force-dynamic';

async function handle() {
  const svc = createServiceClient();
  const apiKey = process.env.INARA_API_KEY;

  if (!apiKey) {
    return NextResponse.json({ ok: true, skipped: true, reason: 'INARA_API_KEY not configured' });
  }

  try {
    const inara = new InaraClient(apiKey);
    const goals = await inara.getCommunityGoals();
    const rows = normalizeCommunityGoals(goals);

    if (rows.length > 0) {
      await svc.from('community_goals').upsert(rows, { onConflict: 'cg_id' }).throwOnError();
    }

    return NextResponse.json({ updated: rows.length });
  } catch (err: unknown) {
    console.error('[Cron CG]', err);
    const message = err instanceof Error ? err.message : 'Unknown Inara sync error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET(req: Request) {
  return runCronTask(req, 'cg-check', handle);
}

export const POST = GET;
