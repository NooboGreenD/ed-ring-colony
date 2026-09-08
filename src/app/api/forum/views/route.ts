import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export async function POST(req: NextRequest) {
  const { thread_id } = await req.json();
  if (!thread_id) return NextResponse.json({ error: "thread_id required" }, { status: 400 });
  await supabaseAdmin.rpc("increment_thread_views", { thread_id });
  return NextResponse.json({ ok: true });
}
