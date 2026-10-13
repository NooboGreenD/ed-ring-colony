import { NextResponse } from 'next/server';
import { replanRingSession } from '@/lib/atlasRingSearch';

/**
 * Сброс сессии кольца для повторного прогона с новыми параметрами
 * (изменение допуска отклонения, добавление ключевых систем, изменение
 * радиуса поиска). Сессия сбрасывается в sectors_done=0, маршрут
 * перестраивается с нуля с учётом обновлённых параметров.
 */

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const sessionId = String(body?.session_id || '').trim();
    if (!sessionId) {
      return NextResponse.json({ error: 'session_id обязателен' }, { status: 400 });
    }

    const deviationLimit = body?.deviation_limit === null || body?.deviation_limit === undefined
      ? undefined
      : Number(body.deviation_limit);
    if (deviationLimit !== undefined && (!Number.isFinite(deviationLimit) || deviationLimit < 10 || deviationLimit > 400)) {
      return NextResponse.json(
        { error: 'Допуск отклонения должен быть в диапазоне 10–400 св.л.' },
        { status: 400 },
      );
    }

    const searchRadius = body?.search_radius === null || body?.search_radius === undefined
      ? undefined
      : Number(body.search_radius);
    if (searchRadius !== undefined && (!Number.isFinite(searchRadius) || searchRadius < 50 || searchRadius > 3000)) {
      return NextResponse.json(
        { error: 'Радиус поиска должен быть в диапазоне 50–3000 св.л.' },
        { status: 400 },
      );
    }

    const additionalKeySystems = Array.isArray(body?.key_systems)
      ? body.key_systems.map((name: unknown) => String(name || '').trim()).filter(Boolean)
      : undefined;

    const plan = await replanRingSession(sessionId, {
      deviationLimit,
      additionalKeySystems,
      searchRadius,
    });

    return NextResponse.json({
      ok: true,
      session: {
        session_id: plan.sessionId,
        start_system: plan.start.name,
        ring_radius: plan.ringRadius,
        search_radius: plan.searchRadius,
        deviation_limit: plan.deviationLimit,
        key_systems: plan.keySystems,
        center: plan.center,
        ring_center: plan.ringCenter,
        basis3d: plan.basis3D,
        height_offset: plan.heightOffset,
        tilt_degrees: plan.tiltDegrees,
        tilt_axis_degrees: plan.tiltAxisDegrees,
        sectors: plan.sectors,
        sectors_done: 0,
        status: plan.status,
      },
    });
  } catch (error: any) {
    console.error('[ring-replan] ошибка:', error);
    return NextResponse.json({ error: error?.message || 'Не удалось сбросить сессию для повтора' }, { status: 500 });
  }
}
