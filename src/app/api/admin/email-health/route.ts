import { NextResponse } from 'next/server';
import { requireAdmin, errorResponse } from '@/lib/billing/auth';
import { getPublicSupabaseUrl } from '@/lib/supabaseUrl';
import { getServerSupabaseUrl } from '@/lib/supabaseServerUrl';

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
type CheckAction = 'enable-signup' | 'enable-site-forms' | 'configure-smtp';

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

export async function GET(req: Request) {
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
        title: 'Публичный шлюз Supabase',
        detail: `Браузер использует ${publicUrl}; web обращается к GoTrue по приватному адресу ${url}.`,
      });
    }

    checks.push({
      id: 'site-flag',
      ok: emailEnabled,
      title: 'AUTH_EMAIL_ENABLED на сайте',
      detail: emailEnabled
        ? 'Сайт разрешает регистрацию и восстановление по почте.'
        : 'Сайт отвечает «Отправка писем временно недоступна»: переменная не равна true.',
      fix: emailEnabled
        ? undefined
        : 'Включите галочку «формы регистрации/восстановления на сайте» ниже и нажмите «Применить и перезапустить» — панель запишет AUTH_EMAIL_ENABLED=true и пересоздаст web. Вручную: AUTH_EMAIL_ENABLED=true в .env.production сайта, затем перезапуск web.',
      action: emailEnabled ? undefined : 'enable-site-forms',
    });

    checks.push({
      id: 'anon-key',
      ok: Boolean(key),
      title: 'NEXT_PUBLIC_SUPABASE_ANON_KEY',
      detail: key ? 'Ключ задан.' : 'Ключ не задан — сайт не может обратиться к GoTrue.',
      fix: key ? undefined : 'Добавьте NEXT_PUBLIC_SUPABASE_ANON_KEY в окружение web.',
    });

    const probe = key ? await probeGoTrue(url, key) : null;

    checks.push({
      id: 'gotrue-reachable',
      ok: Boolean(probe?.reachable),
      title: `Доступность GoTrue из web (${url})`,
      detail: probe
        ? (probe.reachable
          ? 'GoTrue отвечает.'
          : `Запрос не прошёл: ${probe.error}`)
        : 'Проверка не выполнялась: нет ключа.',
      fix: probe && !probe.reachable
        ? (probe.tls === 'error'
          ? 'Похоже на проблему с TLS-сертификатом Supabase: проверьте срок действия и цепочку сертификата для домена Supabase, а также системное время сервера. Именно так выглядит «иногда не получается войти»: браузер отвергает соединение до того, как форма входа что-то отправит.'
          : 'Проверьте, что контейнер Supabase запущен и доступен с сайта (DNS, сеть, обратный прокси).')
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
        title: 'Подтверждение почты в GoTrue',
        detail: autoconfirm === false
          ? 'mailer_autoconfirm выключен — письма отправляются.'
          : 'mailer_autoconfirm включён: GoTrue подтверждает адреса сам и писем не шлёт. Сайт такую конфигурацию отклоняет намеренно.',
        fix: autoconfirm === false
          ? undefined
          : 'Заполните SMTP-поля ниже и нажмите «Применить и перезапустить»: контейнер auth пересоздаётся с GOTRUE_MAILER_AUTOCONFIRM=false, письма начнут уходить.',
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
        title: 'Регистрация в GoTrue',
        detail: disableSignup === false
          ? 'Регистрация разрешена.'
          : disableSignup === undefined
            ? 'GoTrue не сообщил disable_signup — проверить нельзя, новые аккаунты могут не создаваться.'
            : 'disable_signup=true — новые пользователи не создаются.',
        fix: disableSignup === false ? undefined : 'Включите галочку «регистрация новых пилотов открыта» ниже и нажмите «Применить и перезапустить»: панель запишет DISABLE_SIGNUP=false в /opt/supabase/.env и пересоздаст контейнер auth. Вручную — те же два шага: DISABLE_SIGNUP=false в .env стека Supabase и пересоздание auth (docker compose -f docker-compose.yml -f docker-compose.smtp-override.yml up -d --no-deps --force-recreate auth). Ключ именно DISABLE_SIGNUP: GOTRUE_DISABLE_SIGNUP в .env игнорируется.',
        action: disableSignup === false ? undefined : 'enable-signup',
      });

      checks.push({
        id: 'email-provider',
        ok: externalEmail !== false,
        title: 'Провайдер email в GoTrue',
        detail: externalEmail === false ? 'Вход по почте отключён в GoTrue.' : 'Вход по почте включён.',
        fix: externalEmail === false ? 'Выставьте GOTRUE_EXTERNAL_EMAIL_ENABLED=true.' : undefined,
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
        ? 'Регистрация и письма настроены.'
        : `Не пройдено проверок: ${blocking.length}. Первая причина: ${blocking[0].title}.`,
    }, { headers });
  } catch (err) {
    return errorResponse(err);
  }
}
