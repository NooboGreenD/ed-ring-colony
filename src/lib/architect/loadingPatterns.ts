import { CATALOGUE_VERSION, INSTALLATIONS } from "./catalogue.ts";

export type LoadingPattern = {
  name: string;
  visibility: "private" | "public";
  buildings: { installationId: string; count: number; primary: boolean }[];
  carriers: {
    carrierId: string;
    name: string;
    capacity: number;
    recipeLimit?: 1 | 2;
  }[];
  allocations: Record<string, Record<string, number>>;
};
export type LoadingPatternView = {
  id: string;
  version: number;
  canEdit: boolean;
  author: string;
  updatedAt: string;
  pattern: LoadingPattern;
  requirements: Record<string, number>;
  total: number;
  unassigned: Record<string, number>;
  catalogueUpdated: boolean;
  allocationsAdjusted: boolean;
};
export const LOADING_CATALOGUE_VERSION = CATALOGUE_VERSION;
const installations = new Map(INSTALLATIONS.map((item) => [item.id, item]));
export function loadingRequirements(
  buildings: LoadingPattern["buildings"],
): Record<string, number> {
  const goods: Record<string, number> = {};
  for (const row of buildings) {
    const item = installations.get(row.installationId);
    if (!item) throw new Error("lp.invalid");
    const cargo = row.primary ? item.primary?.cargo : item.cargo;
    if (!cargo) throw new Error("lp.invalid");
    for (const [key, qty] of Object.entries(cargo))
      goods[key] = (goods[key] ?? 0) + qty * row.count;
  }
  return Object.fromEntries(
    Object.entries(goods).sort(([a], [b]) => a.localeCompare(b)),
  );
}
/** Stable first-fit, whole tonnes; overflow is retained as unassigned demand. */
export function distributeLoading(
  requirements: Record<string, number>,
  carriers: LoadingPattern["carriers"],
): LoadingPattern["allocations"] {
  const result: LoadingPattern["allocations"] = Object.fromEntries(
    carriers.map((row) => [row.carrierId, {}]),
  );
  const free = carriers.map((row) => row.capacity);
  for (const [good, qty] of Object.entries(requirements)) {
    let remaining = qty;
    carriers.forEach((carrier, index) => {
      const put = Math.min(free[index], remaining);
      if (put > 0) result[carrier.carrierId][good] = put;
      free[index] -= put;
      remaining -= put;
    });
  }
  return result;
}
/** Keep each selected building recipe intact. Limits are explicit, not inferred
 * from available capacity (a partially occupied squadron carrier can have <25kt).
 * Stable first-fit; recipes that do not fit remain unassigned in their entirety.
 */
export function distributeLoadingRecipes(
  buildings: LoadingPattern["buildings"],
  carriers: LoadingPattern["carriers"],
): LoadingPattern["allocations"] {
  const result: LoadingPattern["allocations"] = Object.fromEntries(
    carriers.map((c) => [c.carrierId, {}]),
  );
  const free = carriers.map((c) => c.capacity);
  const counts = carriers.map(() => 0);
  for (const building of buildings) {
    const recipe = loadingRequirements([{ ...building, count: 1 }]);
    const tons = Object.values(recipe).reduce((a, b) => a + b, 0);
    for (let n = 0; n < building.count; n++) {
      const index = carriers.findIndex(
        (c, i) => counts[i] < (c.recipeLimit ?? 1) && free[i] >= tons,
      );
      if (index < 0) continue;
      const allocation = result[carriers[index].carrierId];
      for (const [good, qty] of Object.entries(recipe))
        allocation[good] = (allocation[good] ?? 0) + qty;
      counts[index]++;
      free[index] -= tons;
    }
  }
  return result;
}
export function unassignedLoading(
  pattern: LoadingPattern,
): Record<string, number> {
  const goods = loadingRequirements(pattern.buildings);
  for (const allocation of Object.values(pattern.allocations))
    for (const [good, qty] of Object.entries(allocation)) {
      if (Object.hasOwn(goods, good)) goods[good] -= qty;
    }
  return Object.fromEntries(Object.entries(goods).filter(([, qty]) => qty > 0));
}
function parsePattern(
  input: unknown,
  reconcileCatalogue = false,
): LoadingPattern {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("lp.invalid");
  const raw = input as Record<string, unknown>;
  if (
    typeof raw.name !== "string" ||
    !raw.name.trim() ||
    raw.name.length > 100 ||
    (raw.visibility !== "private" && raw.visibility !== "public") ||
    !Array.isArray(raw.buildings) ||
    !raw.buildings.length ||
    raw.buildings.length > 100 ||
    !Array.isArray(raw.carriers) ||
    !raw.carriers.length ||
    raw.carriers.length > 20
  )
    throw new Error("lp.invalid");
  const buildings = raw.buildings.map((row) => {
    if (
      !row ||
      typeof row.installationId !== "string" ||
      !installations.has(row.installationId) ||
      !Number.isSafeInteger(row.count) ||
      row.count < 1 ||
      row.count > 100 ||
      typeof row.primary !== "boolean" ||
      (row.primary && !installations.get(row.installationId)?.primary)
    )
      throw new Error("lp.invalid");
    return {
      installationId: row.installationId as string,
      count: row.count as number,
      primary: row.primary as boolean,
    };
  });
  const ids = new Set<string>();
  const carriers = raw.carriers.map((row) => {
    if (
      !row ||
      typeof row.carrierId !== "string" ||
      !/^\d{1,16}$/.test(row.carrierId) ||
      Number(row.carrierId) < 1 ||
      !Number.isSafeInteger(Number(row.carrierId)) ||
      String(Number(row.carrierId)) !== row.carrierId ||
      ids.has(row.carrierId) ||
      typeof row.name !== "string" ||
      !row.name.trim() ||
      row.name.length > 100 ||
      !Number.isSafeInteger(row.capacity) ||
      row.capacity < 0 ||
      row.capacity > 60000 ||
      (row.recipeLimit !== undefined &&
        row.recipeLimit !== 1 &&
        row.recipeLimit !== 2)
    )
      throw new Error("lp.invalid");
    ids.add(row.carrierId);
    return {
      carrierId: row.carrierId as string,
      name: row.name.trim() as string,
      capacity: row.capacity as number,
      ...(row.recipeLimit === undefined
        ? {}
        : { recipeLimit: row.recipeLimit as 1 | 2 }),
    };
  });
  const requirements = loadingRequirements(buildings);
  const allocations: LoadingPattern["allocations"] = Object.fromEntries(
    carriers.map((row) => [row.carrierId, {}]),
  );
  if (raw.allocations !== undefined) {
    if (
      !raw.allocations ||
      typeof raw.allocations !== "object" ||
      Array.isArray(raw.allocations)
    )
      throw new Error("lp.invalid");
    const totals: Record<string, number> = {};
    const entries = Object.entries(raw.allocations);
    if (reconcileCatalogue)
      entries.sort(
        ([left], [right]) =>
          carriers.findIndex((row) => row.carrierId === left) -
          carriers.findIndex((row) => row.carrierId === right),
      );
    for (const [id, rows] of entries) {
      if (
        !ids.has(id) ||
        !rows ||
        typeof rows !== "object" ||
        Array.isArray(rows)
      )
        throw new Error("lp.invalid");
      let load = 0;
      for (const [good, qty] of Object.entries(rows)) {
        if (
          (!reconcileCatalogue && !Object.hasOwn(requirements, good)) ||
          typeof qty !== "number" ||
          !Number.isSafeInteger(qty) ||
          qty < 0 ||
          qty > 60000
        )
          throw new Error("lp.invalid");
        // Validate the saved load too: a catalogue update is not permission to
        // accept malformed data or over-capacity assignments.
        load += qty;
        if (!Object.hasOwn(requirements, good)) continue;
        const accepted = reconcileCatalogue
          ? Math.min(qty, Math.max(0, requirements[good] - (totals[good] ?? 0)))
          : qty;
        if (accepted) allocations[id][good] = accepted;
        totals[good] = (totals[good] ?? 0) + accepted;
        if (totals[good] > requirements[good]) throw new Error("lp.invalid");
      }
      if (load > carriers.find((row) => row.carrierId === id)!.capacity)
        throw new Error("lp.invalid");
    }
  } else Object.assign(allocations, distributeLoading(requirements, carriers));
  return {
    name: raw.name.trim(),
    visibility: raw.visibility as LoadingPattern["visibility"],
    buildings,
    carriers,
    allocations,
  };
}
/** New writes always use strict current-catalogue validation. */
export function parseLoadingPattern(input: unknown): LoadingPattern {
  return parsePattern(input);
}
export function loadingPatternView(
  row: Record<string, any>,
  userId: string | null,
): LoadingPatternView {
  const catalogueUpdated =
    Number.isInteger(row.catalogue_version) &&
    row.catalogue_version > 0 &&
    row.catalogue_version < CATALOGUE_VERSION;
  let pattern: LoadingPattern;
  let allocationsAdjusted = false;
  try {
    pattern = parseLoadingPattern(row.definition);
  } catch (error) {
    if (!catalogueUpdated) throw error;
    // Read old templates without writing to the DB: only remove obsolete
    // goods/cap excess targets, never transfer assignments between carriers.
    // Newly required quantities remain explicitly unassigned.
    pattern = parsePattern(row.definition, true);
    allocationsAdjusted = true;
  }
  const requirements = loadingRequirements(pattern.buildings);
  return {
    id: row.id,
    version: row.version,
    author: row.author_name,
    canEdit: row.owner_id === userId,
    updatedAt: row.updated_at,
    pattern,
    requirements,
    total: Object.values(requirements).reduce((a, b) => a + b, 0),
    unassigned: unassignedLoading(pattern),
    catalogueUpdated,
    allocationsAdjusted,
  };
}
export function loadingProgress(
  pattern: LoadingPattern,
  inventories: Map<
    string,
    {
      items: {
        commodity: string;
        quantity: number;
        updatedAt?: string | null;
        name?: string;
      }[];
      updatedAt: string | null;
      baselineAt?: string | null;
      observations?: Record<string, string>;
    }
  >,
) {
  let loaded = 0,
    assigned = 0,
    unknown = 0;
  const carriers = pattern.carriers.map((carrier) => {
    const cargo = inventories.get(carrier.carrierId);
    const stock = new Map(
      (cargo?.items ?? []).map((item) => [item.commodity, item.quantity]),
    );
    let done = 0,
      target = 0,
      carrierUnknown = 0;
    const items = Object.entries(
      pattern.allocations[carrier.carrierId] ?? {},
    ).map(([commodity, required]) => {
      const observedAt =
        cargo?.observations?.[commodity] ??
        cargo?.items.find((item) => item.commodity === commodity)?.updatedAt ??
        cargo?.baselineAt ??
        null;
      const quantity =
        cargo && (stock.has(commodity) || observedAt)
          ? Math.max(0, stock.get(commodity) ?? 0)
          : null;
      const credited = quantity === null ? 0 : Math.min(required, quantity);
      target += required;
      done += credited;
      if (quantity === null) carrierUnknown += required;
      return {
        commodity,
        name:
          cargo?.items.find((item) => item.commodity === commodity)?.name ??
          commodity,
        observedAt,
        required,
        aboard: quantity,
        loaded: quantity === null ? null : credited,
        remaining: quantity === null ? null : required - credited,
      };
    });
    assigned += target;
    loaded += done;
    unknown += carrierUnknown;
    return {
      ...carrier,
      known: !!cargo && carrierUnknown === 0,
      unknown: carrierUnknown,
      updatedAt: cargo?.updatedAt ?? null,
      target,
      loaded: cargo ? done : null,
      items,
    };
  });
  const total = Object.values(loadingRequirements(pattern.buildings)).reduce(
    (a, b) => a + b,
    0,
  );
  return {
    total,
    assigned,
    loaded,
    unknown,
    unassigned: total - assigned,
    complete: total > 0 && loaded === total && unknown === 0,
    carriers,
  };
}
