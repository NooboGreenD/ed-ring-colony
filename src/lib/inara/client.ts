// ═══════════════════════════════════════════════════════════════
// Inara API Client
// ═══════════════════════════════════════════════════════════════

import type {
  InaraApiRequest,
  InaraApiResponse,
  InaraCommanderProfile,
  InaraCommunityGoal,
} from '@/types/inara';

const INARA_API = 'https://inara.cz/inapi/v1/';

export class InaraClient {
  constructor(private apiKey: string) {}

  async call(
    eventName: string,
    eventData: Record<string, unknown> | unknown[]
  ): Promise<InaraApiResponse> {
    const req: InaraApiRequest = {
      header: {
        appName: 'ED Ring Colony',
        appVersion: '1.0',
        APIkey: this.apiKey,
        isBeingDeveloped: false,
      },
      events: [
        {
          eventName,
          eventTimestamp: new Date().toISOString(),
          eventData,
        },
      ],
    };

    const res = await fetch(INARA_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });

    if (!res.ok) throw new Error(`Inara API error: ${res.status}`);
    return res.json();
  }

  async getCommanderProfile(
    cmdrName: string
  ): Promise<InaraCommanderProfile | null> {
    const res = await this.call('getCommanderProfile', {
      searchName: cmdrName,
    });
    const data = res.events[0]?.eventData as
      | InaraCommanderProfile
      | undefined;
    return data || null;
  }

  async getCommunityGoals(): Promise<InaraCommunityGoal[]> {
    const res = await this.call('getCommunityGoalsRecent', []);
    const event = res.events[0];
    if (!event) throw new Error('Inara Community Goals API returned no event result');
    if (event.eventStatus === 204) return [];
    if (event.eventStatus !== 200 && event.eventStatus !== 202) {
      throw new Error(`Inara Community Goals API error: ${event.eventStatusText || event.eventStatus}`);
    }

    if (!Array.isArray(event.eventData)) return [];
    return event.eventData as InaraCommunityGoal[];
  }
}
