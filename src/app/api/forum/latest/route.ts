import { createClient } from "@/lib/supabaseServer";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await createClient();

  const { data: posts } = await supabase
    .from("forum_posts")
    .select("id, content, created_at, author:profiles(cmdr_name), forum_threads(id, title, forum_categories(slug, name))")
    .eq("is_deleted", false)
    .order("created_at", { ascending: false })
    .limit(50);

  const normalized = (posts ?? []).map((p: any) => {
    const thread = p.forum_threads;
    const cat = thread?.forum_categories;
    const author = Array.isArray(p.author) ? p.author[0] : p.author;
    return {
      id: p.id,
      content: p.content,
      created_at: p.created_at,
      author_name: author?.cmdr_name || "Unknown",
      thread_id: thread?.id,
      thread_title: thread?.title,
      category_slug: cat?.slug,
      category_name: cat?.name,
    };
  });

  return NextResponse.json({ posts: normalized });
}
