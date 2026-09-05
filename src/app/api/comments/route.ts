import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabaseServer';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const targetType = url.searchParams.get('target_type');
    const targetId = url.searchParams.get('target_id');
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 100);
    const offset = parseInt(url.searchParams.get('offset') || '0');

    if (!targetType || !targetId) {
      return NextResponse.json({ error: 'target_type and target_id required' }, { status: 400 });
    }
    if (!['galnet', 'news'].includes(targetType)) {
      return NextResponse.json({ error: 'target_type must be galnet or news' }, { status: 400 });
    }

    const supabase = createServiceClient();

    // Get comments
    const { data: comments, error, count } = await supabase
      .from('comments')
      .select('*', { count: 'exact' })
      .eq('target_type', targetType)
      .eq('target_id', targetId)
      .order('created_at', { ascending: true })
      .range(offset, offset + limit - 1);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Get author profiles separately
    const authorIds = [...new Set((comments || []).map((c: any) => c.author_id))];
    let profiles: Record<string, any> = {};
    if (authorIds.length > 0) {
      const { data: profilesData } = await supabase
        .from('profiles')
        .select('id, cmdr_name, avatar_url')
        .in('id', authorIds);
      profiles = Object.fromEntries((profilesData || []).map((p: any) => [p.id, p]));
    }

    // Merge comments with author data
    const enrichedComments = (comments || []).map((c: any) => ({
      ...c,
      author: profiles[c.author_id] || null,
    }));

    return NextResponse.json({ comments: enrichedComments, total: count ?? 0 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || 'Internal error' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const { target_type, target_id, content } = body;

    if (!target_type || !target_id || !content?.trim()) {
      return NextResponse.json({ error: 'target_type, target_id and content required' }, { status: 400 });
    }
    if (!['galnet', 'news'].includes(target_type)) {
      return NextResponse.json({ error: 'target_type must be galnet or news' }, { status: 400 });
    }
    if (content.trim().length > 2000) {
      return NextResponse.json({ error: 'Content too long (max 2000 chars)' }, { status: 400 });
    }

    const authHeader = req.headers.get('authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const token = authHeader.slice(7);

    const supabase = createServiceClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { data: comment, error } = await supabase
      .from('comments')
      .insert({
        target_type,
        target_id: String(target_id),
        author_id: user.id,
        content: content.trim(),
      })
      .select('*')
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Get author profile
    const { data: profile } = await supabase
      .from('profiles')
      .select('id, cmdr_name, avatar_url')
      .eq('id', user.id)
      .single();

    return NextResponse.json({
      comment: { ...comment, author: profile || null },
    }, { status: 201 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || 'Internal error' }, { status: 500 });
  }
}
