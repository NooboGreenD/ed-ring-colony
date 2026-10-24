import { NextResponse } from 'next/server';
import { authFromRequest, createServiceClient } from '@/lib/supabaseServer';
import { enqueueCapiSyncJob, findActiveCapiSyncJob } from '@/lib/capi/syncJobs';

export const dynamic = 'force-dynamic';

/** Return the caller's active durable job, allowing a page reload to resume polling. */
export async function GET(req: Request) {
  const { user } = await authFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const svc = createServiceClient();
  const active = await findActiveCapiSyncJob(svc, user.id);
  if (active.error) {
    console.error('[CAPI Sync] active job lookup failed', active.error.message);
    return NextResponse.json({ error: 'Не удалось проверить очередь синхронизации' }, { status: 500 });
  }
  if (active.data) return NextResponse.json({ job: active.data });

  // If the worker finished before the account page mounted, show its result
  // instead of leaving the OAuth callback's "queued" notice stale.
  const recent = await svc.from('capi_sync_jobs')
    .select('id,status,stage,requested_at,started_at,heartbeat_at,attempts,stage_timings,total_duration_ms,result,error')
    .eq('user_id', user.id)
    .in('status', ['succeeded', 'failed'])
    .gte('requested_at', new Date(Date.now() - 10 * 60 * 1000).toISOString())
    .order('requested_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (recent.error) {
    console.error('[CAPI Sync] recent job lookup failed', recent.error.message);
    return NextResponse.json({ error: 'Не удалось проверить результат синхронизации' }, { status: 500 });
  }
  return NextResponse.json({ job: recent.data ?? null });
}

/**
 * Enqueue only; never call Frontier or run the synchronization inside a
 * browser-facing request. A partial unique index makes repeated clicks and
 * network retries join the existing queued/running job.
 */
export async function POST(req: Request) {
  const startedAt = Date.now();
  const { user } = await authFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const svc = createServiceClient();
  const { data: tokenRow, error: tokenError } = await svc
    .from('capi_tokens')
    .select('user_id')
    .eq('user_id', user.id)
    .maybeSingle();

  if (tokenError) {
    console.error('[CAPI Sync] token lookup failed', tokenError.message);
    return NextResponse.json({ error: 'Не удалось проверить привязку Frontier' }, { status: 500 });
  }
  if (!tokenRow) {
    return NextResponse.json(
      { error: 'Аккаунт Frontier не привязан', needsAuth: true },
      { status: 404 },
    );
  }

  const queued = await enqueueCapiSyncJob(svc, user.id);
  if (queued.error || !queued.data) {
    console.error('[CAPI Sync] enqueue failed', queued.error?.code ?? 'unknown', queued.error?.message ?? 'no job returned');
    return NextResponse.json({ error: 'Не удалось поставить синхронизацию в очередь' }, { status: 500 });
  }

  console.info('[CAPI Sync] job accepted', {
    jobId: queued.data.id,
    reused: queued.reused,
    status: queued.data.status,
    elapsedMs: Date.now() - startedAt,
  });
  return NextResponse.json({ job: queued.data }, { status: 202 });
}
