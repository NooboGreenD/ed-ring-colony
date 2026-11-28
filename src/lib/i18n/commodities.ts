/** Commodity display translations come from the same game-name data as Helper. */
import { commodityNames } from '../commodityNames.ts';

export const commodityTranslations: Record<string, Record<string, string>> = Object.fromEntries(
  ['ru', 'en', 'de', 'it', 'ko', 'zh', 'ja'].map((locale) => [locale,
    Object.fromEntries(Object.entries(commodityNames).map(([key, names]) => [
      `commodity.${key}`, names[locale] || names.en,
    ])),
  ]),
);
