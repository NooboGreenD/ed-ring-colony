import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { getServerSupabaseUrl } from '@/lib/supabaseServerUrl';
import { checkRateLimit } from '@/lib/rateLimit';

export const dynamic = 'force-dynamic';

const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, private',
  Pragma: 'no-cache',
};

function clientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim() || 'local';
  return req.headers.get('x-real-ip')?.trim() || 'local';
}

function getClient() {
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!key) return null;
  const url = getServerSupabaseUrl();
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export async function GET() {
  return NextResponse.json({ ok: true, service: 'desktop-auth' }, { headers: NO_STORE_HEADERS });
}

export async function POST(req: Request) {
  const ip = clientIp(req);
  if (!checkRateLimit(`auth-desktop:${ip}`, 8)) {
    return NextResponse.json(
      { error: 'Слишком много попыток входа. Подождите минуту.' },
      { status: 429, headers: NO_STORE_HEADERS },
    );
  }
  const supabase = getClient();
  if (!supabase) {
    return NextResponse.json({ error: 'Auth не настроен на сервере.' }, { status: 500, headers: NO_STORE_HEADERS });
  }
  let body: { email?: string; password?: string; refresh_token?: string } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Некорректный JSON' }, { status: 400, headers: NO_STORE_HEADERS });
  }
  const refresh = String(body.refresh_token ?? '').trim();
  if (refresh) {
    const { data, error } = await supabase.auth.refreshSession({ refresh_token: refresh });
    if (error || !data.session) {
      return NextResponse.json({ error: error?.message ?? 'Сессия истекла.' }, { status: 401, headers: NO_STORE_HEADERS });
    }
    return NextResponse.json({
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      email: data.user?.email ?? null,
    }, { headers: NO_STORE_HEADERS });
  }
  const email = String(body.email ?? '').trim().toLowerCase();
  const password = String(body.password ?? '');
  if (!email || !password) {
    return NextResponse.json({ error: 'Укажите почту и пароль.' }, { status: 400, headers: NO_STORE_HEADERS });
  }
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.session) {
    return NextResponse.json(
      { error: error?.message === 'Invalid login credentials' ? 'Неверный логин или пароль.' : error?.message ?? 'Вход не удался.' },
      { status: 401, headers: NO_STORE_HEADERS },
    );
  }
  return NextResponse.json({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    email: data.user?.email ?? email,
  }, { headers: NO_STORE_HEADERS });
}
