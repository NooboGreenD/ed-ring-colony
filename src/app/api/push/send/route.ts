import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabaseServer";
import { sendPushToUser, sendPushToUsers } from "@/lib/pushNotifications";

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Проверяем роль
    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single();

    if (!['admin', 'moderator'].includes(profile?.role ?? '')) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await req.json();
    const { userId, userIds, title, body: msgBody, tag, url: clickUrl } = body;

    if (!title || !msgBody) {
      return NextResponse.json({ error: "title and body required" }, { status: 400 });
    }

    // Отправка одному пользователю
    if (userId) {
      await sendPushToUser(userId, title, msgBody, clickUrl || "/", tag);
      return NextResponse.json({ ok: true, sent: 1 });
    }

    // Отправка нескольким пользователям
    if (userIds && Array.isArray(userIds)) {
      await sendPushToUsers(userIds, title, msgBody, clickUrl || "/", tag);
      return NextResponse.json({ ok: true, sent: userIds.length });
    }

    return NextResponse.json({ error: "userId or userIds required" }, { status: 400 });
  } catch (e: any) {
    console.error("[push/send] error:", e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
