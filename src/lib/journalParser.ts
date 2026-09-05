export interface Delivery {
  systemName: string;
  commodity: string;
  amount: number;
  timestamp: string;
  isHub?: boolean;
  routeSystemId?: number | null;
}

export interface ParseResult {
  cmdrName: string | null;
  deliveries: Delivery[];
  stats: {
    eventsParsed: number;
    cargoEvents: number;
    deliveriesFound: number;
    skippedNoSystem: number;
    skippedMarketTrade: number;
    skippedMining: number;
    skippedEject: number;
  };
}

export interface SystemLookup {
  hubs: Set<string>;               // lowercase system names that are hubs
  routeSystems: Map<string, number>; // lowercase system name -> route_systems.id
}

/**
 * Parse Elite Dangerous journal log for Colony construction deliveries.
 *
 * Logic: track inventory changes via Cargo events. A decrease in a commodity
 * between two consecutive Cargo events in the same system is treated as a delivery.
 * We skip changes caused by market trades, mining, ejecting cargo, etc.
 *
 * When lookup is provided, we also tag deliveries with isHub and routeSystemId
 * so the backend can correctly attribute them to hubs and route systems.
 */
export function parseJournal(text: string, lookup?: SystemLookup): ParseResult {
  let cmdrName: string | null = null;
  let currentSystem: string | null = null;
  let lastCargo: Record<string, { count: number; display: string }> | null = null;
  const deliveries: Delivery[] = [];
  let skipNextCargo = false;
  const stats = {
    eventsParsed: 0,
    cargoEvents: 0,
    deliveriesFound: 0,
    skippedNoSystem: 0,
    skippedMarketTrade: 0,
    skippedMining: 0,
    skippedEject: 0,
  };

  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t[0] !== '{') continue;
    let ev: any;
    try {
      ev = JSON.parse(t);
    } catch {
      continue;
    }
    stats.eventsParsed++;
    switch (ev.event) {
      case 'Commander':
        if (ev.Name) cmdrName = ev.Name;
        break;
      case 'LoadGame':
        if (!cmdrName && ev.Commander) cmdrName = ev.Commander;
        break;
      case 'Location':
      case 'FSDJump':
      case 'Docked':
      case 'CarrierJump':
        if (ev.StarSystem) currentSystem = ev.StarSystem;
        break;
      // Skip cargo changes caused by non-delivery events
      case 'MarketBuy':
      case 'MarketSell':
      case 'BuyDrones':
      case 'SellDrones':
        skipNextCargo = true;
        stats.skippedMarketTrade++;
        break;
      case 'MiningRefined':
        skipNextCargo = true;
        stats.skippedMining++;
        break;
      case 'EjectCargo':
      case 'CollectCargo':
        skipNextCargo = true;
        stats.skippedEject++;
        break;
      case 'Cargo': {
        stats.cargoEvents++;
        if (skipNextCargo) {
          skipNextCargo = false;
          // Rebuild lastCargo from this event so next comparison is accurate
          const inv: Record<string, { count: number; display: string }> = {};
          if (Array.isArray(ev.Inventory)) {
            for (const it of ev.Inventory) {
              const key = String(it.Name || '').toLowerCase();
              if (key && it.Count > 0) {
                inv[key] = {
                  count: it.Count,
                  display: String(it.Name_Localised || it.Name || key),
                };
              }
            }
          }
          lastCargo = inv;
          break;
        }
        const inv: Record<string, { count: number; display: string }> = {};
        if (Array.isArray(ev.Inventory)) {
          for (const it of ev.Inventory) {
            const key = String(it.Name || '').toLowerCase();
            if (key && it.Count > 0) {
              inv[key] = {
                count: it.Count,
                display: String(it.Name_Localised || it.Name || key),
              };
            }
          }
        }
        if (lastCargo && currentSystem) {
          for (const [key, prev] of Object.entries(lastCargo)) {
            const now = inv[key];
            const nowCount = now?.count ?? 0;
            if (nowCount < prev.count) {
              const systemKey = currentSystem.toLowerCase();
              const delivery: Delivery = {
                systemName: currentSystem,
                commodity: prev.display,
                amount: prev.count - nowCount,
                timestamp: ev.timestamp,
              };
              if (lookup) {
                delivery.isHub = lookup.hubs.has(systemKey);
                delivery.routeSystemId = lookup.routeSystems.get(systemKey) ?? null;
              }
              deliveries.push(delivery);
              stats.deliveriesFound++;
            }
          }
        } else if (lastCargo && !currentSystem) {
          // We have cargo delta but no known system — skip
          stats.skippedNoSystem++;
        }
        lastCargo = inv;
        break;
      }
    }
  }
  return { cmdrName, deliveries, stats };
}

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

/**
 * Parse Elite Dangerous journal for colonisation events.
 * Extracts ColonisationConstructionDepot and ColonisationContribution events.
 */
export function parseColonisationEvents(text: string): {
  cmdrName: string | null;
  depotEvents: {
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
  }[];
  contributionEvents: {
    timestamp: string;
    systemName: string;
    marketId: number;
    commodity: string;
    commodityLocalised: string;
    amount: number;
    total: number;
  }[];
  stats: {
    eventsParsed: number;
    depotEventsFound: number;
    contributionEventsFound: number;
    fsdJumps: number;
  };
} {
  let cmdrName: string | null = null;
  let currentSystem: string | null = null;
  const depotEvents: ReturnType<typeof parseColonisationEvents>['depotEvents'] = [];
  const contributionEvents: ReturnType<typeof parseColonisationEvents>['contributionEvents'] = [];
  const stats = {
    eventsParsed: 0,
    depotEventsFound: 0,
    contributionEventsFound: 0,
    fsdJumps: 0,
  };

  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t[0] !== '{') continue;
    let ev: any;
    try {
      ev = JSON.parse(t);
    } catch {
      continue;
    }
    stats.eventsParsed++;

    switch (ev.event) {
      case 'Commander':
        if (ev.Name) cmdrName = ev.Name;
        break;
      case 'LoadGame':
        if (!cmdrName && ev.Commander) cmdrName = ev.Commander;
        break;
      case 'Location':
      case 'Docked':
      case 'CarrierJump':
        if (ev.StarSystem) currentSystem = ev.StarSystem;
        break;
      case 'FSDJump':
        if (ev.StarSystem) currentSystem = ev.StarSystem;
        stats.fsdJumps++;
        break;
      case 'ColonisationConstructionDepot': {
        const resources = Array.isArray(ev.ResourcesRequired)
          ? ev.ResourcesRequired.map((r: any) => ({
              name: String(r.Name || ''),
              nameLocalised: String(r.Name_Localised || r.Name || ''),
              requiredAmount: Number(r.RequiredAmount) || 0,
              providedAmount: Number(r.ProvidedAmount) || 0,
              payment: Number(r.Payment) || 0,
            }))
          : [];
        depotEvents.push({
          timestamp: ev.timestamp,
          systemName: String(ev.StarSystem || currentSystem || ''),
          marketId: Number(ev.MarketID) || 0,
          constructionName: String(ev.ConstructionName || ''),
          constructionId: Number(ev.ConstructionID) || 0,
          constructionProgress: Number(ev.ConstructionProgress) || 0,
          constructionComplete: Boolean(ev.ConstructionComplete),
          resourcesRequired: resources,
        });
        stats.depotEventsFound++;
        break;
      }
      case 'ColonisationContribution': {
        const c = ev.Contribution || {};
        contributionEvents.push({
          timestamp: ev.timestamp,
          systemName: String(ev.StarSystem || currentSystem || ''),
          marketId: Number(ev.MarketID) || 0,
          commodity: String(c.Commodity || ''),
          commodityLocalised: String(c.Commodity_Localised || c.Commodity || ''),
          amount: Number(c.Amount) || 0,
          total: Number(c.Total) || 0,
        });
        stats.contributionEventsFound++;
        break;
      }
    }
  }

  return { cmdrName, depotEvents, contributionEvents, stats };
}
