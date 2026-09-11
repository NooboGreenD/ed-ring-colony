import { NextResponse } from 'next/server';
import { authFromRequest, createServiceClient } from '@/lib/supabaseServer';
import { fetchRavenSystemV2, deriveStatusFromProgress } from '@/lib/ravenColonial';
import { enrichRavenSystemWithJournalSnapshots } from '@/lib/ravenDepotSnapshots';
import { persistRavenSystemProgress } from '@/lib/systemProgress';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const { system_name } = await req.json();
    if (!system_name || typeof system_name !== 'string') {
      return NextResponse.json({ error: 'system_name required' }, { status: 400 });
    }

    const { user } = await authFromRequest(req);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const normalizedName = system_name.trim();
    if (!normalizedName) return NextResponse.json({ error: 'system_name required' }, { status: 400 });

    const supabase = createServiceClient();
    const data = await enrichRavenSystemWithJournalSnapshots(
      await fetchRavenSystemV2(normalizedName),
    );
    const status = deriveStatusFromProgress(data.progress);
    const systemFound = data.progress != null || data.projects.length > 0;
    let cacheWarnings: string[] = [];

    if (systemFound) {
      // This endpoint used to update only route_systems. /api/route then read
      // an older 0% system_progress row and overwrote that fresh value.
      const cacheResult = await persistRavenSystemProgress(supabase, normalizedName, data);
      cacheWarnings = cacheResult.warnings;
    }

    await supabase.from('raven_sync_log').insert({
      system_name: normalizedName,
      architect_name: data.architectName,
      system_progress: data.progress,
      system_status: status,
      site_name: data.siteName,
      resources: data.resources || [],
      projects: data.projects || [],
      full_data: {
        siteName: data.siteName,
        architectName: data.architectName,
        projects: data.projects,
        resources: data.resources,
        totalRequired: data.totalRequired,
        totalProvided: data.totalProvided,
        totalRemaining: data.totalRemaining,
      },
      error_message: data.error || null,
      sync_type: 'single',
      source: 'ravencolonial_api',
    });

    return NextResponse.json({
      system_name: normalizedName,
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
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Internal error' }, { status: 500 });
  }
}
