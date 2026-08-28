import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabaseServer';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const categoryId = searchParams.get('category_id');
  const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 200);
  const offset = Math.max(parseInt(searchParams.get('offset') || '0'), 0);

  const supabase = await createClient();
  let query = supabase
    .from('forum_threads')
    .select('*, forum_posts(count)', { count: 'exact' })
    .order('is_pinned', { ascending: false })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (categoryId) query = query.eq('category_id', categoryId);

  const { data, error, count } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Загружаем профили отдельно
  const threads = data || [];
  const authorIds = [...new Set(threads.map((t: any) => t.author_id).filter(Boolean))];
  const { data: profilesData } = authorIds.length
    ? await supabase.from('profiles').select('id, cmdr_name, avatar_url').in('id', authorIds)
    : { data: [] };
  const profileMap = new Map((profilesData || []).map((p: any) => [p.id, p]));
  const threadsWithAuthors = threads.map((t: any) => ({
    ...t,
    author: profileMap.get(t.author_id) ?? { cmdr_name: 'Unknown', avatar_url: null },
  }));

  return NextResponse.json({ threads: threadsWithAuthors, total: count || 0, limit, offset });
}

const threadSchema = z.object({
  category_id: z.number().int().positive(),
  title: z.string().min(1).max(200),
  content: z.string().min(1).max(10000),
});

export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const parse = threadSchema.safeParse(body);
  if (!parse.success) return NextResponse.json({ error: 'Invalid data', details: parse.error.flatten() }, { status: 400 });

  const { data, error } = await supabase
    .from('forum_threads')
    .insert({
      category_id: parse.data.category_id,
      title: parse.data.title,
      author_id: user.id,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await supabase.from('forum_posts').insert({
    thread_id: data.id,
    author_id: user.id,
    content: parse.data.content,
  });

  return NextResponse.json({ thread: data });
}
