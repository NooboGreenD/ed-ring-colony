import { createServiceClient } from "@/lib/supabaseServer";
import { resolveRequestUser } from "@/lib/helperAuth";
import { buildViews, viewerContext } from "@/lib/fleetCarrierStore";
import { loadingProgress, type LoadingPattern } from "./loadingPatterns";

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
) {
  // Public templates expose targets, NEVER another pilot's actual inventory.
  const inventories = new Map();
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
  }
  return loadingProgress(pattern, inventories);
}
