// ═══════════════════════════════════════════════════════════════
// Elite Dangerous Player Journal Event Types
// ═══════════════════════════════════════════════════════════════

export interface JournalResourceRequired {
  Name: string;
  Name_Localised?: string;
  RequiredAmount: number;
  ProvidedAmount: number;
  Payment: number;
}

export interface ColonisationConstructionDepotEvent {
  event: 'ColonisationConstructionDepot';
  timestamp: string;
  StarSystem: string;
  MarketID: number;
  ConstructionName: string;
  ConstructionID: number;
  ConstructionProgress: number;
  ConstructionComplete: boolean;
  ResourcesRequired: JournalResourceRequired[];
}

export interface ColonisationContributionEvent {
  event: 'ColonisationContribution';
  timestamp: string;
  StarSystem: string;
  MarketID: number;
  Contribution: {
    Commodity: string;
    Commodity_Localised?: string;
    Amount: number;
    Total: number;
  };
}

export interface FSDJumpEvent {
  event: 'FSDJump';
  timestamp: string;
  StarSystem: string;
  SystemAddress: number;
  StarPos: [number, number, number];
}

export interface LocationEvent {
  event: 'Location';
  timestamp: string;
  StarSystem: string;
  SystemAddress: number;
  StarPos?: [number, number, number];
}

export interface DockedEvent {
  event: 'Docked';
  timestamp: string;
  StarSystem: string;
  StationName: string;
  MarketID?: number;
}

export interface CommanderEvent {
  event: 'Commander';
  timestamp: string;
  Name: string;
}

export interface LoadGameEvent {
  event: 'LoadGame';
  timestamp: string;
  Commander: string;
}

export type ColonisationJournalEvent =
  | ColonisationConstructionDepotEvent
  | ColonisationContributionEvent
  | FSDJumpEvent
  | LocationEvent
  | DockedEvent
  | CommanderEvent
  | LoadGameEvent;

// ─── Parsed result for colonisation events ───
export interface ParsedColonisationDepot {
  timestamp: string;
  systemName: string;
  marketId: number;
  constructionName: string;
  constructionId: number;
  constructionProgress: number;
  constructionComplete: boolean;
  resourcesRequired: {
    name: string;
    nameLocalised: string;
    requiredAmount: number;
    providedAmount: number;
    payment: number;
  }[];
}

export interface ParsedColonisationContribution {
  timestamp: string;
  systemName: string;
  marketId: number;
  commodity: string;
  commodityLocalised: string;
  amount: number;
  total: number;
}

export interface ColonisationParseResult {
  cmdrName: string | null;
  depotEvents: ParsedColonisationDepot[];
  contributionEvents: ParsedColonisationContribution[];
  stats: {
    eventsParsed: number;
    depotEventsFound: number;
    contributionEventsFound: number;
    fsdJumps: number;
  };
}
