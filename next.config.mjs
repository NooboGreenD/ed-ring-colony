/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Автономная сборка для деплоя на VPS/Docker без Vercel:
  // `next build` кладёт в .next/standalone минимальный сервер со всеми
  // зависимостями — на хостинг копируются только standalone + static + public.
  output: 'standalone',
  images: {
    unoptimized: true,
  },
};
export default nextConfig;