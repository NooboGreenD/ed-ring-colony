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
    eventData: Record<string, unknown>
  ): Promise<InaraApiResponse> {
    const req: InaraApiRequest = {
      header: {
        appName: 'ED Ring Colony',
        appVersion: '1.0',
        APIkey: this.apiKey,
        isDeveloped: true,
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
    const res = await this.call('getCommunityGoals', {});
    return ((res.events[0]?.eventData as unknown) as InaraCommunityGoal[]) || [];
  }
}
