import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabaseServer';
import { parsePlan } from '@/lib/architect/planner';
import {
  PLAN_TABLE,
  buildPlanUpdate,
  isPlanVisibility,
  rowToStoredPlan,
  rowToView,
  type PlanVisibility,
} from '@/lib/architect/store';

export const dynamic = 'force-dynamic';

const FULL_SELECT = '*';
const MAX_SITES = 200;

/**
 * Один план — для открытия по ссылке `/architect?plan=<id>`.
 *
 * Приватный план читает только автор: остальным RLS не отдаст строку, и
 * маршрут честно отвечает 404, а не 403 — существование чужого приватного
 * плана не должно быть видно.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    const { data, error } = await supabase
      .from(PLAN_TABLE)
      .select(FULL_SELECT)
      .eq('id', id)
      .maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const stored = rowToStoredPlan(data as never, user?.id ?? null);
    if (!stored) return NextResponse.json({ error: 'Plan not found' }, { status: 404 });

    return NextResponse.json({ plan: stored.view, draft: stored.plan, warning: stored.warning });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error';
    console.error('[architect/plans/:id] GET error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * Обновить план или его видимость.
 * PUT /api/architect/plans/:id { plan?, visibility?, title? }
 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const record = body as Record<string, unknown>;

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { data: existing, error: readError } = await supabase
      .from(PLAN_TABLE)
      .select(FULL_SELECT)
      .eq('id', id)
      .maybeSingle();
    if (readError) return NextResponse.json({ error: readError.message }, { status: 500 });
    if (!existing) return NextResponse.json({ error: 'Plan not found' }, { status: 404 });

    const previous = existing as Record<string, unknown>;
    if (previous.author_id !== user.id) {
      return NextResponse.json({ error: 'План может менять только его автор' }, { status: 403 });
    }

    let plan = parsePlan(previous.plan).plan;
    let warning: string | undefined;
    if (record.plan !== undefined) {
      const parsed = parsePlan(record.plan);
      if (!parsed.plan) {
        return NextResponse.json({ error: parsed.error || 'Не удалось прочитать план' }, { status: 400 });
      }
      if (parsed.plan.sites.length > MAX_SITES) {
        return NextResponse.json({ error: `Слишком большой план: максимум ${MAX_SITES} построек` }, { status: 400 });
      }
      plan = parsed.plan;
      warning = parsed.warning;
    }
    if (!plan) {
      return NextResponse.json({ error: 'В сохранённом плане нечего обновлять' }, { status: 400 });
    }

    const visibility = isPlanVisibility(record.visibility)
      ? (record.visibility as PlanVisibility)
      : undefined;

    const { data: updated, error } = await supabase
      .from(PLAN_TABLE)
      .update(buildPlanUpdate(plan, {
        visibility,
        title: typeof record.title === 'string' ? record.title : undefined,
        previous: previous as never,
      }))
      .select('id,system_name,title,author_id,author_name,visibility,format_version,catalogue_version,'
        + 'site_count,haul_tons,score,tier2_points,tier3_points,cargo_items,notes,'
        + 'published_at,created_at,updated_at')
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ plan: rowToView(updated as never, user.id), warning });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error';
    console.error('[architect/plans/:id] PUT error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** Удалить план. DELETE /api/architect/plans/:id */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { error } = await supabase.from(PLAN_TABLE).delete().eq('id', id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ ok: true, id });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error';
    console.error('[architect/plans/:id] DELETE error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
