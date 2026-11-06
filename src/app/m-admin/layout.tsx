import type { Metadata, Viewport } from 'next';
import { getServerI18n } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getServerI18n();

  return {
    title: 'ED Ring Colony — Mobile Admin',
    description: t('meta.mAdminDescription'),
  manifest: '/manifest-mobile.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'EDRC Admin',
    },
  };
}

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
