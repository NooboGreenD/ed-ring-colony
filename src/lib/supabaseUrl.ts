import { DEFAULT_SUPABASE_URL } from './siteUrl';

/**
 * Name of the browser session cookie. It deliberately does not depend on the
 * Supabase host: the browser can use the same session when the public gateway
 * is served under the site origin and the server talks to Kong directly.
 */
export const SUPABASE_AUTH_COOKIE_NAME = 'sb-edrc-auth-token';

/**
 * Browser-visible Supabase origin. In the normal setup this is the public
 * Supabase subdomain; in the TLS-resilient setup it is
 * `https://edringcolony.ru/api/supabase` and is proxied by Next to Kong.
 */
export function getPublicSupabaseUrl(): string {
  return (process.env.NEXT_PUBLIC_SUPABASE_URL || DEFAULT_SUPABASE_URL).replace(/\/$/, '');
}

/**
 * Базовый URL для доступа к Supabase Storage из браузера.
 *
 * Прямой хост `supabase.edringcolony.ru` обслуживается Next.js, а не Supabase
 * (прямой запрос к /storage/v1/ возвращает 404 от Next.js). Браузеру нужен
 * same-origin gateway через Next.js: `/api/supabase/storage/v1/...`.
 *
 * Если NEXT_PUBLIC_SUPACHE_URL задан с путём /api/supabase — используется он.
 * Иначе — относительный путь /api/supabase, браузер подставит текущий origin.
 */
export function getPublicStorageBaseUrl(): string {
  const raw = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim();
  if (!raw) return '/api/supabase';
  try {
    const url = new URL(raw);
    const pathname = url.pathname.replace(/\/+$/, '');
    return `${url.origin}${pathname === '/' ? '' : pathname}`;
  } catch {
    return '/api/supabase';
  }
}

/**
 * Полный URL публичного объекта Supabase Storage, доступный из браузера.
 */
export function getPublicStorageUrl(bucket: string, objectPath: string): string {
  const base = getPublicStorageBaseUrl().replace(/\/$/, '');
  return `${base}/storage/v1/object/public/${bucket}/${objectPath}`;
}

/** Keep SSR browser/server clients on one cookie name across proxy modes. */
export function supabaseCookieOptions() {
  return { name: SUPABASE_AUTH_COOKIE_NAME };
}
