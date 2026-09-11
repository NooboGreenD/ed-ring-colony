import { NextResponse } from 'next/server';
import { authFromRequest, createServiceClient } from '@/lib/supabaseServer';
import { fetchRavenSystemV2, deriveStatusFromProgress } from '@/lib/ravenColonial';
import { enrichRavenSystemWithJournalSnapshots } from '@/lib/ravenDepotSnapshots';
import { persistRavenSystemProgress } from '@/lib/systemProgress';
import { checkSyncRateLimit } from '@/lib/rateLimit';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const MAX_BATCH_SIZE = 50;

export async function POST(req: Request) {
  try {
    const { user } = await authFromRequest(req);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const supabase = createServiceClient();
    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single();

    if (!['admin', 'moderator'].includes(profile?.role ?? '')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const ip = req.headers.get('x-forwarded-for') || 'unknown';
    if (!checkSyncRateLimit(ip, 300)) {
      return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
    }

    const { system_names } = await req.json();
    if (!Array.isArray(system_names) || system_names.length === 0) {
      return NextResponse.json({ error: 'system_names array required' }, { status: 400 });
    }
    if (system_names.length > MAX_BATCH_SIZE) {
      return NextResponse.json({ error: `Batch too large. Maximum ${MAX_BATCH_SIZE} systems per request.` }, { status: 400 });
    }

    const results: any[] = [];
    let updated = 0;

    for (const rawName of system_names) {
      const name = typeof rawName === 'string' ? rawName.trim() : '';
      if (!name) {
        results.push({ system_name: String(rawName ?? ''), found: false, error: 'Invalid system name' });
        continue;
      }

      try {
        const data = await enrichRavenSystemWithJournalSnapshots(
          await fetchRavenSystemV2(name),
        );
        const systemFound = data.progress != null || data.projects.length > 0;
        const status = deriveStatusFromProgress(data.progress);
        let cacheWarnings: string[] = [];

        if (systemFound) {
          const cacheResult = await persistRavenSystemProgress(supabase, name, data);
          cacheWarnings = cacheResult.warnings;
          updated++;
        }

        await supabase.from('raven_sync_log').insert({
          system_name: name,
          build_id: data.projects?.[0]?.buildId || null,
          build_name: data.projects?.[0]?.buildName || null,
          architect_name: data.architectName,
          progress: data.projects?.[0]?.progress || null,
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
            error: data.error,
          },
          error_message: data.error || null,
          sync_type: 'batch',
          source: 'ravencolonial_api',
        });

        results.push({
          system_name: name,
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
      } catch (inner: any) {
        await supabase.from('raven_sync_log').insert({
          system_name: name,
          error_message: inner.message || 'Unknown error',
          sync_type: 'batch',
          source: 'error',
        });

        results.push({
          system_name: name,
          progress: null,
          status: 'planned',
          found: false,
          siteName: null,
          architectName: null,
          projects: [],
          resources: [],
          error: inner.message || 'Network error',
        });
      }
    }

    return NextResponse.json({ updated, total: system_names.length, results });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Internal error' }, { status: 500 });
  }
}
