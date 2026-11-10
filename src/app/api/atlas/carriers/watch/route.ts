import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabaseServer';
import { apiTranslate } from '@/lib/i18n/apiT';
import { normalizeCarrierWatch } from '@/lib/carrierDirectory';
import { WATCH_COLUMNS, watchFromRow, watchToRow } from '@/lib/carrierWatch';

export const dynamic = 'force-dynamic';

/**
 * GET /api/atlas/carriers/watch
 *
 * Личный список «Трафика авианосцев»: избранные носители и комментарии
 * текущего пилота. Ничего публичного здесь нет — RLS и фильтр по `user_id`
 * дублируют друг друга намеренно: даже прямой запрос к базе не покажет чужие
 * записи, а маршрут не зависит от одной лишь политики.
 */
export async function GET() {
  const t = await apiTranslate();
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: t('api.unauthorized') }, { status: 401 });

  const { data, error } = await supabase
    .from('atlas_carrier_watch')
    .select(WATCH_COLUMNS)
    .eq('user_id', user.id)
    .order('updated_at', { ascending: false })
    .limit(500);

  if (error) {
    console.error('[atlas/carriers/watch GET]', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json(
    { watches: (data ?? []).map((row) => watchFromRow(row as Record<string, unknown>)) },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

/**
 * PUT /api/atlas/carriers/watch
 *
 * Добавить носитель в избранное, снять флаг или сохранить комментарий.
 * Тело: `{ carrierId, callsign?, name?, system?, favorite?, note? }`.
 *
 * Одна запись — один носитель: повторный `PUT` обновляет строку, а не плодит
 * дубли (`unique (user_id, carrier_id)`). `favorite: false` оставляет запись
 * ради комментария; `DELETE` удаляет её целиком.
 */
export async function PUT(request: Request) {
  const t = await apiTranslate();
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: t('api.unauthorized') }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: t('api.invalidJson') }, { status: 400 });
  }

  const normalized = normalizeCarrierWatch((body ?? {}) as Record<string, unknown>);
  if (!normalized.ok) {
    return NextResponse.json({ error: t('api.invalidRequest'), details: normalized.error }, { status: 400 });
  }

  const row = watchToRow({ ...normalized.value, userId: user.id });
  const { data, error } = await supabase
    .from('atlas_carrier_watch')
    .upsert(row, { onConflict: 'user_id,carrier_id' })
    .select(WATCH_COLUMNS)
    .single();

  if (error) {
    console.error('[atlas/carriers/watch PUT]', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ watch: watchFromRow(data as Record<string, unknown>) }, { headers: { 'Cache-Control': 'no-store' } });
}

/**
 * DELETE /api/atlas/carriers/watch?carrierId=…
 *
 * Убрать носитель из списка вместе с комментарием. Отдельного «снять флаг»
 * нет: это `PUT` с `favorite: false` — заметка при этом остаётся.
 */
export async function DELETE(request: Request) {
  const t = await apiTranslate();
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: t('api.unauthorized') }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const carrierId = (searchParams.get('carrierId') ?? '').trim();
  if (!/^\d+$/.test(carrierId)) {
    return NextResponse.json({ error: t('api.invalidRequest'), details: 'carrierId is required' }, { status: 400 });
  }

  const { error } = await supabase
    .from('atlas_carrier_watch')
    .delete()
    .eq('user_id', user.id)
    .eq('carrier_id', carrierId);

  if (error) {
    console.error('[atlas/carriers/watch DELETE]', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
}
