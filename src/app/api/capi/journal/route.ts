import { NextResponse } from 'next/server';
import { authFromRequest, createServiceClient } from '@/lib/supabaseServer';
import { capiSession } from '@/lib/capi/session';
import { describeCapiError, needsCapiRelink } from '@/lib/capi/client';

export const dynamic = 'force-dynamic';

/**
 * Журнал командира из CAPI.
 *
 * `?date=YYYY-MM-DD` уходит в путь `/journal/YYYY/MM/DD` — именно так его
 * ждёт Frontier. Прежний `?date=` в query-строке сервер игнорировал, и за
 * любую дату приходил журнал за сегодня.
 *
 * Пустой день (HTTP 204) — не ошибка: отдаём пустой список и `empty: true`.
 */
export async function GET(req: Request) {
  const { user } = await authFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const url = new URL(req.url);
  const date = url.searchParams.get('date');
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: 'date must be YYYY-MM-DD' }, { status: 400 });
  }

  const svc = createServiceClient();
  const { data: tokenRow } = await svc
    .from('capi_tokens')
    .select('*')
    .eq('user_id', user.id)
    .maybeSingle();

  if (!tokenRow) {
    return NextResponse.json({ error: 'Аккаунт Frontier не привязан', needsAuth: true }, { status: 404 });
  }

  try {
    const session = await capiSession(svc, user.id, tokenRow);
    const journal = await session.run((client) => client.getJournal(date));

    return NextResponse.json({
      events: journal.events,
      empty: journal.empty,
      partial: journal.partial,
      malformedLines: journal.malformedLines,
    });
  } catch (err) {
    return NextResponse.json(
      { error: describeCapiError(err), needsReauth: needsCapiRelink(err) },
      { status: needsCapiRelink(err) ? 401 : 502 },
    );
  }
}
