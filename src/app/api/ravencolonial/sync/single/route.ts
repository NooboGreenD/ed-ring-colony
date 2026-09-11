import { NextResponse } from 'next/server';
import { authFromRequest, createServiceClient } from '@/lib/supabaseServer';
import { fetchRavenSystemV2, deriveStatusFromProgress } from '@/lib/ravenColonial';
import { enrichRavenSystemWithJournalSnapshots } from '@/lib/ravenDepotSnapshots';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const { system_name } = await req.json();
    if (!system_name || typeof system_name !== 'string') {
      return NextResponse.json({ error: 'system_name required' }, { status: 400 });
    }

    const { user } = await authFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const supabase = createServiceClient();
    const data = await enrichRavenSystemWithJournalSnapshots(
      await fetchRavenSystemV2(system_name),
    );

    const status = deriveStatusFromProgress(data.progress);

    // Обновляем route_systems если система найдена
    const systemFound = data.progress != null || data.projects.length > 0;
    if (systemFound) {
      const normalizedName = system_name.trim();
      const { data: existing } = await supabase.from('route_systems')
        .select('id,system_name')
        .eq('system_name', normalizedName)
        .maybeSingle();
      
      if (existing) {
        const { error: updateError } = await supabase.from('route_systems')
          .update({ 
            progress: data.progress ?? 0, 
            status, 
            updated_at: new Date().toISOString() 
          })
          .eq('id', existing.id);
        if (updateError) {
          console.error('Failed to update route_systems for', system_name, updateError);
        }
      } else {
        const { data: existingCI } = await supabase.from('route_systems')
          .select('id,system_name')
          .ilike('system_name', normalizedName)
          .maybeSingle();
        if (existingCI) {
          const { error: updateError } = await supabase.from('route_systems')
            .update({ 
              progress: data.progress ?? 0, 
              status, 
              updated_at: new Date().toISOString() 
            })
            .eq('id', existingCI.id);
          if (updateError) {
            console.error('Failed to update route_systems (CI) for', system_name, updateError);
          }
        } else {
          console.warn('System not found in route_systems:', normalizedName);
        }
      }
    }

    // Логируем
    await supabase.from('raven_sync_log').insert({
      system_name,
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
      source: 'ravencolonial_api'
    });

    return NextResponse.json({
      system_name,
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
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || 'Internal error' }, { status: 500 });
  }
}
