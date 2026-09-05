import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabaseServer';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const threadId = searchParams.get('thread_id');
  const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 200);
  const offset = Math.max(parseInt(searchParams.get('offset') || '0'), 0);

  if (!threadId) return NextResponse.json({ error: 'thread_id required' }, { status: 400 });

  const supabase = await createClient();
  const { data, error, count } = await supabase
    .from('forum_posts')
    .select('*', { count: 'exact' })
    .eq('thread_id', threadId)
    .eq('is_deleted', false)
    .order('created_at', { ascending: true })
    .range(offset, offset + limit - 1);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Загружаем профили отдельно
  const posts = data || [];
  const authorIds = [...new Set(posts.map((p: any) => p.author_id).filter(Boolean))];
  const { data: profilesData } = authorIds.length
    ? await supabase.from('profiles').select('id, cmdr_name, avatar_url').in('id', authorIds)
    : { data: [] };
  const profileMap = new Map((profilesData || []).map((p: any) => [p.id, p]));
  const postsWithAuthors = posts.map((p: any) => ({
    ...p,
    author: profileMap.get(p.author_id) ?? { cmdr_name: 'Unknown', avatar_url: null },
  }));

  const topLevel = postsWithAuthors.filter((p: any) => !p.parent_post_id);
  const replies = postsWithAuthors.filter((p: any) => p.parent_post_id);
  const tree = topLevel.map((p: any) => ({
    ...p,
    replies: replies.filter((r: any) => r.parent_post_id === p.id),
  }));

  return NextResponse.json({ posts: tree, total: count || 0, limit, offset });
}

const postSchema = z.object({
  thread_id: z.number().int().positive(),
  content: z.string().min(1).max(10000),
  parent_post_id: z.number().int().positive().optional(),
});

export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const parse = postSchema.safeParse(body);
  if (!parse.success) return NextResponse.json({ error: 'Invalid data', details: parse.error.flatten() }, { status: 400 });

  const { data, error } = await supabase
    .from('forum_posts')
    .insert({
      thread_id: parse.data.thread_id,
      content: parse.data.content,
      parent_post_id: parse.data.parent_post_id || null,
      author_id: user.id,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await supabase.rpc('increment_forum_posts', { uid: user.id });

  return NextResponse.json({ post: data });
}

const editSchema = z.object({
  post_id: z.number().int().positive(),
  content: z.string().min(1).max(10000),
});

export async function PATCH(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const parse = editSchema.safeParse(body);
  if (!parse.success) return NextResponse.json({ error: 'Invalid data', details: parse.error.flatten() }, { status: 400 });

  const { data: post } = await supabase
    .from('forum_posts')
    .select('author_id')
    .eq('id', parse.data.post_id)
    .single();

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  const isModerator = ['admin', 'moderator'].includes(profile?.role ?? '');
  if (post?.author_id !== user.id && !isModerator) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { createClient: createServiceClient } = await import('@supabase/supabase-js');
  const serviceSupabase = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { data, error } = await serviceSupabase
    .from('forum_posts')
    .update({ 
      content: parse.data.content,
      is_edited: true,
      updated_at: new Date().toISOString()
    })
    .eq('id', parse.data.post_id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ post: data });
}
