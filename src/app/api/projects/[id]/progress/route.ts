import { NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabaseServer';
import { fetchRavenSystemV2 } from '@/lib/ravenColonial';
import { enrichRavenSystemWithJournalSnapshots } from '@/lib/ravenDepotSnapshots';
import { persistRavenSystemProgress, statusFromProgress } from '@/lib/systemProgress';
import { loadSystemsProgress } from '@/lib/systemOverview';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * GET /api/projects/[id]/progress — прогресс каждой системы проекта тем же
 * расчётом, что у «Проектов систем» и карточки системы (кэш Raven + площадки
 * из журналов пилотов). Проекты эскадрилий публичны — как и их системы.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const projectId = Number.parseInt(id, 10);
  if (!Number.isSafeInteger(projectId) || projectId <= 0) {
    return NextResponse.json({ error: 'Неверный проект' }, { status: 400 });
  }
  try {
    const svc = createServiceClient();
    const { data: systems, error } = await svc
      .from('project_systems')
      .select('system_name')
      .eq('project_id', projectId)
      .limit(2000);
    if (error) throw new Error(error.message);
    const progress = await loadSystemsProgress(svc, (systems ?? []).map((row: { system_name: string }) => row.system_name));
    return NextResponse.json({ systems: progress }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[projects/progress GET]', message);
    const missing = /system_progress_sources|schema cache|does not exist/i.test(message);
    return NextResponse.json(
      { error: missing ? 'Прогресс систем ждёт миграцию 20261020120000_unified_system_data.sql' : 'Не удалось посчитать прогресс систем', systems: [] },
      { status: 503 },
    );
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const resolvedParams = await params;
  try {
    const projectId = parseInt(resolvedParams.id);
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
