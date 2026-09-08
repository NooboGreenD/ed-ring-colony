import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabaseServer';
import { upsertProfile } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';
export async function POST(req: Request) {
  let body: { id?: string; email?: string; cmdr_name?: string | null; avatar_url?: string } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Некорректный JSON' }, { status: 400 });
  }
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Требуется авторизация' }, { status: 401 });
  }
  const id = user.id;
  if (body.id && body.id !== user.id) {
    return NextResponse.json({ error: 'Нельзя создать чужой профиль' }, { status: 403 });
  }
  
  // Приоритет: данные из тела запроса, затем из пользователя, затем из метаданных
  const profileData: any = { 
    id, 
    email: user.email ?? body.email ?? null 
  };
  
  // Если cmdr_name передан явно (включая null), используем его
  // Иначе пробуем взять из метаданных пользователя
  if (body.cmdr_name !== undefined) {
    profileData.cmdr_name = body.cmdr_name;
  } else if (user.user_metadata?.cmdr_name) {
    profileData.cmdr_name = user.user_metadata.cmdr_name;
  }
  
  if (body.avatar_url !== undefined) profileData.avatar_url = body.avatar_url;
  
  const result = await upsertProfile(profileData);
  if (result.error) return NextResponse.json({ error: result.error }, { status: 500 });
  return NextResponse.json({ ok: true });
}
