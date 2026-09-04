// ═══════════════════════════════════════════════════════════════
// EDDN (Elite Dangerous Data Network) Types
// ═══════════════════════════════════════════════════════════════

export interface EddnHeader {
  gatewayTimestamp: string;
  softwareName: string;
  softwareVersion: string;
  uploaderID: string;
}

export interface EddnCommodity {
  name: string;
  meanPrice: number;
  buyPrice: number;
  stock: number;
  stockBracket: number;
  sellPrice: number;
  demand: number;
  demandBracket: number;
  statusFlags?: string[];
}

export interface EddnCommodityMessage {
  $schemaRef: string;
  header: EddnHeader;
  message: {
    systemName: string;
    stationName: string;
    marketId: number;
    commodities: EddnCommodity[];
    timestamp: string;
    horizons?: boolean;
    odyssey?: boolean;
  };
}

export interface EddnJournalMessage {
  $schemaRef: string;
  header: EddnHeader;
  message: Record<string, unknown>;
}

export interface EddnFleetCarrierMessage {
  $schemaRef: string;
  header: EddnHeader;
  message: {
    carrierName: string;
    carrierId: string;
    systemName: string;
    timestamp: string;
    commodities?: EddnCommodity[];
  };
}
