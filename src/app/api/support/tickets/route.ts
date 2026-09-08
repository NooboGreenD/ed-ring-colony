import { NextRequest, NextResponse } from 'next/server';
import { authFromRequest, createServiceClient } from '@/lib/supabaseServer';

export const dynamic = 'force-dynamic';

const STAFF_ROLES = ['admin', 'moderator', 'support_manager'];

export async function GET(req: NextRequest) {
  try {
    console.log('[support/tickets GET] start');
    const { user } = await authFromRequest(req);
    console.log('[support/tickets GET] user:', user?.id || 'null');

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const url = new URL(req.url);
    const status = url.searchParams.get('status');
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 100);
    const offset = parseInt(url.searchParams.get('offset') || '0');

    console.log('[support/tickets GET] creating service client');
    const service = createServiceClient();
    console.log('[support/tickets GET] service client created');

    console.log('[support/tickets GET] fetching profile for user:', user.id);
    const { data: profile, error: profileError } = await service
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .maybeSingle();

    console.log('[support/tickets GET] profile result:', { profile, profileError: profileError?.message || 'none' });

    const isStaff = STAFF_ROLES.includes(profile?.role || '');
    console.log('[support/tickets GET] isStaff:', isStaff);

    console.log('[support/tickets GET] building query');
    let query = service
      .from('support_tickets')
      .select(
        '*, user:profiles!support_tickets_user_id_fkey(cmdr_name, avatar_url), assigned:profiles!support_tickets_assigned_to_fkey(cmdr_name)',
        { count: 'exact' }
      );

    if (!isStaff) {
      query = query.eq('user_id', user.id);
    }

    if (status) {
      query = query.eq('status', status);
    }

    query = query.order('created_at', { ascending: false }).range(offset, offset + limit - 1);

    console.log('[support/tickets GET] executing query');
    const { data: tickets, error, count } = await query;

    console.log('[support/tickets GET] result:', {
      ticketsCount: tickets?.length,
      error: error?.message || 'none',
      total: count,
    });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ tickets: tickets || [], total: count || 0 });
  } catch (e: any) {
    console.error('[support/tickets GET] CRITICAL ERROR:', e?.message || e);
    return NextResponse.json({ error: 'Internal server error: ' + (e?.message || 'unknown') }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    console.log('[support/tickets POST] start');
    const { user } = await authFromRequest(req);
    console.log('[support/tickets POST] user:', user?.id || 'null');

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    let body;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const { title, category, priority, page_url, content } = body;

    if (!title?.trim() || !content?.trim()) {
      return NextResponse.json({ error: 'title and content required' }, { status: 400 });
    }

    console.log('[support/tickets POST] creating service client');
    const service = createServiceClient();
    console.log('[support/tickets POST] service client created');

    console.log('[support/tickets POST] inserting ticket');
    const { data: ticket, error } = await service
      .from('support_tickets')
      .insert({
        user_id: user.id,
        title: title.trim(),
        category: category || 'other',
        priority: priority || 'normal',
        page_url: page_url || null,
        status: 'open',
      })
      .select('*')
      .single();

    if (error) {
      console.error('[support/tickets POST] insert error:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    console.log('[support/tickets POST] ticket created:', ticket?.id);

    await service.from('support_messages').insert({
      ticket_id: ticket.id,
      sender_id: user.id,
      content: content.trim(),
      is_internal: false,
    });

    return NextResponse.json({ ticket }, { status: 201 });
  } catch (e: any) {
    console.error('[support/tickets POST] CRITICAL ERROR:', e?.message || e);
    return NextResponse.json({ error: 'Internal server error: ' + (e?.message || 'unknown') }, { status: 500 });
  }
}
