import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabaseServer';
import { parsePlan } from '@/lib/architect/planner';
import {
  PLAN_TABLE,
  buildPlanInsert,
  isPlanVisibility,
  rowToView,
  type PlanVisibility,
} from '@/lib/architect/store';

export const dynamic = 'force-dynamic';

/** Сводные колонки: сам JSON плана в списке не нужен. */
const SUMMARY_SELECT = 'id,system_name,title,author_id,author_name,visibility,'
  + 'format_version,catalogue_version,site_count,haul_tons,score,'
  + 'tier2_points,tier3_points,cargo_items,notes,published_at,created_at,updated_at';

/** Ограничение на размер плана: защищаем и базу, и браузер читателя. */
const MAX_SITES = 200;

/**
 * Список планов системы: публичные + собственные.
 * GET /api/architect/plans?system=HIP%2090297
 */
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const system = (searchParams.get('system') || '').trim();
    if (!system) {
      return NextResponse.json({ error: 'system parameter is required' }, { status: 400 });
    }
    const limit = Math.min(Number.parseInt(searchParams.get('limit') || '50', 10) || 50, 100);

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    let query = supabase
      .from(PLAN_TABLE)
      .select(SUMMARY_SELECT)
      .eq('system_name_lc', system.toLowerCase())
      .order('updated_at', { ascending: false })
      .limit(limit);

    // `unlisted` в список не попадает намеренно: он открывается только по
    // прямой ссылке. Свои планы автор видит при любой видимости.
    query = user
      ? query.or(`visibility.eq.public,author_id.eq.${user.id}`)
      : query.eq('visibility', 'public');

    const { data, error } = await query;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const plans = (data ?? [])
      .map((row) => rowToView(row as never, user?.id ?? null))
      .filter((view): view is NonNullable<typeof view> => view !== null);

    return NextResponse.json({ system, plans, count: plans.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error';
    console.error('[architect/plans] GET error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * Сохранить план на сервере.
 * POST /api/architect/plans { system, plan, title?, visibility? }
 */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const record = body as Record<string, unknown>;

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const requestedSystem = typeof record.system === 'string' ? record.system.trim() : '';
    const parsed = parsePlan(record.plan);
    if (!parsed.plan) {
      return NextResponse.json({ error: parsed.error || 'Не удалось прочитать план' }, { status: 400 });
    }
    const plan = parsed.plan;
    const system = requestedSystem || plan.system;
    if (!system) {
      return NextResponse.json({ error: 'Не указано название системы' }, { status: 400 });
    }
    if (plan.sites.length > MAX_SITES) {
      return NextResponse.json({ error: `Слишком большой план: максимум ${MAX_SITES} построек` }, { status: 400 });
    }

    const visibility = isPlanVisibility(record.visibility) ? (record.visibility as PlanVisibility) : 'private';
    const profile = await loadAuthorName(supabase, user.id);

    const { data: inserted, error } = await supabase
      .from(PLAN_TABLE)
      .insert(buildPlanInsert({ ...plan, system }, {
        authorId: user.id,
        authorName: profile,
        visibility,
        title: typeof record.title === 'string' ? record.title : '',
      }))
      .select(SUMMARY_SELECT)
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const view = rowToView(inserted as never, user.id);
    return NextResponse.json({ plan: view, warning: parsed.warning }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error';
    console.error('[architect/plans] POST error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** Имя автора для подписи плана: имя командира из профиля, иначе «Командир». */
async function loadAuthorName(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
): Promise<string> {
  const { data } = await supabase
    .from('profiles')
    .select('cmdr_name')
    .eq('id', userId)
    .maybeSingle();
  const row = data as { cmdr_name?: string | null } | null;
  return row?.cmdr_name || 'Командир';
}
