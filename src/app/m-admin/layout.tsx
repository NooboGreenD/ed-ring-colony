import type { Metadata, Viewport } from 'next';

export const metadata: Metadata = {
  title: 'ED Ring Colony — Mobile Admin',
  description: 'Мобильная админ-панель для мониторинга ED Ring Colony',
  manifest: '/manifest-mobile.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'EDRC Admin',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: '#1e2022',
  colorScheme: 'dark',
};

export default function MobileAdminLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
