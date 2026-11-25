import { NextResponse } from "next/server";
import { apiTranslate } from "@/lib/i18n/apiT";
import { checkRateLimit } from "@/lib/rateLimit";
import { loadingPatternView } from "@/lib/architect/loadingPatterns";
import {
  loadingContext,
  loadingMembers,
  loadingParticipant,
  loadingUuid,
  LOADING_MEMBERS,
  LOADING_TABLE,
  LOADING_PRIVATE,
  readLoadingBody,
} from "@/lib/architect/loadingPatternServer";

export const dynamic = "force-dynamic";
type Params = { params: Promise<{ id: string }> };
async function mutate(request: Request, { params }: Params, method: string) {
  const t = await apiTranslate();
  const fail = (key: string, status: number) =>
    NextResponse.json({ error: t(key) }, { status, headers: LOADING_PRIVATE });
  try {
    const { svc, userId } = await loadingContext(request);
    if (!userId) return fail("lp.login", 401);
    if (!checkRateLimit(`loading:${userId}`, 30)) return fail("lp.rate", 429);
    const { id } = await params;
    if (!loadingUuid(id)) return fail("lp.notFound", 404);
    const { data: row, error } = await svc
      .from(LOADING_TABLE)
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    if (!row) return fail("lp.notFound", 404);
    const members = await loadingMembers(svc, id);
    const owner = row.owner_id === userId;
    const self = loadingParticipant(members, userId);
    // Public visibility alone never grants membership management.
    if (!owner && !self) return fail("lp.notFound", 404);
    let body;
    try {
      body = await readLoadingBody(request);
    } catch {
      return fail("lp.invalid", 400);
    }
    if (method === "POST") {
      if (!owner) return fail("lp.notFound", 404);
      if (
        typeof body.cmdr !== "string" ||
        !body.cmdr.trim() ||
        body.cmdr.trim().length > 100
      )
        return fail("lp.pilotRequired", 400);
      // Exact case-insensitive name, not an attacker-controlled wildcard search.
      const name = body.cmdr.trim().replace(/[\\%_]/g, "\\$&");
      const { data: pilots, error: pilotError } = await svc
        .from("public_profiles")
        .select("id, cmdr_name")
        .ilike("cmdr_name", name)
        .limit(2);
      if (pilotError) throw pilotError;
      if (!pilots?.length) return fail("lp.pilotMissing", 404);
      if (pilots.length !== 1) return fail("lp.pilotAmbiguous", 409);
      const pilot = pilots[0];
      if (
        pilot.id === row.owner_id ||
        members.some((member) => member.user_id === pilot.id)
      )
        return fail("lp.alreadyMember", 409);
      if (members.length >= 50) return fail("lp.membersLimit", 400);
      const { error: insertError } = await svc.from(LOADING_MEMBERS).insert({
        pattern_id: id,
        user_id: pilot.id,
        cmdr_name: pilot.cmdr_name,
        accepted_at: null,
        shared_carrier_ids: [],
      });
      if (insertError) throw insertError;
    } else if (method === "PATCH") {
      // Only the pilot themself can consent, never the pattern author.
      if (
        body.accept !== true ||
        !Array.isArray(body.sharedCarrierIds) ||
        body.sharedCarrierIds.length > 20 ||
        body.sharedCarrierIds.some((value) => typeof value !== "string") ||
        new Set(body.sharedCarrierIds).size !== body.sharedCarrierIds.length
      )
        return fail("lp.invalid", 400);
      const ids = body.sharedCarrierIds as string[];
      const pattern = loadingPatternView(row, userId).pattern;
      if (
        ids.some(
          (id) => !pattern.carriers.some((carrier) => carrier.carrierId === id),
        )
      )
        return fail("lp.shareOwnOnly", 400);
      if (ids.length) {
        const { data: carriers, error: carrierError } = await svc
          .from("fleet_carriers")
          .select("carrier_id")
          .eq("owner_id", userId)
          .in("carrier_id", ids);
        if (carrierError) throw carrierError;
        if (
          ids.some(
            (id) =>
              !carriers?.some((carrier) => String(carrier.carrier_id) === id),
          )
        )
          return fail("lp.shareOwnOnly", 403);
      }
      const consent = {
        accepted_at: new Date().toISOString(),
        shared_carrier_ids: ids,
      };
      if (owner) {
        const { error: saveError } = await svc.from(LOADING_MEMBERS).upsert(
          {
            pattern_id: id,
            user_id: userId,
            cmdr_name: row.author_name,
            ...consent,
          },
          { onConflict: "pattern_id,user_id" },
        );
        if (saveError) throw saveError;
      } else {
        const { data: saved, error: saveError } = await svc
          .from(LOADING_MEMBERS)
          .update(consent)
          .eq("pattern_id", id)
          .eq("user_id", userId)
          .select("user_id")
          .maybeSingle();
        if (saveError) throw saveError;
        if (!saved) return fail("lp.notFound", 404);
      }
    } else {
      const target = body.userId === undefined ? userId : body.userId;
      if (typeof target !== "string" || (!owner && target !== userId))
        return fail("lp.notFound", 404);
      // The owner stays owner; deleting their consent simply revokes sharing.
      const { error: deleteError } = await svc
        .from(LOADING_MEMBERS)
        .delete()
        .eq("pattern_id", id)
        .eq("user_id", target);
      if (deleteError) throw deleteError;
    }
    return NextResponse.json({ ok: true }, { headers: LOADING_PRIVATE });
  } catch {
    return fail("lp.unavailable", 503);
  }
}
export const POST = (request: Request, params: Params) =>
  mutate(request, params, "POST");
export const PATCH = (request: Request, params: Params) =>
  mutate(request, params, "PATCH");
export const DELETE = (request: Request, params: Params) =>
  mutate(request, params, "DELETE");
