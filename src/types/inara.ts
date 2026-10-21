// ═══════════════════════════════════════════════════════════════
// Inara API Types
// ═══════════════════════════════════════════════════════════════

export interface InaraApiHeader {
  appName: string;
  appVersion: string;
  APIkey: string;
  isBeingDeveloped: boolean;
}

export interface InaraApiEvent {
  eventName: string;
  eventTimestamp: string;
  eventData: Record<string, unknown> | unknown[];
}

export interface InaraApiRequest {
  header: InaraApiHeader;
  events: InaraApiEvent[];
}

export interface InaraApiResponseEvent {
  eventStatus: number;
  eventStatusText?: string;
  eventData?: Record<string, unknown> | unknown[];
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
  [key: string]: unknown;
  communitygoalGameID?: number;
  communitygoalName: string;
  starsystemName?: string;
  stationName?: string;
  goalExpiry?: string;
  tierReached?: number | string;
  tierMax?: number | string;
  contributorsNum?: number;
  contributionsTotal?: number;
  isCompleted?: boolean;
  lastUpdate?: string;
  goalObjectiveText?: string;
  goalRewardText?: string;
  goalDescriptionText?: string;
  inaraURL?: string;

  /** Legacy field aliases tolerated for previously documented payloads. */
  cgID?: number;
  cgName?: string;
  objective?: string;
  reward?: string;
  contributors?: number;
  expiryDate?: string;
}
