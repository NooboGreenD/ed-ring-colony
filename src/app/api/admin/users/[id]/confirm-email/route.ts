import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/billing/auth';
import { createAdminClient } from '@/lib/supabaseAdmin';
import { confirmUserEmail } from '@/lib/adminEmailActions';
import { apiTranslate } from '@/lib/i18n/apiT';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * «Подтвердить email» для пилота — Админка → Управление → Пользователи.
 *
 * Подтверждает адрес сервисной ролью (`email_confirm: true`), без письма и без
 * одноразовой ссылки: именно этого не хватало, когда пилот нажал «Подтвердить»,
 * ссылка оказалась потрачена (например, её открыл почтовый сканер), а войти по
 * паролю нельзя, пока адрес не подтверждён.
 *
 * Кто и кому подтвердил — пишется в журнал. Адрес чужими руками не меняется:
 * маршрут подтверждает только уже существующий адрес аккаунта, а не подставляет
 * новый.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const t = await apiTranslate();
  const auth = await requireAdmin(req);
  if ('response' in auth) return auth.response;

  const { id } = await params;
  // Идентификатор приходит из адреса: мусор отсекаем до запроса в GoTrue.
  if (!/^[0-9a-fA-F-]{36}$/.test(id)) {
    return NextResponse.json({ error: t('admin.emailConfirmBadId') }, { status: 400 });
  }

  try {
    const result = await confirmUserEmail(createAdminClient(), id);
    if (!result.ok) {
      if (result.error === 'not_found') {
        return NextResponse.json({ error: t('admin.emailConfirmNoUser') }, { status: 404 });
      }
      console.error('[admin/users/confirm-email] GoTrue did not confirm the address:', result.message);
      return NextResponse.json({ error: t('admin.emailConfirmFailed') }, { status: 502 });
    }
    console.log(`[admin/users/confirm-email] ${auth.actor.userId} confirmed pilot ${id}`);
    return NextResponse.json({
      ok: true,
      // false — адрес был подтверждён раньше; панель обновит строку, но
      // «подтверждено» об этом уже не соврёт.
      changed: result.changed,
      email: result.email,
      confirmedAt: result.changed ? result.confirmedAt : null,
      message: result.changed
        ? t('admin.emailConfirmDone', { email: String(result.email ?? '') })
        : t('admin.emailConfirmAlready', { email: String(result.email ?? '') }),
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[admin/users/confirm-email]', error instanceof Error ? error.message : error);
    return NextResponse.json({ error: t('admin.emailConfirmUnavailable') }, { status: 503 });
  }
}
