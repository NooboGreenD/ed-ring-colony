/**
 * Справочники товарного поиска Atlas: отдельный список стройматериалов и
 * полный список рыночных товаров, включая редкие.
 */
import { CONSTRUCTION_COMMODITIES } from './constructionBlueprints.ts';
import items from './stationSearchItems.json' with { type: 'json' };

export const BUILD_COMMODITIES: string[] = CONSTRUCTION_COMMODITIES;

/** All marketable in-game goods, including rare goods (not just build materials). */
export const MARKET_COMMODITIES: string[] = Array.from(new Set(
  [...items.commodities, ...items.rare]
    .filter((item) => item.category !== 'NonMarketable')
    .map((item) => item.name.trim())
    .filter(Boolean),
)).sort((left, right) => left.localeCompare(right));

/** Match EDDN journal symbols, EDSM display names, case and hyphen variants. */
export function commodityKey(input: string): string {
  return input
    .trim()
    .replace(/^\$/, '')
    .replace(/_name;?$/i, '')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase();
}

const knownMarketCommodities = new Map<string, string>();
for (const item of [...items.commodities, ...items.rare]) {
  if (item.category === 'NonMarketable') continue;
  for (const value of [item.name, item.symbol]) {
    const key = commodityKey(value);
    if (key && !knownMarketCommodities.has(key)) knownMarketCommodities.set(key, item.name);
  }
}

/** Canonical in-game name for any known market good; preserve free-form queries. */
export function resolveCommodity(input: string): string {
  const query = input.trim();
  if (!query) return '';
  return knownMarketCommodities.get(commodityKey(query)) || query;
}
