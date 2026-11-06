import { NextResponse } from 'next/server';
import { authFromRequest, createServiceClient } from '@/lib/supabaseServer';
import { apiTranslate } from '@/lib/i18n/apiT';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, context: { params: Promise<{ jobId: string }> | { jobId: string } }) {
  const t = await apiTranslate();
  const { user } = await authFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { jobId } = await context.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(jobId)) {
    return NextResponse.json({ error: t('api.syncJobNotFound') }, { status: 404 });
  }
  const { data, error } = await createServiceClient().from('capi_sync_jobs')
    .select('id,status,stage,requested_at,started_at,heartbeat_at,attempts,stage_timings,total_duration_ms,result,error')
    .eq('id', jobId)
    .eq('user_id', user.id)
    .maybeSingle();

  if (error) {
    console.error('[CAPI Sync] job status lookup failed', error.message);
    return NextResponse.json({ error: t('api.syncStateFailed') }, { status: 500 });
  }
  if (!data) return NextResponse.json({ error: t('api.syncJobNotFound') }, { status: 404 });
  return NextResponse.json({ job: data });
}
