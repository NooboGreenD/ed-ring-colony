'use client';

/**
 * Вкладки раздела «Архитектор»: планировщик одной системы и проекты систем
 * (группы систем под общую стройку). Ссылки, а не состояние: у каждой
 * вкладки свой адрес, его можно открыть в новой вкладке и переслать.
 */

import Link from 'next/link';
import { useI18n } from '@/lib/i18n/I18nContext';
import type { CSSProperties } from 'react';

export type ArchitectSection = 'planner' | 'projects';

const TABS: Array<{ id: ArchitectSection; href: string; labelKey: string; hintKey: string }> = [
  { id: 'planner', href: '/architect', labelKey: 'anav.planner', hintKey: 'anav.plannerHint' },
  { id: 'projects', href: '/architect/projects', labelKey: 'anav.projects', hintKey: 'anav.projectsHint' },
];

const navStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 0,
  marginBottom: 12,
  borderBottomWidth: 1,
  borderBottomStyle: 'solid',
  borderBottomColor: 'var(--line)',
};

const tabStyle: CSSProperties = {
  padding: '9px 16px',
  fontSize: 13,
  fontFamily: 'ui-monospace, monospace',
  letterSpacing: 0.4,
  color: 'var(--muted)',
  textDecoration: 'none',
  borderBottomWidth: 2,
  borderBottomStyle: 'solid',
  borderBottomColor: 'transparent',
  marginBottom: -1,
};

const activeTabStyle: CSSProperties = {
  color: 'var(--orange)',
  borderBottomColor: 'var(--orange)',
};

export default function ArchitectNav({ active }: { active: ArchitectSection }) {
  const { t } = useI18n();

  return (
    <nav aria-label={t('anav.aria')} style={navStyle}>
      {TABS.map((tab) => {
        const isActive = tab.id === active;
        return (
          <Link
            key={tab.id}
            href={tab.href}
            title={t(tab.hintKey)}
            aria-current={isActive ? 'page' : undefined}
            style={isActive ? { ...tabStyle, ...activeTabStyle } : tabStyle}
          >
            {t(tab.labelKey)}
          </Link>
        );
      })}
    </nav>
  );
}
