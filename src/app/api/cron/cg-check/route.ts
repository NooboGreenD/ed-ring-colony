import { runCronTask } from '@/lib/cronAuth';
import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabaseServer';
import { InaraClient } from '@/lib/inara/client';

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

    for (const g of goals) {
      const isColonisation = /colonisation|colony|construction|settlement/i.test(g.cgName + ' ' + g.objective);

      await svc.from('community_goals').upsert({
        cg_id: g.cgID,
        title: g.cgName,
        description: g.objective,
        system_name: g.starsystemName,
        station_name: g.stationName,
        objective: g.objective,
        reward: g.reward,
        tier_current: g.tierReached,
        tier_max: g.tierMax,
        contributors: g.contributors,
        contributions_total: g.contributionsTotal,
        expiry_date: g.expiryDate,
        is_complete: g.isCompleted,
        is_colonisation_related: isColonisation,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'cg_id' }).throwOnError();
    }

    return NextResponse.json({ updated: goals.length });
  } catch (err: any) {
    console.error('[Cron CG]', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function GET(req: Request) {
  return runCronTask(req, 'cg-check', handle);
}

export const POST = GET;
