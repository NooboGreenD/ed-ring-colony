/** Display-only game names shared with the packaged Helper. Never localize API keys. */
import catalog from '../../uploader/commodity_names.json' with { type: 'json' };

export const commodityNames: Record<string, Record<string, string>> = catalog.goods;
export const constructionCommodityKeys: string[] = catalog.construction;

function fold(value: string): string {
  return value.trim().replace(/^\$+/, '').replace(/_name;?$/i, '')
    .toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]/gu, '');
}
const aliases = new Map<string, string>();
for (const [key, names] of Object.entries(commodityNames)) {
  aliases.set(fold(key), key);
  for (const name of Object.values(names)) if (!aliases.has(fold(name))) aliases.set(fold(name), key);
}
for (const [alias, key] of Object.entries(catalog.aliases)) aliases.set(fold(alias), key);

/** Known symbols, journal tokens, game labels and legacy Russian spellings only. */
export function knownCommodityKey(value: string): string | undefined {
  return aliases.get(fold(value));
}

export function localizedCommodityName(value: string, locale = 'ru', fallback = value): string {
  const key = knownCommodityKey(value) ?? knownCommodityKey(fallback);
  if (!key) return fallback;
  const names = commodityNames[key];
  const language = locale.split('-')[0].toLowerCase();
  if (language === 'ru' && !names.ru && /[А-Яа-яЁё]/.test(fallback)) return fallback;
  return names[language] || names.en || fallback;
}
