/**
 * A same-origin tunnel for a self-hosted Supabase gateway.
 *
 * With `NEXT_PUBLIC_SUPABASE_URL=https://edringcolony.ru/api/supabase`, browser
 * requests no longer establish TLS to `supabase.edringcolony.ru`. Next proxies
 * HTTP and WebSocket traffic to the private `SUPABASE_INTERNAL_URL` (usually
 * `http://kong:8000` on the shared Docker network). This uses the existing
 * site reverse-proxy entry and needs neither a new Synology rule nor a port.
 */
function supabaseGatewayTarget(raw) {
  if (!raw?.trim()) return null;

  try {
    const url = new URL(raw.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('unsupported URL shape');
    }
    return url.toString().replace(/\/$/, '');
  } catch {
    throw new Error('SUPABASE_INTERNAL_URL must be an absolute http(s) URL without credentials, query or fragment');
  }
}

const supabaseGateway = supabaseGatewayTarget(process.env.SUPABASE_INTERNAL_URL);

function usesSameOriginSupabaseGateway(raw) {
  if (!raw?.trim()) return false;
  try {
    return new URL(raw.trim()).pathname.replace(/\/+$/, '') === '/api/supabase';
  } catch {
    return false;
  }
}

// Do not silently build a broken same-origin endpoint. With the browser URL
// pointing at /api/supabase, the private Kong rewrite is required for REST,
// Auth, and Realtime (including WebSocket Upgrade) to reach Supabase.
if (usesSameOriginSupabaseGateway(process.env.NEXT_PUBLIC_SUPABASE_URL) && !supabaseGateway) {
  throw new Error(
    'NEXT_PUBLIC_SUPABASE_URL uses /api/supabase but SUPABASE_INTERNAL_URL is empty; configure the private Kong URL before building.',
  );
}

// Персистентный кэш сборки Turbopack (Next 16.3+, `.next/cache`) ускоряет
// тёплые пересборки, но переживает смену версии Next и на сервере умеет
// «отравиться»: `TurbopackInternalError: read_task_output: task … no longer
// exists (it was garbage collected)` — сборка падает ещё до разбора кода, и
// повтор с тем же кэшем падает так же. Обычно его лечит страж
// `deploy/docker-next-cache-guard.sh` (он чистит кэш при смене версии Next) и
// холодный повтор в `edrc_build_with_retry`. NEXT_BUILD_CACHE=off — крайняя
// мера: кэш не пишется вовсе, каждая сборка холодная.
const buildCacheDisabled = /^(off|0|false|no)$/i.test(String(process.env.NEXT_BUILD_CACHE ?? '').trim());

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Bound build workers on a small self-hosted server. `proxyTimeout` covers
  // slow Storage uploads; WebSocket upgrades themselves have no timeout.
  experimental: {
    cpus: 2,
    proxyClientMaxBodySize: '50mb',
    proxyTimeout: 3_600_000,
    ...(buildCacheDisabled ? { turbopackFileSystemCacheForBuild: false } : {}),
  },
  allowedDevOrigins: ['*.e2b.app', 'localhost', '127.0.0.1'],
  // Автономная сборка для деплоя на VPS/Docker без Vercel:
  // `next build` кладёт в .next/standalone минимальный сервер со всеми
  // зависимостями — на хостинг копируются только standalone + static + public.
  output: 'standalone',
  async rewrites() {
    if (!supabaseGateway) return [];
    return {
      // `beforeFiles` ensures that no app route can accidentally shadow a
      // Supabase endpoint. Next's native external rewrite preserves request
      // bodies and supports Upgrade/WebSocket, unlike a Route Handler fetch.
      beforeFiles: [{
        source: '/api/supabase/:path*',
        destination: `${supabaseGateway}/:path*`,
      }],
      afterFiles: [],
      fallback: [],
    };
  },
  async headers() {
    return [{ source: '/auth/:path*', headers: [
      { key: 'Referrer-Policy', value: 'no-referrer' },
      { key: 'Cache-Control', value: 'no-store' },
    ] }];
  },
  images: {
    unoptimized: true,
  },
};
export default nextConfig;
