import { createClient } from "@/lib/supabaseServer";
import { NextResponse } from "next/server";

export const dynamic = 'force-dynamic';
export async function POST(req: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { thread_id, action } = body;

  if (action === "unsubscribe") {
    await supabase.from("forum_subscriptions").delete().eq("thread_id", thread_id).eq("user_id", user.id);
  } else {
    await supabase.from("forum_subscriptions").insert({ thread_id, user_id: user.id }).select();
  }

  return NextResponse.json({ ok: true });
}
