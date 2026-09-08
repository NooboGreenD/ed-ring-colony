import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

function getClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export async function GET() {
  return NextResponse.json({ ok: true, service: 'desktop-auth' });
}

export async function POST(req: Request) {
  const supabase = getClient();
  if (!supabase) {
    return NextResponse.json({ error: 'Auth не настроен на сервере.' }, { status: 500 });
  }
  let body: { email?: string; password?: string; refresh_token?: string } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Некорректный JSON' }, { status: 400 });
  }
  const refresh = String(body.refresh_token ?? '').trim();
  if (refresh) {
    const { data, error } = await supabase.auth.refreshSession({ refresh_token: refresh });
    if (error || !data.session) {
      return NextResponse.json({ error: error?.message ?? 'Сессия истекла.' }, { status: 401 });
    }
    return NextResponse.json({
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      email: data.user?.email ?? null,
    });
  }
  const email = String(body.email ?? '').trim().toLowerCase();
  const password = String(body.password ?? '');
  if (!email || !password) {
    return NextResponse.json({ error: 'Укажите почту и пароль.' }, { status: 400 });
  }
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.session) {
    return NextResponse.json(
      { error: error?.message === 'Invalid login credentials' ? 'Неверный логин или пароль.' : error?.message ?? 'Вход не удался.' },
      { status: 401 },
    );
  }
  return NextResponse.json({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    email: data.user?.email ?? email,
  });
}
