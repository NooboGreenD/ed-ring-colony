import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabaseServer';

export const dynamic = 'force-dynamic';
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const q = searchParams.get('q')?.trim().toLowerCase();
  if (!q || q.length < 2) return NextResponse.json({ threads: [], posts: [] });

  const supabase = await createClient();

  const { data: threads } = await supabase
    .from('forum_threads')
    .select('id, title, created_at, author_id, forum_categories!inner(slug, name)')
    .ilike('title', `%${q}%`)
    .limit(20);

  const { data: posts } = await supabase
    .from('forum_posts')
    .select('id, content, created_at, author_id, forum_threads!inner(id, title)')
    .eq('is_deleted', false)
    .ilike('content', `%${q}%`)
    .limit(20);

  // Загружаем профили
  const allAuthorIds = [...new Set([
    ...(threads || []).map((t: any) => t.author_id),
    ...(posts || []).map((p: any) => p.author_id),
  ].filter(Boolean))];

  const { data: profilesData } = allAuthorIds.length
    ? await supabase.from('profiles').select('id, cmdr_name').in('id', allAuthorIds)
    : { data: [] };
  const profileMap = new Map((profilesData || []).map((p: any) => [p.id, p]));

  return NextResponse.json({
    threads: (threads || []).map((t: any) => ({
      ...t,
      author_name: profileMap.get(t.author_id)?.cmdr_name || 'Unknown',
    })),
    posts: (posts || []).map((p: any) => ({
      ...p,
      author_name: profileMap.get(p.author_id)?.cmdr_name || 'Unknown',
    })),
  });
}
