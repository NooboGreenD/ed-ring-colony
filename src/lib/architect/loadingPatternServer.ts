import { createServiceClient } from "@/lib/supabaseServer";
import { resolveRequestUser } from "@/lib/helperAuth";
import { buildViews, viewerContext } from "@/lib/fleetCarrierStore";
import { buildCarrierView } from "@/lib/fleetCarriers";
import type { LoadingCollaboration } from "./loadingPatternMembers";
import { loadingProgress, type LoadingPattern } from "./loadingPatterns";

export const LOADING_MEMBERS = "carrier_loading_pattern_members";
type Svc = ReturnType<typeof createServiceClient>;
export type LoadingMember = {
  user_id: string;
  cmdr_name: string;
  accepted_at: string | null;
  shared_carrier_ids: string[];
};
export async function loadingMembers(
  svc: Svc,
  id: string,
): Promise<LoadingMember[]> {
  const { data, error } = await svc
    .from(LOADING_MEMBERS)
    .select("user_id, cmdr_name, accepted_at, shared_carrier_ids")
    .eq("pattern_id", id);
  if (error) throw error;
  return data ?? [];
}
export function loadingParticipant(
  members: LoadingMember[],
  userId: string | null,
) {
  return userId
    ? members.find((member) => member.user_id === userId)
    : undefined;
}
export async function loadingCollaboration(
  svc: Svc,
  userId: string | null,
  ownerId: string,
  pattern: LoadingPattern,
  members: LoadingMember[],
): Promise<LoadingCollaboration | null> {
  const self = loadingParticipant(members, userId);
  if (!userId || (userId !== ownerId && !self)) return null;
  let ownCarrierIds: string[] = [];
  if (pattern.carriers.length) {
    const { data, error } = await svc
      .from("fleet_carriers")
      .select("carrier_id")
      .eq("owner_id", userId)
      .in(
        "carrier_id",
        pattern.carriers.map((c) => c.carrierId),
      );
    if (error) throw error;
    ownCarrierIds = (data ?? []).map((row) => String(row.carrier_id));
  }
  return {
    canManage: userId === ownerId,
    self: {
      accepted: userId === ownerId || !!self?.accepted_at,
      sharedCarrierIds: self?.shared_carrier_ids ?? [],
    },
    ownCarrierIds,
    participants: members.map((member) => ({
      userId: member.user_id,
      name: member.cmdr_name,
      accepted: !!member.accepted_at,
      sharedCarrierIds: member.shared_carrier_ids,
    })),
  };
}
export const LOADING_TABLE = "carrier_loading_patterns";
export const LOADING_PRIVATE = {
  "Cache-Control": "private, no-store",
  Vary: "Authorization, Cookie",
};
export const loadingUuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export async function loadingContext(request: Request) {
  const user = await resolveRequestUser(request);
  return { svc: createServiceClient(), userId: user?.userId ?? null };
}
export async function readLoadingBody(
  request: Request,
): Promise<Record<string, unknown>> {
  const max = 128 * 1024;
  if (Number(request.headers.get("content-length")) > max)
    throw new Error("lp.invalid");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("lp.invalid");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    bytes += item.value.byteLength;
    if (bytes > max) {
      await reader.cancel();
      throw new Error("lp.invalid");
    }
    chunks.push(item.value);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new Error("lp.invalid");
  return body;
}
export async function currentLoadingProgress(
  svc: ReturnType<typeof createServiceClient>,
  userId: string | null,
  pattern: LoadingPattern,
  sharing?: { ownerId: string; members: LoadingMember[] },
) {
  // A public template is NOT consent. Only owner/accepted members may
  // use explicit, pattern-scoped grants; regular fleet permissions stay intact.
  const inventories = new Map();
  const sharedOnly = new Set<string>();
  if (userId) {
    const viewer = await viewerContext(svc, userId);
    const { data, error } = await svc
      .from("fleet_carriers")
      .select("*")
      .in(
        "carrier_id",
        pattern.carriers.map((row) => row.carrierId),
      );
    if (error) throw new Error("lp.unavailable");
    const rows = (data ?? []).filter(
      (row) =>
        row.owner_id === userId ||
        viewer.squadronIds.includes(Number(row.squadron_id)),
    );
    for (const view of await buildViews(svc, rows, {
      ...viewer,
      officerSquadronIds: [],
    })) {
      if (view.cargo && (view.cargo.updatedAt || view.cargo.baselineAt))
        inventories.set(view.carrierId, view.cargo);
    }
    const canUseShares =
      sharing &&
      (sharing.ownerId === userId ||
        !!loadingParticipant(sharing.members, userId)?.accepted_at);
    if (canUseShares) {
      // Match BOTH carrier ID and current owner. Neither invitations, squadron
      // officers nor a forged client-side owner can grant another pilot's cargo.
      const sharedRows = (data ?? []).filter(
        (row) =>
          !inventories.has(String(row.carrier_id)) &&
          sharing.members.some(
            (member) =>
              !!member.accepted_at &&
              member.user_id === row.owner_id &&
              member.shared_carrier_ids.includes(String(row.carrier_id)),
          ),
      );
      if (sharedRows.length) {
        const { data: cargoRows, error: cargoError } = await svc
          .from("fleet_carrier_cargo")
          .select(
            "carrier_id, commodity, name_localised, quantity, baseline_at, baseline_source, observed_at, updated_at",
          )
          .in(
            "carrier_id",
            sharedRows.map((row) => String(row.carrier_id)),
          );
        if (cargoError) throw cargoError;
        for (const row of sharedRows) {
          // Reuse stock observation semantics, but never expose finance or
          // change the viewer's global fleet access. Only coverage is returned.
          const view = buildCarrierView(row, {
            relation: "squadron",
            showFinance: false,
            cargoRows: (cargoRows ?? []).filter(
              (cargo) => String(cargo.carrier_id) === String(row.carrier_id),
            ),
          });
          if (view.cargo && (view.cargo.updatedAt || view.cargo.baselineAt)) {
            inventories.set(view.carrierId, view.cargo);
            sharedOnly.add(view.carrierId);
          }
        }
      }
    }
  }
  const progress = loadingProgress(pattern, inventories);
  // The ordinary projection includes full aboard quantities for the owner's
  // own fleet. Team consent exposes only target coverage, never bank surplus.
  for (const carrier of progress.carriers)
    if (sharedOnly.has(carrier.carrierId))
      for (const item of carrier.items) item.aboard = item.loaded;
  return progress;
}
