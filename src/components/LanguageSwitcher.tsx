'use client';

import { useI18n } from '@/lib/i18n/I18nContext';
import { LOCALE_FLAGS } from '@/lib/i18n/translations';
import { useState, useRef, useEffect } from 'react';

export default function LanguageSwitcher() {
  const { locale, setLocale, supportedLocales, localeNames } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 10px',
          fontSize: 12,
          background: 'transparent',
          border: '1px solid #3a3d40',
          color: '#9ca3af',
          cursor: 'pointer',
          borderRadius: 2,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
          letterSpacing: 1,
        }}
        title="Language"
      >
        <span>{LOCALE_FLAGS[locale] ?? ''}</span>
        <span>{localeNames[locale] ?? locale}</span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            bottom: 'calc(100% + 4px)',
            left: 0,
            background: '#1a1c1e',
            border: '1px solid #3a3d40',
            borderRadius: 4,
            padding: '4px 0',
            zIndex: 100,
            minWidth: 140,
            boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
          }}
        >
          {supportedLocales.map((loc) => (
            <button
              key={loc}
              onClick={() => {
                setLocale(loc);
                setOpen(false);
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                width: '100%',
                padding: '8px 12px',
                background: loc === locale ? 'rgba(230,126,34,0.1)' : 'transparent',
                border: 'none',
                color: loc === locale ? '#e67e22' : '#eeeeee',
                cursor: 'pointer',
                fontSize: 12,
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                textAlign: 'left',
                transition: 'background 0.15s',
              }}
            >
              <span>{LOCALE_FLAGS[loc] ?? ''}</span>
              <span>{localeNames[loc] ?? loc}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
