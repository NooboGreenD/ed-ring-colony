import { createClient } from "@/lib/supabaseServer";
import { notFound } from "next/navigation";
import { ThreadPageClient } from "./ThreadPageClient";

export const revalidate = 10;

interface Props {
  params: { id: string };
}

export async function generateMetadata({ params }: Props) {
  const supabase = createClient();
  const { data: thread } = await supabase
    .from("forum_threads")
    .select("title")
    .eq("id", params.id)
    .single();

  return {
    title: thread?.title ? `${thread.title} | Форум ED Ring Colony` : "Тема | Форум",
    description: "Обсуждение на форуме колонии ED Ring",
  };
}

export default async function ThreadPage({ params }: Props) {
  const supabase = createClient();
  const threadId = parseInt(params.id);
  if (isNaN(threadId)) notFound();

  const { data: thread } = await supabase
    .from("forum_threads")
    .select("*")
    .eq("id", threadId)
    .single();

  if (!thread) notFound();

  const { data: category } = await supabase
    .from("forum_categories")
    .select("*")
    .eq("id", thread.category_id)
    .single();

  // Загружаем посты без join (избегаем проблем с FK/RLS на profiles)
  const { data: posts, error: postsError } = await supabase
    .from("forum_posts")
    .select("*")
    .eq("thread_id", threadId)
    .order("created_at", { ascending: true });

  if (postsError) {
    console.error("[forum/thread] posts error:", postsError.message);
  }

  // Загружаем аватары авторов отдельным запросом
  const authorIds = [...new Set((posts ?? []).map((p: any) => p.author_id).filter(Boolean))];
  let avatars: Record<string, string | null> = {};
  if (authorIds.length > 0) {
    const { data: profiles } = await supabase
      .from("profiles")
      .select("id, avatar_url")
      .in("id", authorIds);
    avatars = Object.fromEntries((profiles ?? []).map((p: any) => [p.id, p.avatar_url]));
  }

  const formattedPosts = (posts ?? []).map((p: any) => ({
    ...p,
    author: { cmdr_name: p.author_name, avatar_url: avatars[p.author_id] ?? null },
  }));

  // Increment view
  await supabase.from("forum_threads").update({ views: thread.views + 1 }).eq("id", threadId);

  return (
    <ThreadPageClient
      thread={thread}
      category={category}
      initialPosts={formattedPosts}
    />
  );
}
