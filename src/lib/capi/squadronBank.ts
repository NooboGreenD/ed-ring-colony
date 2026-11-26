import { canonicalCommodity } from '../fleetCarriers';
import { validBankInventory, type BankInventoryItem } from '../bankCorrection';

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** EDCD/FDevIDs: /squadron -> bank.commodities.All, not market demand or ship cargo.
 * Only the explicit shared account is accepted. Missing/private/unknown shapes
 * are NOT an empty inventory. Personal allocations are not available bank stock.
 */
export function squadronBankSnapshot(raw: unknown, expected: { callsign: string; carrierId: string }, requestedAt: Date, receivedAt: Date = requestedAt) {
  if (!record(raw) || !record(raw.squadronCarrier) || !record(raw.squadronCarrier.name)
      || !record(raw.bank) || !record(raw.bank.commodities)) return null;
  const callsign = raw.squadronCarrier.name.callsign;
  if (typeof callsign !== 'string' || !/^[A-Z0-9]{4}$/.test(callsign)
      || callsign !== expected.callsign.toUpperCase() || raw.tag !== callsign) return null;
  // Some /squadron responses omit the carrier's numeric market ID. A bound
  // website carrier plus matching in-game squadron tag identifies it instead.
  const market = raw.squadronCarrier.market;
  if (record(market) && market.id !== undefined && String(market.id) !== expected.carrierId) return null;
  const rows = raw.bank.commodities.All;
  if (!Array.isArray(rows) || rows.length > 512) return null;
  const items: BankInventoryItem[] = [];
  for (const row of rows) {
    if (!record(row) || typeof row.name !== 'string' || !Number.isSafeInteger(row.qty)
        || Number(row.qty) < 0 || Number(row.qty) > 60000) return null;
    const commodity = canonicalCommodity(row.name);
    if (!commodity) return null;
    items.push({ commodity, qty: Number(row.qty),
      ...(typeof row.locName === 'string' ? { name_localised: row.locName } : {}) });
  }
  items.sort((a, b) => a.commodity.localeCompare(b.commodity));
  if (!validBankInventory(items)) return null;
  // Use Frontier's timestamp when supplied. Otherwise the start of the live
  // no-store request is a conservative retrieval cursor, NOT receipt time:
  // transactions after the request started must remain in the ledger.
  const at = raw.timestamp === undefined ? requestedAt.getTime()
    : typeof raw.timestamp === 'string' ? Date.parse(raw.timestamp) : NaN;
  if (!Number.isFinite(at) || !Number.isFinite(receivedAt.getTime())
      || receivedAt.getTime() < requestedAt.getTime() || at > receivedAt.getTime()
      || at < requestedAt.getTime() - 5 * 60_000) return null;
  return { items, observedAt: new Date(at).toISOString() };
}
