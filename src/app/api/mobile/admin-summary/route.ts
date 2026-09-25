import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/billing/auth';
import { getServerMonitorSnapshot } from '@/lib/serverMonitor';
import { authFromRequest } from '@/lib/requestUser';
import { billingRepo } from '@/lib/billingData';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const revalidate = 0;

/**
 * Мобильный агрегатор админ-панели для Android-приложения.
 * Один запрос = вся информация по пунктам админки.
 * Требует роль admin.
 */
export async function GET(req: Request) {
  try {
    const auth = await requireAdmin(req);
    if ('response' in auth) return auth.response;

    const { searchParams } = new URL(req.url);
    const period = (searchParams.get('period') as any) || '30d';

    const { supabase } = await authFromRequest(req);

    // Параллельно собираем все данные
    const [
      monitor,
      billingStats,
      profilesCount,
      hubs,
      routeCount,
      newsCount,
      forumThreadsCount,
      forumPostsCount,
      commentsCount,
      ticketsOpen,
      ticketsAll,
      tokensCount,
      galaxyCount,
      backupLog,
      galnetLog,
      recentNews,
      recentHubs,
      recentRoute,
      contentRow,
      authProvidersRow,
    ] = await Promise.allSettled([
      getServerMonitorSnapshot(),
      billingRepo.getProjectStatistics(period).catch(() => null),
      supabase.from('profiles').select('id', { count: 'exact', head: true }),
      supabase.from('hubs').select('id, name, system_name, status, segment_order').order('segment_order').limit(100),
      supabase.from('route_systems').select('id', { count: 'exact', head: true }),
      supabase.from('news').select('id', { count: 'exact', head: true }),
      supabase.from('forum_threads').select('id', { count: 'exact', head: true }),
      supabase.from('forum_posts').select('id', { count: 'exact', head: true }),
      supabase.from('comments').select('id', { count: 'exact', head: true }),
      supabase.from('support_tickets').select('id', { count: 'exact', head: true }).eq('status', 'open'),
      supabase.from('support_tickets').select('id', { count: 'exact', head: true }),
      supabase.from('api_tokens').select('id', { count: 'exact', head: true }).is('revoked_at', null),
      supabase.from('galaxy_systems').select('id', { count: 'exact', head: true }),
      supabase.from('galnet_sync_log').select('*').order('id', { ascending: false }).limit(5),
      supabase.from('galnet_news').select('id', { count: 'exact', head: true }),
      supabase.from('news').select('id, title, published_at, translation_status').order('published_at', { ascending: false }).limit(10),
      supabase.from('hubs').select('id, name, system_name, status, x, y, z, segment_order').order('segment_order').limit(20),
      supabase.from('route_systems').select('id, system_name, status, progress, sort_order, x, y, z').order('sort_order').limit(30),
      supabase.from('site_content').select('*').eq('id', 1).maybeSingle(),
      supabase.from('app_flags').select('*').limit(10),
    ]);

    const safeCount = (r: PromiseSettledResult<any>) => {
      if (r.status === 'fulfilled' && r.value && typeof r.value.count === 'number') return r.value.count;
      if (r.status === 'fulfilled' && r.value && r.value.data && typeof r.value.data === 'object') {
        // head:true returns count in separate field
        return (r.value as any).count ?? null;
      }
      return null;
    };

    const safeData = (r: PromiseSettledResult<any>) => {
      if (r.status === 'fulfilled') return r.value?.data ?? null;
      return null;
    };

    const monitorData = monitor.status === 'fulfilled' ? monitor.value : null;
    const billing = billingStats.status === 'fulfilled' ? billingStats.value : null;

    // Enrich billing telemetry if possible
    if (billing) {
      try {
        const [cmdrs, hubsCnt, doneHubs, tonnage] = await Promise.all([
          supabase.from('profiles').select('id', { count: 'exact', head: true }),
          supabase.from('hubs').select('id', { count: 'exact', head: true }),
          supabase.from('hubs').select('id', { count: 'exact', head: true }).eq('status', 'done'),
          supabase.from('deliveries').select('amount.sum()').maybeSingle(),
        ]);
        if (cmdrs.count != null) billing.telemetry.totalRegisteredPilots = cmdrs.count;
        if (hubsCnt.count != null) billing.telemetry.totalSystemsClaimed = hubsCnt.count;
        if (doneHubs.count != null) billing.telemetry.totalFacilitiesBuilt = doneHubs.count;
        const sum = (tonnage.data as any)?.sum;
        if (typeof sum === 'number') billing.telemetry.totalTonnageHauled = sum;
      } catch {}
    }

    const response = {
      success: true,
      checkedAt: new Date().toISOString(),
      // Overview counts — для dashboard
      overview: {
        profiles: safeCount(profilesCount),
        hubs: safeCount(hubs),
        routeSystems: safeCount(routeCount),
        news: safeCount(newsCount),
        forumThreads: safeCount(forumThreadsCount),
        forumPosts: safeCount(forumPostsCount),
        comments: safeCount(commentsCount),
        ticketsOpen: safeCount(ticketsOpen),
        ticketsTotal: safeCount(ticketsAll),
        apiTokens: safeCount(tokensCount),
        galaxySystems: safeCount(galaxyCount),
        galnetPending: safeCount(galnetLog),
      },
      // Полный снапшот мониторинга сервера
      monitor: monitorData,
      // Биллинг
      billing: billing,
      // Списки
      lists: {
        hubs: safeData(hubs) ?? [],
        routeSystems: safeData(recentRoute) ?? [],
        recentNews: safeData(recentNews) ?? [],
        backupLog: safeData(backupLog) ?? [],
      },
      // Контент
      content: safeData(contentRow) ?? null,
      flags: safeData(authProvidersRow) ?? [],
      // Health summary
      health: {
        overall: monitorData?.overall ?? 'unknown',
        app: monitorData?.application ? 'healthy' : 'unknown',
        database: monitorData?.database?.status ?? 'unknown',
        docker: monitorData?.docker?.available ? 'healthy' : 'unknown',
        disk: monitorData?.disk?.available ? (monitorData.disk.usedPercent && monitorData.disk.usedPercent > 90 ? 'warning' : 'healthy') : 'unknown',
        project: monitorData?.project?.updateStatus ?? 'unknown',
      },
    };

    return NextResponse.json(response, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (e: any) {
    console.error('[mobile admin-summary] error', e);
    return NextResponse.json({ error: e.message || 'Internal error' }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }
}
