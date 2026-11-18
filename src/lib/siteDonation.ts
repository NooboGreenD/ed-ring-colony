export type SiteDonationData = {
  widgetUrl: string;
  buttonUrl: string;
};

export const DEFAULT_DONATION: SiteDonationData = {
  widgetUrl:
    'https://www.donationalerts.com/widget/goal/10063399?token=4exln3m2MiIzRjW9yY7M',
  buttonUrl: 'https://www.donationalerts.com/r/noobo_greeend_dev',
};

const DONATION_FIELDS = ['widget_url', 'button_url'] as const;

/** БCP-47 базовый язык (ru / en / …), без регионального суффикса. */
function safeLocale(locale: string | undefined): string | null {
  const value = (locale || '').toLowerCase().split('-')[0];
  return /^[a-z]{2}$/.test(value) ? value : null;
}

/**
 * Читает настройки пожертвований из строки site_content (id = 1).
 * Порядок: перевод текущей локали → базовая колонка → дефолтные ссылки.
 * Пустая строка означает «не задано» — подставляется дефолт.
 */
export function donationFromContent(
  c: Record<string, unknown> | null | undefined,
  locale?: string,
): SiteDonationData {
  const lang = safeLocale(locale);
  const read = (field: (typeof DONATION_FIELDS)[number]): string => {
    const base = `donation_${field}`;
    if (lang) {
      const translated = c?.[`${base}_${lang}`];
      if (typeof translated === 'string' && translated.trim()) return translated;
    }
    const value = c?.[base];
    return typeof value === 'string' ? value : '';
  };

  return {
    widgetUrl: read('widget_url').trim() || DEFAULT_DONATION.widgetUrl,
    buttonUrl: read('button_url').trim() || DEFAULT_DONATION.buttonUrl,
  };
}

/** Payload, который безопасно писать в `site_content`: базовые колонки + переводы. */
export function buildDonationPayload(
  fields: Record<string, Record<string, string>>,
  canonicalLang = 'ru',
): Record<string, string> {
  const payload: Record<string, string> = {};
  for (const [base, record] of Object.entries(fields)) {
    for (const [lang, value] of Object.entries(record)) {
      if (!/^[a-z]{2}$/.test(lang)) continue;
      payload[`donation_${base}_${lang}`] = value;
    }
    payload[`donation_${base}`] = (record[canonicalLang] ?? '').trim();
  }
  return payload;
}
