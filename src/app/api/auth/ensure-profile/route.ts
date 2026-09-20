import { ensureUserProfile, type EnsureProfileBody } from "@/lib/ensureProfile";
import { NextResponse } from "next/server";
import { authFromRequest } from "@/lib/supabaseServer";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: EnsureProfileBody = {};
  try {
    const parsed = await req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return NextResponse.json({ error: "Некорректный JSON" }, { status: 400 });
    }
    body = parsed as EnsureProfileBody;
  } catch {
    return NextResponse.json({ error: "Некорректный JSON" }, { status: 400 });
  }

  const { user, supabase } = await authFromRequest(req);
  if (!user) {
    return NextResponse.json({ error: "Требуется авторизация" }, { status: 401 });
  }
  if (typeof body.id === "string" && body.id !== user.id) {
    return NextResponse.json({ error: "Нельзя создать чужой профиль" }, { status: 403 });
  }

  const result = await ensureUserProfile(supabase, user, body);
  return NextResponse.json(result.ok ? result : { error: "Не удалось создать профиль" },
    { status: !result.ok ? 500 : result.created ? 201 : 200 });
}
