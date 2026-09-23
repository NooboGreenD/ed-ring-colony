import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

import { readMaintenanceCached } from '@/lib/maintenanceEdge';
import { isMaintenanceExemptPath } from '@/lib/maintenanceFlag';

/** Сколько просить браузер подождать перед повторной попыткой (секунды). */
const MAINTENANCE_RETRY_AFTER = '120';

export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;

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
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      {
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

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ttf|otf|woff|woff2)$).*)',
  ],
};
