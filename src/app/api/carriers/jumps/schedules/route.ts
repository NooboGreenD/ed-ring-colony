import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabaseServer';
import { resolveRequestUser } from '@/lib/helperAuth';
import { apiTranslate } from '@/lib/i18n/apiT';
import {
  createJumpSchedule,
  isScheduleFailure,
  listJumpSchedules,
} from '@/lib/carrierJumpScheduleStore';

export const dynamic = 'force-dynamic';

/**
 * GET /api/carriers/jumps/schedules
 *
 * Список расписаний прыжков: свои (любой видимости) и все публичные. Публичные
 * видны и гостю — ссылкой делятся с логистами, которым вход не нужен.
 * Приватные чужие не показываются вовсе: их не должно быть видно даже названием.
 *
 * POST /api/carriers/jumps/schedules
 *
 * Создать расписание. Тело: `{ title, note?, visibility? }`, где `visibility` —
 * `private` (по умолчанию) или `public`. Нужна сессия.
 */
export async function GET(request: Request) {
  const t = await apiTranslate();
  try {
    const svc = createServiceClient();
    let viewerId: string | null = null;
    try {
      viewerId = (await resolveRequestUser(request))?.userId ?? null;
    } catch {
      viewerId = null;
    }
    const schedules = await listJumpSchedules(svc, viewerId);
    return NextResponse.json(
      { schedules, viewer: { signedIn: Boolean(viewerId) } },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    console.error('[carriers/jumps/schedules GET]', error instanceof Error ? error.message : error);
    return NextResponse.json({ error: t('api.jumpScheduleFailed') }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const t = await apiTranslate();
  const user = await resolveRequestUser(request).catch(() => null);
  if (!user) return NextResponse.json({ error: t('api.unauthorized') }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: t('api.invalidJson') }, { status: 400 });
  }

  try {
    const svc = createServiceClient();
    const created = await createJumpSchedule(svc, user.userId, (body ?? {}) as Record<string, unknown>);
    if (isScheduleFailure(created)) {
      return NextResponse.json({ error: t(created.key) }, { status: created.status });
    }
    return NextResponse.json(
      { schedule: created, viewer: { signedIn: true } },
      { status: 201, headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    console.error('[carriers/jumps/schedules POST]', error instanceof Error ? error.message : error);
    return NextResponse.json({ error: t('api.jumpScheduleFailed') }, { status: 503 });
  }
}
