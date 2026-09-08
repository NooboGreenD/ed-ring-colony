import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabaseServer';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 200);
    const systemName = searchParams.get('system_name');
    const syncType = searchParams.get('sync_type');

    const supabase = await createClient();

    let query = supabase
      .from('raven_sync_log')
      .select('*')
      .order('synced_at', { ascending: false })
      .limit(limit);

    if (systemName) {
      query = query.ilike('system_name', `%${systemName}%`);
    }

    if (syncType) {
      query = query.eq('sync_type', syncType);
    }

    const { data, error } = await query;

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Группировка по системам для сводки
    const systemMap = new Map();
    (data || []).forEach((log: any) => {
      if (!systemMap.has(log.system_name)) {
        systemMap.set(log.system_name, log);
      }
    });

    return NextResponse.json({
      logs: data || [],
      latestBySystem: Array.from(systemMap.values()),
      count: data?.length || 0
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || 'Internal error' }, { status: 500 });
  }
}
