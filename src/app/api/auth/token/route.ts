import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createHash } from 'crypto';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function getAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const svc = getAdminClient();

  let body: { token?: string } = {};
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const token = String(body.token ?? '').trim();
  if (!token) {
    return NextResponse.json({ error: 'Token required' }, { status: 400 });
  }

  const tokenHash = hashToken(token);

  const { data: apiToken, error } = await svc
    .from('api_tokens')
    .select('id, user_id, name, is_revoked, last_used_at')
    .eq('token_hash', tokenHash)
    .maybeSingle();

  if (error || !apiToken || apiToken.is_revoked) {
    return NextResponse.json({ error: 'Invalid or revoked token' }, { status: 401 });
  }

  // Обновляем last_used_at
  await svc.from('api_tokens').update({ last_used_at: new Date().toISOString() }).eq('id', apiToken.id);

  // Получаем профиль пользователя
  const { data: profile } = await svc
    .from('profiles')
    .select('id, cmdr_name, email')
    .eq('id', apiToken.user_id)
    .single();

  return NextResponse.json({
    ok: true,
    user_id: apiToken.user_id,
    cmdr_name: profile?.cmdr_name ?? null,
    email: profile?.email ?? null,
    token_name: apiToken.name,
  });
}
