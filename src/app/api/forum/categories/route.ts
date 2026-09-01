import { createClient } from "@/lib/supabaseServer";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await createClient();

  const [{ data: categories }, { data: latestThreads }, { count: totalThreads }] = await Promise.all([
    supabase.from("forum_categories").select("*").order("sort_order"),
    supabase.from("forum_threads")
      .select("id, title, created_at, author:profiles(cmdr_name), forum_categories(slug, name)")
      .order("created_at", { ascending: false })
      .limit(5),
    supabase.from("forum_threads").select("*", { count: "exact", head: true }),
  ]);

  return NextResponse.json({
    categories: categories ?? [],
    latestThreads: latestThreads ?? [],
    totalThreads: totalThreads ?? 0,
  });
}
