export type SiteFooterData = {
  copyright: string;
  discord: string;
  edsm: string;
  inara: string;
};

export const DEFAULT_FOOTER: SiteFooterData = {
  copyright: '© 2026 The Galaxy Ring Project. Elite Dangerous © Frontier Developments.',
  discord: '',
  edsm: 'https://www.edsm.net/',
  inara: 'https://inara.cz/',
};

export function footerFromContent(c: Record<string, unknown> | null | undefined): SiteFooterData {
  return {
    copyright: String(c?.footer_copyright ?? DEFAULT_FOOTER.copyright),
    discord: String(c?.footer_discord ?? DEFAULT_FOOTER.discord),
    edsm: String(c?.footer_edsm ?? DEFAULT_FOOTER.edsm),
    inara: String(c?.footer_inara ?? DEFAULT_FOOTER.inara),
  };
}
