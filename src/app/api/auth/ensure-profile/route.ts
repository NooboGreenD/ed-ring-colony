import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabaseServer';
import { upsertProfile } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';
export async function POST(req: Request) {
  let body: { id?: string; email?: string; cmdr_name?: string; avatar_url?: string } = {};
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
  const profileData: any = { id, email: user.email ?? body.email };
  if (body.cmdr_name !== undefined) profileData.cmdr_name = body.cmdr_name;
  if (body.avatar_url !== undefined) profileData.avatar_url = body.avatar_url;
  const result = await upsertProfile(profileData);
  if (result.error) return NextResponse.json({ error: result.error }, { status: 500 });
  return NextResponse.json({ ok: true });
}
