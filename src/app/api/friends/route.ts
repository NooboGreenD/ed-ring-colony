import { NextRequest, NextResponse } from "next/server";
import { authFromRequest, createServiceClient } from "@/lib/supabaseServer";

export const dynamic = "force-dynamic";

const FRIEND_STATUSES = new Set(["pending", "accepted", "blocked"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type DbError = { code?: string; message?: string };
type FriendRow = Record<string, any>;
// The original table used user_id/friend_id. Some deployed versions also have
// its status column, while the oldest form represents an immediately accepted
// relationship and has no request state at all.
type FriendSchema = "modern" | "legacy-with-status" | "legacy";

function apiError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

async function getFriendsRequestContext(req: NextRequest) {
  const { user, supabase: authenticatedClient } = await authFromRequest(req);
  if (!user) return { user: null, supabase: null as any };

  // The service client lets this compatibility route read either deployed
  // schema regardless of an outdated RLS policy. If a deployment deliberately
  // has no service key, retain normal authenticated/RLS access rather than
  // making a user's saved list disappear.
  try {
    return { user, supabase: createServiceClient() };
  } catch {
    console.warn("[friends] Service client is unavailable; using authenticated access.");
    return { user, supabase: authenticatedClient };
  }
}

function isLegacyColumnError(error: DbError | null | undefined) {
  const message = error?.message || "";
  return (
    error?.code === "42703"
    || error?.code === "PGRST204"
    || /(?:requester_id|addressee_id|status|updated_at).*(?:does not exist|could not find)/i.test(message)
    || /could not find.*(?:requester_id|addressee_id|status|updated_at)/i.test(message)
  );
}

function isMissingLegacyFriendColumns(error: DbError | null | undefined) {
  const message = error?.message || "";
  return (
    error?.code === "42703"
    || error?.code === "PGRST204"
    || /(?:user_id|friend_id).*(?:does not exist|could not find)/i.test(message)
    || /could not find.*(?:user_id|friend_id)/i.test(message)
  );
}

function isMissingStatusColumn(error: DbError | null | undefined) {
  const message = error?.message || "";
  // PGRST204/42703 alone only identify an unknown column; require the actual
  // column name so a missing user_id/friend_id never gets misclassified as an
  // old no-status layout.
  return /status.*(?:does not exist|could not find)|could not find.*status/i.test(message);
}

function legacySchemaForRow(row: FriendRow | null | undefined): FriendSchema {
  return row && Object.prototype.hasOwnProperty.call(row, "status")
    ? "legacy-with-status"
    : "legacy";
}

function schemaSupportsStatus(schema: FriendSchema): boolean {
  return schema !== "legacy";
}

function rowUpdatedAt(row: FriendRow) {
  return String(row.updated_at ?? row.created_at ?? "");
}

function normaliseFriend(row: FriendRow, userId: string, schema: FriendSchema) {
  const requesterId = schema === "modern" ? row.requester_id : row.user_id;
  const addresseeId = schema === "modern" ? row.addressee_id : row.friend_id;
  const isRequester = requesterId === userId;
  return {
    ...row,
    requester_id: requesterId,
    addressee_id: addresseeId,
    // The oldest user_id/friend_id rows predate pending requests and represent
    // an already accepted relationship. Later legacy rows retain a status
    // column, so keep their incoming/outgoing state visible.
    status: schemaSupportsStatus(schema) ? row.status : "accepted",
    updated_at: row.updated_at ?? row.created_at ?? null,
    friend_id: isRequester ? addresseeId : requesterId,
  };
}

async function requestBody(req: NextRequest): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return body && typeof body === "object" && !Array.isArray(body)
      ? body as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

async function listRelationships(
  supabase: any,
  userId: string,
  status: string,
): Promise<{ rows: FriendRow[]; schema: FriendSchema }> {
  const modernResponse = await supabase
    .from("friends")
    .select("*")
    .or(`requester_id.eq.${userId},addressee_id.eq.${userId}`)
    .eq("status", status);
  if (!modernResponse.error && (modernResponse.data?.length || status !== "accepted")) {
    return { rows: modernResponse.data || [], schema: "modern" };
  }
  if (modernResponse.error && !isLegacyColumnError(modernResponse.error)) throw modernResponse.error;

  // Compatibility with the original friends(user_id, friend_id) schema. Some
  // deployments also have its status column, so preserve pending requests
  // rather than treating every old-schema row as accepted.
  const legacyWithStatus = await supabase
    .from("friends")
    .select("*")
    .or(`user_id.eq.${userId},friend_id.eq.${userId}`)
    .eq("status", status);
  if (!legacyWithStatus.error) {
    return { rows: legacyWithStatus.data || [], schema: "legacy-with-status" };
  }
  if (!isMissingStatusColumn(legacyWithStatus.error)) {
    if (!modernResponse.error && isMissingLegacyFriendColumns(legacyWithStatus.error)) {
      return { rows: modernResponse.data || [], schema: "modern" };
    }
    throw legacyWithStatus.error;
  }

  // The oldest table has no request-state column. It can only contain accepted
  // relationships, and cannot have pending/blocked records to list.
  if (status !== "accepted") return { rows: [], schema: "legacy" };
  const legacyResponse = await supabase
    .from("friends")
    .select("*")
    .or(`user_id.eq.${userId},friend_id.eq.${userId}`);
  if (legacyResponse.error) throw legacyResponse.error;
  return { rows: legacyResponse.data || [], schema: "legacy" };
}

async function findRelationship(
  supabase: any,
  userId: string,
  otherUserId: string,
): Promise<{ row: FriendRow | null; schema: FriendSchema }> {
  const modernResponse = await supabase
    .from("friends")
    .select("*")
    .or(`and(requester_id.eq.${userId},addressee_id.eq.${otherUserId}),and(requester_id.eq.${otherUserId},addressee_id.eq.${userId})`)
    .limit(2);
  if (!modernResponse.error && modernResponse.data?.length) {
    return { row: modernResponse.data[0], schema: "modern" };
  }
  if (modernResponse.error && !isLegacyColumnError(modernResponse.error)) throw modernResponse.error;

  const legacyResponse = await supabase
    .from("friends")
    .select("*")
    .or(`and(user_id.eq.${userId},friend_id.eq.${otherUserId}),and(user_id.eq.${otherUserId},friend_id.eq.${userId})`)
    .limit(2);
  if (legacyResponse.error) {
    if (!modernResponse.error && isMissingLegacyFriendColumns(legacyResponse.error)) {
      return { row: null, schema: "modern" };
    }
    throw legacyResponse.error;
  }
  if (legacyResponse.data?.length) {
    return {
      row: legacyResponse.data[0],
      schema: legacySchemaForRow(legacyResponse.data[0]),
    };
  }

  // An empty legacy relationship query does not reveal whether status exists.
  // Probe its column once so creating a new request uses the deployed layout.
  const statusProbe = await supabase.from("friends").select("status").limit(1);
  if (!statusProbe.error) return { row: null, schema: "legacy-with-status" };
  if (isMissingStatusColumn(statusProbe.error)) return { row: null, schema: "legacy" };
  throw statusProbe.error;
}

async function findRelationshipByBody(
  supabase: any,
  body: Record<string, unknown>,
): Promise<{ row: FriendRow | null; schema: FriendSchema }> {
  const id = typeof body.id === "number" || typeof body.id === "string" ? body.id : null;
  const requesterId = typeof body.requester_id === "string" ? body.requester_id : null;
  const addresseeId = typeof body.addressee_id === "string" ? body.addressee_id : null;
  if (!id && !(requesterId && addresseeId)) throw new Error("id or requester_id+addressee_id required");
  if ((requesterId && !UUID_PATTERN.test(requesterId)) || (addresseeId && !UUID_PATTERN.test(addresseeId))) {
    throw new Error("Invalid user id");
  }

  let modernQuery = supabase.from("friends").select("*");
  modernQuery = id
    ? modernQuery.eq("id", id)
    : modernQuery.eq("requester_id", requesterId).eq("addressee_id", addresseeId);
  const modernResponse = await modernQuery.maybeSingle();
  if (!modernResponse.error && modernResponse.data) return { row: modernResponse.data, schema: "modern" };
  if (modernResponse.error && !isLegacyColumnError(modernResponse.error)) throw modernResponse.error;

  let legacyQuery = supabase.from("friends").select("*");
  legacyQuery = id
    ? legacyQuery.eq("id", id)
    : legacyQuery.eq("user_id", requesterId).eq("friend_id", addresseeId);
  const legacyResponse = await legacyQuery.maybeSingle();
  if (legacyResponse.error) {
    if (!modernResponse.error && isMissingLegacyFriendColumns(legacyResponse.error)) {
      return { row: null, schema: "modern" };
    }
    throw legacyResponse.error;
  }
  return {
    row: legacyResponse.data,
    schema: legacySchemaForRow(legacyResponse.data),
  };
}

async function hydrateFriends(supabase: any, userId: string, rows: FriendRow[], schema: FriendSchema) {
  const normalised = rows
    .map((row) => normaliseFriend(row, userId, schema))
    .sort((left, right) => rowUpdatedAt(right).localeCompare(rowUpdatedAt(left)));
  const profileIds = Array.from(new Set(normalised
    .flatMap((row) => [row.requester_id, row.addressee_id])
    .filter((id): id is string => typeof id === "string" && id.length > 0)));

  if (profileIds.length === 0) return normalised;
  const { data: profiles, error } = await supabase
    .from("profiles")
    .select("id, cmdr_name, avatar_url")
    .in("id", profileIds);
  // A profile label is supplementary. Never hide a valid friend relationship
  // because a legacy profile is missing or its read is temporarily delayed.
  if (error) console.warn("[friends] Profile hydration failed:", error.message);

  const profileMap = new Map<string, FriendRow>((profiles || []).map((profile: FriendRow) => [String(profile.id), profile]));
  return normalised.map((friend) => {
    const profile = profileMap.get(friend.friend_id);
    return {
      ...friend,
      friend_name: profile?.cmdr_name ?? null,
      friend_avatar: profile?.avatar_url ?? null,
    };
  });
}

export async function GET(req: NextRequest) {
  try {
    const { user, supabase } = await getFriendsRequestContext(req);
    if (!user || !supabase) return apiError("Unauthorized", 401);

    const status = new URL(req.url).searchParams.get("status") || "accepted";
    if (!FRIEND_STATUSES.has(status)) return apiError("Invalid friendship status", 400);

    const { rows, schema } = await listRelationships(supabase, user.id, status);
    const friends = await hydrateFriends(supabase, user.id, rows, schema);
    return NextResponse.json({ friends });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[friends GET] Failed:", message);
    return apiError("Could not load friends", 500);
  }
}

export async function POST(req: NextRequest) {
  try {
    const { user, supabase } = await getFriendsRequestContext(req);
    if (!user || !supabase) return apiError("Unauthorized", 401);

    const body = await requestBody(req);
    const addresseeId = typeof body?.addressee_id === "string" ? body.addressee_id.trim() : "";
    if (!addresseeId) return apiError("addressee_id required", 400);
    if (!UUID_PATTERN.test(addresseeId)) return apiError("Invalid addressee_id", 400);
    if (addresseeId === user.id) return apiError("Cannot friend yourself", 400);

    const existing = await findRelationship(supabase, user.id, addresseeId);
    if (existing.row) {
      const relationship = normaliseFriend(existing.row, user.id, existing.schema);
      if (existing.schema === "legacy") return apiError("Already friends", 409);
      if (relationship.status === "blocked") return apiError("Blocked", 403);
      if (relationship.status === "accepted") return apiError("Already friends", 409);
      if (relationship.status === "pending") {
        // A reciprocal pending request means the person receiving it accepts.
        // Resending one's own outstanding request must not auto-accept it.
        if (relationship.addressee_id !== user.id) return apiError("Friend request already pending", 409);
        const { data, error } = await supabase
          .from("friends")
          .update({ status: "accepted" })
          .eq("id", existing.row.id)
          .select()
          .single();
        if (error) throw error;
        return NextResponse.json({ friend: data, accepted: true });
      }
    }

    const payload = existing.schema === "modern"
      ? { requester_id: user.id, addressee_id: addresseeId, status: "pending" }
      : existing.schema === "legacy-with-status"
        ? { user_id: user.id, friend_id: addresseeId, status: "pending" }
        : { user_id: user.id, friend_id: addresseeId };
    // The generated Supabase types still describe the legacy friend columns;
    // runtime schema selection above intentionally supports both layouts.
    const { data, error } = await supabase.from("friends").insert(payload as any).select().single();
    if (error) throw error;

    if (existing.schema === "legacy") {
      return NextResponse.json({ friend: data, accepted: true }, { status: 201 });
    }

    const { data: requesterProfile, error: profileError } = await supabase
      .from("profiles")
      .select("cmdr_name")
      .eq("id", user.id)
      .maybeSingle();
    if (profileError) console.warn("[friends POST] Could not load requester label:", profileError.message);

    // Notification delivery is best effort. RLS intentionally prevents many
    // normal users from writing another user's inbox, but that must not undo a
    // successfully persisted friend request.
    const { error: notificationError } = await supabase.from("user_notifications").insert({
      user_id: addresseeId,
      type: "friend_request",
      title: "Запрос в друзья",
      body: `${requesterProfile?.cmdr_name || "Пилот"} хочет добавить вас в друзья`,
      href: "/account/friends",
      metadata: { requester_id: user.id, friend_id: data.id },
    });
    if (notificationError) {
      console.warn("[friends POST] Friend notification was not created:", notificationError.message);
    }

    return NextResponse.json({ friend: data, accepted: false }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[friends POST] Failed:", message);
    return apiError("Could not create friend request", 500);
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const { user, supabase } = await getFriendsRequestContext(req);
    if (!user || !supabase) return apiError("Unauthorized", 401);

    const body = await requestBody(req);
    if (!body) return apiError("Invalid JSON body", 400);
    const status = typeof body.status === "string" ? body.status : "";
    if (!status || !["accepted", "blocked"].includes(status)) return apiError("Invalid friendship status", 400);

    let existing: { row: FriendRow | null; schema: FriendSchema };
    try {
      existing = await findRelationshipByBody(supabase, body);
    } catch (error) {
      return apiError(error instanceof Error ? error.message : "Invalid friend request", 400);
    }
    if (!existing.row) return apiError("Not found", 404);

    const normalised = normaliseFriend(existing.row, user.id, existing.schema);
    if (normalised.addressee_id !== user.id && normalised.requester_id !== user.id) return apiError("Forbidden", 403);
    if (!schemaSupportsStatus(existing.schema)) {
      return apiError("Legacy friendships are already accepted", 409);
    }
    // Only the recipient may accept a pending request. Either side may block
    // an existing relationship, but a requester must not accept their own.
    if (status === "accepted" && normalised.addressee_id !== user.id) {
      return apiError("Only the recipient can accept this request", 403);
    }

    const { data, error } = await supabase
      .from("friends")
      .update({ status })
      .eq("id", existing.row.id)
      .select()
      .single();
    if (error) throw error;

    if (status === "accepted") {
      const { error: notificationError } = await supabase
        .from("user_notifications")
        .delete()
        .eq("user_id", user.id)
        .eq("type", "friend_request")
        .or(`metadata->>requester_id.eq.${normalised.requester_id},metadata->>friend_id.eq.${existing.row.id}`);
      if (notificationError) {
        console.warn("[friends PATCH] Could not clear request notification:", notificationError.message);
      }
    }

    return NextResponse.json({ friend: data });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[friends PATCH] Failed:", message);
    return apiError("Could not update friend request", 500);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { user, supabase } = await getFriendsRequestContext(req);
    if (!user || !supabase) return apiError("Unauthorized", 401);

    const body = await requestBody(req);
    if (!body) return apiError("Invalid JSON body", 400);

    let existing: { row: FriendRow | null; schema: FriendSchema };
    try {
      existing = await findRelationshipByBody(supabase, body);
    } catch (error) {
      return apiError(error instanceof Error ? error.message : "Invalid friend request", 400);
    }
    if (!existing.row) return apiError("Not found", 404);

    const normalised = normaliseFriend(existing.row, user.id, existing.schema);
    if (normalised.requester_id !== user.id && normalised.addressee_id !== user.id) return apiError("Forbidden", 403);

    const { error } = await supabase.from("friends").delete().eq("id", existing.row.id);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[friends DELETE] Failed:", message);
    return apiError("Could not remove friend", 500);
  }
}
