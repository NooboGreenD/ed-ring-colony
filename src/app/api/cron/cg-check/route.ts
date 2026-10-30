import { runCronTask } from '@/lib/cronAuth';
import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabaseServer';
import { InaraClient } from '@/lib/inara/client';
import { normalizeCommunityGoals } from '@/lib/inara/community-goals.mjs';
import {
  markExpiredCommunityGoalsComplete,
  syncCommunityGoalsFromFrontier,
  upsertCommunityGoalCatalog,
} from '@/lib/communityGoalCatalog';
import { fetchFrontierPublicCommunityGoals } from '@/lib/frontierCommunityGoals.mjs';

export const dynamic = 'force-dynamic';

async function handle() {
  const svc = createServiceClient();
  const results: Record<string, unknown> = {};
  const errors: string[] = [];
  let totalUpdated = 0;

  // This website endpoint is independent of a commander OAuth binding, so it
  // continues to populate the public catalogue even when Inara/CAPI is absent.
  try {
    const payload = await fetchFrontierPublicCommunityGoals();
    const received = Array.isArray(payload.activeInitiatives) ? payload.activeInitiatives.length : 0;
    const updated = await syncCommunityGoalsFromFrontier(svc, payload);
    results.frontier = { received, updated };
    totalUpdated += updated;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown Frontier public initiatives sync error';
    console.error('[Cron CG] Frontier public sync failed:', err);
    errors.push(`Frontier public initiatives: ${message}`);
    results.frontier = { error: message };
  }

  const apiKey = process.env.INARA_API_KEY;
  if (apiKey) {
    try {
      const inara = new InaraClient(apiKey);
      const goals = await inara.getCommunityGoals();
      const rows = normalizeCommunityGoals(goals);
      const updated = await upsertCommunityGoalCatalog(svc, rows, 'inara');
      results.inara = { updated, received: rows.length };
      totalUpdated += updated;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown Inara sync error';
      console.error('[Cron CG] Inara sync failed:', err);
      errors.push(`Inara: ${message}`);
      results.inara = { error: message };
    }
  } else {
    results.inara = { skipped: true, reason: 'INARA_API_KEY not configured' };
  }

  // Frontier перестаёт присылать истёкшие инициативы, поэтому закрываем их
  // сами — иначе они навсегда остаются в фильтре «Активные».
  try {
    const expired = await markExpiredCommunityGoalsComplete(svc);
    results.expirySweep = { completed: expired };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown expiry sweep error';
    console.error('[Cron CG] Expiry sweep failed:', err);
    errors.push(`Expiry sweep: ${message}`);
    results.expirySweep = { error: message };
  }

  const succeeded = Object.values(results).some((result) =>
    Boolean(result && typeof result === 'object' && ('updated' in result || 'received' in result)),
  );
  return NextResponse.json({
    ok: errors.length === 0,
    updated: totalUpdated,
    sources: results,
    errors,
    fallbackSources: ['Frontier public initiatives', 'Frontier CAPI community-goals endpoint', 'commander journal uploads (moderator review)'],
  }, { status: succeeded ? 200 : 502 });
}

export async function GET(req: Request) {
  return runCronTask(req, 'cg-check', handle);
}

export const POST = GET;
