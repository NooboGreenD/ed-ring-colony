import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createHash, randomBytes } from 'crypto';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function generateToken(): string {
  return 'rc_' + randomBytes(32).toString('hex');
}

function anonClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const authHeader = req.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const accessToken = authHeader.slice(7);
  const supabase = anonClient();
  const { data: { user }, error } = await supabase.auth.getUser(accessToken);
  if (error || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { data: tokens } = await supabaseAdmin
    .from('api_tokens')
    .select('id, name, created_at, last_used_at, is_revoked')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  return NextResponse.json({ tokens: tokens || [] });
}

export async function POST(req: Request) {
  const authHeader = req.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const accessToken = authHeader.slice(7);
  const supabase = anonClient();
  const { data: { user }, error } = await supabase.auth.getUser(accessToken);
  if (error || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { name?: string } = {};
  try { body = await req.json(); } catch {}

  const token = generateToken();
  const tokenHash = hashToken(token);

  const { error: insertError } = await supabaseAdmin.from('api_tokens').insert({
    user_id: user.id,
    token_hash: tokenHash,
    name: body.name || 'Colonial Helper Token',
  });

  if (insertError) {
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

  return NextResponse.json({
    token,
    name: body.name || 'Colonial Helper Token',
    created_at: new Date().toISOString(),
  });
}

export async function DELETE(req: Request) {
  const authHeader = req.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const accessToken = authHeader.slice(7);
  const supabase = anonClient();
  const { data: { user }, error } = await supabase.auth.getUser(accessToken);
  if (error || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { id?: string } = {};
  try { body = await req.json(); } catch {}

  if (!body.id) {
    return NextResponse.json({ error: 'Token ID required' }, { status: 400 });
  }

  const { error: deleteError } = await supabaseAdmin
    .from('api_tokens')
    .update({ is_revoked: true })
    .eq('id', body.id)
    .eq('user_id', user.id);

  if (deleteError) {
    return NextResponse.json({ error: deleteError.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
