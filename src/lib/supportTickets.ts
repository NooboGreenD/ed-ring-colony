import { authFromRequest, createServiceClient } from "@/lib/supabaseServer";

export const SUPPORT_STAFF_ROLES = [
  "admin",
  "moderator",
  "support_manager",
] as const;

type SupportDatabaseClient = {
  from(table: string): any;
  storage: {
    from(bucket: string): any;
  };
};

export interface SupportProfile {
  id: string;
  cmdr_name: string | null;
  avatar_url: string | null;
  email?: string | null;
  role?: string | null;
}

export interface SupportRequestContext {
  user: { id: string } | null;
  db: SupportDatabaseClient | null;
  isStaff: boolean;
}

export function isSupportStaff(role: unknown): boolean {
  return SUPPORT_STAFF_ROLES.includes(
    String(role ?? "")
      .trim()
      .toLowerCase() as (typeof SUPPORT_STAFF_ROLES)[number],
  );
}

/**
 * Authenticate first, then prefer the server service client for support data.
 * The authenticated client is a safe fallback when a deployment temporarily
 * lacks SUPABASE_SERVICE_ROLE_KEY; support RLS policies still scope the data.
 */
export async function getSupportRequestContext(
  request: Request,
): Promise<SupportRequestContext> {
  const { user, supabase: authenticatedClient } =
    await authFromRequest(request);
  if (!user) return { user: null, db: null, isStaff: false };

  let db: SupportDatabaseClient = authenticatedClient;
  try {
    db = createServiceClient();
  } catch (error) {
    console.warn(
      "[support] Service client is unavailable; using the authenticated client instead.",
    );
  }

  let profileResponse = await db
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  // A malformed/missing service key must not make the complete support UI look
  // empty. Retry the role read and subsequent data access under the verified
  // caller session, where normal support RLS applies.
  if (profileResponse.error && db !== authenticatedClient) {
    console.warn(
      "[support] Service profile lookup failed; falling back to authenticated support access.",
    );
    db = authenticatedClient;
    profileResponse = await db
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .maybeSingle();
  }

  if (profileResponse.error) {
    console.warn(
      "[support] Could not resolve the caller role:",
      profileResponse.error.message,
    );
  }

  return {
    user: { id: user.id },
    db,
    isStaff: isSupportStaff(profileResponse.data?.role),
  };
}

/**
 * PostgREST cannot embed profiles through support_tickets.user_id because that
 * foreign key points at auth.users, not public.profiles. Fetch public-profile
 * labels separately so ticket listing does not depend on an invalid inferred
 * relationship in the PostgREST schema cache.
 */
export async function loadSupportProfiles(
  db: SupportDatabaseClient,
  ids: unknown[],
  includeEmail = false,
): Promise<Map<string, SupportProfile>> {
  const uniqueIds = Array.from(
    new Set(
      ids.filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  );
  if (uniqueIds.length === 0) return new Map();

  const select = includeEmail
    ? "id,cmdr_name,avatar_url,email"
    : "id,cmdr_name,avatar_url";
  const { data, error } = await db
    .from("profiles")
    .select(select)
    .in("id", uniqueIds);

  if (error) {
    // Profile labels are supplementary. Returning tickets without labels is
    // much better than turning a successful ticket query into an empty list.
    console.warn(
      "[support] Could not load ticket profile labels:",
      error.message,
    );
    return new Map();
  }

  return new Map(
    (data || []).map((profile: SupportProfile) => [profile.id, profile]),
  );
}
