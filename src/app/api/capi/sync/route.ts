import { NextResponse } from 'next/server';
import { authFromRequest, createServiceClient } from '@/lib/supabaseServer';
import { markCapiTokenBroken, syncCapiPilot } from '@/lib/capi/syncPilot';

export const dynamic = 'force-dynamic';

/**
 * Ручная синхронизация с Frontier CAPI.
 *
 * Вся работа — в `syncCapiPilot()`: тот же код выполняет колбэк OAuth и
 * cron, поэтому «в браузере подтянулось, а по расписанию нет» больше не
 * бывает. Здесь только авторизация запроса и форма ответа.
 *
 * Ответ 200 отдаётся и при частичном успехе (профиль сохранён, журнала за
 * сегодня нет). Раньше пустой журнал — совершенно штатное «сегодня не
 * играл» — валил весь маршрут пятисоткой, и пилот видел «Sync failed» при
 * полностью исправной привязке.
 */
export async function POST(req: Request) {
  const { user } = await authFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const svc = createServiceClient();
  const { data: tokenRow, error: tokenError } = await svc
    .from('capi_tokens')
    .select('*')
    .eq('user_id', user.id)
    .maybeSingle();

  if (tokenError) {
    console.error('[CAPI Sync] token read', tokenError);
    return NextResponse.json({ error: tokenError.message }, { status: 500 });
  }
  if (!tokenRow) {
    return NextResponse.json(
      { error: 'Аккаунт Frontier не привязан', needsAuth: true },
      { status: 404 },
    );
  }

  const result = await syncCapiPilot(svc, user.id, tokenRow);
  for (const warning of result.warnings) console.warn('[CAPI Sync]', warning);

  if (!result.ok) {
    if (result.needsReauth) {
      await markCapiTokenBroken(svc, user.id, result.error || 'Frontier отклонил токен');
    }
    console.error('[CAPI Sync]', result.error);
    return NextResponse.json(
      {
        error: result.error || 'Синхронизация не удалась',
        needsReauth: result.needsReauth,
        warnings: result.warnings,
      },
      { status: result.needsReauth ? 401 : 502 },
    );
  }

  return NextResponse.json({
    synced: true,
    cmdrName: result.cmdrName,
    profileSaved: result.profileSaved,
    journalStatus: result.journalStatus,
    eventsImported: result.eventsImported,
    eventsDuplicate: result.eventsDuplicate,
    eventsSkipped: result.eventsSkipped,
    warnings: result.warnings,
    binding: result.binding,
  });
}
