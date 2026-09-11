export type DeliverySource =
  | 'colonisation_contribution'
  | 'cargo_depot'
  | 'cargo_delta';

export interface Delivery {
  systemName: string;
  commodity: string;
  amount: number;
  timestamp: string;
  /** Kept as text so 64-bit Elite IDs never pass through a JS Number. */
  marketId?: string | null;
  systemAddress?: string | null;
  source: DeliverySource;
  /** Stable per-journal-event identifier used to make leaderboard imports idempotent. */
  sourceHash: string;
  isHub?: boolean;
  routeSystemId?: number | null;
}

export interface JournalParseStats {
  eventsParsed: number;
  cargoEvents: number;
  deliveriesFound: number;
  /** Direct, authoritative ColonisationContribution entries. */
  colonisationDeliveries: number;
  /** Direct CargoDepot deliveries, e.g. wing cargo missions. */
  cargoDepotDeliveries: number;
  /** Inventory-diff fallback when the journal has no explicit delivery event. */
  cargoDeltaDeliveries: number;
  skippedNoSystem: number;
  skippedMarketTrade: number;
  skippedMining: number;
  skippedEject: number;
  skippedDuplicates: number;
}

export interface ParseResult {
  cmdrName: string | null;
  deliveries: Delivery[];
  stats: JournalParseStats;
  state: JournalParseState;
}

export interface SystemLookup {
  hubs: Set<string>; // lowercase normalized system names that are hubs
  routeSystems: Map<string, number>; // lowercase normalized system name -> route_systems.id
}

type CargoItem = { count: number; display: string };
type CargoInventory = Record<string, CargoItem>;

/**
 * Stateful context for consecutive Journal.*.log files. Journal inventory
 * snapshots and ColonisationContribution counters can span a file boundary,
 * so each selected file must not start from an empty state.
 */
export interface JournalParseState {
  cmdrName: string | null;
  currentSystem: string | null;
  currentSystemAddress: string | null;
  lastCargo: CargoInventory | null;
  contributionTotals: Map<string, number>;
  /** Commodity keys reported explicitly before the next Cargo snapshot. */
  accountedCargoKeys: Set<string>;
  /** A market/trade event changed cargo; don't mistake its next snapshot for delivery. */
  skipNextCargo: boolean;
  /** Delivery fingerprints across all selected files, not every raw journal event. */
  seenDeliveryHashes: Set<string>;
  sequence: number;
}

export function createJournalParseState(): JournalParseState {
  return {
    cmdrName: null,
    currentSystem: null,
    currentSystemAddress: null,
    lastCargo: null,
    contributionTotals: new Map(),
    accountedCargoKeys: new Set(),
    skipNextCargo: false,
    seenDeliveryHashes: new Set(),
    sequence: 0,
  };
}

function systemKey(value: unknown): string {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function commodityKey(value: unknown): string {
  const raw = String(value ?? '').trim();
  return raw
    .replace(/^\$+/, '')
    .replace(/_name;?$/i, '')
    .replace(/[\s_-]+/g, '')
    .toLowerCase();
}

function displayCommodity(value: unknown, fallback: string): string {
  const result = String(value ?? '').trim();
  if (result) return result;
  const readable = fallback
    .replace(/^\$+/, '')
    .replace(/_name;?$/i, '')
    .replace(/[_-]+/g, ' ')
    .trim();
  return readable ? readable.replace(/^./, (character) => character.toUpperCase()) : 'Unknown commodity';
}

function finitePositive(value: unknown): number | null {
  const number = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : NaN;
  if (!Number.isFinite(number) || number <= 0) return null;
  return number;
}

function finiteNonNegative(value: unknown): number {
  const number = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : NaN;
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

/** Extract an integer token before JSON.parse can round a 64-bit value. */
function rawJournalInteger(line: string, field: string): string | null {
  // Field names are fixed, trusted Journal keys. Looking up the literal key
  // avoids constructing an escaping-sensitive regular expression while still
  // preserving the exact integer token from the original JSON line.
  const marker = `"${field}"`;
  const start = line.indexOf(marker);
  if (start < 0) return null;
  const remainder = line.slice(start + marker.length);
  const match = remainder.match(/^\s*:\s*(?:"(-?\d+)"|(-?\d+))/);
  const value = match?.[1] ?? match?.[2];
  return value && /^-?\d+$/.test(value) ? value : null;
}

function journalId(value: unknown, rawValue: string | null): string | null {
  if (rawValue != null) return rawValue;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(Math.trunc(value));
  return null;
}

/** Fast deterministic browser-safe hash (two 32-bit FNV-style lanes). */
function fingerprint(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(36)}${(second >>> 0).toString(36)}`;
}

function buildInventory(inventory: unknown): CargoInventory | null {
  if (!Array.isArray(inventory)) return null;

  const result: CargoInventory = {};
  for (const item of inventory) {
    if (!item || typeof item !== 'object') continue;
    const rawName = (item as Record<string, unknown>).Name;
    const key = commodityKey(rawName);
    const count = finitePositive((item as Record<string, unknown>).Count);
    if (!key || count == null) continue;
    result[key] = {
      count,
      display: displayCommodity((item as Record<string, unknown>).Name_Localised, String(rawName ?? key)),
    };
  }
  return result;
}

const CARGO_RESET_EVENTS = new Set([
  'MarketBuy',
  'MarketSell',
  'BuyDrones',
  'SellDrones',
  'MiningRefined',
  'EjectCargo',
  'CollectCargo',
  'CollectItems',
  'MissionCompleted',
  'MissionFailed',
  'MissionAbandoned',
  'Died',
  'Interdicted',
  'Interdiction',
  'CommunityGoal',
  'CommunityGoalReward',
  'TransferMicroResources',
  'TransferCargo',
  'CargoTransfer',
  'CarrierDepositFuel',
  'CarrierJumpRequest',
  'CarrierTradeOrder',
  'PowerplayCollect',
  'PowerplayDeliver',
  'PowerplayFastTrack',
  'LaunchSRV',
  'DockSRV',
  'ShipyardTransfer',
  'ShipyardSwap',
]);

function updateLocation(state: JournalParseState, event: Record<string, unknown>, rawLine: string) {
  const starSystem = typeof event.StarSystem === 'string' ? event.StarSystem.trim() : '';
  const address = journalId(event.SystemAddress, rawJournalInteger(rawLine, 'SystemAddress'));
  if (starSystem) {
    const changedSystem = systemKey(state.currentSystem) !== systemKey(starSystem);
    state.currentSystem = starSystem;
    // Avoid attributing an address from the preceding system when a compact
    // Journal event names a new system but has no SystemAddress field.
    if (changedSystem) {
      if (!address) state.currentSystemAddress = null;
      // Cargo snapshots belong to a location. Do not compare an arrival
      // snapshot with one from the previous system: a delivery just before a
      // jump may not have emitted its own post-delivery Cargo event.
      state.lastCargo = null;
      // Direct delivery events only suppress the following inventory snapshot
      // at that depot, never a later Cargo snapshot after a hyperspace jump.
      state.accountedCargoKeys.clear();
    }
  }
  if (address) state.currentSystemAddress = address;
}

function tagDelivery(delivery: Delivery, lookup?: SystemLookup): Delivery {
  if (!lookup) return delivery;
  const key = systemKey(delivery.systemName);
  return {
    ...delivery,
    isHub: lookup.hubs.has(key),
    routeSystemId: lookup.routeSystems.get(key) ?? null,
  };
}

function emitDelivery(
  deliveries: Delivery[],
  state: JournalParseState,
  stats: JournalParseStats,
  delivery: Delivery,
  lookup?: SystemLookup,
) {
  if (!delivery.systemName || !delivery.commodity || !Number.isFinite(delivery.amount) || delivery.amount <= 0) return;

  if (state.seenDeliveryHashes.has(delivery.sourceHash)) {
    stats.skippedDuplicates += 1;
    return;
  }
  state.seenDeliveryHashes.add(delivery.sourceHash);
  deliveries.push(tagDelivery(delivery, lookup));
  stats.deliveriesFound += 1;

  if (delivery.source === 'colonisation_contribution') stats.colonisationDeliveries += 1;
  else if (delivery.source === 'cargo_depot') stats.cargoDepotDeliveries += 1;
  else stats.cargoDeltaDeliveries += 1;
}

type Contribution = { key: string; display: string; amount: number };

function colonisationContributions(event: Record<string, unknown>): Contribution[] {
  const rawContributions = Array.isArray(event.Contributions)
    ? event.Contributions
    : event.Contribution && typeof event.Contribution === 'object'
      ? [event.Contribution]
      : [];

  const values: Contribution[] = [];
  for (const rawContribution of rawContributions) {
    if (!rawContribution || typeof rawContribution !== 'object') continue;
    const contribution = rawContribution as Record<string, unknown>;
    const rawName = contribution.Name ?? contribution.Commodity;
    const key = commodityKey(rawName);
    const amount = finitePositive(contribution.Amount);
    if (!key || amount == null) continue;
    values.push({
      key,
      display: displayCommodity(contribution.Name_Localised ?? contribution.Commodity_Localised, String(rawName)),
      amount,
    });
  }
  return values;
}

/**
 * Parse one journal text buffer. Pass the `state` returned from the preceding
 * file to preserve inventory and contribution context across a large upload.
 */
export function parseJournal(text: string, lookup?: SystemLookup, state: JournalParseState = createJournalParseState()): ParseResult {
  const deliveries: Delivery[] = [];
  const stats: JournalParseStats = {
    eventsParsed: 0,
    cargoEvents: 0,
    deliveriesFound: 0,
    colonisationDeliveries: 0,
    cargoDepotDeliveries: 0,
    cargoDeltaDeliveries: 0,
    skippedNoSystem: 0,
    skippedMarketTrade: 0,
    skippedMining: 0,
    skippedEject: 0,
    skippedDuplicates: 0,
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line[0] !== '{') continue;

    let event: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      event = parsed as Record<string, unknown>;
    } catch {
      continue;
    }

    state.sequence += 1;
    stats.eventsParsed += 1;
    const eventName = typeof event.event === 'string' ? event.event : 'Unknown';

    if (eventName === 'Commander' && typeof event.Name === 'string' && event.Name.trim()) {
      state.cmdrName = event.Name.trim();
      continue;
    }
    if (eventName === 'LoadGame') {
      if (!state.cmdrName && typeof event.Commander === 'string' && event.Commander.trim()) {
        state.cmdrName = event.Commander.trim();
      }
      updateLocation(state, event, line);
      continue;
    }

    if (eventName === 'Location' || eventName === 'FSDJump' || eventName === 'Docked' || eventName === 'CarrierJump') {
      updateLocation(state, event, line);
      continue;
    }

    // Some generated/relayed Journal records include StarSystem directly on a
    // contribution or depot event. Accept that stronger location evidence too.
    if (typeof event.StarSystem === 'string' || event.SystemAddress != null) {
      updateLocation(state, event, line);
    }

    if (CARGO_RESET_EVENTS.has(eventName)) {
      state.skipNextCargo = true;
      if (eventName === 'MarketBuy' || eventName === 'MarketSell' || eventName === 'BuyDrones' || eventName === 'SellDrones') {
        stats.skippedMarketTrade += 1;
      } else if (eventName === 'MiningRefined') {
        stats.skippedMining += 1;
      } else if (eventName === 'EjectCargo' || eventName === 'CollectCargo' || eventName === 'CollectItems') {
        stats.skippedEject += 1;
      }
      continue;
    }

    const systemName = typeof event.StarSystem === 'string' && event.StarSystem.trim()
      ? event.StarSystem.trim()
      : state.currentSystem;
    if (systemName && typeof event.StarSystem === 'string') state.currentSystem = systemName;
    const timestamp = typeof event.timestamp === 'string' && event.timestamp ? event.timestamp : `sequence:${state.sequence}`;

    if (eventName === 'ColonisationContribution') {
      const marketId = journalId(event.MarketID, rawJournalInteger(line, 'MarketID'));
      const contributions = colonisationContributions(event);
      if (!systemName) {
        if (contributions.length > 0) stats.skippedNoSystem += contributions.length;
        continue;
      }

      for (const contribution of contributions) {
        // In this journal event Amount is cumulative per depot/commodity. A
        // lower amount means a new construction context, so it becomes a new
        // baseline rather than producing a negative delivery.
        const contributionKey = `${marketId ?? `system:${systemKey(systemName)}`}:${contribution.key}`;
        const previous = state.contributionTotals.get(contributionKey);
        const amount = previous == null
          ? contribution.amount
          : contribution.amount >= previous
            ? contribution.amount - previous
            : contribution.amount;
        state.contributionTotals.set(contributionKey, contribution.amount);
        state.accountedCargoKeys.add(contribution.key);

        if (amount <= 0) continue;
        emitDelivery(deliveries, state, stats, {
          systemName,
          commodity: contribution.display,
          amount,
          timestamp,
          marketId,
          systemAddress: state.currentSystemAddress,
          source: 'colonisation_contribution',
          sourceHash: `journal-v2-${fingerprint(`contribution\u0000${line}\u0000${contribution.key}\u0000${amount}`)}`,
        }, lookup);
      }
      continue;
    }

    if (eventName === 'CargoDepot') {
      const updateType = typeof event.UpdateType === 'string' ? event.UpdateType.toLowerCase() : '';
      const amount = finitePositive(event.Count);
      const rawCommodity = event.CargoType ?? '';
      const key = commodityKey(rawCommodity);
      if (updateType !== 'deliver' || amount == null || !key) continue;
      if (!systemName) {
        stats.skippedNoSystem += 1;
        continue;
      }

      state.accountedCargoKeys.add(key);
      emitDelivery(deliveries, state, stats, {
        systemName,
        commodity: displayCommodity(event.CargoType_Localised, String(rawCommodity)),
        amount,
        timestamp,
        systemAddress: state.currentSystemAddress,
        source: 'cargo_depot',
        sourceHash: `journal-v2-${fingerprint(`cargo-depot\u0000${line}\u0000${key}\u0000${amount}`)}`,
      }, lookup);
      continue;
    }

    if (eventName !== 'Cargo') continue;

    stats.cargoEvents += 1;
    const inventory = buildInventory(event.Inventory);
    if (!inventory) {
      state.skipNextCargo = false;
      state.accountedCargoKeys.clear();
      continue;
    }

    if (state.skipNextCargo) {
      state.skipNextCargo = false;
      state.accountedCargoKeys.clear();
      state.lastCargo = inventory;
      continue;
    }

    if (!state.lastCargo) {
      state.lastCargo = inventory;
      state.accountedCargoKeys.clear();
      continue;
    }

    if (!systemName) {
      stats.skippedNoSystem += 1;
      state.lastCargo = inventory;
      state.accountedCargoKeys.clear();
      continue;
    }

    for (const [key, previous] of Object.entries(state.lastCargo)) {
      const current = inventory[key];
      const currentCount = current?.count ?? 0;
      const amount = previous.count - currentCount;
      if (amount <= 0) continue;

      // Direct ColonisationContribution/CargoDepot events are more reliable.
      // Their accompanying Cargo snapshot must not create a second trip.
      if (state.accountedCargoKeys.has(key)) continue;

      emitDelivery(deliveries, state, stats, {
        systemName,
        commodity: previous.display,
        amount,
        timestamp,
        systemAddress: state.currentSystemAddress,
        source: 'cargo_delta',
        sourceHash: `journal-v2-${fingerprint(`cargo-delta\u0000${line}\u0000${key}\u0000${previous.count}\u0000${currentCount}`)}`,
      }, lookup);
    }

    state.lastCargo = inventory;
    state.accountedCargoKeys.clear();
  }

  return { cmdrName: state.cmdrName, deliveries, stats, state };
}

export interface ParsedColonisationDepot {
  timestamp: string;
  systemName: string;
  marketId: string | null;
  constructionName: string;
  constructionId: string | null;
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
  marketId: string | null;
  commodity: string;
  commodityLocalised: string;
  amount: number;
  total: number;
}

function constructionProgress(value: unknown, complete: boolean): number {
  if (complete) return 100;
  const raw = finiteNonNegative(value);
  // Elite journals write 0.222472 for 22.2472%; older integrations may
  // already send 22.2472. Preserve both formats.
  return Math.min(100, raw <= 1 ? raw * 100 : raw);
}

/**
 * Parse construction snapshots for the Journal page/CAPI. IDs stay textual so
 * imported MarketID values continue to match Raven's 64-bit identifiers.
 */
export function parseColonisationEvents(text: string): {
  cmdrName: string | null;
  depotEvents: ParsedColonisationDepot[];
  contributionEvents: ParsedColonisationContribution[];
  stats: {
    eventsParsed: number;
    depotEventsFound: number;
    contributionEventsFound: number;
    fsdJumps: number;
  };
} {
  let cmdrName: string | null = null;
  let currentSystem: string | null = null;
  const depotEvents: ParsedColonisationDepot[] = [];
  const contributionEvents: ParsedColonisationContribution[] = [];
  const seen = new Set<string>();
  const stats = {
    eventsParsed: 0,
    depotEventsFound: 0,
    contributionEventsFound: 0,
    fsdJumps: 0,
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line[0] !== '{') continue;

    let event: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      event = parsed as Record<string, unknown>;
    } catch {
      continue;
    }

    stats.eventsParsed += 1;
    const eventName = typeof event.event === 'string' ? event.event : 'Unknown';
    if (eventName === 'Commander' && typeof event.Name === 'string') {
      cmdrName = event.Name || cmdrName;
      continue;
    }
    if (eventName === 'LoadGame') {
      if (!cmdrName && typeof event.Commander === 'string') cmdrName = event.Commander;
      if (typeof event.StarSystem === 'string' && event.StarSystem.trim()) currentSystem = event.StarSystem.trim();
      continue;
    }
    if (eventName === 'Location' || eventName === 'Docked' || eventName === 'CarrierJump' || eventName === 'FSDJump') {
      if (typeof event.StarSystem === 'string' && event.StarSystem.trim()) currentSystem = event.StarSystem.trim();
      if (eventName === 'FSDJump') stats.fsdJumps += 1;
      continue;
    }

    // CAPI relays and a few journal versions include StarSystem directly on
    // construction events. Retain it for the following compact event too.
    if (typeof event.StarSystem === 'string' && event.StarSystem.trim()) {
      currentSystem = event.StarSystem.trim();
    }

    const timestamp = typeof event.timestamp === 'string' ? event.timestamp : '';
    const systemName = typeof event.StarSystem === 'string' && event.StarSystem.trim()
      ? event.StarSystem.trim()
      : currentSystem || '';
    if (eventName === 'ColonisationConstructionDepot') {
      const marketId = journalId(event.MarketID, rawJournalInteger(line, 'MarketID'));
      const constructionId = journalId(event.ConstructionID, rawJournalInteger(line, 'ConstructionID'));
      const constructionComplete = event.ConstructionComplete === true;
      const dedupeKey = `depot:${timestamp}:${systemName}:${marketId ?? ''}:${constructionId ?? ''}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const resources = Array.isArray(event.ResourcesRequired)
        ? event.ResourcesRequired
          .filter((resource): resource is Record<string, unknown> => !!resource && typeof resource === 'object')
          .map((resource) => ({
            name: String(resource.Name || ''),
            nameLocalised: displayCommodity(resource.Name_Localised, String(resource.Name || '')),
            requiredAmount: finiteNonNegative(resource.RequiredAmount),
            providedAmount: finiteNonNegative(resource.ProvidedAmount),
            payment: finiteNonNegative(resource.Payment),
          }))
        : [];

      depotEvents.push({
        timestamp,
        systemName,
        marketId,
        constructionName: String(event.ConstructionName || ''),
        constructionId,
        constructionProgress: constructionProgress(event.ConstructionProgress, constructionComplete),
        constructionComplete,
        resourcesRequired: resources,
      });
      stats.depotEventsFound += 1;
      continue;
    }

    if (eventName === 'ColonisationContribution') {
      const marketId = journalId(event.MarketID, rawJournalInteger(line, 'MarketID'));
      for (const contribution of colonisationContributions(event)) {
        const dedupeKey = `contribution:${timestamp}:${systemName}:${marketId ?? ''}:${contribution.key}:${contribution.amount}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        contributionEvents.push({
          timestamp,
          systemName,
          marketId,
          commodity: contribution.key,
          commodityLocalised: contribution.display,
          amount: contribution.amount,
          total: contribution.amount,
        });
        stats.contributionEventsFound += 1;
      }
    }
  }

  return { cmdrName, depotEvents, contributionEvents, stats };
}
