import { NextResponse } from 'next/server';
import type { BgsSnapshot } from '@/lib/bgs';
import { journalEventToSnapshot, type BgsJournalReject } from '@/lib/bgsJournal';
import { applyPilotSnapshots } from '@/lib/bgsStore';
import { resolveRequestUser } from '@/lib/helperAuth';
import { createServiceClient } from '@/lib/supabaseServer';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MAX_BYTES = 3 * 1024 * 1024;
const MAX_EVENTS = 500;

/**
 * POST /api/factions/sync — состояние фракций из журналов пилотов.
 *
 * Шлют Colonial Helper (API-токен: живые прыжки и догрузка истории) и
 * загрузчик журналов на сайте (сессия). Тело: `{ token?, events: [...] }`,
 * события — проекции FSDJump / Location / CarrierJump со списком `Factions`
 * (`projectBgsEvent` / `uploader/bgs_sync.py`).
 *
 * База применяет наблюдение, только если оно не старше сохранённого, поэтому
 * повтор пачки и один журнал, загруженный и с сайта, и из Helper'а, ничего не
 * портят. Ответ: сколько пришло, применено, устарело и отброшено.
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

    const nowMs = Date.now();
    const snapshots: BgsSnapshot[] = [];
    const rejected: Partial<Record<BgsJournalReject, number>> = {};
    for (const event of body.events) {
      const result = journalEventToSnapshot(event, nowMs);
      if ('snapshot' in result) snapshots.push(result.snapshot);
      else rejected[result.reject] = (rejected[result.reject] ?? 0) + 1;
    }
    const invalid = body.events.length - snapshots.length;
    const source = user.via === 'api_token' ? 'helper' : 'web';
    const result = await applyPilotSnapshots(createServiceClient(), snapshots, { source, userId: user.userId, invalid });
    return NextResponse.json({
      ok: true,
      received: body.events.length,
      accepted: snapshots.length,
      applied: result.applied,
      stale: result.stale,
      created: result.created,
      invalid,
      rejected,
      systems: result.systems,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[factions/sync]', message);
    const missing = /bgs_|schema cache|does not exist/i.test(message);
    return NextResponse.json(
      { error: missing ? 'Faction tables are missing: apply migration 20261019120000_minor_factions.sql' : 'Faction database unavailable; retry later' },
      { status: 503 },
    );
  }
}
