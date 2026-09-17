// ═══════════════════════════════════════════════════════════════
// Frontier CAPI HTTP Client
// ═══════════════════════════════════════════════════════════════

import type {
  CapiProfile,
  CapiMarket,
  CapiFleetCarrier,
  CapiCommunityGoalsResponse,
} from '@/types/capi';

const CAPI_BASE = 'https://companion.orerve.net';

export class CapiClient {
  constructor(private accessToken: string) {}

  private async fetchJson(endpoint: string): Promise<unknown> {
    const res = await fetch(`${CAPI_BASE}${endpoint}`, {
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        Accept: 'application/json',
      },
    });

    // Frontier отвечает 422 на просроченный access-токен (он живёт ~4 часа),
    // а 401/403 — на отозванный доступ. Оба случая для нас «нужен refresh».
    if (res.status === 401 || res.status === 403 || res.status === 422) {
      throw new Error('UNAUTHORIZED');
    }
    if (!res.ok) {
      throw new Error(`CAPI ${endpoint}: ${res.status}`);
    }

    return res.json();
  }

  async getProfile(): Promise<CapiProfile> {
    return this.fetchJson('/profile') as Promise<CapiProfile>;
  }

  async getJournal(date?: string): Promise<{ events: Record<string, unknown>[] }> {
    const q = date ? `?date=${encodeURIComponent(date)}` : '';
    return this.fetchJson(`/journal${q}`) as Promise<{ events: Record<string, unknown>[] }>;
  }

  async getMarket(): Promise<CapiMarket> {
    return this.fetchJson('/market') as Promise<CapiMarket>;
  }

  async getFleetCarrier(): Promise<CapiFleetCarrier | null> {
    try {
      return (await this.fetchJson('/fleetcarrier')) as CapiFleetCarrier;
    } catch {
      return null;
    }
  }

  async getCommunityGoals(): Promise<CapiCommunityGoalsResponse> {
    return this.fetchJson('/communitygoals') as Promise<CapiCommunityGoalsResponse>;
  }

  async getVisitedStars(): Promise<Blob> {
    const res = await fetch(`${CAPI_BASE}/visitedstars`, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });
    if (!res.ok) throw new Error(`CAPI /visitedstars: ${res.status}`);
    return res.blob();
  }
}
