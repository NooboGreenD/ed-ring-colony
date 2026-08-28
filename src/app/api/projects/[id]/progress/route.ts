import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabaseServer';
import { fetchRavenSystemV2 } from '@/lib/ravenColonial';

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

    for (let i = 0; i < systems.length; i += batchSize) {
      const batch = systems.slice(i, i + batchSize);

      await Promise.all(batch.map(async (sys) => {
        try {
          const raven = await fetchRavenSystemV2(sys.system_name);

          // Сохраняем в project_systems.notes как JSON для кэширования
          const ravenCache = {
            progress: raven.progress,
            siteName: raven.siteName,
            architectName: raven.architectName,
            projects: raven.projects,
            resources: raven.resources,
            synced_at: new Date().toISOString(),
          };

          await supabase
            .from('project_systems')
            .update({ 
              notes: JSON.stringify(ravenCache),
              planned_status: raven.progress === 100 ? 'done' : raven.progress && raven.progress > 0 ? 'building' : undefined
            })
            .eq('id', sys.id);

          results.push({
            system_name: sys.system_name,
            found: raven.progress != null,
            progress: raven.progress,
            projects_count: raven.projects.length,
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
