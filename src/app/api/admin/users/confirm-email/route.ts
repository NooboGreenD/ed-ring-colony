import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/billing/auth';
import { createAdminClient } from '@/lib/supabaseAdmin';
import { emailConfirmedAt } from '@/lib/adminEmailActions';
import { apiTranslate } from '@/lib/i18n/apiT';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Статус подтверждения адресов для списка пилотов в админке.
 *
 * Зачем отдельный маршрут. `profiles` в базе не знает, подтвердил ли пилот
 * почту: это поле `email_confirmed_at` в GoTrue (`auth.users`). Гонять весь
 * список аккаунтов в браузер нельзя — оттуда утекают адреса всех пилотов и
 * служебные поля. Поэтому наружу уходят только `id → дата подтверждения`, и
 * только администратору.
 *
 * Ответ:
 *   `confirmed` — `{ [id]: ISO | null }` (нет ключа — пилота нет в GoTrue);
 *   `unavailable` + `error` — статус получить нельзя (нет сервисной роли, GoTrue
 *   не ответил). Это не «все подтверждены», и панель обязана сказать так же.
 */
const PAGE_SIZE = 200;
const MAX_PAGES = 10;

export async function GET(req: Request) {
  const t = await apiTranslate();
  const auth = await requireAdmin(req);
  if ('response' in auth) return auth.response;

  const headers = { 'Cache-Control': 'no-store' };
  let admin;
  try {
    admin = createAdminClient();
  } catch {
    // Нет `SUPABASE_SERVICE_ROLE_KEY` — подтверждать нечем, и притворяться,
    // что статус известен, нельзя.
    return NextResponse.json({
      unavailable: true,
      confirmed: {},
      error: t('admin.mailStatusUnavailable'),
    }, { headers });
  }

  try {
    const confirmed: Record<string, string | null> = {};
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage: PAGE_SIZE });
      if (error) {
        console.error('[admin/users/confirm-email] Could not list users:', error.message);
        return NextResponse.json({
          unavailable: true,
          confirmed,
          error: t('admin.mailStatusFailed'),
        }, { headers });
      }
      const users = data?.users ?? [];
      for (const user of users) confirmed[user.id] = emailConfirmedAt(user);
      if (users.length < PAGE_SIZE) break;
    }
    return NextResponse.json({ unavailable: false, confirmed }, { headers });
  } catch (error) {
    console.error('[admin/users/confirm-email]', error instanceof Error ? error.message : error);
    return NextResponse.json({
      unavailable: true,
      confirmed: {},
      error: t('admin.mailStatusFailed'),
    }, { headers });
  }
}
