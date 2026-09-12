import { createClient } from "@/lib/supabaseServer";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await createClient();

  // PostgREST caps a normal select at the project's max-rows setting (usually
  // 1,000). Page through only thread IDs so category statistics remain exact
  // as the forum grows.
  const fetchVisiblePostThreadRows = async () => {
    const rows: { thread_id?: number }[] = [];
    const pageSize = 1000;
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await supabase
        .from("forum_posts")
        .select("thread_id")
        .eq("is_deleted", false)
        .range(from, from + pageSize - 1);
      if (error) {
        // Older forum deployments do not have the soft-delete column yet.
        // Falling back to the base relation keeps category post totals
        // visible instead of silently turning every group count into zero.
        const fallback = await supabase
          .from("forum_posts")
          .select("thread_id")
          .range(from, from + pageSize - 1);
        if (fallback.error || !fallback.data?.length) break;
        rows.push(...fallback.data);
        if (fallback.data.length < pageSize) break;
        continue;
      }
      if (!data?.length) break;
      rows.push(...data);
      if (data.length < pageSize) break;
    }
    return rows;
  };

  const [
    { data: categories },
    { data: allThreads },
    { data: recentPosts },
    { data: profilesData },
    postThreadRows,
    { count: totalThreads },
    { count: totalPosts },
    { count: totalUsers },
  ] = await Promise.all([
    supabase.from("forum_categories").select("*").order("sort_order"),
    // Fetch thread rows without an inferred profiles relationship. Some
    // production schemas have the author_id column but no FK/PostgREST
    // relationship, which previously made the entire thread query fail and
    // reduced every category's totals to zero.
    supabase.from("forum_threads").select("id, title, category_id, author_id, updated_at").order("updated_at", { ascending: false }),
    supabase.from("forum_posts").select("id, content, created_at, author_id, thread_id").eq("is_deleted", false).order("created_at", { ascending: false }).limit(10),
    supabase.from("profiles").select("id, cmdr_name, avatar_url"),
    // An embedded `forum_posts(count)` would include soft-deleted posts under
    // the current public RLS policy.
    fetchVisiblePostThreadRows(),
    supabase.from("forum_threads").select("*", { count: "exact", head: true }),
    supabase.from("forum_posts").select("*", { count: "exact", head: true }).eq("is_deleted", false),
    supabase.from("profiles").select("*", { count: "exact", head: true }),
  ]);

  const postCountByThread = new Map<number, number>();
  for (const post of postThreadRows || []) {
    const threadId = Number((post as { thread_id?: number }).thread_id);
    if (Number.isFinite(threadId)) {
      postCountByThread.set(threadId, (postCountByThread.get(threadId) || 0) + 1);
    }
  }

  const normalizedThreads = (allThreads || []).map((t: any) => ({
    id: t.id,
    title: t.title,
    category_id: t.category_id,
    updated_at: t.updated_at,
    author_name: profilesData?.find((profile: any) => profile.id === t.author_id)?.cmdr_name || "Unknown",
    post_count: postCountByThread.get(Number(t.id)) || 0,
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
