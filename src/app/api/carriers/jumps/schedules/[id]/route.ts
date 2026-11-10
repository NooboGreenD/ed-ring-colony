import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabaseServer';
import { resolveRequestUser } from '@/lib/helperAuth';
import { apiTranslate } from '@/lib/i18n/apiT';
import {
  addScheduleEntry,
  deleteJumpSchedule,
  deleteScheduleEntry,
  isScheduleFailure,
  loadJumpSchedule,
  updateJumpSchedule,
} from '@/lib/carrierJumpScheduleStore';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Одно расписание прыжков (`/carriers/jumps?tab=calendar&schedule=<id>`).
 *
 *   GET    — расписание и его прыжки; публичное читает кто угодно, приватное —
 *            только владелец (иначе 403);
 *   PATCH  — название, заметка или видимость; только владелец;
 *   POST   — добавить прыжок; только владелец, повтор пары «носитель + время»
 *            даёт 409;
 *   DELETE — `?entry=<id>` убирает один прыжок, без параметра — всё расписание.
 *
 * Права проверяет хранилище: маршрут только переводит ответ в HTTP.
 */
async function resolveId(context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const decoded = decodeURIComponent(id ?? '');
  return UUID.test(decoded) ? decoded.toLowerCase() : null;
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const t = await apiTranslate();
  const id = await resolveId(context);
  if (!id) return NextResponse.json({ error: t('api.jumpScheduleNotFound') }, { status: 404 });
  try {
    const svc = createServiceClient();
    const viewer = await resolveRequestUser(request).catch(() => null);
    const loaded = await loadJumpSchedule(svc, id, viewer?.userId ?? null);
    if (!loaded.ok) {
      return NextResponse.json({ error: t(loaded.failure.key) }, { status: loaded.failure.status });
    }
    return NextResponse.json(
      { schedule: loaded.schedule, entries: loaded.entries, viewer: { signedIn: Boolean(viewer) } },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    console.error('[carriers/jumps/schedules/:id GET]', error instanceof Error ? error.message : error);
    return NextResponse.json({ error: t('api.jumpScheduleFailed') }, { status: 503 });
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const t = await apiTranslate();
  const id = await resolveId(context);
  if (!id) return NextResponse.json({ error: t('api.jumpScheduleNotFound') }, { status: 404 });
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
    const updated = await updateJumpSchedule(svc, id, user.userId, (body ?? {}) as Record<string, unknown>);
    if (isScheduleFailure(updated)) {
      return NextResponse.json({ error: t(updated.key) }, { status: updated.status });
    }
    return NextResponse.json({ schedule: updated }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[carriers/jumps/schedules/:id PATCH]', error instanceof Error ? error.message : error);
    return NextResponse.json({ error: t('api.jumpScheduleFailed') }, { status: 503 });
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const t = await apiTranslate();
  const id = await resolveId(context);
  if (!id) return NextResponse.json({ error: t('api.jumpScheduleNotFound') }, { status: 404 });
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
    const entry = await addScheduleEntry(svc, id, user.userId, (body ?? {}) as Record<string, unknown>);
    if (isScheduleFailure(entry)) {
      return NextResponse.json({ error: t(entry.key), duplicate: Boolean(entry.duplicate) }, { status: entry.status });
    }
    return NextResponse.json(
      { entry },
      { status: 201, headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    console.error('[carriers/jumps/schedules/:id POST]', error instanceof Error ? error.message : error);
    return NextResponse.json({ error: t('api.jumpScheduleFailed') }, { status: 503 });
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const t = await apiTranslate();
  const id = await resolveId(context);
  if (!id) return NextResponse.json({ error: t('api.jumpScheduleNotFound') }, { status: 404 });
  const user = await resolveRequestUser(request).catch(() => null);
  if (!user) return NextResponse.json({ error: t('api.unauthorized') }, { status: 401 });

  const entry = new URL(request.url).searchParams.get('entry') ?? '';
  try {
    const svc = createServiceClient();
    if (entry) {
      if (!UUID.test(entry)) {
        return NextResponse.json({ error: t('api.jumpScheduleEntryInvalid') }, { status: 400 });
      }
      const failure = await deleteScheduleEntry(svc, id, entry.toLowerCase(), user.userId);
      if (failure) return NextResponse.json({ error: t(failure.key) }, { status: failure.status });
      return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
    }
    const failure = await deleteJumpSchedule(svc, id, user.userId);
    if (failure) return NextResponse.json({ error: t(failure.key) }, { status: failure.status });
    return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[carriers/jumps/schedules/:id DELETE]', error instanceof Error ? error.message : error);
    return NextResponse.json({ error: t('api.jumpScheduleFailed') }, { status: 503 });
  }
}
