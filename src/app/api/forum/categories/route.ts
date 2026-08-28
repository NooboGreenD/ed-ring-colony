import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";


export async function GET() {
  const { data, error } = await supabaseAdmin
    .from("forum_categories")
    .select("*, forum_threads(count)")
    .order("sort_order");
  if (error) {
    console.error("GET /api/forum/categories error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ categories: data });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { data, error } = await supabaseAdmin.from("forum_categories").insert(body).select().single();
  if (error) {
    console.error("POST /api/forum/categories error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ category: data });
}
