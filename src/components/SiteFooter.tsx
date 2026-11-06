'use client';

import type { SiteFooterData } from '@/lib/siteFooter';
import Link from "next/link";
import { useI18n } from '@/lib/i18n/I18nContext';

export default function SiteFooter({ copyright, discord, edsm, inara }: SiteFooterData) {
  const { t } = useI18n();
  const links = [
    { href: discord, label: 'Discord' },
    { href: edsm, label: 'EDSM' },
    { href: inara, label: 'INARA' },
  ].filter((l) => l.href.trim());

  return (
    <footer className="site-footer">
      <div className="site-footer-inner">
        <p className="site-footer-copy">{copyright}</p>
        {links.length > 0 && (
          <nav className="site-footer-links" aria-label={t('foot.externalAria')}>
            {links.map((l) => (
              <a key={l.label} href={l.href} target="_blank" rel="noreferrer">
                {l.label}
              </a>
            ))}
          </nav>
        )}
        <nav className="site-footer-links" aria-label={t('foot.legalAria')}>
          <Link href="/offer">{t('foot.offer')}</Link>
          <Link href="/support">{t('nav.support')}</Link>
        </nav>
      </div>
    </footer>
  );
}
