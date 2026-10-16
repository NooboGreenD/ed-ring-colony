import { NextResponse } from 'next/server';
import { authFromRequest } from '@/lib/requestUser';
import { getServerSupabaseUrl } from '@/lib/supabaseServerUrl';
import { checkRateLimit } from '@/lib/rateLimit';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, private',
  Pragma: 'no-cache',
};

function clientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim() || 'local';
  return req.headers.get('x-real-ip')?.trim() || 'local';
}

/**
 * Проверка сессии для Android-приложения.
 * Принимает Bearer токен Supabase, возвращает профиль и роль.
 */
export async function GET(req: Request) {
  try {
    const { user, supabase } = await authFromRequest(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Не авторизован' }, { status: 401, headers: NO_STORE_HEADERS });
    }
    const { data: profile } = await supabase.from('profiles').select('id, cmdr_name, role, email, avatar_url, created_at').eq('id', user.id).maybeSingle();
    const role = profile?.role ?? 'user';
    if (!['admin', 'moderator', 'support_manager'].includes(role)) {
      return NextResponse.json({ success: false, error: 'Доступ запрещён: требуется роль администратора', role }, { status: 403, headers: NO_STORE_HEADERS });
    }
    return NextResponse.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        cmdr_name: profile?.cmdr_name ?? null,
        role,
        avatar_url: profile?.avatar_url ?? null,
      },
    }, { headers: NO_STORE_HEADERS });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500, headers: NO_STORE_HEADERS });
  }
}

export async function POST(req: Request) {
  // Прокси для логина через Supabase (email/password)
  // Тело: { email, password }
  try {
    const ip = clientIp(req);
    if (!checkRateLimit(`mobile-auth:${ip}`, 8)) {
      return NextResponse.json(
        { success: false, error: 'Слишком много попыток входа. Подождите минуту.' },
        { status: 429, headers: NO_STORE_HEADERS },
      );
    }
    const body = await req.json();
    const { email, password } = body;
    if (!email || !password) {
      return NextResponse.json({ success: false, error: 'Email и пароль обязательны' }, { status: 400, headers: NO_STORE_HEADERS });
    }
    // Создаём клиент без сессии и пытаемся логин
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(getServerSupabaseUrl(), process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error || !data.session || !data.user) {
      return NextResponse.json({ success: false, error: error?.message || 'Неверные данные' }, { status: 401, headers: NO_STORE_HEADERS });
    }
    // Проверяем роль
    const { data: profile } = await supabase.from('profiles').select('role, cmdr_name').eq('id', data.user.id).maybeSingle();
    if (!profile || !['admin', 'moderator', 'support_manager', 'admin'].includes(profile.role)) {
      return NextResponse.json({ success: false, error: 'Доступ только для администраторов' }, { status: 403, headers: NO_STORE_HEADERS });
    }
    return NextResponse.json({
      success: true,
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      user: {
        id: data.user.id,
        email: data.user.email,
        cmdr_name: profile.cmdr_name,
        role: profile.role,
      },
    }, { headers: NO_STORE_HEADERS });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500, headers: NO_STORE_HEADERS });
  }
}
