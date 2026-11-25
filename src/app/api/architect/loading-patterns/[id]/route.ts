import { NextResponse } from "next/server";
import { apiTranslate } from "@/lib/i18n/apiT";
import { checkRateLimit } from "@/lib/rateLimit";
import {
  LOADING_CATALOGUE_VERSION,
  loadingPatternView,
  parseLoadingPattern,
} from "@/lib/architect/loadingPatterns";
import {
  currentLoadingProgress,
  loadingContext,
  loadingUuid,
  LOADING_PRIVATE,
  LOADING_TABLE,
  readLoadingBody,
} from "@/lib/architect/loadingPatternServer";
export const dynamic = "force-dynamic";
type Params = { params: Promise<{ id: string }> };
export async function GET(request: Request, { params }: Params) {
  const t = await apiTranslate();
  try {
    const { id } = await params;
    if (!loadingUuid(id))
      return NextResponse.json(
        { error: t("lp.notFound") },
        { status: 404, headers: LOADING_PRIVATE },
      );
    const { svc, userId } = await loadingContext(request);
    const { data, error } = await svc
      .from(LOADING_TABLE)
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    if (!data || (data.owner_id !== userId && data.visibility !== "public"))
      return NextResponse.json(
        { error: t("lp.notFound") },
        { status: 404, headers: LOADING_PRIVATE },
      );
    const view = loadingPatternView(data, userId);
    const progress = await currentLoadingProgress(svc, userId, view.pattern);
    return NextResponse.json(
      {
        ok: true,
        pattern: view,
        progress,
        checkedAt: new Date().toISOString(),
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
async function mutate(request: Request, { params }: Params, remove: boolean) {
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
    const { id } = await params;
    if (!loadingUuid(id))
      return NextResponse.json(
        { error: t("lp.notFound") },
        { status: 404, headers: LOADING_PRIVATE },
      );
    let body;
    let pattern;
    try {
      body = await readLoadingBody(request);
      if (!Number.isSafeInteger(body.version) || Number(body.version) < 1)
        throw new Error();
      if (!remove) pattern = parseLoadingPattern(body);
    } catch {
      return NextResponse.json(
        { error: t("lp.invalid") },
        { status: 400, headers: LOADING_PRIVATE },
      );
    }
    const current = await svc
      .from(LOADING_TABLE)
      .select("owner_id")
      .eq("id", id)
      .maybeSingle();
    if (current.error) throw current.error;
    if (!current.data || current.data.owner_id !== userId)
      return NextResponse.json(
        { error: t("lp.notFound") },
        { status: 404, headers: LOADING_PRIVATE },
      );
    const query = remove
      ? svc.from(LOADING_TABLE).delete()
      : svc
          .from(LOADING_TABLE)
          .update({
            name: pattern!.name,
            visibility: pattern!.visibility,
            definition: pattern,
            version: Number(body.version) + 1,
            catalogue_version: LOADING_CATALOGUE_VERSION,
            updated_at: new Date().toISOString(),
          });
    const { data, error } = await query
      .eq("id", id)
      .eq("owner_id", userId)
      .eq("version", body.version)
      .select("*")
      .maybeSingle();
    if (error) throw error;
    if (!data)
      return NextResponse.json(
        { error: t("lp.conflict") },
        { status: 409, headers: LOADING_PRIVATE },
      );
    return NextResponse.json(
      remove
        ? { ok: true }
        : { ok: true, pattern: loadingPatternView(data, userId) },
      { headers: LOADING_PRIVATE },
    );
  } catch {
    return NextResponse.json(
      { error: t("lp.unavailable") },
      { status: 503, headers: LOADING_PRIVATE },
    );
  }
}
export const PATCH = (request: Request, params: Params) =>
  mutate(request, params, false);
export const DELETE = (request: Request, params: Params) =>
  mutate(request, params, true);
