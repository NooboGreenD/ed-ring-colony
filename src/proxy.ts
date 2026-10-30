import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

import {
  COOKIE_WARN_BYTES,
  RESET_MARKER_COOKIE,
  RESET_MARKER_SECONDS,
  cookieHeaderBytes,
  deadCookieNames,
  resetCookieNames,
  shouldResetCookies,
  type CookieLike,
} from '@/lib/cookieBudget';
import { readMaintenanceCached } from '@/lib/maintenanceEdge';
import { isMaintenanceExemptPath } from '@/lib/maintenanceFlag';
import { supabaseCookieOptions } from '@/lib/supabaseUrl';
import { getServerSupabaseUrl } from '@/lib/supabaseServerUrl';

/** Сколько просить браузер подождать перед повторной попыткой (секунды). */
const MAINTENANCE_RETRY_AFTER = '120';

/** Разрешённые публичные API-маршруты Kong через туннель /api/supabase/* (без Supabase Studio и pg-meta). */
const ALLOWED_SUPABASE_GATEWAY_PREFIX = /^\/api\/supabase\/(?:auth|rest|realtime|storage|functions|graphql)\/v1(?:\/|$)/;

/**
 * Точка входа Next: прежнее тело плюс уборка cookie.
 *
 * Заголовок `Cookie` разбирается один раз на входе и один раз на выходе, до
 * того как ответ уйдёт в браузер: мёртвые куски сессии удаляются, а совсем
 * разросшийся набор сбрасывается (см. `src/lib/cookieBudget.ts`).
 */
export async function proxy(request: NextRequest) {
  const response = await handleRequest(request);
  return applyCookieBudget(request, response);
}

async function handleRequest(request: NextRequest) {
  const path = request.nextUrl.pathname;

  // The site-origin Supabase gateway is a transparent HTTP/WebSocket tunnel.
  // Do not try to refresh a session or read maintenance state on its requests:
  // that would add a second auth request before every GoTrue/PostgREST call and
  // can recurse back through the same gateway.
  if (path === '/api/supabase' || path.startsWith('/api/supabase/')) {
    if (!ALLOWED_SUPABASE_GATEWAY_PREFIX.test(path)) {
      return NextResponse.json({ error: 'Not Found' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
    }
    return NextResponse.next();
  }

  // ── Технические работы ──────────────────────────────────────────────
  // Пока идёт резервное копирование базы, посетители видят заглушку вместо
  // сайта. Админка, API и вход остаются доступными: иначе не увидеть прогресс
  // и не отменить дамп. Признак читается из public.app_flags с кэшем на
  // несколько секунд (см. src/lib/maintenanceEdge.ts).
  if (!isMaintenanceExemptPath(path)) {
    const maintenance = await readMaintenanceCached();
    if (maintenance?.active) {
      const stub = NextResponse.rewrite(new URL('/maintenance', request.url), {
        status: 503,
        headers: {
          'Cache-Control': 'no-store',
          'Retry-After': MAINTENANCE_RETRY_AFTER,
        },
      });
      return stub;
    }
  }

  let response = NextResponse.next({ request });
  const pendingCookies = new Map<string, { name: string; value: string; options?: CookieOptions }>();
  const authHeaders: Record<string, string> = {
    'Cache-Control': 'private, no-cache, no-store, must-revalidate, max-age=0',
    Expires: '0', Pragma: 'no-cache',
  };
  // Integration requests do not use a browser session. Preserve refreshes
  // on other API routes: their read-only cookie clients rely on middleware.
  if (path.startsWith('/api/auth/email/') || path.startsWith('/auth/') ||
      path === '/api/health' || path === '/api/auth/register' || path === '/api/auth/password' ||
      path.startsWith('/api/cron/') || path === '/api/auth/vk/callback' || path === '/api/auth/yandex/callback' ||
      ['/auth/callback', '/api/auth/callback', '/api/auth/token', '/api/auth/providers', '/api/logs/upload'].includes(path) ||
      (path === '/api/galnet' && request.method !== 'GET')) return response;

  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    console.error('[Middleware] Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY');
    return response;
  }

  try {
    const supabase = createServerClient(
      getServerSupabaseUrl(),
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      {
        cookieOptions: supabaseCookieOptions(),
        cookies: {
          getAll() {
            return request.cookies.getAll();
          },
          setAll(cookiesToSet, headers: Record<string, string> = {}) {
            Object.assign(authHeaders, headers);
            cookiesToSet.forEach(cookie => {
              request.cookies.set(cookie.name, cookie.value);
              pendingCookies.set(cookie.name, cookie);
            });
            response = NextResponse.next({ request });
            pendingCookies.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
            // SSR 0.12 supplies these only on its first write. Keep them across
            // subsequent writes: a CDN must never cache somebody's session cookie.
            for (const [name, value] of Object.entries(authHeaders)) response.headers.set(name, value);
          },
        },
      },
    );
    await supabase.auth.getUser();
  } catch (err: any) {
    console.error('[Middleware] Supabase error:', err.message || err);
  }

  return response;
}

/** Не чаще раза в минуту: иначе разросшийся заголовок зальёт журнал. */
let warnedAt = 0;

function warnOnce(size: number, note: string): void {
  const now = Date.now();
  if (now - warnedAt < 60_000) return;
  warnedAt = now;
  console.warn(`[proxy] заголовок Cookie ${size} Б — ${note}. `
    + 'Пределы поднимают deploy/nginx.conf и Dockerfile (--max-http-header-size).');
}

function responseHasCookie(response: NextResponse, name: string): boolean {
  const jar = response.cookies;
  try {
    if (typeof jar.get === 'function' && jar.get(name) !== undefined) return true;
  } catch {
    // `get` в заглушках бывает без реализации — тогда считаем, что не ставили.
  }
  return false;
}

function expireCookie(response: NextResponse, name: string): void {
  response.cookies.set(name, '', { path: '/', maxAge: 0 });
}

/**
 * Убрать мёртвые cookie и, если их слишком много, сбросить набор целиком.
 *
 * Сброс — переадресация на тот же адрес без «тяжёлых» cookie: вместо
 * 400/431 (сайт не открывается, помогает только инкогнито) пилот получает
 * обычную страницу и входит заново. Отметка `edrc-cookie-reset` не даёт
 * зациклиться, если раздутый заголовок собран не нашими cookie.
 */
function applyCookieBudget(request: NextRequest, response: NextResponse): NextResponse {
  const header = request.headers.get('cookie') || '';
  const size = cookieHeaderBytes(header);
  const cookies: CookieLike[] = request.cookies?.getAll?.() ?? [];
  if (size > COOKIE_WARN_BYTES) {
    warnOnce(size, `это выше предела nginx по умолчанию (${COOKIE_WARN_BYTES} Б)`);
  }

  const path = request.nextUrl?.pathname || '';
  const method = request.method || 'GET';

  if (shouldResetCookies({
    headerBytes: size,
    cookies,
    marker: Boolean(request.cookies?.get?.(RESET_MARKER_COOKIE)),
    method,
    path,
  })) {
    console.warn(`[proxy] cookie ${size} Б — сброс набора: сессия требует повторного входа, `
      + 'зато сайт открывается');
    // Тот же адрес: `request.url` уже содержит путь и строку запроса.
    const target = NextResponse.redirect(new URL(request.url));
    for (const name of resetCookieNames(cookies)) expireCookie(target, name);
    target.cookies.set(RESET_MARKER_COOKIE, '1',
      { path: '/', maxAge: RESET_MARKER_SECONDS, sameSite: 'lax' });
    return target;
  }

  for (const name of deadCookieNames(cookies)) {
    // Свежий кусок сессии, который только что записал сам прокси, не трогаем.
    if (responseHasCookie(response, name)) continue;
    expireCookie(response, name);
  }
  return response;
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ttf|otf|woff|woff2)$).*)',
  ],
};
