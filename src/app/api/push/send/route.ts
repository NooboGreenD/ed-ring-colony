import { NextResponse } from "next/server";
import { sendPushToUser, sendPushToUsers } from "@/lib/pushNotifications";

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
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
