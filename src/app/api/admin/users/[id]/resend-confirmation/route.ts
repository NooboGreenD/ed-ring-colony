import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/billing/auth';
import { createAdminClient } from '@/lib/supabaseAdmin';
import { resendUserConfirmation } from '@/lib/adminEmailActions';
import { apiTranslate } from '@/lib/i18n/apiT';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * «Отправить письмо заново» для пилота — Админка → Управление → Пользователи.
 *
 * Нужно рядом с «Подтвердить email», когда адрес должен подтвердить сам пилот
 * (администратор не уверен, что адрес принадлежит ему). Пишет то же письмо, что
 * страница «Повторить подтверждение», включая новый шаблон со ссылкой на сайт.
 *
 * Причины отказа называются по отдельности: адрес уже подтверждён, у аккаунта
 * нет адреса, GoTrue/SMTP не принял письмо. «Письмо отправлено» на любой сбой
 * администратора бы обмануло.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const t = await apiTranslate();
  const auth = await requireAdmin(req);
  if ('response' in auth) return auth.response;

  const { id } = await params;
  if (!/^[0-9a-fA-F-]{36}$/.test(id)) {
    return NextResponse.json({ error: t('admin.emailConfirmBadId') }, { status: 400 });
  }

  try {
    const result = await resendUserConfirmation(createAdminClient(), id);
    if (result.ok) {
      console.log(`[admin/users/resend-confirmation] ${auth.actor.userId} resent the letter to pilot ${id}`);
      return NextResponse.json({
        ok: true,
        email: result.email,
        message: t('admin.emailResent', { email: String(result.email ?? '') }),
      }, { headers: { 'Cache-Control': 'no-store' } });
    }
    if (result.error === 'not_found') {
      return NextResponse.json({ error: t('admin.emailConfirmNoUser') }, { status: 404 });
    }
    if (result.error === 'no_email') {
      return NextResponse.json({ error: t('admin.emailResendNoEmail') }, { status: 409 });
    }
    if (result.error === 'already_confirmed') {
      return NextResponse.json({ error: t('admin.emailResendAlready', { email: String(result.email ?? '') }) }, { status: 409 });
    }
    return NextResponse.json({ error: t('admin.emailResendFailed') }, { status: 502 });
  } catch (error) {
    console.error('[admin/users/resend-confirmation]', error instanceof Error ? error.message : error);
    return NextResponse.json({ error: t('admin.emailConfirmUnavailable') }, { status: 503 });
  }
}
