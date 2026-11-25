import { NextResponse } from "next/server";
import { apiTranslate } from "@/lib/i18n/apiT";
import { checkRateLimit } from "@/lib/rateLimit";
import {
  LOADING_CATALOGUE_VERSION,
  loadingPatternView,
  parseLoadingPattern,
} from "@/lib/architect/loadingPatterns";
import {
  loadingContext,
  LOADING_TABLE,
  LOADING_MEMBERS,
  LOADING_PRIVATE,
  readLoadingBody,
} from "@/lib/architect/loadingPatternServer";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const t = await apiTranslate();
  try {
    const { svc, userId } = await loadingContext(request);
    const scope = new URL(request.url).searchParams.get("scope") ?? "mine";
    if (scope !== "public" && !userId)
      return NextResponse.json(
        { error: t("lp.login") },
        { status: 401, headers: LOADING_PRIVATE },
      );
    let query = svc
      .from(LOADING_TABLE)
      .select("*")
      .order("updated_at", { ascending: false })
      .limit(100);
    query =
      scope === "public"
        ? query.eq("visibility", "public")
        : query.eq("owner_id", userId!);
    const { data, error } = await query;
    if (error) throw error;
    // "mine" includes invitations/team patterns for both website and Helper.
    const combined = [...(data ?? [])];
    if (scope !== "public" && userId) {
      const { data: memberships, error: memberError } = await svc
        .from(LOADING_MEMBERS)
        .select("pattern_id")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(100);
      if (memberError) throw memberError;
      const ids = (memberships ?? []).map((row) => row.pattern_id);
      if (ids.length) {
        const { data: shared, error: sharedError } = await svc
          .from(LOADING_TABLE)
          .select("*")
          .in("id", ids)
          .order("updated_at", { ascending: false })
          .limit(100);
        if (sharedError) throw sharedError;
        for (const row of shared ?? [])
          if (!combined.some((item) => item.id === row.id)) combined.push(row);
      }
    }
    return NextResponse.json(
      {
        ok: true,
        patterns: combined.map((row) => loadingPatternView(row, userId)),
      },
      { headers: LOADING_PRIVATE },
    );
  } catch {
    return NextResponse.json(
      { error: t("lp.unavailable") },
      { status: 503, headers: LOADING_PRIVATE },
    );
  }
}
export async function POST(request: Request) {
  const t = await apiTranslate();
  try {
    const { svc, userId } = await loadingContext(request);
    if (!userId)
      return NextResponse.json(
        { error: t("lp.login") },
        { status: 401, headers: LOADING_PRIVATE },
      );
    if (!checkRateLimit(`loading:${userId}`, 30))
      return NextResponse.json(
        { error: t("lp.rate") },
        { status: 429, headers: LOADING_PRIVATE },
      );
    let pattern;
    try {
      pattern = parseLoadingPattern(await readLoadingBody(request));
    } catch {
      return NextResponse.json(
        { error: t("lp.invalid") },
        { status: 400, headers: LOADING_PRIVATE },
      );
    }
    const profile = await svc
      .from("public_profiles")
      .select("cmdr_name")
      .eq("id", userId)
      .maybeSingle();
    const { data, error } = await svc
      .from(LOADING_TABLE)
      .insert({
        owner_id: userId,
        author_name: profile.data?.cmdr_name ?? "CMDR",
        name: pattern.name,
        visibility: pattern.visibility,
        definition: pattern,
        catalogue_version: LOADING_CATALOGUE_VERSION,
      })
      .select("*")
      .single();
    if (error || !data) throw error;
    return NextResponse.json(
      { ok: true, pattern: loadingPatternView(data, userId) },
      { status: 201, headers: LOADING_PRIVATE },
    );
  } catch {
    return NextResponse.json(
      { error: t("lp.unavailable") },
      { status: 503, headers: LOADING_PRIVATE },
    );
  }
}
