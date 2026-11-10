import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabaseServer';
import { resolveRequestUser } from '@/lib/helperAuth';
import { normalizeCarrierEvents } from '@/lib/fleetCarriers';
import { applyCarrierOps } from '@/lib/fleetCarrierStore';
import { applyCarrierSightings } from '@/lib/carrierRegistryStore';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MAX_BYTES = 3 * 1024 * 1024;
const MAX_EVENTS = 3000;

/**
 * POST /api/carriers/sync — журнальные события авианосцев.
 *
 * Шлют Colonial Helper (API-токен, живые события и догрузка истории) и
 * загрузчик журналов на сайте (сессия). Тело: `{ token?, events: [...] }`.
 * Повторная отправка безопасна: состояние обновляется только более свежими
 * наблюдениями, грузовые дельты идемпотентны по хешу события.
 */
export async function POST(request: Request) {
  try {
    if (Number(request.headers.get('content-length')) > MAX_BYTES) {
      return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
    }
    const text = await request.text();
    if (Buffer.byteLength(text) > MAX_BYTES) {
      return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
    }
    let body: Record<string, unknown>;
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      body = parsed;
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const user = await resolveRequestUser(request, body.token);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    if (!Array.isArray(body.events)) {
      return NextResponse.json({ error: 'events must be an array' }, { status: 400 });
    }
    if (body.events.length > MAX_EVENTS) {
      return NextResponse.json({ error: `Too many events (max ${MAX_EVENTS})` }, { status: 413 });
    }

    const { ops, skipped } = normalizeCarrierEvents(body.events, { userId: user.userId });
    const source = user.via === 'api_token' ? 'helper' : 'web';
    const svc = createServiceClient();
    const totals = await applyCarrierOps(svc, user.userId, source, ops);
    // Тот же поток питает реестр Атласа: визит даёт пилоту право уточнить имя
    // носителя, `CarrierStats`/`CarrierNameChanged` владельца — достоверное имя.
    // Реестр вторичен: его сбой не должен отменять уже записанный учёт.
    let registry = { visits: 0, names: 0 };
    try {
      registry = await applyCarrierSightings(svc, user.userId, body.events);
    } catch (registryError) {
      console.warn('[carriers/sync] carrier registry:', (registryError as Error).message);
    }
    return NextResponse.json({
      registry,
      ok: true,
      received: body.events.length,
      skipped,
      applied: totals.applied,
      duplicates: totals.duplicates,
      ignored: totals.ignored,
      stations_moved: totals.stationsMoved,
      carriers: totals.carriers,
    });
  } catch (error) {
    console.error('[carriers/sync]', error instanceof Error ? error.message : error);
    return NextResponse.json({ error: 'Carrier database unavailable; retry later' }, { status: 503 });
  }
}
