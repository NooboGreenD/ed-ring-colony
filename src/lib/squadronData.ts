import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Read-model helpers for squadron pages.
 *
 * Older production databases have the base squadron tables but not the
 * PostgREST views (squadron_summary, squadron_member_detail and
 * project_summary) that a previous client assumed existed. Keeping this model
 * in application code makes the public profile and squadron pages work during
 * a gradual database rollout as well.
 */

export type SquadronPermission = {
  can_manage_projects: boolean;
  can_manage_members: boolean;
  can_manage_ranks: boolean;
  can_edit_squadron: boolean;
};

const noPermissions: SquadronPermission = {
  can_manage_projects: false,
  can_manage_members: false,
  can_manage_ranks: false,
  can_edit_squadron: false,
};

function asRows(value: unknown): Record<string, any>[] {
  return Array.isArray(value) ? value as Record<string, any>[] : [];
}

function asErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === "object" && "message" in error && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return fallback;
}

function rankOrder(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

export function normaliseSquadronMember(
  member: Record<string, any>,
  rank: Record<string, any> | undefined,
  profile: Record<string, any> | undefined,
) {
  return {
    ...member,
    joined_at: member.joined_at ?? member.created_at ?? null,
    rank_name: rank?.name ?? null,
    rank_order: rank?.sort_order ?? null,
    is_default: rank?.is_default ?? null,
    can_manage_projects: rank?.can_manage_projects ?? false,
    can_manage_members: rank?.can_manage_members ?? false,
    can_manage_ranks: rank?.can_manage_ranks ?? false,
    can_edit_squadron: rank?.can_edit_squadron ?? false,
    cmdr_name: profile?.cmdr_name ?? null,
    avatar_url: profile?.avatar_url ?? null,
  };
}

export async function loadSquadronMembers(
  db: SupabaseClient,
  squadronId: number,
) {
  const { data: memberData, error: memberError } = await db
    .from("squadron_members")
    .select("*")
    .eq("squadron_id", squadronId);
  if (memberError) throw new Error(asErrorMessage(memberError, "Could not load squadron members"));

  const members = asRows(memberData);
  if (members.length === 0) return [];

  const rankIds = Array.from(new Set(
    members
      .map((member) => Number(member.rank_id))
      .filter((id) => Number.isSafeInteger(id)),
  ));
  const userIds = Array.from(new Set(
    members.map((member) => member.user_id).filter((id): id is string => typeof id === "string" && id.length > 0),
  ));

  const [rankResponse, profileResponse] = await Promise.all([
    rankIds.length
      ? db.from("squadron_ranks").select("*").in("id", rankIds)
      : Promise.resolve({ data: [], error: null }),
    userIds.length
      ? db.from("profiles").select("id, cmdr_name, avatar_url").in("id", userIds)
      : Promise.resolve({ data: [], error: null }),
  ]);

  // Rank/profile labels enrich a membership list but must not make every
  // squadron disappear when an older installation is still completing schema
  // setup. The base relation remains authoritative.
  if (rankResponse.error) {
    console.warn("[squadronData] Could not hydrate member ranks:", rankResponse.error.message);
  }
  if (profileResponse.error) {
    console.warn("[squadronData] Could not hydrate member profiles:", profileResponse.error.message);
  }

  const ranks = new Map(asRows(rankResponse.error ? [] : rankResponse.data).map((rank) => [String(rank.id), rank]));
  const profiles = new Map(asRows(profileResponse.error ? [] : profileResponse.data).map((profile) => [String(profile.id), profile]));

  return members
    .map((member) => normaliseSquadronMember(
      member,
      member.rank_id == null ? undefined : ranks.get(String(member.rank_id)),
      profiles.get(String(member.user_id)),
    ))
    .sort((left, right) => {
      const rankDifference = rankOrder(left.rank_order) - rankOrder(right.rank_order);
      if (rankDifference !== 0) return rankDifference;
      return String(left.cmdr_name ?? "").localeCompare(String(right.cmdr_name ?? ""), "ru");
    });
}

export async function getSquadronMembership(
  db: SupabaseClient,
  squadronId: number,
  userId: string,
): Promise<(Record<string, any> & SquadronPermission) | null> {
  const { data: memberData, error: memberError } = await db
    .from("squadron_members")
    .select("*")
    .eq("squadron_id", squadronId)
    .eq("user_id", userId)
    .maybeSingle();
  if (memberError) throw new Error(asErrorMessage(memberError, "Could not load squadron membership"));
  if (!memberData) return null;

  const member = memberData as Record<string, any>;
  let rank: Record<string, any> | null = null;
  if (member.rank_id != null) {
    const { data: rankData, error: rankError } = await db
      .from("squadron_ranks")
      .select("*")
      .eq("id", member.rank_id)
      .eq("squadron_id", squadronId)
      .maybeSingle();
    if (rankError) throw new Error(asErrorMessage(rankError, "Could not load squadron rank"));
    rank = rankData as Record<string, any> | null;
  }

  return {
    ...member,
    ...noPermissions,
    can_manage_projects: rank?.can_manage_projects === true,
    can_manage_members: rank?.can_manage_members === true,
    can_manage_ranks: rank?.can_manage_ranks === true,
    can_edit_squadron: rank?.can_edit_squadron === true,
  };
}

export async function loadSquadronProjects(
  db: SupabaseClient,
  squadronId: number,
) {
  const { data: projectData, error: projectError } = await db
    .from("projects")
    .select("*")
    .eq("squadron_id", squadronId)
    .order("created_at", { ascending: false });
  if (projectError) throw new Error(asErrorMessage(projectError, "Could not load squadron projects"));

  const projects = asRows(projectData);
  if (projects.length === 0) return [];
  const projectIds = projects.map((project) => project.id).filter((id) => id != null);

  const [memberResponse, systemResponse] = await Promise.all([
    db.from("project_members").select("project_id").in("project_id", projectIds),
    db.from("project_systems").select("project_id, planned_status, target_date").in("project_id", projectIds),
  ]);
  if (memberResponse.error) console.warn("[squadronData] Could not load project members:", memberResponse.error.message);
  if (systemResponse.error) console.warn("[squadronData] Could not load project systems:", systemResponse.error.message);

  const membersByProject = new Map<string, number>();
  for (const member of asRows(memberResponse.error ? [] : memberResponse.data)) {
    const key = String(member.project_id);
    membersByProject.set(key, (membersByProject.get(key) ?? 0) + 1);
  }
  const systemsByProject = new Map<string, { total: number; done: number; building: number; latestTarget: string | null }>();
  for (const system of asRows(systemResponse.error ? [] : systemResponse.data)) {
    const key = String(system.project_id);
    const summary = systemsByProject.get(key) ?? { total: 0, done: 0, building: 0, latestTarget: null };
    summary.total += 1;
    if (system.planned_status === "done") summary.done += 1;
    if (system.planned_status === "building") summary.building += 1;
    if (typeof system.target_date === "string" && (!summary.latestTarget || system.target_date > summary.latestTarget)) {
      summary.latestTarget = system.target_date;
    }
    systemsByProject.set(key, summary);
  }

  return projects.map((project) => {
    const summary = systemsByProject.get(String(project.id));
    return {
      ...project,
      member_count: membersByProject.get(String(project.id)) ?? 0,
      system_count: summary?.total ?? 0,
      systems_done: summary?.done ?? 0,
      systems_building: summary?.building ?? 0,
      latest_target_date: summary?.latestTarget ?? null,
    };
  });
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

export async function loadProjectSummaries(
  db: SupabaseClient,
  options: { status?: string | null; limit?: number; offset?: number } = {},
) {
  const limit = boundedInteger(options.limit, 50, 1, 100);
  const offset = boundedInteger(options.offset, 0, 0, 100_000);
  let query = db
    .from("projects")
    .select("*")
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (options.status) query = query.eq("status", options.status);

  const { data: projectData, error: projectError } = await query;
  if (projectError) throw new Error(asErrorMessage(projectError, "Could not load projects"));
  const projects = asRows(projectData);
  if (projects.length === 0) return [];
  const projectIds = projects.map((project) => project.id).filter((id) => id != null);

  const [memberResponse, systemResponse] = await Promise.all([
    db.from("project_members").select("project_id").in("project_id", projectIds),
    db.from("project_systems").select("project_id, planned_status, target_date").in("project_id", projectIds),
  ]);
  if (memberResponse.error) console.warn("[squadronData] Could not count project members:", memberResponse.error.message);
  if (systemResponse.error) console.warn("[squadronData] Could not count project systems:", systemResponse.error.message);

  const membersByProject = new Map<string, number>();
  for (const member of asRows(memberResponse.error ? [] : memberResponse.data)) {
    const key = String(member.project_id);
    membersByProject.set(key, (membersByProject.get(key) ?? 0) + 1);
  }
  const systemsByProject = new Map<string, { total: number; done: number; building: number; latestTarget: string | null }>();
  for (const system of asRows(systemResponse.error ? [] : systemResponse.data)) {
    const key = String(system.project_id);
    const summary = systemsByProject.get(key) ?? { total: 0, done: 0, building: 0, latestTarget: null };
    summary.total += 1;
    if (system.planned_status === "done") summary.done += 1;
    if (system.planned_status === "building") summary.building += 1;
    if (typeof system.target_date === "string" && (!summary.latestTarget || system.target_date > summary.latestTarget)) {
      summary.latestTarget = system.target_date;
    }
    systemsByProject.set(key, summary);
  }

  return projects.map((project) => {
    const summary = systemsByProject.get(String(project.id));
    return {
      ...project,
      member_count: membersByProject.get(String(project.id)) ?? 0,
      system_count: summary?.total ?? 0,
      systems_done: summary?.done ?? 0,
      systems_building: summary?.building ?? 0,
      latest_target_date: summary?.latestTarget ?? null,
    };
  });
}

export async function loadSquadronSummaries(
  db: SupabaseClient,
  options: { status?: string | null; limit?: number; offset?: number } = {},
) {
  const limit = boundedInteger(options.limit, 50, 1, 100);
  const offset = boundedInteger(options.offset, 0, 0, 100_000);
  let query = db
    .from("squadrons")
    .select("*")
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (options.status) query = query.eq("status", options.status);

  const { data: squadronData, error: squadronError } = await query;
  if (squadronError) throw new Error(asErrorMessage(squadronError, "Could not load squadrons"));
  const squadrons = asRows(squadronData);
  if (squadrons.length === 0) return [];

  const squadronIds = squadrons.map((squadron) => squadron.id).filter((id) => id != null);
  const [memberResponse, projectResponse] = await Promise.all([
    db.from("squadron_members").select("squadron_id").in("squadron_id", squadronIds),
    db.from("projects").select("squadron_id").in("squadron_id", squadronIds),
  ]);
  if (memberResponse.error) console.warn("[squadronData] Could not count squadron members:", memberResponse.error.message);
  if (projectResponse.error) console.warn("[squadronData] Could not count squadron projects:", projectResponse.error.message);

  const memberCounts = new Map<string, number>();
  for (const member of asRows(memberResponse.error ? [] : memberResponse.data)) {
    const key = String(member.squadron_id);
    memberCounts.set(key, (memberCounts.get(key) ?? 0) + 1);
  }
  const projectCounts = new Map<string, number>();
  for (const project of asRows(projectResponse.error ? [] : projectResponse.data)) {
    const key = String(project.squadron_id);
    projectCounts.set(key, (projectCounts.get(key) ?? 0) + 1);
  }

  return squadrons.map((squadron) => ({
    ...squadron,
    member_count: memberCounts.get(String(squadron.id)) ?? 0,
    project_count: projectCounts.get(String(squadron.id)) ?? 0,
  }));
}

export async function loadSquadronForUser(db: SupabaseClient, userId: string) {
  const { data: membershipData, error: membershipError } = await db
    .from("squadron_members")
    .select("squadron_id")
    .eq("user_id", userId)
    .limit(1)
    .maybeSingle();
  if (membershipError) throw new Error(asErrorMessage(membershipError, "Could not load squadron membership"));

  let squadronId = (membershipData as { squadron_id?: number } | null)?.squadron_id ?? null;
  let squadron: Record<string, any> | null = null;
  if (squadronId != null) {
    const { data, error } = await db.from("squadrons").select("*").eq("id", squadronId).maybeSingle();
    if (error) throw new Error(asErrorMessage(error, "Could not load squadron"));
    squadron = data as Record<string, any> | null;
  }

  if (!squadron) {
    const { data, error } = await db
      .from("squadrons")
      .select("*")
      .eq("created_by", userId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(asErrorMessage(error, "Could not load created squadron"));
    squadron = data as Record<string, any> | null;
    squadronId = squadron?.id ?? null;
  }

  if (!squadron || squadronId == null) return null;
  const [membersResult, ranksResult, projectsResult] = await Promise.allSettled([
    loadSquadronMembers(db, Number(squadronId)),
    db.from("squadron_ranks").select("*").eq("squadron_id", squadronId).order("sort_order", { ascending: true }),
    loadSquadronProjects(db, Number(squadronId)),
  ]);

  if (membersResult.status === "rejected") {
    console.warn("[squadronData] Could not load members for profile squadron:", membersResult.reason);
  }
  if (projectsResult.status === "rejected") {
    console.warn("[squadronData] Could not load projects for profile squadron:", projectsResult.reason);
  }
  const ranks = ranksResult.status === "fulfilled" && !ranksResult.value.error
    ? asRows(ranksResult.value.data)
    : [];
  if (ranksResult.status === "rejected") {
    console.warn("[squadronData] Could not load ranks for profile squadron:", ranksResult.reason);
  } else if (ranksResult.value.error) {
    console.warn("[squadronData] Could not load ranks for profile squadron:", ranksResult.value.error.message);
  }

  return {
    squadron,
    members: membersResult.status === "fulfilled" ? membersResult.value : [],
    ranks,
    projects: projectsResult.status === "fulfilled" ? projectsResult.value : [],
  };
}
