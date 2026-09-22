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

const FOOTER_FIELDS = ['copyright', 'discord', 'edsm', 'inara'] as const;

/**
 * Локаль влияет на имя колонки, поэтому её нельзя брать из запроса как есть:
 * только белый список языков перевода.
 */
function safeLocale(locale: string | undefined): string | null {
  const value = (locale || '').toLowerCase().split('-')[0];
  return /^[a-z]{2}$/.test(value) ? value : null;
}

/**
 * Подвал админка хранит в двух видах: базовые колонки (`footer_copyright`) и
 * переводы (`footer_copyright_ru`). Раньше читались только базовые, поэтому
 * правки из админки на сайте не появлялись. Порядок: перевод текущей локали →
 * базовая колонка → дефолт; пустая строка означает «ссылки нет» и не
 * подменяется дефолтом.
 */
export function footerFromContent(
  c: Record<string, unknown> | null | undefined,
  locale?: string,
): SiteFooterData {
  const lang = safeLocale(locale);
  const read = (field: (typeof FOOTER_FIELDS)[number]): string => {
    const base = `footer_${field}`;
    if (lang) {
      const translated = c?.[`${base}_${lang}`];
      if (typeof translated === 'string' && translated.trim()) return translated;
    }
    const value = c?.[base];
    return typeof value === 'string' ? value : '';
  };

  return {
    copyright: read('copyright').trim() || DEFAULT_FOOTER.copyright,
    discord: read('discord'),
    edsm: read('edsm').trim() || DEFAULT_FOOTER.edsm,
    inara: read('inara').trim() || DEFAULT_FOOTER.inara,
  };
}

/**
 * Payload, который безопасно писать в `site_content`: и базовые колонки, и
 * переводы. Базовая колонка нужна тем читателям, что до сих пор ходят к ней, а
 * правки админки должны доходить до сайта независимо от того, применена ли
 * миграция с колонками переводов.
 */
export function buildSiteContentPayload(
  fields: Record<string, Record<string, string>>,
  canonicalLang = 'ru',
): Record<string, string> {
  const payload: Record<string, string> = {};
  for (const [base, record] of Object.entries(fields)) {
    for (const [lang, value] of Object.entries(record)) {
      if (!/^[a-z]{2}$/.test(lang)) continue;
      payload[`${base}_${lang}`] = value;
    }
    payload[base] = record[canonicalLang] ?? '';
  }
  return payload;
}

export const SITE_CONTENT_FOOTER_FIELDS = FOOTER_FIELDS;
