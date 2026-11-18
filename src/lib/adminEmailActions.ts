import type { SupabaseClient } from '@supabase/supabase-js';
import { ensureUserProfile } from '@/lib/ensureProfile';
import { getSiteUrl } from '@/lib/siteUrl';

/**
 * Действия администратора над подтверждением адреса пилота.
 *
 * Зачем отдельный модуль. В админке (раздел «Пользователи») у пилота, который
 * нажал «Подтвердить», но так и не подтвердился, раньше не было ни одного
 * действия: оставалось просить его заново запросить письмо и надеяться. При этом
 * ссылка из письма одноразовая: если её потратил почтовый сканер, пилот сам
 * ничего сделать уже не может.
 *
 * Здесь два действия, и они решают разные задачи:
 *
 *   1. `confirmEmail` — подтвердить адрес за пилота (`admin.updateUserById`
 *      с `email_confirm: true`): ровно то, что делает переход по ссылке, только
 *      без письма и без токена. Это снимает блокировку входа прямо сейчас.
 *   2. `resendConfirmation` — выслать новое письмо. Нужно, когда пилот хочет
 *      подтвердить адрес сам (например, администратор не уверен, что адрес
 *      принадлежит пилоту) — прежние письма и их ссылки при этом недействительны.
 *
 * Модуль без Next: маршруты только читают тело запроса и передают клиента,
 * поэтому действия проверяются тестами на заглушке GoTrue.
 */

export type AdminEmailAction = 'confirm' | 'resend';

/** Текст сообщения об ошибке из GoTrue — без письма и без токенов. */
function safeMessage(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' ? message.slice(0, 300) : '';
}

/**
 * Существующий ли адрес: повторная отправка письма на несуществующий аккаунт
 * ведёт себя как успех (GoTrue не раскрывает адреса), а администратору нужно
 * знать правду — иначе «письмо отправлено» врёт.
 */
async function requireUser(admin: SupabaseClient, userId: string) {
  const { data, error } = await admin.auth.admin.getUserById(userId);
  if (error || !data?.user) return { ok: false as const, status: 404, message: safeMessage(error) };
  return { ok: true as const, user: data.user };
}

/**
 * Подтвердить адрес за пилота.
 *
 * Сразу после подтверждения профиль создаётся, если его нет: иначе пилот
 * подтверждён, а в кабинете пусто. Ошибка профиля действие не отменяет — его
 * повторяет `/account` при входе.
 */
export async function confirmUserEmail(admin: SupabaseClient, userId: string) {
  const found = await requireUser(admin, userId);
  if (!found.ok) return { ok: false as const, status: found.status, error: 'not_found' as const, message: found.message };

  // Уже подтверждён: действие идемпотентно, но панель должна сказать правду,
  // а не «готово» после пустого обновления.
  if (found.user.email_confirmed_at) {
    return { ok: true as const, changed: false, email: found.user.email ?? null };
  }

  const { data, error } = await admin.auth.admin.updateUserById(userId, { email_confirm: true });
  if (error || !data?.user) {
    return { ok: false as const, status: 502, error: 'confirm_failed' as const, message: safeMessage(error) };
  }

  try {
    await ensureUserProfile(admin, data.user);
  } catch (profileError) {
    console.warn('[admin/email] Profile will be retried from account:',
      profileError instanceof Error ? profileError.message : profileError);
  }

  return {
    ok: true as const,
    changed: true,
    email: data.user.email ?? null,
    confirmedAt: data.user.email_confirmed_at ?? null,
  };
}

/**
 * Выслать новое письмо подтверждения.
 *
 * `resend({ type: 'signup' })` — тот же путь, что у страницы «Повторить
 * подтверждение», но письмо уходит независимо от того, открыта ли у сайта
 * форма (`AUTH_EMAIL_ENABLED`): администратор действует осознанно, а пилот мог
 * сам не дойти до формы. Адрес уже подтверждён — письма не шлём: GoTrue на
 * подтверждённый адрес отвечает ошибкой, и «ссылка не пришла» было бы загадкой.
 */
export async function resendUserConfirmation(admin: SupabaseClient, userId: string) {
  const found = await requireUser(admin, userId);
  if (!found.ok) return { ok: false as const, status: found.status, error: 'not_found' as const, message: found.message };

  const email = found.user.email ?? '';
  if (!email) return { ok: false as const, status: 409, error: 'no_email' as const, message: '' };
  if (found.user.email_confirmed_at) {
    return { ok: false as const, status: 409, error: 'already_confirmed' as const, message: '', email };
  }

  const { error } = await admin.auth.resend({
    type: 'signup',
    email,
    options: { emailRedirectTo: `${getSiteUrl()}/auth/email` },
  });
  if (error) {
    // Причина видна администратору (SMTP, лимит частоты), но без адреса
    // пилота: он и так перед глазами, а в журнал лишнее не пишем.
    console.warn('[admin/email] Confirmation letter was not sent; inspect GoTrue/SMTP logs');
    return { ok: false as const, status: 502, error: 'send_failed' as const, message: safeMessage(error) };
  }
  return { ok: true as const, email };
}

/** Статус подтверждения для строки списка: `confirmed_at` из GoTrue. */
export function emailConfirmedAt(user: { email_confirmed_at?: string | null } | null | undefined): string | null {
  const value = user?.email_confirmed_at;
  return typeof value === 'string' && value ? value : null;
}
