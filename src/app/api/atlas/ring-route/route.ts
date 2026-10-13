import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabaseServer';
import {
  DEFAULT_STEP_SECTORS,
  loadRingSession,
  planRingSession,
  stepRingSession,
  type RingPlan,
  type RingStepResult,
} from '@/lib/atlasRingSearch';

/**
 * Поиск Галактического кольца — пошагово.
 *
 *   POST { start_system, ring_radius, search_radius, deviation_limit, key_systems }
 *     — новая сессия + первый шаг; key_systems — массив имён обязательных систем
 *   POST { session_id }                                      — продолжить существующую
 *   GET  ?session_id=<id>                                    — состояние сессии (для возобновления)
 */

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface RequestBody {
  start_system?: string;
  ring_radius?: number;
  search_radius?: number;
  deviation_limit?: number | null;
  key_systems?: string[];
  session_id?: string;
  step_sectors?: number;
}

function sessionEnvelope(plan: RingPlan) {
  return {
    session_id: plan.sessionId,
    start_system: plan.start.name,
    ring_radius: plan.ringRadius,
    search_radius: plan.searchRadius,
    deviation_limit: plan.deviationLimit,
    key_systems: plan.keySystems,
    sectors: plan.sectors,
    sectors_done: plan.sectorsDone,
    status: plan.status,
    center: plan.center,
  };
}

function stepEnvelope(step: RingStepResult) {
  const percent = step.sectors > 0 ? Math.min(99, Math.round((step.sectorsDone / step.sectors) * 98)) : 0;
  return {
    session_id: step.sessionId,
    sectors: step.sectors,
    sectors_done: step.sectorsDone,
    processed: step.processed,
    done: step.done,
    progress: {
      percent,
      stage: step.done ? 'route' : 'scan',
      message: step.done
        ? 'Сегменты пройдены — собираем замкнутый маршрут'
        : `Перебор сегмента ${step.sectorsDone} из ${step.sectors}`,
    },
    anchors: step.anchors,
    found: step.found,
    beam: step.beam,
    stats: step.stats,
  };
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as RequestBody;
    const stepSectors = Math.max(1, Math.min(60, Number(body.step_sectors) || DEFAULT_STEP_SECTORS));

    let plan: RingPlan | null = null;
    if (body.session_id) {
      plan = await loadRingSession(String(body.session_id));
      if (!plan) return NextResponse.json({ error: 'Сессия поиска кольца не найдена' }, { status: 404 });
    } else {
      if (!body.start_system || !String(body.start_system).trim()) {
        return NextResponse.json({ error: 'Укажите начальную систему кольца' }, { status: 400 });
      }
      const supabase = await createClient();
      const { data: { user } } = await supabase.auth.getUser();
      plan = await planRingSession(
        {
          startSystem: String(body.start_system),
          ringRadius: body.ring_radius,
          searchRadius: body.search_radius,
          deviationLimit: body.deviation_limit,
          keySystems: Array.isArray(body.key_systems) ? body.key_systems : undefined,
        },
        user?.id || null,
      );
    }

    if (plan.status === 'completed') {
      return NextResponse.json({
        completed: true,
        session: sessionEnvelope(plan),
        route: (plan as RingPlan & { route?: unknown }).route || null,
      });
    }

    const step = await stepRingSession(plan.sessionId, stepSectors);
    return NextResponse.json({
      completed: false,
      session: { ...sessionEnvelope(plan), sectors_done: step.sectorsDone },
      step: stepEnvelope(step),
      totals: {
        real_anchors: step.stats.realAnchors,
        triangulated_anchors: step.stats.triangulatedAnchors,
        systems_found: step.stats.systemsFound,
        systems_saved: step.stats.systemsSaved,
      },
    });
  } catch (error: any) {
    console.error('[ring-route] шаг не удался:', error);
    return NextResponse.json({ error: error?.message || 'Ошибка поиска кольца' }, { status: 500 });
  }
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const sessionId = searchParams.get('session_id');
  if (!sessionId) {
    return NextResponse.json({ error: 'session_id обязателен' }, { status: 400 });
  }
  const plan = await loadRingSession(sessionId);
  if (!plan) return NextResponse.json({ error: 'Сессия не найдена' }, { status: 404 });
  return NextResponse.json({
    session: sessionEnvelope(plan),
    anchors: plan.anchors,
    stats: plan.stats,
    done: plan.sectorsDone >= plan.sectors,
  });
}
