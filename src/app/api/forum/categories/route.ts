import { createClient } from "@/lib/supabaseServer";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await createClient();

  const [
    { data: categories },
    { data: allThreads },
    { data: recentPosts },
    { data: profilesData },
    { count: totalThreads },
    { count: totalPosts },
    { count: totalUsers },
  ] = await Promise.all([
    supabase.from("forum_categories").select("*").order("sort_order"),
    supabase.from("forum_threads").select("id, title, category_id, updated_at, author:profiles(cmdr_name)").order("updated_at", { ascending: false }),
    supabase.from("forum_posts").select("id, content, created_at, author_id, thread_id").eq("is_deleted", false).order("created_at", { ascending: false }).limit(10),
    supabase.from("profiles").select("id, cmdr_name, avatar_url"),
    supabase.from("forum_threads").select("*", { count: "exact", head: true }),
    supabase.from("forum_posts").select("*", { count: "exact", head: true }),
    supabase.from("profiles").select("*", { count: "exact", head: true }),
  ]);

  const normalizedThreads = (allThreads || []).map((t: any) => ({
    id: t.id,
    title: t.title,
    category_id: t.category_id,
    updated_at: t.updated_at,
    author_name: Array.isArray(t.author) ? t.author[0]?.cmdr_name : t.author?.cmdr_name || "Unknown",
  }));

  return NextResponse.json({
    categories: categories || [],
    allThreads: normalizedThreads,
    recentPosts: recentPosts || [],
    profiles: profilesData || [],
    totalThreads: totalThreads || 0,
    totalPosts: totalPosts || 0,
    totalUsers: totalUsers || 0,
  });
}
