import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabaseServer';
import { createAdminClient } from '@/lib/supabaseAdmin';
import { loadRingRoute } from '@/lib/atlasRingSearch';

/**
 * Сохранение найденного кольца в проект эскадрильи.
 *
 * Маршрут кольца — это тысячи систем, поэтому точка уходит в `project_systems`
 * вместе с координатами: у систем кольца нет строк в `route_systems`, и старый
 * массовый импорт (`/systems/bulk`) их отбрасывал как «не в маршруте».
 *
 * Расчётные (триангулированные) точки по умолчанию не сохраняются: это
 * вычисленные координаты, а не системы, колонизировать их нельзя. Флаг
 * `include_synthetic` добавляет их, если кольцо нужно сохранить целиком.
 */

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Предел одного сохранения. Совпадает с потолком чтения систем проекта
 * (`/api/projects/[id]/systems` листает до 15 000 строк): сохранённое кольцо
 * обязано целиком показываться в проекте и на карте.
 */
const MAX_POINTS = 15_000;
/** Размер пачки вставки: PostgREST не любит тела на мегабайты. */
const INSERT_BATCH = 500;

const pointSchema = z.object({
  name: z.string().min(1).max(200),
  x: z.number(),
  y: z.number(),
  z: z.number(),
  source: z.string().max(32).optional(),
});

const bodySchema = z.object({
  project_id: z.number().int().positive(),
  session_id: z.string().min(1).optional(),
  route: z.array(pointSchema).optional(),
  ring_radius: z.number().optional(),
  include_synthetic: z.boolean().optional(),
});

export async function POST(req: Request) {
  try {
    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Некорректный запрос на сохранение кольца' }, { status: 400 });
    }
    const { project_id: projectId, include_synthetic: includeSynthetic = false } = parsed.data;

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const admin = createAdminClient();
    const { data: membership } = await admin
      .from('project_members')
      .select('role')
      .eq('project_id', projectId)
      .eq('user_id', user.id)
      .single();
    if (!membership || !['leader', 'officer'].includes(String(membership.role))) {
      return NextResponse.json({ error: 'Сохранять маршрут в проект могут лидер и офицеры' }, { status: 403 });
    }

    // Маршрут берём из сессии, если она указана: так клиент не передаёт тело
    // на тысячи точек, а сервер не пересчитывает кольцо.
    let points = parsed.data.route || [];
    let ringRadius = parsed.data.ring_radius;
    let startSystem = '';
    if (parsed.data.session_id) {
      const session = await loadRingRoute(parsed.data.session_id);
      if (!session) return NextResponse.json({ error: 'Сессия поиска кольца не найдена' }, { status: 404 });
      if (session.route.length > 0) {
        points = session.route;
        ringRadius = ringRadius ?? session.ringRadius;
        startSystem = session.start;
      }
    }
    if (points.length === 0) {
      return NextResponse.json({ error: 'Маршрут кольца пуст — сначала соберите кольцо' }, { status: 400 });
    }

    // Уже сохранённые в проекте системы не дублируем.
    const { data: existing } = await admin
      .from('project_systems')
      .select('system_name')
      .eq('project_id', projectId);
    const existingNames = new Set((existing || []).map((row) => String(row.system_name).toLowerCase()));

    const rows: Array<{
      project_id: number;
      system_name: string;
      sort_order: number;
      planned_status: string;
      priority: number;
      notes: string;
      x: number;
      y: number;
      z: number;
    }> = [];
    let skippedSynthetic = 0;
    let skippedDuplicate = 0;

    for (const point of points) {
      const name = String(point.name || '').trim();
      if (!name) continue;
      if (String(point.source) === 'triangulated' && !includeSynthetic) {
        skippedSynthetic++;
        continue;
      }
      const key = name.toLowerCase();
      if (existingNames.has(key)) {
        skippedDuplicate++;
        continue;
      }
      existingNames.add(key);
      rows.push({
        project_id: projectId,
        system_name: name,
        sort_order: rows.length + 1,
        planned_status: 'planned',
        priority: 1,
        notes: `Atlas: галактическое кольцо${ringRadius ? `, радиус ${Math.round(ringRadius)} св.л.` : ''}`,
        x: Number(point.x),
        y: Number(point.y),
        z: Number(point.z),
      });
      if (rows.length >= MAX_POINTS) break;
    }

    if (rows.length === 0) {
      return NextResponse.json({
        error: `Нечего добавлять: дубликатов ${skippedDuplicate}, расчётных точек ${skippedSynthetic}.`,
        added: 0,
        skipped_duplicate: skippedDuplicate,
        skipped_synthetic: skippedSynthetic,
      }, { status: 400 });
    }

    // Начальный порядок продолжаем от уже существующих строк проекта.
    const { data: maxOrderRow } = await admin
      .from('project_systems')
      .select('sort_order')
      .eq('project_id', projectId)
      .order('sort_order', { ascending: false })
      .limit(1)
      .single();
    const offset = Number(maxOrderRow?.sort_order) || 0;
    rows.forEach((row, index) => { row.sort_order = offset + index + 1; });

    let added = 0;
    for (let index = 0; index < rows.length; index += INSERT_BATCH) {
      const { error } = await admin.from('project_systems').insert(rows.slice(index, index + INSERT_BATCH));
      if (error) throw error;
      added += Math.min(INSERT_BATCH, rows.length - index);
    }

    return NextResponse.json({
      ok: true,
      project_id: projectId,
      added,
      total_points: points.length,
      skipped_duplicate: skippedDuplicate,
      skipped_synthetic: skippedSynthetic,
      truncated: points.length > MAX_POINTS,
      start_system: startSystem || undefined,
      ring_radius: ringRadius ?? null,
    });
  } catch (error: any) {
    console.error('[ring-route/save] ошибка:', error);
    return NextResponse.json({ error: error?.message || 'Не удалось сохранить кольцо в проект' }, { status: 500 });
  }
}
