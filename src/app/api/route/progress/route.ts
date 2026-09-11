import { NextResponse } from 'next/server';
import { authFromRequest, createServiceClient } from '@/lib/supabaseServer';
import { fetchRavenSystemV2, deriveStatusFromProgress } from '@/lib/ravenColonial';
import { enrichRavenSystemWithJournalSnapshots } from '@/lib/ravenDepotSnapshots';
import { persistRavenSystemProgress } from '@/lib/systemProgress';

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
    for (const routeSystem of routeSystems) {
      try {
        const data = await enrichRavenSystemWithJournalSnapshots(
          await fetchRavenSystemV2(routeSystem.system_name),
        );
        const systemFound = data.progress != null || data.projects.length > 0;
        const status = data.progress != null
          ? deriveStatusFromProgress(data.progress)
          : routeSystem.status;

        let cacheWarnings: string[] = [];
        if (systemFound) {
          const cacheResult = await persistRavenSystemProgress(supabase, routeSystem.system_name, data);
          cacheWarnings = cacheResult.warnings;
        }

        results.push({
          system_name: routeSystem.system_name,
          progress: data.progress,
          status,
          found: systemFound,
          siteName: data.siteName,
          architectName: data.architectName,
          projects: data.projects,
          resources: data.resources,
          totalRequired: data.totalRequired,
          totalProvided: data.totalProvided,
          totalRemaining: data.totalRemaining,
          error: data.error,
          ...(cacheWarnings.length > 0 ? { cacheWarnings } : {}),
        });
      } catch (innerErr: any) {
        console.error(`[route/progress] Error processing ${routeSystem.system_name}:`, innerErr);
        results.push({
          system_name: routeSystem.system_name,
          progress: null,
          status: routeSystem.status,
          found: false,
          siteName: null,
          architectName: null,
          projects: [],
          resources: [],
          error: innerErr.message || 'Internal error',
        });
      }
    }

    return NextResponse.json({ results, updated: results.filter((result) => result.found).length });
  } catch (error: any) {
    console.error('[route/progress] Unhandled error:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
