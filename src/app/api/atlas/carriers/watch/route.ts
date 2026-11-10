import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabaseServer';
import { apiTranslate } from '@/lib/i18n/apiT';
import { normalizeCarrierWatch } from '@/lib/carrierDirectory';
import { WATCH_COLUMNS, WATCH_COLUMNS_BASE, watchFromRow, watchToRow } from '@/lib/carrierWatch';
import { jumpSnapshot } from '@/lib/carrierJumps';

export const dynamic = 'force-dynamic';

/**
 * GET /api/atlas/carriers/watch
 *
 * Личный список «Трафика авианосцев»: избранные носители и комментарии
 * текущего пилота. Ничего публичного здесь нет — RLS и фильтр по `user_id`
 * дублируют друг друга намеренно: даже прямой запрос к базе не покажет чужие
 * записи, а маршрут не зависит от одной лишь политики.
 *
 * С миграции `20261110190000` в записи есть снимок плана прыжка: по нему
 * страница `/carriers/jumps` показывает, изменился ли заказ после подписки.
 * На установке без этой миграции запрос повторяется без `jump_*`-колонок,
 * и избранное Атласа работает как раньше.
 */
export async function GET() {
  const t = await apiTranslate();
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: t('api.unauthorized') }, { status: 401 });

  const read = (columns: string) => supabase
    .from('atlas_carrier_watch')
    .select(columns)
    .eq('user_id', user.id)
    .order('updated_at', { ascending: false })
    .limit(500);

  const full = await read(WATCH_COLUMNS);
  const result = full.error ? await read(WATCH_COLUMNS_BASE) : full;
  if (result.error) {
    console.error('[atlas/carriers/watch GET]', result.error.message);
    return NextResponse.json({ error: result.error.message }, { status: 500 });
  }
  const rows = (result.data ?? []) as unknown as Array<Record<string, unknown>>;
  return NextResponse.json(
    { watches: rows.map((row) => watchFromRow(row)) },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

/**
 * PUT /api/atlas/carriers/watch
 *
 * Добавить носитель в избранное, снять флаг, сохранить комментарий или
 * подписаться на прыжок.
 * Тело: `{ carrierId, callsign?, name?, system?, favorite?, note?,
 * jumpSystem?, jumpDepartureAt? }`.
 *
 * `jumpSystem`/`jumpDepartureAt` — снимок плана на момент подписки
 * (`/carriers/jumps`). Без них запись пишется как обычно: снимок, сделанный
 * раньше, не затирается — PostgREST обновляет только переданные колонки.
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

  const snapshot = jumpSnapshot((body ?? {}) as Record<string, unknown>);
  const base = { ...normalized.value, userId: user.id };
  const save = async (row: Record<string, unknown>, columns: string) => {
    const result = await supabase
      .from('atlas_carrier_watch')
      .upsert(row, { onConflict: 'user_id,carrier_id' })
      .select(columns)
      .single();
    return result as { data: unknown; error: { message: string } | null };
  };

  // Установка без миграции снимка прыжка: первая запись падает на неизвестных
  // колонках — повторяем без `jump_*`, чтобы избранное Атласа работало.
  const result = await (async () => {
    const full = await save(watchToRow({ ...base, ...(snapshot ?? {}) }), WATCH_COLUMNS);
    return full.error ? save(watchToRow(base), WATCH_COLUMNS_BASE) : full;
  })();

  if (result.error || !result.data) {
    const message = result.error?.message ?? 'empty result';
    console.error('[atlas/carriers/watch PUT]', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
  return NextResponse.json(
    { watch: watchFromRow(result.data as Record<string, unknown>) },
    { headers: { 'Cache-Control': 'no-store' } },
  );
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
