import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabaseServer';
import { fetchRavenSystemV2 } from '@/lib/ravenColonial';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const { system_name } = await req.json();
    if (!system_name || typeof system_name !== 'string') {
      return NextResponse.json({ error: 'system_name required' }, { status: 400 });
    }

    const supabase = await createClient();
    const data = await fetchRavenSystemV2(system_name);

    const status = data.progress != null 
      ? (data.progress >= 100 ? 'done' : data.progress > 0 ? 'building' : 'planned')
      : 'planned';

    // Обновляем route_systems
    if (data.progress != null) {
      await supabase.from('route_systems')
        .update({ progress: data.progress, status })
        .ilike('system_name', system_name);
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
      },
      error_message: data.error || null,
      sync_type: 'single',
      source: 'ravencolonial_api'
    });

    return NextResponse.json({
      system_name,
      progress: data.progress,
      status,
      found: data.progress != null,
      siteName: data.siteName,
      architectName: data.architectName,
      projects: data.projects,
      resources: data.resources,
      error: data.error,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || 'Internal error' }, { status: 500 });
  }
}
