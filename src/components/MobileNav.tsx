'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useI18n } from '@/lib/i18n/I18nContext';
import { IconAtlas, IconHomeSystem, IconPlane, IconProjects } from '@/components/Icons';
import type { TranslationKey } from '@/lib/i18n/types';

/**
 * Нижняя навигация мобильного веба.
 *
 * Раньше пункты были захардкожены по-русски и не подсвечивали активный раздел:
 * класс `.mobile-nav-item.active` существовал в CSS, но никогда не выставлялся.
 */
const MOBILE_ITEMS: { href: string; translation: TranslationKey; icon: React.ReactNode }[] = [
  { href: '/', translation: 'nav.home', icon: <IconHomeSystem size={20} /> },
  { href: '/squadrons', translation: 'nav.squadrons', icon: <IconPlane size={20} /> },
  { href: '/projects', translation: 'nav.projects', icon: <IconProjects size={20} /> },
  { href: '/atlas', translation: 'nav.atlas', icon: <IconAtlas size={20} /> },
];

export default function MobileNav() {
  const { t } = useI18n();
  const pathname = usePathname();

  return (
    <nav className="mobile-nav" aria-label={t('nav.menu')}>
      {MOBILE_ITEMS.map((item) => {
        const isActive = item.href === '/' ? pathname === '/' : pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`mobile-nav-item${isActive ? ' active' : ''}`}
            aria-current={isActive ? 'page' : undefined}
            aria-label={t(item.translation)}
          >
            {item.icon}
            <span className="mobile-nav-label">{t(item.href === '/squadrons' ? 'nav.squadronsShort' : item.translation)}</span>
          </Link>
        );
      })}
      <button type="button" className="mobile-nav-item" aria-controls="sidebar-drawer" onClick={() => window.dispatchEvent(new Event('navigation:open'))}>
        <span aria-hidden="true" className="mobile-menu-icon">☰</span>{t('nav.menu')}
      </button>
    </nav>
  );
}
