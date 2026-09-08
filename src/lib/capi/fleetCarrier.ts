// ═══════════════════════════════════════════════════════════════
// Fleet Carrier CAPI Helpers
// ═══════════════════════════════════════════════════════════════

import type { CapiFleetCarrier } from '@/types/capi';

export function parseFleetCarrier(data: Record<string, unknown>): CapiFleetCarrier {
  return {
    carrierName: String(data.carrierName || ''),
    carrierId: String(data.carrierId || ''),
    callsign: String(data.callsign || ''),
    currentSystem: String(data.currentSystem || ''),
    currentBody: String(data.currentBody || ''),
    balance: Number(data.balance) || 0,
    fuel: Number(data.fuel) || 0,
    services: Array.isArray(data.services) ? data.services as CapiFleetCarrier['services'] : [],
    market: data.market as CapiFleetCarrier['market'],
    itinerary: Array.isArray(data.itinerary) ? data.itinerary as CapiFleetCarrier['itinerary'] : [],
  };
}

export function getCarrierMarketSummary(carrier: CapiFleetCarrier) {
  if (!carrier.market?.commodities) return [];

  const categories: Record<string, typeof carrier.market.commodities> = {};
  for (const c of carrier.market.commodities) {
    const cat = c.name.split('_')[0] || 'Other';
    if (!categories[cat]) categories[cat] = [];
    categories[cat].push(c);
  }

  return Object.entries(categories).map(([category, items]) => ({
    category,
    items,
  }));
}
