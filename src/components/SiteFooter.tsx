import type { SiteFooterData } from '@/lib/siteFooter';

export default function SiteFooter({ copyright, discord, edsm, inara }: SiteFooterData) {
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
          <nav className="site-footer-links" aria-label="Внешние ресурсы">
            {links.map((l) => (
              <a key={l.label} href={l.href} target="_blank" rel="noreferrer">
                {l.label}
              </a>
            ))}
          </nav>
        )}
      </div>
    </footer>
  );
}
