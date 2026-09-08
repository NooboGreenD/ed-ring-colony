// ═══════════════════════════════════════════════════════════════
// Frontier CAPI Types
// ═══════════════════════════════════════════════════════════════

export interface CapiCommander {
  name: string;
}

export interface CapiRanks {
  combat: number;
  trade: number;
  explore: number;
  empire: number;
  federation: number;
  cqc?: number;
}

export interface CapiShip {
  shipId: number;
  shipType: string;
  shipName?: string;
  shipIdent?: string;
  value?: { hull: number; modules: number; cargo: number; total: number };
  modules?: Record<string, unknown>;
}

export interface CapiCurrentSystem {
  name: string;
  systemAddress: number;
  starPos?: [number, number, number];
}

export interface CapiCurrentStation {
  name: string;
  id?: number;
}

export interface CapiProfile {
  commander: CapiCommander;
  credits: number;
  loan?: number;
  ranks: CapiRanks;
  currentShip: string;
  currentSystem: CapiCurrentSystem;
  currentStation?: CapiCurrentStation;
  ships: CapiShip[];
}

export interface CapiTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

export interface CapiJournalEntry {
  event: string;
  timestamp: string;
  [key: string]: unknown;
}

export interface CapiMarketCommodity {
  id: number;
  name: string;
  category: string;
  buyPrice: number;
  sellPrice: number;
  meanPrice: number;
  stock: number;
  stockBracket: number;
  demand: number;
  demandBracket: number;
}

export interface CapiMarket {
  id: number;
  name: string;
  type: string;
  commodities: CapiMarketCommodity[];
}

export interface CapiFleetCarrierService {
  name: string;
  enabled: boolean;
  crew?: { name: string; faction: string };
}

export interface CapiFleetCarrierItinerary {
  system: string;
  body: string;
  arrival: string;
  departure?: string;
}

export interface CapiFleetCarrier {
  carrierName: string;
  carrierId: string;
  callsign: string;
  currentSystem: string;
  currentBody: string;
  balance: number;
  fuel: number;
  services: CapiFleetCarrierService[];
  market?: { commodities: { name: string; stock: number; buyPrice: number; sellPrice: number }[] };
  itinerary?: CapiFleetCarrierItinerary[];
}

export interface CapiCommunityGoalReward {
  type: string;
  amount: number;
}

export interface CapiCommunityGoal {
  cg_id: number;
  title: string;
  description: string;
  system_name: string;
  station_name: string;
  objective: string;
  reward: string;
  rewards?: CapiCommunityGoalReward[];
  tier_current: number;
  tier_max: number;
  contributors: number;
  contributions_total: number;
  expiry_date: string;
  is_complete: boolean;
}

export interface CapiCommunityGoalsResponse {
  goals: CapiCommunityGoal[];
}
