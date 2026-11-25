import catalogue from './stationSearchItems.json' with { type: 'json' };

export const BANK_MAX_TONNES = 60000;
export type BankInventoryItem = { commodity: string; qty: number; name_localised?: string };
// Symbols, not translated labels, are the ledger keys. Include limpets and
// salvage (Titan Drive Components), not just construction materials.
export const BANK_GOODS = [...catalogue.commodities, ...catalogue.rare]
  .map(item => ({ commodity: item.symbol.toLowerCase().replace(/[^a-z0-9]/g, ''), name: item.name }));
const known = new Set(BANK_GOODS.map(item => item.commodity));
known.add('drones');

export function validBankInventory(value: unknown): value is BankInventoryItem[] {
  if (!Array.isArray(value) || value.length > 512) return false;
  const seen = new Set<string>();
  let total = 0;
  for (const item of value) {
    if (!item || typeof item !== 'object' || typeof item.commodity !== 'string'
      || !known.has(item.commodity) || seen.has(item.commodity)
      || !Number.isSafeInteger(item.qty) || item.qty < 0 || item.qty > BANK_MAX_TONNES
      || (item.name_localised !== undefined && (typeof item.name_localised !== 'string' || item.name_localised.length > 120))) return false;
    seen.add(item.commodity); total += item.qty;
  }
  return total <= BANK_MAX_TONNES;
}

export type BankCorrectionHistory = { id: number; observedAt: string; recordedAt: string; reason: string; total: number; author: string };
