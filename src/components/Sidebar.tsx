'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import LanguageSwitcher from '@/components/LanguageSwitcher';
import { useI18n } from '@/lib/i18n/I18nContext';
import {
  IconAtlas,
  IconBuilding,
  IconChevronDown,
  IconGear,
  IconGlobe,
  IconHomeSystem,
  IconLeaderboard,
  IconMap,
  IconMessage,
  IconNote,
  IconPlane,
  IconProfile,
  IconProjects,
  IconRadio,
  IconSearch,
  IconHeadphones,
  IconStore,
  IconUsers,
  IconWiki,
  IconWrench,
} from '@/components/Icons';
import type { TranslationKey } from '@/lib/i18n/types';

/**
 * Пункт меню. `translation` — ключ словаря; новые разделы обязаны иметь перевод
 * во всех локалях (см. scripts/tests/menu-i18n.test.mjs).
 */
interface NavItem {
  href: string;
  translation: TranslationKey;
  icon: React.ReactNode;
  /** Подпункты выводятся с отступом под родителем; подпись — тоже ключ словаря. */
  children?: { href: string; labelKey: TranslationKey }[];
}

interface NavGroup {
  id: string;
  titleKey: TranslationKey;
  items: NavItem[];
}

const iconSize = 18;

const NAV_GROUPS: NavGroup[] = [
  {
    id: 'navigation',
    titleKey: 'nav.group.navigation',
    items: [
      { href: '/', translation: 'nav.home', icon: <IconHomeSystem size={iconSize} className="sidebar-icon" /> },
      { href: '/map', translation: 'nav.map', icon: <IconMap size={iconSize} className="sidebar-icon" /> },
      {
        href: '/atlas',
        translation: 'nav.atlas',
        icon: <IconAtlas size={iconSize} className="sidebar-icon" />,
        children: [{ href: '/atlas/sector', labelKey: 'nav.sectors' }],
      },
      { href: '/systems', translation: 'nav.systems', icon: <IconGlobe size={iconSize} className="sidebar-icon" /> },
      { href: '/cmdrs', translation: 'nav.cmdrs', icon: <IconUsers size={iconSize} className="sidebar-icon" /> },
      { href: '/leaderboard', translation: 'nav.leaderboard', icon: <IconLeaderboard size={iconSize} className="sidebar-icon" /> },
    ],
  },
  {
    id: 'community',
    titleKey: 'nav.group.community',
    items: [
      { href: '/squadrons', translation: 'nav.squadrons', icon: <IconPlane size={iconSize} className="sidebar-icon" /> },
      { href: '/projects', translation: 'nav.projects', icon: <IconProjects size={iconSize} className="sidebar-icon" /> },
      { href: '/news', translation: 'nav.news', icon: <IconNote size={iconSize} className="sidebar-icon" /> },
      { href: '/galnet', translation: 'nav.galnet', icon: <IconRadio size={iconSize} className="sidebar-icon" /> },
      { href: '/forum', translation: 'nav.forum', icon: <IconMessage size={iconSize} className="sidebar-icon" /> },
      { href: '/wiki', translation: 'nav.wiki', icon: <IconWiki size={iconSize} className="sidebar-icon" /> },
    ],
  },
  {
    id: 'tools',
    titleKey: 'nav.group.tools',
    items: [
      { href: '/architect', translation: 'nav.architect', icon: <IconBuilding size={iconSize} className="sidebar-icon" /> },
      { href: '/outfitting', translation: 'nav.outfitting', icon: <IconWrench size={iconSize} className="sidebar-icon" /> },
      { href: '/engineers', translation: 'nav.engineers', icon: <IconGear size={iconSize} className="sidebar-icon" /> },
    ],
  },
  {
    id: 'help',
    titleKey: 'nav.group.help',
    items: [
      { href: '/support', translation: 'nav.support', icon: <IconHeadphones size={iconSize} className="sidebar-icon" /> },
      { href: '/premium-shop', translation: 'nav.shop', icon: <IconStore size={iconSize} className="sidebar-icon" /> },
      { href: '/account', translation: 'nav.account', icon: <IconProfile size={iconSize} className="sidebar-icon" /> },
    ],
  },
];

const COLLAPSED_STORAGE_KEY = 'ed-ring-sidebar-collapsed';

/** Активен ли пункт: точное совпадение или вложенный маршрут. */
export function isNavItemActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

function readCollapsedGroups(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(COLLAPSED_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function NavContent({
  pathname,
  query,
  collapsed,
  onNavigate,
  onToggleGroup,
}: {
  pathname: string;
  query: string;
  collapsed: string[];
  onNavigate?: () => void;
  onToggleGroup: (id: string) => void;
}) {
  const { t } = useI18n();
  const normalizedQuery = query.trim().toLowerCase();

  // Пункт считается найденным и по своему названию, и по подписи подпункта:
  // так запрос «секторы» находит Atlas, даже когда раздел свёрнут.
  const itemMatches = useCallback(
    (item: NavItem) =>
      t(item.translation).toLowerCase().includes(normalizedQuery) ||
      Boolean(item.children?.some((child) => t(child.labelKey).toLowerCase().includes(normalizedQuery))),
    [normalizedQuery, t],
  );

  const visibleGroups = useMemo(() => {
    if (!normalizedQuery) return NAV_GROUPS;
    return NAV_GROUPS.map((group) => ({
      ...group,
      items: group.items.filter(itemMatches),
    })).filter((group) => group.items.length > 0);
  }, [normalizedQuery, itemMatches]);

  if (visibleGroups.length === 0) {
    return <p className="sidebar-empty">{t('nav.empty')}</p>;
  }

  return (
    <>
      {visibleGroups.map((group) => {
        const isCollapsed = collapsed.includes(group.id) && !normalizedQuery;
        return (
          <div className="sidebar-group" key={group.id}>
            <button
              type="button"
              className={`sidebar-group-title${isCollapsed ? ' collapsed' : ''}`}
              onClick={() => onToggleGroup(group.id)}
              aria-expanded={!isCollapsed}
            >
              <span>{t(group.titleKey)}</span>
              <IconChevronDown size={12} />
            </button>
            {!isCollapsed && (
              <div className="sidebar-group-items">
                {group.items.map((item) => {
                  const isActive = isNavItemActive(pathname, item.href);
                  const childMatches = Boolean(normalizedQuery)
                    && Boolean(item.children?.some((child) => t(child.labelKey).toLowerCase().includes(normalizedQuery)));
                  return (
                    <div key={item.href}>
                      <Link
                        href={item.href}
                        className={`sidebar-item${isActive ? ' active' : ''}`}
                        onClick={onNavigate}
                        aria-current={isActive ? 'page' : undefined}
                      >
                        {item.icon}
                        {t(item.translation)}
                      </Link>
                      {item.children && (isActive || childMatches) && (
                        <div className="sidebar-subitems">
                          {item.children.map((child) => {
                            const childActive = isNavItemActive(pathname, child.href);
                            return (
                              <Link
                                key={child.href}
                                href={child.href}
                                className={`sidebar-subitem${childActive ? ' active' : ''}`}
                                onClick={onNavigate}
                                aria-current={childActive ? 'page' : undefined}
                              >
                                {t(child.labelKey)}
                              </Link>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

export default function Sidebar() {
  const { t } = useI18n();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const drawerRef = useRef<HTMLDivElement | null>(null);

  // Настройка «свёрнутые разделы» — персональная, переживает перезагрузку.
  useEffect(() => {
    setCollapsed(readCollapsedGroups());
  }, []);

  // Мобильное меню: Escape, блокировка прокрутки и фокус внутри панели.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKeyDown);
    drawerRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  // Переход по ссылке закрывает drawer, чтобы карта не оставалась под оверлеем.
  useEffect(() => {
    setOpen(false);
    setQuery('');
  }, [pathname]);

  const toggleGroup = useCallback((id: string) => {
    setCollapsed((current) => {
      const next = current.includes(id) ? current.filter((item) => item !== id) : [...current, id];
      try {
        window.localStorage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Приватный режим: настройка просто не сохранится.
      }
      return next;
    });
  }, []);

  const closeDrawer = useCallback(() => setOpen(false), []);

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="sidebar" aria-label={t('nav.menu')}>
        <div className="sidebar-search">
          <IconSearch size={14} className="sidebar-search-icon" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('nav.filter')}
            aria-label={t('nav.filter')}
          />
          {query && (
            <button type="button" className="sidebar-search-clear" onClick={() => setQuery('')} aria-label="×">
              ×
            </button>
          )}
        </div>
        <nav className="sidebar-nav">
          <NavContent pathname={pathname} query={query} collapsed={collapsed} onToggleGroup={toggleGroup} />
        </nav>
        <div className="sidebar-footer">
          <LanguageSwitcher />
        </div>
      </aside>

      {/* Mobile hamburger */}
      <button
        className="hamburger"
        onClick={() => setOpen((current) => !current)}
        aria-label={open ? t('nav.closeMenu') : t('nav.menu')}
        aria-expanded={open}
        aria-controls="sidebar-drawer"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          {open ? (
            <>
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </>
          ) : (
            <>
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </>
          )}
        </svg>
      </button>

      <div className={`mobile-overlay${open ? ' open' : ''}`} onClick={closeDrawer} aria-hidden="true" />

      <div
        id="sidebar-drawer"
        ref={drawerRef}
        className={`sidebar-drawer${open ? ' open' : ''}`}
        role="dialog"
        aria-modal={open}
        aria-label={t('nav.menu')}
        tabIndex={-1}
      >
        <div className="sidebar-search">
          <IconSearch size={14} className="sidebar-search-icon" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('nav.filter')}
            aria-label={t('nav.filter')}
          />
        </div>
        <nav className="sidebar-nav">
          <NavContent
            pathname={pathname}
            query={query}
            collapsed={collapsed}
            onNavigate={closeDrawer}
            onToggleGroup={toggleGroup}
          />
        </nav>
        <div className="sidebar-footer">
          <LanguageSwitcher />
        </div>
      </div>
    </>
  );
}
