import { NextResponse } from "next/server";
import { authFromRequest } from "@/lib/supabaseServer";

export const dynamic = "force-dynamic";

type EnsureProfileBody = {
  id?: unknown;
  cmdr_name?: unknown;
  avatar_url?: unknown;
};

function initialText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text && text.length <= maxLength ? text : undefined;
}

function initialNickname(user: { user_metadata?: Record<string, unknown> | null }, body: EnsureProfileBody) {
  const metadata = user.user_metadata ?? {};
  const customClaims = metadata.custom_claims;
  return (
    initialText(body.cmdr_name, 250)
    ?? initialText(metadata.cmdr_name, 250)
    ?? (customClaims && typeof customClaims === "object"
      ? initialText((customClaims as Record<string, unknown>).global_name, 250)
      : undefined)
    ?? initialText(metadata.global_name, 250)
    ?? initialText(metadata.full_name, 250)
    ?? initialText(metadata.name, 250)
    ?? initialText(metadata.preferred_username, 250)
  );
}

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

  // This is intentionally an INSERT, never an UPSERT. OAuth providers may
  // refresh their display metadata on every login; an existing profile's CMDR
  // nickname and avatar are user-owned values and must not be touched here.
  const profileData: Record<string, unknown> = {
    id: user.id,
    email: user.email ?? null,
  };
  const nickname = initialNickname(user, body);
  const avatar = initialText(body.avatar_url, 2_000)
    ?? initialText(user.user_metadata?.avatar_url, 2_000)
    ?? initialText(user.user_metadata?.picture, 2_000);
  if (nickname) profileData.cmdr_name = nickname;
  if (avatar) profileData.avatar_url = avatar;

  const { error } = await supabase.from("profiles").insert(profileData);
  if (error) {
    // A database auth trigger can create the profile between account creation
    // and this request. A primary-key race means the profile already exists,
    // which is the successful no-overwrite result we want.
    if (error.code === "23505") {
      return NextResponse.json({ ok: true, created: false });
    }
    console.error("[ensure-profile] Could not create profile:", error.message);
    return NextResponse.json({ error: "Не удалось создать профиль" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, created: true }, { status: 201 });
}
