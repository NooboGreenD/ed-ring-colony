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

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Bound build workers on a small self-hosted server. `proxyTimeout` covers
  // slow Storage uploads; WebSocket upgrades themselves have no timeout.
  experimental: { cpus: 2, proxyClientMaxBodySize: '50mb', proxyTimeout: 3_600_000 },
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
