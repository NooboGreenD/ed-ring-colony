import { ensureUserProfile, type EnsureProfileBody } from "@/lib/ensureProfile";
import { NextResponse } from "next/server";
import { authFromRequest } from "@/lib/supabaseServer";
import { apiTranslate } from '@/lib/i18n/apiT';

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const t = await apiTranslate();
  let body: EnsureProfileBody = {};
  try {
    const parsed = await req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return NextResponse.json({ error: t('api.jsonInvalid') }, { status: 400 });
    }
    body = parsed as EnsureProfileBody;
  } catch {
    return NextResponse.json({ error: t('api.jsonInvalid') }, { status: 400 });
  }

  const { user, supabase } = await authFromRequest(req);
  if (!user) {
    return NextResponse.json({ error: t('auth.authRequired') }, { status: 401 });
  }
  if (typeof body.id === "string" && body.id !== user.id) {
    return NextResponse.json({ error: t('auth.foreignProfileDenied') }, { status: 403 });
  }

  const result = await ensureUserProfile(supabase, user, body);
  return NextResponse.json(result.ok ? result : { error: t('auth.profileCreateFailed') },
    { status: !result.ok ? 500 : result.created ? 201 : 200 });
}
