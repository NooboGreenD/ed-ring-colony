import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabaseServer';
import { resolveRequestUser } from '@/lib/helperAuth';
import {
  buildSystemCards,
  projectNeed,
  projectNeedTotal,
  type JournalSiteRow,
  type SiteProjectCard,
  type StoredProjectRow,
} from '@/lib/siteProjects';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Сколько систем разворачивать, когда спрашивают «проекты командира». */
const MAX_SYSTEMS = 12;
const MAX_PROJECTS = 200;

/**
 * GET /api/projects/active — действующие стройки, первичный источник для Helper.
 *
 * Параметры:
 *   * `system` — имя системы (в том числе несколько через запятую);
 *   * `system_address` — адрес системы из журнала;
 *   * `market_id` — конкретная стройплощадка;
 *   * `cmdr` — «мои проекты» (только с токеном Helper или сессией).
 *
 * Данные собираются из трёх независимых источников и сливаются по площадке
 * (`src/lib/siteProjects.ts`):
 *
 *   1. `construction_projects` — то, что Helper прислал сам. Работает даже
 *      когда Raven Colonial отвечает 503;
 *   2. `system_progress.data.projects` — кэш Raven: вклад других командиров,
 *      если он когда-либо синхронизировался;
 *   3. `colonisation_sites` — снимки `ColonisationConstructionDepot`: точные
 *      `RequiredAmount`/`ProvidedAmount` из журналов.
 *
 * Ответ: `{ projects, sources, raven, warnings }`. `projects[].commodities` —
 * остаток потребности, `projects[].stale` — данные старше шести часов.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const systems = (url.searchParams.get('system') ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, MAX_SYSTEMS);
    const systemAddress = Number(url.searchParams.get('system_address') ?? '') || 0;
    const marketId = Number(url.searchParams.get('market_id') ?? '') || 0;
    const cmdr = (url.searchParams.get('cmdr') ?? '').trim();

    if (systems.length === 0 && !marketId && !cmdr) {
      return NextResponse.json(
        { error: 'system, market_id or cmdr is required' },
        { status: 400 },
      );
    }

    // Список «мои проекты» привязан к аккаунту: без него имя командира —
    // это перечисление чужих строек.
    let user: { userId: string; via: string } | null = null;
    if (cmdr) {
      user = await resolveRequestUser(req, url.searchParams.get('token') ?? undefined);
      if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const svc = createServiceClient();
    const stored = new Map<string, StoredProjectRow>();

    const addStored = (rows: StoredProjectRow[] | null | undefined) => {
      for (const row of rows ?? []) {
        // Более свежая строка по тому же ключу побеждает.
        const previous = stored.get(row.project_key);
        if (!previous || String(row.updated_at ?? '') >= String(previous.updated_at ?? '')) {
          stored.set(row.project_key, row);
        }
      }
    };

    if (systems.length > 0) {
      const { data, error } = await svc
        .from('construction_projects')
        .select('*')
        .in('system_name_lc', systems.map((name) => name.toLowerCase()))
        .order('updated_at', { ascending: false })
        .limit(MAX_PROJECTS);
      if (error) throw new Error(error.message);
      addStored(data as StoredProjectRow[]);
    }

    if (marketId) {
      const { data, error } = await svc
        .from('construction_projects')
        .select('*')
        .eq('market_id', marketId)
        .order('updated_at', { ascending: false })
        .limit(20);
      if (error) throw new Error(error.message);
      addStored(data as StoredProjectRow[]);
    }

    if (cmdr) {
      // Имя командира — без учёта регистра и лишних пробелов.
      const { data, error } = await svc
        .from('construction_projects')
        .select('*')
        .ilike('commander', cmdr)
        .eq('status', 'active')
        .order('updated_at', { ascending: false })
        .limit(MAX_PROJECTS);
      if (error) throw new Error(error.message);
      addStored(data as StoredProjectRow[]);
    }

    if (systemAddress) {
      const { data, error } = await svc
        .from('construction_projects')
        .select('*')
        .eq('system_address', systemAddress)
        .order('updated_at', { ascending: false })
        .limit(MAX_PROJECTS);
      if (error) throw new Error(error.message);
      addStored(data as StoredProjectRow[]);
    }

    // Системы, по которым нужны кэш Raven и снимки депотов. Когда ask — по
    // командиру, берём системы его проектов: без них ответ был бы пустым
    // вскоре после переустановки Helper.
    const systemNames = new Set(systems);
    for (const row of stored.values()) {
      const name = String(row.system_name ?? '').trim();
      if (name) systemNames.add(name);
    }
    const uniqueSystems = Array.from(systemNames).slice(0, MAX_SYSTEMS);

    let ravenRows: { system_name: string | null; data: unknown; updated_at: string | null }[] = [];
    let journalRows: JournalSiteRow[] = [];

    if (uniqueSystems.length > 0) {
      // У `system_progress` и `colonisation_sites` нет нормализованного ключа:
      // имя хранится как есть, а регистр исторически разный. Поэтому сравнение
      // по ilike на каждую систему отдельно, а не одним `or`: в именах бывают
      // запятые и скобки, на которых PostgREST-фильтр ломается.
      for (const name of uniqueSystems) {
        const { data } = await svc
          .from('system_progress')
          .select('system_name, data, updated_at')
          .ilike('system_name', name)
          .limit(5);
        if (data) ravenRows.push(...(data as typeof ravenRows));
      }

      for (const name of uniqueSystems) {
        const { data } = await svc
          .from('colonisation_sites')
          .select('market_id, system_name, construction_name, construction_progress, resources_total, event_timestamp')
          .ilike('system_name', name)
          .limit(200);
        if (data) journalRows.push(...(data as JournalSiteRow[]));
      }
    }

    const warnings: string[] = [];
    const cards = buildSystemCards({
      stored: Array.from(stored.values()),
      ravenCache: ravenRows,
      journalSites: journalRows,
      system: uniqueSystems[0] ?? '',
    });

    // Отдаём только то, что действительно стройка: закрытые проекты нужны
    // только когда их спросили явно (market_id).
    const visible = cards
      .filter((card) => marketId
        ? card.marketId === marketId || card.key.includes(String(marketId))
        : card.status === 'active')
      .slice(0, MAX_PROJECTS)
      .map(toResponse);

    if (visible.length === 0) {
      warnings.push('no active projects for the request');
    }

    const newestRaven = ravenRows
      .map((row) => row.updated_at)
      .filter((value): value is string => Boolean(value))
      .sort()
      .pop() ?? null;

    return NextResponse.json({
      projects: visible,
      sources: {
        site: visible.filter((card) => card.sources.includes('site')).length,
        raven: visible.filter((card) => card.sources.includes('raven')).length,
        journal: visible.filter((card) => card.sources.includes('journal')).length,
      },
      // `available: null` — сайт не опрашивал Raven в этом запросе. Живость
      // Raven определяет Helper: он и так ходит туда за синхронизацией.
      raven: { available: null, cachedAt: newestRaven, systems: ravenRows.length },
      authenticated: Boolean(user),
      warnings,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const missing = /construction_projects|colonisation_sites|system_progress|schema cache/i.test(message);
    return NextResponse.json({
      error: missing ? 'relevant tables are not migrated yet' : message,
      hint: missing ? 'Примените миграции supabase/migrations (см. DOCS.md)' : undefined,
      projects: [],
      sources: { site: 0, raven: 0, journal: 0 },
      raven: { available: null, cachedAt: null, systems: 0 },
      warnings: [message],
    }, { status: missing ? 503 : 500 });
  }
}

/** Карточка в форме, совместимой с проектами Raven (`commodities`, `sumNeed`). */
function toResponse(card: SiteProjectCard) {
  const need = projectNeed(card);
  const needTotal = projectNeedTotal(card);
  return {
    key: card.key,
    buildId: card.buildId,
    systemName: card.systemName,
    systemAddress: card.systemAddress,
    marketId: card.marketId,
    buildName: card.buildName,
    buildType: card.buildType,
    bodyName: card.bodyName,
    bodyNum: card.bodyNum,
    starPos: card.starPos,
    architectName: card.architectName,
    commander: card.commander,
    status: card.status,
    progress: card.progress,
    // Остаток в тех же единицах, что ждёт Helper: `commodities` — словарь
    // «товар → тонны», `sumNeed` — сумма (как у Raven).
    commodities: need,
    sumNeed: needTotal,
    maxNeed: card.maxNeed,
    sumTotal: maxNeedTotal(card),
    primary: card.primary,
    sources: card.sources,
    rcState: card.rcState,
    stale: card.stale,
    updatedAt: card.updatedAt,
  };
}

function maxNeedTotal(card: SiteProjectCard): number | null {
  if (typeof card.maxNeed === 'number') return card.maxNeed;
  if (card.maxNeed && typeof card.maxNeed === 'object') {
    return Object.values(card.maxNeed).reduce((sum, value) => sum + value, 0);
  }
  const required = card.resources.reduce((sum, row) => sum + row.RequiredAmount, 0);
  return required > 0 ? required : null;
}
