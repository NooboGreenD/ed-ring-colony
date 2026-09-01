import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabaseServer";

export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status") || "accepted";

  // Use service client to bypass RLS — we already verified the user above
  const service = createServiceClient();

  // 1. Получаем записи дружбы
  const { data: rows, error } = await service
    .from("friends")
    .select("id, requester_id, addressee_id, status, created_at, updated_at")
    .or(`requester_id.eq.${user.id},addressee_id.eq.${user.id}`)
    .eq("status", status)
    .order("updated_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!rows || rows.length === 0) return NextResponse.json({ friends: [] });

  // 2. Собираем все ID профилей, которые нужно подгрузить
  const profileIds = Array.from(new Set(rows.flatMap((r: any) => [r.requester_id, r.addressee_id])));

  // 3. Подгружаем профили одним запросом
  const { data: profiles } = await service
    .from("profiles")
    .select("id, cmdr_name, avatar_url")
    .in("id", profileIds);

  const profileMap = new Map((profiles || []).map((p: any) => [p.id, p]));

  // 4. Нормализуем
  const normalized = rows.map((f: any) => {
    const isRequester = f.requester_id === user.id;
    const friendId = isRequester ? f.addressee_id : f.requester_id;
    const profile = profileMap.get(friendId);
    return {
      ...f,
      friend_id: friendId,
      friend_name: profile?.cmdr_name ?? null,
      friend_avatar: profile?.avatar_url ?? null,
    };
  });

  return NextResponse.json({ friends: normalized });
}

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { addressee_id } = await req.json();
  if (!addressee_id) return NextResponse.json({ error: "addressee_id required" }, { status: 400 });
  if (addressee_id === user.id) return NextResponse.json({ error: "Cannot friend yourself" }, { status: 400 });

  const service = createServiceClient();
  const { data: existing } = await service
    .from("friends")
    .select("id, status")
    .or(`and(requester_id.eq.${user.id},addressee_id.eq.${addressee_id}),and(requester_id.eq.${addressee_id},addressee_id.eq.${user.id})`)
    .maybeSingle();

  if (existing) {
    if (existing.status === "blocked") return NextResponse.json({ error: "Blocked" }, { status: 403 });
    if (existing.status === "accepted") return NextResponse.json({ error: "Already friends" }, { status: 409 });
    if (existing.status === "pending") {
      const { data, error } = await service
        .from("friends")
        .update({ status: "accepted" })
        .eq("id", existing.id)
        .select()
        .single();
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ friend: data, accepted: true });
    }
  }

  const { data, error } = await service
    .from("friends")
    .insert({ requester_id: user.id, addressee_id, status: "pending" })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Создаём уведомление для адресата
  const { data: requesterProfile } = await service
    .from("profiles")
    .select("cmdr_name")
    .eq("id", user.id)
    .maybeSingle();

  await service.from("user_notifications").insert({
    user_id: addressee_id,
    type: "friend_request",
    title: "Запрос в друзья",
    body: `${requesterProfile?.cmdr_name || "Пилот"} хочет добавить вас в друзья`,
    href: "/account/friends",
    metadata: { requester_id: user.id, friend_id: data.id },
  });

  return NextResponse.json({ friend: data, accepted: false }, { status: 201 });
}

export async function PATCH(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id, requester_id, addressee_id, status } = await req.json();
  if (!status) return NextResponse.json({ error: "status required" }, { status: 400 });
  if (!id && !(requester_id && addressee_id)) {
    return NextResponse.json({ error: "id or requester_id+addressee_id required" }, { status: 400 });
  }

  const service = createServiceClient();
  let query = service.from("friends").select("*");
  if (id) {
    query = query.eq("id", id);
  } else {
    query = query.eq("requester_id", requester_id).eq("addressee_id", addressee_id);
  }
  const { data: existing } = await query.single();

  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (existing.addressee_id !== user.id && existing.requester_id !== user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data, error } = await service
    .from("friends")
    .update({ status })
    .eq("id", existing.id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // При принятии дружбы — удаляем связанное уведомление о запросе
  if (status === "accepted") {
    await service
      .from("user_notifications")
      .delete()
      .eq("user_id", user.id)
      .eq("type", "friend_request")
      .or(`metadata->>requester_id.eq.${existing.requester_id},metadata->>friend_id.eq.${existing.id}`);
  }

  return NextResponse.json({ friend: data });
}

export async function DELETE(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id, requester_id, addressee_id } = await req.json();
  if (!id && !(requester_id && addressee_id)) {
    return NextResponse.json({ error: "id or requester_id+addressee_id required" }, { status: 400 });
  }

  const service = createServiceClient();
  let query = service.from("friends").delete();
  if (id) {
    query = query.eq("id", id);
  } else {
    query = query.eq("requester_id", requester_id).eq("addressee_id", addressee_id);
  }
  const { error } = await query.or(`requester_id.eq.${user.id},addressee_id.eq.${user.id}`);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
