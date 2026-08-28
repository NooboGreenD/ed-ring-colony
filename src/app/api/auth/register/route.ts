import { NextResponse } from 'next/server';
import { createAdminClient, upsertProfile } from '@/lib/supabaseAdmin';

export async function POST(req: Request) {
  let body: { email?: string; password?: string; cmdr_name?: string } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Некорректный JSON' }, { status: 400 });
  }
  const email = String(body.email ?? '').trim().toLowerCase();
  const password = String(body.password ?? '');
  const cmdr_name = String(body.cmdr_name ?? '').trim();
  if (!email || !password || !cmdr_name) {
    return NextResponse.json({ error: 'Заполните ник, почту и пароль.' }, { status: 400 });
  }
  if (password.length < 6) {
    return NextResponse.json({ error: 'Пароль должен быть не короче 6 символов.' }, { status: 400 });
  }
  const admin = createAdminClient();
  if (!admin) {
    return NextResponse.json(
      { error: 'На сервере не задан SUPABASE_SERVICE_ROLE_KEY — регистрация через API недоступна.' },
      { status: 500 },
    );
  }
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { cmdr_name },
  });
  if (error || !data.user) {
    const msg = error?.message ?? 'Не удалось создать пользователя.';
    if (/already been registered|already registered|exists/i.test(msg)) {
      return NextResponse.json({ error: 'Этот email уже зарегистрирован.' }, { status: 409 });
    }
    if (/database error saving new user/i.test(msg)) {
      return NextResponse.json(
        {
          error:
            'Supabase отклонил создание пользователя (триггер профиля). Выполните SQL из инструкции и повторите.',
        },
        { status: 500 },
      );
    }
    return NextResponse.json({ error: msg }, { status: 400 });
  }
  const profile = await upsertProfile({
    id: data.user.id,
    email,
    cmdr_name,
  });
  if (profile.error) {
    return NextResponse.json(
      { error: 'Пользователь создан, но профиль не записался: ' + profile.error },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true });
}
