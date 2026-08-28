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
  const id = user?.id || (typeof body.id === 'string' ? body.id : '');
  if (!id) return NextResponse.json({ error: 'Нет пользователя' }, { status: 400 });
  if (user && body.id && body.id !== user.id) {
    return NextResponse.json({ error: 'Нельзя создать чужой профиль' }, { status: 403 });
  }
  const result = await upsertProfile({
    id,
    email: user?.email ?? body.email,
    cmdr_name: body.cmdr_name,
    avatar_url: body.avatar_url,
  });
  if (result.error) return NextResponse.json({ error: result.error }, { status: 500 });
  return NextResponse.json({ ok: true });
}
