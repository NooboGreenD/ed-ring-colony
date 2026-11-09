import { readAllRows } from '@/lib/readAllRows';
import { NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabaseServer';
import { fetchRavenSystemProgress, deriveStatusFromProgress } from '@/lib/ravenColonial';
import { enrichRavenSystemWithJournalSnapshots } from '@/lib/ravenDepotSnapshots';
import {
  latestProgressBySystem,
  persistRavenSystemProgress,
  readableProgress,
  statusFromProgress,
  systemNameKey,
} from '@/lib/systemProgress';
import { apiTranslate } from '@/lib/i18n/apiT';
import {
  buildSystemCards,
  mergeResourceRows,
  ravenProjectFromCard,
  type SiteProjectCard,
  type StoredProjectRow,
} from '@/lib/siteProjects';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

async function loadJournalTelemetry(supabase: Awaited<ReturnType<typeof createClient>>, name: string) {
  const { data, count, error } = await supabase
    .from('construction_depot_snapshots')
    .select('snapshot_at', { count: 'exact' })
    .ilike('system_name', name)
    .order('snapshot_at', { ascending: false })
    .limit(1);
  if (error) return { available: false, snapshots: 0, latestAt: null as string | null };
  return {
    available: (count ?? 0) > 0,
    snapshots: count ?? 0,
    latestAt: data?.[0]?.snapshot_at ?? null,
  };
}

/**
 * Проекты, которые Helper прислал на сайт (`construction_projects`).
 *
 * Это первичный источник: Raven Colonial может отвечать 503, а стройка, о
 * которой Helper уже сообщил сайту, всё равно должна быть видна.
 */
async function loadSiteProjects(
  supabase: Awaited<ReturnType<typeof createClient>>,
  name: string,
): Promise<StoredProjectRow[]> {
  const { data, error } = await supabase
    .from('construction_projects')
    .select('*')
    .ilike('system_name', name)
    .order('updated_at', { ascending: false })
    .limit(100);
  if (error) {
    console.warn('[systems/progress] Failed to read construction_projects:', error.message);
    return [];
  }
  return (data ?? []) as StoredProjectRow[];
}

/**
 * Ответ страницы системы из карточек сайта: проекты, общий тоннаж и процент.
 * Форма та же, что у ответа Raven, поэтому страница не знает, откуда данные.
 */
function sitePayload(name: string, cards: SiteProjectCard[]) {
  const projects = cards.map(ravenProjectFromCard);
  const resources = mergeResourceRows(projects.flatMap((project) => project.resources));
  const exact = resources.length > 0 && resources.every((row) => row.exact);
  const totalRequired = exact
    ? resources.reduce((sum, row) => sum + (row.required ?? 0), 0)
    : cards.reduce((sum, card) => sum + (ravenProjectFromCard(card).totalRequired ?? 0), 0) || null;
  const totalRemaining = resources.reduce((sum, row) => sum + row.remaining, 0);
  const totalProvided = totalRequired == null ? null : Math.max(0, totalRequired - totalRemaining);
  const progress = totalRequired && totalRequired > 0
    ? Math.round(Math.min(100, (totalProvided ?? 0) / totalRequired * 100) * 100) / 100
    : null;
  const newest = cards
    .map((card) => card.updatedAt)
    .filter((value): value is string => Boolean(value))
    .sort()
    .pop() ?? null;
  return {
    system_name: cards[0]?.systemName || name,
    progress,
    status: deriveStatusFromProgress(progress),
    found: true,
    siteName: null,
    architectName: cards.map((card) => card.architectName).find(Boolean) ?? null,
    projects,
    resources,
    totalRequired,
    totalProvided,
    totalRemaining,
    updated_at: newest,
    siteProjects: cards.length,
  };
}

/** Один и тот же проект у Raven и на сайте: совпадает MarketID или buildId. */
function sameProject(card: SiteProjectCard, project: { marketId?: unknown; buildId?: unknown }): boolean {
  const market = project.marketId == null ? '' : String(project.marketId).trim();
  if (market && card.marketId != null && String(card.marketId) === market) return true;
  const build = project.buildId == null ? '' : String(project.buildId).trim();
  return Boolean(build) && card.buildId === build;
}

function mergeCached(
  names: { system_name: string; hub_name?: string; status?: string }[],
  cached: { system_name: string; progress: unknown; updated_at: string | null }[] | null,
) {
  const byName = latestProgressBySystem(cached);
  return names.map((system) => {
    const row = byName.get(systemNameKey(system.system_name));
    const progress = row?.progress ?? null;
    return {
      system_name: system.system_name,
      hub_name: system.hub_name,
      status: progress == null ? system.status ?? 'planned' : statusFromProgress(progress),
      progress,
      updated_at: row?.updated_at ?? null,
      found: progress != null,
      data: null,
    };
  });
}

export async function GET(req: Request) {
  const t = await apiTranslate();
  const url = new URL(req.url);
  const name = url.searchParams.get('name')?.trim();
  const supabase = await createClient();

  if (name) {
    // Uploader и Raven читаются параллельно. Журнальный snapshot даёт точные
    // ресурсы последнего состояния, Raven — общий прогресс и вклад всех
    // командиров; архитектору нужны оба источника, а не один вместо другого.
    const telemetryPromise = loadJournalTelemetry(supabase, name);
    // Сайт проекта читается параллельно с Raven: источник истины — сайт,
    // Raven лишь вторичная синхронизация и вполне может отвечать 503.
    const sitePromise = loadSiteProjects(supabase, name);
    // 1. Пробуем RavenColonial напрямую
    const ravenData = await fetchRavenSystemProgress(name, enrichRavenSystemWithJournalSnapshots);
    const [telemetry, siteRows] = await Promise.all([telemetryPromise, sitePromise]);
    const siteCards = buildSystemCards({ stored: siteRows, system: name });
    if (ravenData.found && !ravenData.error) {
      // A system detail page is also a live Raven read. Store that same read
      // in the map cache so returning to /map cannot show an older 0% row.
      // Cache failures must not make the public detail page unavailable.
      try {
        const cacheResult = await persistRavenSystemProgress(createServiceClient(), name, {
          systemName: ravenData.system_name,
          progress: ravenData.progress,
          siteName: ravenData.data?.siteName || null,
          architectName: ravenData.data?.architectName || null,
          projects: ravenData.data?.projects || [],
          resources: ravenData.data?.resources || [],
          totalRequired: ravenData.data?.totalRequired ?? null,
          totalProvided: ravenData.data?.totalProvided ?? null,
          totalRemaining: ravenData.data?.totalRemaining ?? 0,
        });
        if (cacheResult.warnings.length > 0) {
          console.warn('[systems/progress] Raven result could only be partially cached:', cacheResult.warnings.join(' | '));
        }
      } catch (cacheError: any) {
        console.warn('[systems/progress] Failed to update map cache:', cacheError?.message || cacheError);
      }

      // Сайт первичен: проекты, которых Raven ещё не знает (например, Helper
      // создал их, пока Raven отвечал 503), тоже должны быть на странице.
      const ravenProjects = ravenData.data?.projects || [];
      const siteOnly = siteCards.filter(
        (card) => !ravenProjects.some((project) => sameProject(card, project)),
      );
      if (ravenProjects.length === 0 && siteCards.length > 0) {
        // Raven жив, но про эту систему ничего не знает — показываем сайт.
        return NextResponse.json({
          ...sitePayload(name, siteCards),
          telemetry,
          error: undefined,
        });
      }

      // Раскладываем вложенные data.* на верхний уровень для совместимости с UI
      return NextResponse.json({
        system_name: ravenData.system_name,
        progress: ravenData.progress,
        status: ravenData.status,
        found: ravenData.found,
        siteName: ravenData.data?.siteName || null,
        architectName: ravenData.data?.architectName || null,
        projects: [...ravenProjects, ...siteOnly.map(ravenProjectFromCard)],
        resources: ravenData.data?.resources || [],
        totalRequired: ravenData.data?.totalRequired ?? null,
        totalProvided: ravenData.data?.totalProvided ?? null,
        totalRemaining: ravenData.data?.totalRemaining ?? 0,
        siteProjects: siteCards.length,
        telemetry,
        updated_at: ravenData.updated_at,
        error: ravenData.error,
      });
    }

    // 2. Fallback to the newest normalized cache row. Legacy case variants
    // can coexist in this table, so `maybeSingle()` would be ambiguous.
    const { data: cachedRows } = await supabase
      .from('system_progress')
      .select('system_name,progress,updated_at,data')
      .ilike('system_name', name)
      .order('updated_at', { ascending: false })
      .limit(20);
    const cachedByName = latestProgressBySystem(cachedRows);
    const cachedProgress = cachedByName.get(systemNameKey(name));
    const cached = (cachedRows || []).find((row) =>
      systemNameKey(row.system_name) === systemNameKey(name)
      && row.updated_at === cachedProgress?.updated_at,
    ) ?? (cachedRows || []).find((row) => systemNameKey(row.system_name) === systemNameKey(name));

    // 2. Raven недоступен: собираем карточки из сайта и последнего кэша Raven.
    // Сайт важнее кэша — он свежее и не зависит от доступности Raven.
    const fallbackCards = buildSystemCards({
      stored: siteRows,
      ravenCache: cachedRows,
      system: name,
    });
    if (fallbackCards.length > 0) {
      const payload = sitePayload(name, fallbackCards);
      return NextResponse.json({
        ...payload,
        telemetry,
        // Причину недоступности Raven скрывать нельзя: цифры могут быть неполными.
        error: ravenData.error
          ? t('api.siteProjectShown', { error: ravenData.error })
          : undefined,
      });
    }

    if (cached) {
      const cachedData = cached.data && typeof cached.data === 'object' ? cached.data as Record<string, any> : {};
      const progress = cachedProgress?.progress ?? cached.progress;
      return NextResponse.json({
        system_name: cached.system_name,
        progress,
        status: statusFromProgress(progress),
        found: progress != null || (Array.isArray(cachedData.projects) && cachedData.projects.length > 0),
        siteName: cachedData.siteName || null,
        architectName: cachedData.architectName || null,
        projects: cachedData.projects || [],
        resources: cachedData.resources || [],
        totalRequired: cachedData.totalRequired ?? null,
        totalProvided: cachedData.totalProvided ?? null,
        totalRemaining: cachedData.totalRemaining ?? 0,
        telemetry,
        updated_at: cachedProgress?.updated_at ?? cached.updated_at,
        error: ravenData.error ? t('api.ravenShownCached', { error: ravenData.error }) : undefined,
      });
    }

    // 3. Fallback to the map source record. Query an array rather than
    // `maybeSingle()` because old data can contain case variants, and include
    // hubs so a hub marker's detail link behaves just like a route marker.
    const [{ data: routeRows }, { data: hubRows }] = await Promise.all([
      supabase
        .from('route_systems')
        .select('system_name,status,progress')
        .ilike('system_name', name)
        .limit(20),
      supabase
        .from('hubs')
        .select('system_name,status,progress')
        .ilike('system_name', name)
        .limit(20),
    ]);
    const requestedKey = systemNameKey(name);
    const mapSystem = [...(routeRows || []), ...(hubRows || [])]
      .find((row) => systemNameKey(row.system_name) === requestedKey);

    if (mapSystem) {
      const progress = readableProgress(mapSystem.progress);
      return NextResponse.json({
        system_name: mapSystem.system_name,
        progress,
        // When a numeric value is present, use the identical status rule as
        // the map rather than retaining a legacy status column value.
        status: progress == null ? mapSystem.status : statusFromProgress(progress),
        found: progress != null,
        siteName: null,
        architectName: null,
        projects: [],
        resources: [],
        totalRequired: null,
        totalProvided: null,
        totalRemaining: 0,
        telemetry,
        error: ravenData.error || t('api.buildingsNotFound'),
      });
    }

    return NextResponse.json({
      system_name: ravenData.system_name,
      progress: ravenData.progress,
      status: ravenData.status,
      found: ravenData.found,
      siteName: ravenData.data?.siteName || null,
      architectName: ravenData.data?.architectName || null,
      projects: ravenData.data?.projects || [],
      resources: ravenData.data?.resources || [],
      totalRequired: ravenData.data?.totalRequired ?? null,
      totalProvided: ravenData.data?.totalProvided ?? null,
      totalRemaining: ravenData.data?.totalRemaining ?? 0,
      telemetry,
      updated_at: ravenData.updated_at,
      error: ravenData.error,
    });
  }

  const scope = url.searchParams.get('scope')?.trim() || 'hubs';

  if (scope === 'route') {
    const [{ data: hubs }, { data: route, error }] = await Promise.all([
      supabase.from('hubs').select('system_name'),
      readAllRows((from, to) => supabase.from('route_systems').select('system_name,sort_order').order('sort_order').order('id').range(from, to)),
    ]);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const hubSet = new Set((hubs ?? []).map((hub) => systemNameKey(hub.system_name)));
    const listed = (route ?? []).filter((routeSystem) => !hubSet.has(systemNameKey(routeSystem.system_name)));
    const { data: cached } = await readAllRows((from, to) => supabase
      .from('system_progress')
      .select('system_name,progress,updated_at').order('system_name').range(from, to));
    return NextResponse.json({
      systems: mergeCached(
        listed.map((r) => ({ system_name: r.system_name })),
        cached,
      ),
      total: listed.length,
      cached: true,
    });
  }

  const { data: hubs, error } = await supabase
    .from('hubs')
    .select('system_name,name,status,segment_order')
    .order('segment_order');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const { data: cached } = await supabase
    .from('system_progress')
    .select('system_name,progress,updated_at');

  return NextResponse.json({
    systems: mergeCached(
      (hubs ?? []).map((h) => ({
        system_name: h.system_name,
        hub_name: h.name,
        status: h.status,
      })),
      cached,
    ),
    cached: true,
  });
}
