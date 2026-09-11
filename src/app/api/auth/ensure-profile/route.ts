import { NextResponse } from "next/server";
import { authFromRequest } from "@/lib/supabaseServer";
import { upsertProfile } from "@/lib/supabaseAdmin";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: {
    id?: string;
    email?: string;
    cmdr_name?: string | null;
    avatar_url?: string;
  } = {};

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Некорректный JSON" }, { status: 400 });
  }

  const { user } = await authFromRequest(req);
  if (!user) {
    return NextResponse.json({ error: "Требуется авторизация" }, { status: 401 });
  }

  if (body.id && body.id !== user.id) {
    return NextResponse.json({ error: "Нельзя создать чужой профиль" }, { status: 403 });
  }

  // User identity always comes from the verified session, never from the
  // browser-provided payload.
  const profileData: {
    id: string;
    email: string | null;
    cmdr_name?: string | null;
    avatar_url?: string;
  } = {
    id: user.id,
    email: user.email ?? body.email ?? null,
  };

  if (body.cmdr_name !== undefined) {
    profileData.cmdr_name = body.cmdr_name;
  } else if (user.user_metadata?.cmdr_name) {
    profileData.cmdr_name = user.user_metadata.cmdr_name;
  }

  if (body.avatar_url !== undefined) profileData.avatar_url = body.avatar_url;

  const result = await upsertProfile(profileData);
  if (result.error) {
    return NextResponse.json({ error: result.error }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
