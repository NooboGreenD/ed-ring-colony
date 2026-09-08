import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabaseServer';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const job_id = searchParams.get('id');
    if (!job_id) {
      return NextResponse.json({ error: 'id is required' }, { status: 400 });
    }

    const svc = createServiceClient();
    const { data: job, error } = await svc
      .from('market_search_jobs')
      .select('*')
      .eq('id', job_id)
      .single();

    if (error || !job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    }

    return NextResponse.json({
      job_id: job.id,
      status: job.status,
      progress: {
        total: job.total_systems,
        scanned: job.scanned_systems,
        found: job.found_stations,
        current: job.current_system,
      },
      scan_log: (job.scan_log || []).slice(-30),
      result: job.result || [],
      is_done: job.status === 'done',
      created_at: job.created_at,
      updated_at: job.updated_at,
    });
  } catch (e: any) {
    console.error('[Market Status] Error:', e);
    return NextResponse.json({ error: e.message || 'Status check failed' }, { status: 500 });
  }
}
