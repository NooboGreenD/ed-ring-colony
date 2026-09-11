import { NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabaseServer';
import { fetchRavenSystemV2 } from '@/lib/ravenColonial';
import { enrichRavenSystemWithJournalSnapshots } from '@/lib/ravenDepotSnapshots';
import { persistRavenSystemProgress, statusFromProgress } from '@/lib/systemProgress';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const projectId = parseInt(params.id);
    const supabase = await createClient();

    const { data: systems } = await supabase
      .from('project_systems')
      .select('id, system_name')
      .eq('project_id', projectId);

    if (!systems?.length) return NextResponse.json({ error: 'No systems' }, { status: 400 });

    const results: any[] = [];
    const batchSize = 3;
    const mapCache = createServiceClient();

    for (let i = 0; i < systems.length; i += batchSize) {
      const batch = systems.slice(i, i + batchSize);

      await Promise.all(batch.map(async (sys) => {
        try {
          const raven = await enrichRavenSystemWithJournalSnapshots(
            await fetchRavenSystemV2(sys.system_name),
          );

          // Сохраняем в project_systems.notes как JSON для кэширования
          const ravenCache = {
            progress: raven.progress,
            siteName: raven.siteName,
            architectName: raven.architectName,
            projects: raven.projects,
            resources: raven.resources,
            totalRequired: raven.totalRequired,
            totalProvided: raven.totalProvided,
            totalRemaining: raven.totalRemaining,
            synced_at: new Date().toISOString(),
          };

          const projectSystemUpdate: { notes: string; planned_status?: 'planned' | 'building' | 'done' } = {
            notes: JSON.stringify(ravenCache),
          };
          if (raven.progress != null) {
            projectSystemUpdate.planned_status = statusFromProgress(raven.progress);
          }

          await supabase
            .from('project_systems')
            .update(projectSystemUpdate)
            .eq('id', sys.id);

          const found = raven.progress != null || raven.projects.length > 0;
          let cacheWarnings: string[] = [];
          if (found) {
            // The system detail read is authoritative for this response. A
            // transient map-cache write failure must not turn it into a false
            // “not found” result for the project UI.
            try {
              const mapCacheResult = await persistRavenSystemProgress(mapCache, sys.system_name, raven);
              cacheWarnings = mapCacheResult.warnings;
            } catch (cacheError) {
              cacheWarnings = [cacheError instanceof Error ? cacheError.message : 'Could not update map progress cache.'];
            }
          }

          results.push({
            system_name: sys.system_name,
            found,
            progress: raven.progress,
            projects_count: raven.projects.length,
            totalRequired: raven.totalRequired,
            totalProvided: raven.totalProvided,
            totalRemaining: raven.totalRemaining,
            ...(cacheWarnings.length ? { cacheWarnings } : {}),
          });
        } catch (err: any) {
          results.push({
            system_name: sys.system_name,
            found: false,
            error: err.message,
          });
        }
      }));
    }

    return NextResponse.json({ results, synced: results.filter(r => r.found).length });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
