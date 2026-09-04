// ═══════════════════════════════════════════════════════════════
// Inara API Types
// ═══════════════════════════════════════════════════════════════

export interface InaraApiHeader {
  appName: string;
  appVersion: string;
  APIkey: string;
  isDeveloped: boolean;
}

export interface InaraApiEvent {
  eventName: string;
  eventTimestamp: string;
  eventData: Record<string, unknown>;
}

export interface InaraApiRequest {
  header: InaraApiHeader;
  events: InaraApiEvent[];
}

export interface InaraApiResponseEvent {
  eventStatus: number;
  eventStatusText?: string;
  eventData?: Record<string, unknown>;
}

export interface InaraApiResponse {
  header: {
    eventStatus: number;
    eventStatusText?: string;
  };
  events: InaraApiResponseEvent[];
}

export interface InaraCommanderProfile {
  userID: number;
  userName: string;
  commanderId: number;
  commanderName: string;
  preferredAllegianceName?: string;
  preferredPowerName?: string;
  squadronName?: string;
  squadronId?: number;
  squadronMemberRank?: string;
  avatarImageURL?: string;
}

export interface InaraRank {
  rankName: string;
  rankValue: number;
  rankProgress: number;
}

export interface InaraCommunityGoal {
  cgID: number;
  cgName: string;
  starsystemName: string;
  stationName: string;
  objective: string;
  reward: string;
  tierReached: number;
  tierMax: number;
  contributors: number;
  contributionsTotal: number;
  expiryDate: string;
  isCompleted: boolean;
}
