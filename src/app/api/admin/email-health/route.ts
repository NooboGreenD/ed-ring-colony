import { NextResponse } from 'next/server';
import { requireAdmin, errorResponse } from '@/lib/billing/auth';
import { getPublicSupabaseUrl } from '@/lib/supabaseUrl';
import { getServerSupabaseUrl } from '@/lib/supabaseServerUrl';
import { listSmtpKeys } from '@/lib/updateAgent';
import { apiTranslate } from '@/lib/i18n/apiT';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Диагностика входа и регистрации по почте.
 *
 * Зачем: пользователи видят одно из двух сообщений — «Отправка писем временно
 * недоступна. Обратитесь к администратору.» или «Сервис авторизации временно
 * недоступен», а администратору неоткуда узнать, что именно сломалось. Причин
 * ровно три, и все три проверяемы:
 *
 *   1. `AUTH_EMAIL_ENABLED` на сайте не равен `true` — регистрация выключена
 *      самим сайтом (ровно это сообщение и видит пользователь);
 *   2. GoTrue не настроен: `mailer_autoconfirm` не выключен (письма не шлются,
 *      адрес подтверждался бы сам), `disable_signup` включён, или почтовый
 *      провайдер в настройках отключён;
 *   3. до `NEXT_PUBLIC_SUPABASE_URL` вообще не достучаться — чаще всего из-за
 *      просроченного или неподходящего TLS-сертификата
 *      (`supabase.<домен>`), и тогда ломается и обычный вход по паролю.
 *
 * Маршрут ничего не чинит и не раскрывает значения ключей: только говорит,
 * какая из проверок не прошла, что делать и (`action`) какую починку панель
 * умеет выполнить сама.
 */

const headers = { 'Cache-Control': 'no-store' };

/**
 * `action` — машинная причина, по которой панель умеет починить проверку
 * одним нажатием. `fix` остаётся текстовой инструкцией для тех, кто чинит
 * руками (и для отчёта, который копируют в переписку).
 */
type CheckAction = 'enable-signup' | 'enable-site-forms' | 'configure-smtp' | 'fix-site-url';

interface Check {
  id: string;
  ok: boolean;
  title: string;
  detail: string;
  fix?: string;
  action?: CheckAction;
}

function supabaseUrl(): string {
  return getServerSupabaseUrl();
}

/** Живой запрос к GoTrue: отвечает ли и что говорит о почте. */
async function probeGoTrue(url: string, key: string): Promise<{
  reachable: boolean;
  tls: 'ok' | 'error' | 'unknown';
  error: string;
  settings: Record<string, unknown> | null;
}> {
  try {
    const response = await fetch(`${url}/auth/v1/settings`, {
      headers: { apikey: key },
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      return { reachable: true, tls: 'ok', error: `HTTP ${response.status}`, settings: null };
    }
    const settings = await response.json().catch(() => null);
    return { reachable: true, tls: 'ok', error: '', settings: settings && typeof settings === 'object' ? settings : null };
  } catch (error) {
    // Ошибка TLS приходит как причина внутри TypeError: fetch failed.
    const message = error instanceof Error ? String(error.cause ?? error.message) : String(error);
    const tls = /certificate|self[- ]signed|tls|ssl|ERR_TLS|UNABLE_TO_VERIFY|CERT_/i.test(message)
      ? 'error' as const
      : 'unknown' as const;
    return { reachable: false, tls, error: message.slice(0, 300), settings: null };
  }
}

/**
 * Сколько адресов зарегистрировались и так и не подтвердились.
 *
 * Зачем в диагностике: пилот нажимает «Подтвердить», видит ошибку и говорит
 * «учётка не подтвердилась». По одному сообщению не понять, письмо не дошло,
 * ссылку потратил почтовый сканер или сломался сам GoTrue. `email_confirmed_at`
 * у пилота в базе отвечает на это прямо, а в панели такого поля не было.
 *
 * Свежие регистрации не считаем: пилот мог открыть форму только что и ещё
 * читает письмо (льгота `MAILBOX_GRACE_MS`). Адреса не раскрываем — в отчёте
 * только количество и самый старый случай.
 */
const MAILBOX_GRACE_MS = 30 * 60 * 1000;
const MAILBOX_PAGE_SIZE = 200;
const MAILBOX_MAX_PAGES = 5;

async function probeMailboxes(url: string, key: string, serviceKey: string) {
  const now = Date.now();
  let unconfirmed = 0;
  let oldest = '';
  let confirmed = 0;
  for (let page = 1; page <= MAILBOX_MAX_PAGES; page++) {
    const response = await fetch(
      `${url}/auth/v1/admin/users?page=${page}&per_page=${MAILBOX_PAGE_SIZE}`,
      {
        headers: { apikey: key, Authorization: `Bearer ${serviceKey}` },
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) return { ok: false as const, error: `HTTP ${response.status}` };
    const body = await response.json().catch(() => null) as { users?: unknown } | null;
    const users = Array.isArray(body?.users) ? body.users as Array<Record<string, unknown>> : [];
    for (const user of users) {
      if (typeof user.email_confirmed_at === 'string' && user.email_confirmed_at) { confirmed++; continue; }
      const created = Date.parse(String(user.created_at ?? ''));
      if (!Number.isFinite(created) || now - created < MAILBOX_GRACE_MS) continue;
      unconfirmed++;
      if (!oldest || created < Date.parse(oldest)) oldest = new Date(created).toISOString();
    }
    if (users.length < MAILBOX_PAGE_SIZE) break;
  }
  return { ok: true as const, unconfirmed, oldest, confirmed };
}

export async function GET(req: Request) {
  const t = await apiTranslate();
  try {
    const auth = await requireAdmin(req);
    if ('response' in auth) return auth.response;

    const url = supabaseUrl();
    const publicUrl = getPublicSupabaseUrl();
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
    const emailEnabled = process.env.AUTH_EMAIL_ENABLED === 'true';
    const checks: Check[] = [];

    if (publicUrl !== url) {
      checks.push({
        id: 'site-gateway',
        ok: true,
        title: t('mail.titleGateway'),
        detail: t('mail.gatewayDetail', { publicUrl, url }),
      });
    }

    checks.push({
      id: 'site-flag',
      ok: emailEnabled,
      title: t('mail.titleSiteFlag'),
      detail: emailEnabled
        ? t('mail.siteFlagOn')
        : t('mail.siteFlagOff'),
      fix: emailEnabled
        ? undefined
        : t('mail.siteFlagFix'),
      action: emailEnabled ? undefined : 'enable-site-forms',
    });

    checks.push({
      id: 'anon-key',
      ok: Boolean(key),
      title: 'NEXT_PUBLIC_SUPABASE_ANON_KEY',
      detail: key ? t('mail.keySet') : t('mail.keyMissing'),
      fix: key ? undefined : t('mail.keyFix'),
    });

    // Ссылка из письма подтверждения строится от SITE_URL стека Supabase.
    // Когда там адрес API (https://supabase.<домен>), письмо уводит нового
    // пилота на /auth/v1/verify?token=…&type=signup — «страницы не существует»,
    // а адрес так и остаётся неподтверждённым. Ставим проверку рядом с
    // остальными: причина видна до жалобы пилота, а починка — та же кнопка
    // «Применить и перезапустить» (apply-smtp.sh перепишет SITE_URL сам).
    try {
      const smtp = await listSmtpKeys();
      const stackSite = smtp.ok ? (smtp.payload?.siteUrl ?? null) : null;
      if (smtp.payload?.siteUrlIsApi === true) {
        checks.push({
          id: 'mail-site-url',
          ok: false,
          title: t('mail.titleMailSiteUrl'),
          detail: t('mail.mailSiteUrlApi', { url: String(stackSite ?? '') }),
          fix: t('mail.mailSiteUrlFix'),
          action: 'fix-site-url',
        });
      } else if (smtp.ok && stackSite) {
        checks.push({
          id: 'mail-site-url',
          ok: true,
          title: t('mail.titleMailSiteUrl'),
          detail: t('mail.mailSiteUrlOk', { url: String(stackSite) }),
        });
      }
    } catch {
      // Агента нет или он старой версии: проверка недоступна, остальные — есть.
    }

    // Подтвердился ли адрес на самом деле — отдельная проверка. Её нет, если
    // сервисной роли нет: без неё админский список пользователей закрыт, а
    // выдумывать вердикт по недоступным данным нельзя.
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (key && serviceKey) {
      try {
        const mailboxes = await probeMailboxes(url, key, serviceKey);
        if (mailboxes.ok) {
          checks.push({
            id: 'confirmed-mailboxes',
            ok: mailboxes.unconfirmed === 0,
            title: t('mail.titleMailboxes'),
            detail: mailboxes.unconfirmed === 0
              ? t('mail.mailboxesOk', { count: mailboxes.confirmed })
              : t('mail.mailboxesPending', {
                count: mailboxes.unconfirmed,
                // Дата без локали сервера: отчёт читают и на других языках, а
                // `toLocaleDateString` за nginx может отдать что угодно.
                date: mailboxes.oldest ? mailboxes.oldest.slice(0, 10) : '—',
              }),
            fix: mailboxes.unconfirmed === 0 ? undefined : t('mail.mailboxesFix'),
          });
        }
      } catch {
        // Админский список не ответил — остальные проверки всё равно нужны.
      }
    }

    const probe = key ? await probeGoTrue(url, key) : null;

    checks.push({
      id: 'gotrue-reachable',
      ok: Boolean(probe?.reachable),
      title: t('mail.titleGoTrueReach', { url }),
      detail: probe
        ? (probe.reachable
          ? t('mail.gotrueAnswers')
          : t('api.probeFailed', { error: probe.error }))
        : t('mail.probeSkipped'),
      fix: probe && !probe.reachable
        ? (probe.tls === 'error'
          ? t('mail.fixTls')
          : t('mail.fixReach'))
        : undefined,
    });

    const settings = probe?.settings ?? null;
    if (settings) {
      const autoconfirm = settings.mailer_autoconfirm;
      const disableSignup = settings.disable_signup;
      const externalEmail = (settings.external as Record<string, unknown> | undefined)?.email;

      checks.push({
        id: 'mailer-autoconfirm',
        ok: autoconfirm === false,
        title: t('mail.titleAutoconfirm'),
        detail: autoconfirm === false
          ? t('mail.autoconfirmOff')
          : t('mail.autoconfirmOn'),
        fix: autoconfirm === false
          ? undefined
          : t('mail.autoconfirmFix'),
        action: autoconfirm === false ? undefined : 'configure-smtp',
      });

      // disable_signup=true — ровно то состояние, в котором сайт отвечает
      // «Новые регистрации временно закрыты», хотя SMTP настроен и письма
      // уходят. Правка не там, где кажется: GoTrue читает
      // GOTRUE_DISABLE_SIGNUP, но compose подставляет в него значение
      // DISABLE_SIGNUP из /opt/supabase/.env — строка GOTRUE_DISABLE_SIGNUP в
      // этом файле не делает ничего. Поэтому в подсказке нет «просто
      // выставьте GOTRUE_…»: сначала правильное имя ключа, затем пересоздание
      // контейнера (без него GoTrue продолжает работать со старым окружением).
      checks.push({
        id: 'signup',
        ok: disableSignup === false,
        title: t('mail.titleSignup'),
        detail: disableSignup === false
          ? t('mail.signupOpen')
          : disableSignup === undefined
            ? t('mail.signupUnknown')
            : t('mail.signupClosed'),
        fix: disableSignup === false ? undefined : t('mail.signupFix'),
        action: disableSignup === false ? undefined : 'enable-signup',
      });

      checks.push({
        id: 'email-provider',
        ok: externalEmail !== false,
        title: t('mail.titleProvider'),
        detail: externalEmail === false ? t('mail.providerOff') : t('mail.providerOn'),
        fix: externalEmail === false ? t('mail.providerFix') : undefined,
      });
    }

    const blocking = checks.filter((check) => !check.ok);
    return NextResponse.json({
      success: true,
      ok: blocking.length === 0,
      supabaseUrl: url,
      tls: probe?.tls ?? 'unknown',
      checks,
      summary: blocking.length === 0
        ? t('mail.summaryOk')
        : t('mail.summaryFailed', { count: blocking.length, title: blocking[0].title }),
    }, { headers });
  } catch (err) {
    return errorResponse(err);
  }
}
