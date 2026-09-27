// ═══════════════════════════════════════════════════════════════
// Fleet Carrier CAPI Helpers
// ═══════════════════════════════════════════════════════════════
//
// Реальный ответ `/fleetcarrier` (EDCD/FDevIDs → Frontier API):
//
//   { "name": { "callsign": "K7X-B0Z",
//               "vanityName": "48454C495820...",   ← имя в hex
//               "filteredVanityName": "..." },
//     "currentStarSystem": "Sol",
//     "balance": 123, "fuel": 500,
//     "itinerary": { "currentJump": "...", "completed": [ ... ] },
//     "market": { "commodities": [ ... ] } }
//
// Прежний парсер читал `carrierName`, `carrierId`, `currentSystem`,
// `services` как массив — таких полей там нет, поэтому карточка авианосца
// заполнялась пустыми строками и нулями.

import type { CapiFleetCarrier, CapiFleetCarrierItinerary } from '@/types/capi';

/** Имя авианосца Frontier отдаёт hex-строкой UTF-8. */
export function decodeVanityName(value: unknown): string {
  const hex = String(value ?? '').trim();
  if (!hex || !/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) return hex;
  try {
    return Buffer.from(hex, 'hex').toString('utf8');
  } catch {
    return hex;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseFleetCarrier(data: Record<string, unknown>): CapiFleetCarrier {
  const name = isRecord(data.name) ? data.name : {};
  const itinerary = isRecord(data.itinerary) ? data.itinerary : {};
  const completed = Array.isArray(itinerary.completed) ? itinerary.completed : [];

  // `services` приходит словарём «услуга → статус» (ok/unavailable/private).
  const servicesSource = isRecord(data.services)
    ? data.services
    : isRecord((data.market as Record<string, unknown> | undefined)?.services)
      ? ((data.market as Record<string, unknown>).services as Record<string, unknown>)
      : {};

  return {
    carrierName: decodeVanityName(name.filteredVanityName ?? name.vanityName),
    carrierId: String(data.market && isRecord(data.market) ? data.market.id ?? '' : ''),
    callsign: String(name.callsign ?? data.callsign ?? ''),
    currentSystem: String(data.currentStarSystem ?? data.currentSystem ?? ''),
    currentBody: String(data.currentBody ?? ''),
    balance: Number(isRecord(data.finance) ? data.finance.bankBalance : data.balance) || 0,
    fuel: Number(data.fuel) || 0,
    services: Object.entries(servicesSource).map(([service, status]) => ({
      name: service,
      enabled: status === 'ok',
    })),
    market: isRecord(data.market) ? (data.market as CapiFleetCarrier['market']) : undefined,
    itinerary: completed
      .filter(isRecord)
      .map((jump): CapiFleetCarrierItinerary => ({
        system: String(jump.starsystem ?? ''),
        body: String(jump.body ?? ''),
        arrival: String(jump.arrivalTime ?? ''),
        departure: jump.departureTime ? String(jump.departureTime) : undefined,
      })),
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
