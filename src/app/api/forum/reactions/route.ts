import { createClient } from "@/lib/supabaseServer";
import { NextResponse } from "next/server";

export const dynamic = 'force-dynamic';
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const postId = searchParams.get("post_id");
  if (!postId) return NextResponse.json({ error: "No post_id" }, { status: 400 });

  const supabase = createClient();
  const { data } = await supabase.from("forum_reactions").select("*").eq("post_id", postId);
  return NextResponse.json({ reactions: data });
}
