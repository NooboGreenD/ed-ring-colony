import './globals.css';
import '@/styles/forum-extra.css';
import '@/styles/mobile-shell.css';
import Link from 'next/link';
import SiteStatusBar from '@/components/SiteStatusBar';
import NotificationBell from '@/components/NotificationBell';
import UserMenu from '@/components/UserMenu';
import Footer from '@/components/Footer';
import Sidebar from '@/components/Sidebar';
import MobileNav from '@/components/MobileNav';
import HudSkinProvider from '@/components/Cosmetics/HudSkinProvider';
import { I18nProvider } from '@/lib/i18n/I18nContext';
import { Toaster } from '@/components/ui/Toaster';

export const viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover' };

export const metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || 'https://edringcolony.ru'),
  title: 'ED Ring Colony — The Galaxy Ring Project',
  description: 'Платформа для координации колонизации в Elite Dangerous. Эскадрильи, проекты, атлас систем, лидерборд.',
  keywords: ['Elite Dangerous', 'колонизация', 'эскадрильи', 'ED', 'Ring Colony', 'Galaxy Ring'],
  authors: [{ name: 'ED Ring Colony' }],
  icons: {
    icon: '/favicon.ico',
    shortcut: '/favicon.ico',
    apple: '/apple-touch-icon.png',
  },
  manifest: '/manifest.json',
  openGraph: {
    title: 'ED Ring Colony — The Galaxy Ring Project',
    description: 'Платформа для координации колонизации в Elite Dangerous',
    url: process.env.NEXT_PUBLIC_SITE_URL || 'https://edringcolony.ru',
    siteName: 'ED Ring Colony',
    images: [{ url: '/og-image.png', width: 1200, height: 630, alt: 'ED Ring Colony' }],
    locale: 'ru_RU',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'ED Ring Colony — The Galaxy Ring Project',
    description: 'Платформа для координации колонизации в Elite Dangerous',
    images: ['/twitter-image.png'],
  },
};

function HexLogo() {
  return (
    <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true">
      <polygon points="16,2 28,9 28,23 16,30 4,23 4,9" fill="none" stroke="#e67e22" strokeWidth="2" />
      <circle cx="16" cy="16" r="4" fill="#e67e22" />
    </svg>
  );
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body className="min-h-screen bg-bg text-text">
        <I18nProvider>
          <HudSkinProvider />
          <header className="topbar">
            <Link href="/" className="brand">
              <HexLogo />
              <span className="brand-name">The Galaxy Ring Project</span>
            </Link>
            <div className="topbar-right">
              <SiteStatusBar />
              <NotificationBell />
              <UserMenu />
            </div>
          </header>
          <div style={{ display: 'flex' }}>
            <Sidebar />
            <div className="site-content" style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
              <main className="main-with-sidebar">{children}</main>
              <Footer />
            </div>
          </div>
          <MobileNav />
          {/* Один общий хост уведомлений: страницы больше не дублируют <Toaster/>,
              а /atlas/market перестал терять toast-сообщения. */}
          <Toaster />
        </I18nProvider>
      </body>
    </html>
  );
}
