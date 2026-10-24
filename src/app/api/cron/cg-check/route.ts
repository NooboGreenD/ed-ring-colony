import { runCronTask } from '@/lib/cronAuth';
import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabaseServer';
import { InaraClient } from '@/lib/inara/client';
import { normalizeCommunityGoals } from '@/lib/inara/community-goals.mjs';
import { upsertCommunityGoalCatalog } from '@/lib/communityGoalCatalog';

export const dynamic = 'force-dynamic';

async function handle() {
  const svc = createServiceClient();
  const apiKey = process.env.INARA_API_KEY;

  if (!apiKey) {
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: 'INARA_API_KEY not configured',
      fallbackSources: ['Frontier CAPI community-goals endpoint', 'commander journal uploads (moderator review)'],
    });
  }

  try {
    const inara = new InaraClient(apiKey);
    const goals = await inara.getCommunityGoals();
    const rows = normalizeCommunityGoals(goals);

    const updated = await upsertCommunityGoalCatalog(svc, rows, 'inara');
    return NextResponse.json({ updated, received: rows.length, source: 'inara' });
  } catch (err: unknown) {
    console.error('[Cron CG]', err);
    const message = err instanceof Error ? err.message : 'Unknown Inara sync error';
    return NextResponse.json({
      error: message,
      fallbackSources: ['Frontier CAPI community-goals endpoint', 'commander journal uploads (moderator review)'],
    }, { status: 500 });
  }
}

export async function GET(req: Request) {
  return runCronTask(req, 'cg-check', handle);
}

export const POST = GET;
