'use client';

/**
 * Вкладки раздела «Архитектор»: планировщик одной системы и проекты систем
 * (группы систем под общую стройку). Ссылки, а не состояние: у каждой
 * вкладки свой адрес, его можно открыть в новой вкладке и переслать.
 */

import Link from 'next/link';
import type { CSSProperties } from 'react';

export type ArchitectSection = 'planner' | 'projects';

const TABS: Array<{ id: ArchitectSection; href: string; label: string; hint: string }> = [
  { id: 'planner', href: '/architect', label: 'Планировщик системы', hint: 'План застройки одной системы' },
  { id: 'projects', href: '/architect/projects', label: 'Проекты систем', hint: 'Группы систем, участники, авианосцы и лидеры' },
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
  return (
    <nav aria-label="Разделы архитектора" style={navStyle}>
      {TABS.map((tab) => {
        const isActive = tab.id === active;
        return (
          <Link
            key={tab.id}
            href={tab.href}
            title={tab.hint}
            aria-current={isActive ? 'page' : undefined}
            style={isActive ? { ...tabStyle, ...activeTabStyle } : tabStyle}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
