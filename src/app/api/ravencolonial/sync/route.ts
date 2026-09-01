import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabaseServer';
import { fetchRavenSystemV2 } from '@/lib/ravenColonial';
import { checkRateLimit } from '@/lib/rateLimit';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const MAX_BATCH_SIZE = 50;

export async function POST(req: Request) {
  try {
    // Аутентификация
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Проверяем роль (только admin/moderator могут синхронизировать)
    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single();

    if (!['admin', 'moderator'].includes(profile?.role ?? '')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Rate limiting по IP
    const ip = req.headers.get('x-forwarded-for') || 'unknown';
    if (!checkRateLimit(ip, 10)) {
      return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
    }

    const { system_names } = await req.json();
    if (!Array.isArray(system_names) || system_names.length === 0) {
      return NextResponse.json({ error: 'system_names array required' }, { status: 400 });
    }

    if (system_names.length > MAX_BATCH_SIZE) {
      return NextResponse.json(
        { error: `Batch too large. Maximum ${MAX_BATCH_SIZE} systems per request.` },
        { status: 400 }
      );
    }

    const results: any[] = [];
    let updated = 0;

    for (const name of system_names) {
      try {
        const data = await fetchRavenSystemV2(name);

        const status = data.progress != null 
          ? (data.progress >= 100 ? 'done' : data.progress > 0 ? 'building' : 'planned')
          : 'planned';

        // Upsert в кэш прогресса
        await supabase.from('system_progress').upsert({
          system_name: name,
          progress: data.progress,
          updated_at: new Date().toISOString(),
          data: {
            siteName: data.siteName,
            architectName: data.architectName,
            projects: data.projects,
            resources: data.resources,
          },
        });

        // Обновление route_systems если найден прогресс
        if (data.progress != null) {
          await supabase.from('route_systems')
            .update({ progress: data.progress, status })
            .ilike('system_name', name);
          updated++;
        }

        // Логирование в raven_sync_log
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
            error: data.error
          },
          error_message: data.error || null,
          sync_type: 'batch',
          source: 'ravencolonial_api'
        });

        results.push({
          system_name: name,
          progress: data.progress,
          status,
          found: data.progress != null,
          siteName: data.siteName,
          architectName: data.architectName,
          projects: data.projects,
          resources: data.resources,
          error: data.error,
        });
      } catch (inner: any) {
        // Логируем ошибку
        await supabase.from('raven_sync_log').insert({
          system_name: name,
          error_message: inner.message || 'Unknown error',
          sync_type: 'batch',
          source: 'error'
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

    return NextResponse.json({ 
      updated, 
      total: system_names.length,
      results 
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || 'Internal error' }, { status: 500 });
  }
}
