import { NextResponse } from 'next/server';
import { authFromRequest, createServiceClient } from '@/lib/supabaseServer';
import { encryptRavenKey, maskRavenKey } from '@/lib/raven/keyVault';
import { ravenWhoAmI } from '@/lib/raven/client';

export const dynamic = 'force-dynamic';

const secret = () => process.env.RAVEN_KEY_SECRET || '';

/** Состояние: подключён ли ключ, маска и имя командира. Сам ключ не отдаём. */
export async function GET(req: Request) {
  const { user } = await authFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { data, error } = await createServiceClient()
    .from('raven_keys')
    .select('key_mask, cmdr_name, updated_at')
    .eq('user_id', user.id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({
    connected: Boolean(data),
    mask: data?.key_mask ?? null,
    cmdrName: data?.cmdr_name ?? null,
    updatedAt: data?.updated_at ?? null,
  });
}

/** Сохранить ключ: сначала проверяем его в Raven, потом шифруем и кладём в базу. */
export async function PUT(req: Request) {
  const { user } = await authFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!secret()) {
    return NextResponse.json({ error: 'На сервере не задан RAVEN_KEY_SECRET — сохранить ключ нельзя.' }, { status: 503 });
  }
  let body: { key?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Ожидался JSON' }, { status: 400 });
  }
  const key = typeof body.key === 'string' ? body.key.trim() : '';
  if (key.length < 8 || key.length > 200) {
    return NextResponse.json({ error: 'Ключ RCC выглядит неверно' }, { status: 400 });
  }
  const who = await ravenWhoAmI(key);
  if (!who.ok) return NextResponse.json({ error: who.error }, { status: 400 });

  const { error } = await createServiceClient()
    .from('raven_keys')
    .upsert({
      user_id: user.id,
      key_cipher: encryptRavenKey(key, secret()),
      key_mask: maskRavenKey(key),
      cmdr_name: who.displayName || null,
      updated_at: new Date().toISOString(),
    });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ connected: true, mask: maskRavenKey(key), cmdrName: who.displayName || null });
}

/** Удалить ключ с сайта. */
export async function DELETE(req: Request) {
  const { user } = await authFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { error } = await createServiceClient().from('raven_keys').delete().eq('user_id', user.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ connected: false });
}
