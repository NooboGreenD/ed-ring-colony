import { NextResponse } from 'next/server';
import { runCronTask } from '@/lib/cronAuth';
import { createServiceClient } from '@/lib/supabaseServer';
import { markCapiTokenBroken, syncCapiPilot } from '@/lib/capi/syncPilot';
import { publicCapiSyncResult, safeCapiDiagnostic } from '@/lib/capi/syncJobs';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

async function handleOne() {
  const svc = createServiceClient();
  const claimStartedAt = Date.now();
  const { data: jobs, error: claimError } = await svc.rpc('claim_next_capi_sync_job');
  if (claimError) throw new Error(`CAPI job claim failed: ${safeCapiDiagnostic(claimError.message)}`);
  const job = Array.isArray(jobs) ? jobs[0] : null;
  if (!job) return NextResponse.json({ claimed: false, ok: true });

  const startedAt = Date.now();
  const stageTimings: Array<{ stage: string; attempt: number; durationMs: number }> =
    Array.isArray(job.stage_timings) ? [...job.stage_timings] : [];
  const attempt = Number(job.attempts) || 1;
  let activeStage = 'starting';
  let stageStartedAt = startedAt;

  const finishStage = (at: number) => {
    stageTimings.push({ stage: activeStage, attempt, durationMs: Math.max(0, at - stageStartedAt) });
    stageStartedAt = at;
  };
  const recordStage = async (stage: string) => {
    const now = Date.now();
    finishStage(now);
    activeStage = stage;
    const { error } = await svc.from('capi_sync_jobs').update({
      stage,
      heartbeat_at: new Date(now).toISOString(),
      stage_timings: stageTimings,
      updated_at: new Date(now).toISOString(),
    }).eq('id', job.id).eq('status', 'running');
    console.info('[CAPI Sync Job]', JSON.stringify({
      jobId: job.id,
      event: 'stage',
      stage,
      elapsedMs: now - startedAt,
      previousStageMs: stageTimings.at(-1)?.durationMs ?? 0,
    }));
    if (error) console.warn('[CAPI Sync Job] stage update failed', job.id, safeCapiDiagnostic(error.message));
  };

  console.info('[CAPI Sync Job]', JSON.stringify({ jobId: job.id, event: 'started', attempt: job.attempts, queueWaitMs: startedAt - claimStartedAt }));

  try {
    await recordStage('token_lookup');
    const { data: tokenRow, error: tokenError } = await svc.from('capi_tokens')
      .select('*')
      .eq('user_id', job.user_id)
      .maybeSingle();

    if (tokenError) throw new Error(`Frontier binding lookup failed: ${safeCapiDiagnostic(tokenError.message)}`);
    if (!tokenRow) throw new Error('Frontier account was unlinked before the queued sync started');

    const result = await syncCapiPilot(svc, job.user_id, tokenRow, {
      skipCommunityGoals: job.skip_community_goals ?? true,
      requestedPlatform: job.requested_platform ?? null,
      identity: tokenRow.platform ? {
        frontierId: tokenRow.frontier_id ?? null,
        email: null,
        platform: tokenRow.platform,
      } : undefined,
      onStage: recordStage,
    });
    const publicResult = publicCapiSyncResult(result);

    if (!result.ok && result.needsReauth) {
      await markCapiTokenBroken(svc, job.user_id, result.error || 'Frontier отклонил токен');
    }

    finishStage(Date.now());
    const finishedAt = new Date().toISOString();
    const durationMs = Date.now() - startedAt;
    const status = result.ok ? 'succeeded' : 'failed';
    const { error: saveError } = await svc.from('capi_sync_jobs').update({
      status,
      stage: status,
      heartbeat_at: finishedAt,
      finished_at: finishedAt,
      updated_at: finishedAt,
      stage_timings: stageTimings,
      total_duration_ms: durationMs,
      result: publicResult,
      error: result.ok ? null : safeCapiDiagnostic(result.error || 'CAPI sync failed'),
    }).eq('id', job.id).eq('status', 'running');
    if (saveError) throw new Error(`CAPI job completion write failed: ${safeCapiDiagnostic(saveError.message)}`);

    for (const warning of publicResult.warnings) console.warn('[CAPI Sync Job]', job.id, warning);
    console.info('[CAPI Sync Job]', JSON.stringify({
      jobId: job.id,
      event: 'finished',
      status,
      totalDurationMs: durationMs,
      stageTimings,
      profileSaved: result.profileSaved,
      journalStatus: result.journalStatus,
    }));
    return NextResponse.json({ claimed: true, jobId: job.id, status, durationMs });
  } catch (err) {
    finishStage(Date.now());
    const message = safeCapiDiagnostic(err);
    const finishedAt = new Date().toISOString();
    const durationMs = Date.now() - startedAt;
    const { error: saveError } = await svc.from('capi_sync_jobs').update({
      status: 'failed',
      stage: 'failed',
      heartbeat_at: finishedAt,
      finished_at: finishedAt,
      updated_at: finishedAt,
      stage_timings: stageTimings,
      total_duration_ms: durationMs,
      error: message,
    }).eq('id', job.id).eq('status', 'running');
    console.error('[CAPI Sync Job]', JSON.stringify({
      jobId: job.id,
      event: 'failed',
      elapsedMs: durationMs,
      stage: activeStage,
      error: message,
      saveError: saveError ? safeCapiDiagnostic(saveError.message) : undefined,
    }));
    return NextResponse.json({ claimed: true, jobId: job.id, status: 'failed' });
  }
}

export async function POST(req: Request) {
  return runCronTask(req, 'capi-sync-jobs', handleOne);
}

export const GET = POST;
