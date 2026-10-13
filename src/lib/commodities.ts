/**
 * Товары для строительства колоний: используются и в панели Atlas, и на
 * странице `/atlas/market`, чтобы подсказки в обоих поисковиках совпадали.
 */
import { CONSTRUCTION_COMMODITIES } from './constructionBlueprints';

export const BUILD_COMMODITIES: string[] = CONSTRUCTION_COMMODITIES;

/** Match EDDN journal symbols, EDSM display names, case and hyphen variants. */
export function commodityKey(input: string): string {
  return input
    .trim()
    .replace(/^\$/, '')
    .replace(/_name;?$/i, '')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase();
}

/** Точное имя товара из списка (регистр не важен), иначе — введённый текст. */
export function resolveCommodity(input: string): string {
  const query = input.trim().toLowerCase();
  if (!query) return '';
  return (
    BUILD_COMMODITIES.find(
      (item) => commodityKey(item) === commodityKey(query)
    ) || input.trim()
  );
}
