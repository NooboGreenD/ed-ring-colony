/**
 * Товары для строительства колоний: используются и в панели Atlas, и на
 * странице `/atlas/market`, чтобы подсказки в обоих поисковиках совпадали.
 */
export const BUILD_COMMODITIES: string[] = [
  'Aluminium',
  'Ceramic Composites',
  'CMM Composite',
  'Computer Components',
  'Copper',
  'Food Cartridges',
  'Fruit and Vegetables',
  'Insulating Membrane',
  'Liquid oxygen',
  'Medical Diagnostic Equipment',
  'Non-Lethal Weapons',
  'Polymers',
  'Power Generators',
  'Semiconductors',
  'Steel',
  'Superconductors',
  'Titanium',
  'Water',
  'Water Purifiers',
  'Structural Regulators',
  'Building Fabricators',
  'Thermal Cooling Units',
];

/** Точное имя товара из списка (регистр не важен), иначе — введённый текст. */
export function resolveCommodity(input: string): string {
  const query = input.trim().toLowerCase();
  if (!query) return '';
  return BUILD_COMMODITIES.find((item) => item.toLowerCase() === query) || input.trim();
}
