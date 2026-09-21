/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Bound build workers on a small self-hosted server. No Edge-only proxy.
  experimental: { cpus: 2 },
  allowedDevOrigins: ['*.e2b.app', 'localhost', '127.0.0.1'],
  // Автономная сборка для деплоя на VPS/Docker без Vercel:
  // `next build` кладёт в .next/standalone минимальный сервер со всеми
  // зависимостями — на хостинг копируются только standalone + static + public.
  output: 'standalone',
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