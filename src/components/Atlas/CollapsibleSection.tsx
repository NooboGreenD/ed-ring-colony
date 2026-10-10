'use client';

import { useEffect, useState } from 'react';
import { IconChevronDown } from '@/components/Icons';

/**
 * Складной блок панели Atlas. Состояние хранится отдельно для каждого
 * `storageKey`, поэтому «Избранное» и «История» не спорят друг с другом.
 */
interface Props {
  title: string;
  count?: number;
  storageKey?: string;
  defaultOpen?: boolean;
  actions?: React.ReactNode;
  children: React.ReactNode;
}

export function CollapsibleSection({ title, count, storageKey, defaultOpen = true, actions, children }: Props) {
  const [open, setOpen] = useState(defaultOpen);

  useEffect(() => {
    if (!storageKey || typeof window === 'undefined') return;
    try {
      const stored = window.localStorage.getItem(`atlas:section:${storageKey}`);
      if (stored === 'open') setOpen(true);
      else if (stored === 'closed') setOpen(false);
    } catch {
      // ignore
    }
  }, [storageKey]);

  const toggle = () => {
    setOpen((current) => {
      const next = !current;
      if (storageKey) {
        try {
          window.localStorage.setItem(`atlas:section:${storageKey}`, next ? 'open' : 'closed');
        } catch {
          // ignore
        }
      }
      return next;
    });
  };

  return (
    <section className={`atlas-section atlas-collapsible${open ? ' open' : ''}`}>
      <div className="atlas-section-head">
        <button type="button" className="atlas-section-toggle" onClick={toggle} aria-expanded={open}>
          <IconChevronDown size={12} />
          <span>{title}</span>
          {typeof count === 'number' && <span className="atlas-section-count">{count.toLocaleString('ru-RU')}</span>}
        </button>
        {actions && <div className="atlas-section-actions">{actions}</div>}
      </div>
      {open && <div className="atlas-section-body">{children}</div>}
    </section>
  );
}
