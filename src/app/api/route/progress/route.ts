import { NextResponse } from 'next/server';
import { authFromRequest, createServiceClient } from '@/lib/supabaseServer';
import { fetchRavenSystemV2, deriveStatusFromProgress } from '@/lib/ravenColonial';
import { enrichRavenSystemWithJournalSnapshots } from '@/lib/ravenDepotSnapshots';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const { ids } = await req.json();
    if (!Array.isArray(ids) || ids.length === 0) {
      return NextResponse.json({ error: 'ids array required' }, { status: 400 });
    }

    const { user } = await authFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const supabase = createServiceClient();
    const { data: routeSystems, error } = await supabase
      .from('route_systems')
      .select('id,system_name,status')
      .in('id', ids);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!routeSystems?.length) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const results: any[] = [];
    for (const r of routeSystems) {
      try {
        const data = await enrichRavenSystemWithJournalSnapshots(
          await fetchRavenSystemV2(r.system_name),
        );

        // Upsert в кэш-таблицу system_progress
        const { error: upsertErr } = await supabase.from('system_progress').upsert({
          system_name: r.system_name,
          progress: data.progress,
          updated_at: new Date().toISOString(),
          data: {
            siteName: data.siteName,
            architectName: data.architectName,
            projects: data.projects,
            resources: data.resources,
            totalRequired: data.totalRequired,
            totalProvided: data.totalProvided,
            totalRemaining: data.totalRemaining,
          },
        });
        if (upsertErr) {
          console.warn('[route/progress] system_progress upsert skipped:', upsertErr.message);
        }

        const systemFound = data.progress != null || data.projects.length > 0;
        if (systemFound) {
          const status = data.progress != null ? deriveStatusFromProgress(data.progress) : r.status;
          if (data.progress != null) {
            await supabase
              .from('route_systems')
              .update({ progress: data.progress, status, updated_at: new Date().toISOString() })
              .eq('id', r.id);
          }
          results.push({ 
            system_name: r.system_name, 
            progress: data.progress,
            status,
            found: true,
            siteName: data.siteName,
            architectName: data.architectName,
            projects: data.projects,
            resources: data.resources,
            totalRequired: data.totalRequired,
            totalProvided: data.totalProvided,
            totalRemaining: data.totalRemaining,
            error: data.error 
          });
        } else {
          results.push({ 
            system_name: r.system_name, 
            progress: null, 
            status: r.status, 
            found: false,
            siteName: null,
            architectName: null,
            projects: [],
            resources: [],
            error: data.error 
          });
        }
      } catch (innerErr: any) {
        console.error(`[route/progress] Error processing ${r.system_name}:`, innerErr);
        results.push({ 
          system_name: r.system_name, 
          progress: null, 
          status: r.status, 
          found: false, 
          siteName: null,
          architectName: null,
          projects: [],
          resources: [],
          error: innerErr.message || 'Internal error' 
        });
      }
    }

    return NextResponse.json({ results, updated: results.filter((r) => r.found).length });
  } catch (e: any) {
    console.error('[route/progress] Unhandled error:', e);
    return NextResponse.json({ error: e.message || 'Internal server error' }, { status: 500 });
  }
}
