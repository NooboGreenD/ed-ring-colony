import { NextResponse } from 'next/server';
import { authFromRequest } from '@/lib/supabaseServer';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const { user, supabase } = await authFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Требуется авторизация' }, { status: 401 });
  const { data, error } = await supabase.from('outfitting_builds').select('id,name,ship,code,created_at').eq('user_id', user.id).order('created_at', { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ builds: data ?? [] });
}

export async function POST(req: Request) {
  const { user, supabase } = await authFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Требуется авторизация' }, { status: 401 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body.name !== 'string' || typeof body.ship !== 'string' || typeof body.code !== 'string') return NextResponse.json({ error: 'Некорректная сборка' }, { status: 400 });
  const { data, error } = await supabase.from('outfitting_builds').insert({ user_id: user.id, name: body.name.trim().slice(0, 120), ship: body.ship.slice(0, 120), code: body.code.slice(0, 20000) }).select('id,name,ship,code,created_at').single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ build: data }, { status: 201 });
}

export async function DELETE(req: Request) {
  const { user, supabase } = await authFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Требуется авторизация' }, { status: 401 });
  const id = new URL(req.url).searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'Не указан id' }, { status: 400 });
  await supabase.from('outfitting_builds').delete().eq('id', id).eq('user_id', user.id);
  return NextResponse.json({ ok: true });
}
