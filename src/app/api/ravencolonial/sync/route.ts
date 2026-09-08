import { NextResponse } from 'next/server';
import { authFromRequest, createServiceClient } from '@/lib/supabaseServer';
import { fetchRavenSystemV2, deriveStatusFromProgress } from '@/lib/ravenColonial';
import { checkSyncRateLimit } from '@/lib/rateLimit';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const MAX_BATCH_SIZE = 50;

export async function POST(req: Request) {
  try {
    // Аутентификация
    const { user } = await authFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Service client для обхода RLS
    const supabase = createServiceClient();

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
    if (!checkSyncRateLimit(ip, 300)) {
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

        const status = deriveStatusFromProgress(data.progress);

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

        // Всегда обновляем route_systems если система найдена (есть проекты или прогресс)
        const systemFound = data.progress != null || (data.projects && data.projects.length > 0);
        if (systemFound) {
          const normalizedName = name.trim();
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
              console.error('Failed to update route_systems for', name, updateError);
            }
          } else {
            // Пробуем case-insensitive поиск
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
                console.error('Failed to update route_systems (CI) for', name, updateError);
              }
            } else {
              console.warn('System not found in route_systems:', normalizedName);
            }
          }
          updated++;
        }

        // Также обновляем hubs (таблица хабов для карты)
        if (systemFound) {
          const normalizedName = name.trim();
          const { data: existingHub } = await supabase.from('hubs')
            .select('id,system_name')
            .eq('system_name', normalizedName)
            .maybeSingle();
          
          if (existingHub) {
            const { error: hubUpdateError } = await supabase.from('hubs')
              .update({ 
                progress: data.progress ?? 0, 
                status, 
                updated_at: new Date().toISOString() 
              })
              .eq('id', existingHub.id);
            if (hubUpdateError) {
              console.error('Failed to update hubs for', name, hubUpdateError);
            }
          } else {
            // Пробуем case-insensitive поиск в hubs
            const { data: existingHubCI } = await supabase.from('hubs')
              .select('id,system_name')
              .ilike('system_name', normalizedName)
              .maybeSingle();
            if (existingHubCI) {
              const { error: hubUpdateError } = await supabase.from('hubs')
                .update({ 
                  progress: data.progress ?? 0, 
                  status, 
                  updated_at: new Date().toISOString() 
                })
                .eq('id', existingHubCI.id);
              if (hubUpdateError) {
                console.error('Failed to update hubs (CI) for', name, hubUpdateError);
              }
            }
          }
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
          found: systemFound,
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
