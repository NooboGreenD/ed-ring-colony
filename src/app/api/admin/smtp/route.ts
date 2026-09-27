import { NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/billing/auth';
import { SMTP_KEYS, listSmtpKeys, saveSmtpKey, deleteSmtpKey, type SmtpKeyName } from '@/lib/updateAgent';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = { headers: { 'Cache-Control': 'no-store' } };

/**
 * Настройки отправки писем (Админка → Авторизация → «Отправка писем»).
 *
 * Письма подтверждения при регистрации отправляет GoTrue (сервис auth стека
 * Supabase): сайт лишь проверяет конфигурацию и проксирует правки SMTP-ключей
 * через update-agent — тот же узкий хоппинг, что и у «API-ключей». Снаружи
 * уходят только маски значений: пароль SMTP нельзя прочитать из браузера,
 * можно только заменить целиком.
 */
export async function GET(request: Request) {
  try {
    const auth = await requireAdmin(request);
    if ('response' in auth) return auth.response;

    const result = await listSmtpKeys();
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error || 'Не удалось получить настройки почты' },
        { status: result.status, ...NO_STORE },
      );
    }
    return NextResponse.json({
      success: true,
      // Ключи сайта, влияющие на регистрацию: панель показывает их рядом,
      // чтобы всё, что нужно письмам, настраивалось в одном месте.
      webEmailEnabled: process.env.AUTH_EMAIL_ENABLED === 'true',
      allowedKeys: SMTP_KEYS,
      available: result.payload?.available === true,
      envExists: result.payload?.envExists === true,
      override: result.payload?.override ?? null,
      keys: Array.isArray(result.payload?.keys) ? result.payload.keys : [],
    }, NO_STORE);
  } catch {
    return NextResponse.json({ error: 'Не удалось получить настройки почты' }, { status: 500, ...NO_STORE });
  }
}

export async function POST(request: Request) {
  try {
    const auth = await requireAdmin(request);
    if ('response' in auth) return auth.response;

    const body = await request.json().catch(() => null) as { key?: unknown; value?: unknown } | null;
    const key = typeof body?.key === 'string' ? body.key.trim() : '';
    const value = typeof body?.value === 'string' ? body.value : null;
    if (!(SMTP_KEYS as readonly string[]).includes(key)) {
      return NextResponse.json(
        { error: `Ключ должен быть одним из: ${SMTP_KEYS.join(', ')}` },
        { status: 400, ...NO_STORE },
      );
    }
    if (value == null || /[\r\n]/.test(value) || Buffer.byteLength(value, 'utf8') > 8 * 1024) {
      return NextResponse.json({ error: 'Значение: одна строка до 8 КБ без перевода строки' }, { status: 400, ...NO_STORE });
    }

    const result = await saveSmtpKey(key as SmtpKeyName, value);
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error || 'Не удалось сохранить ключ' },
        { status: result.status, ...NO_STORE },
      );
    }
    return NextResponse.json({
      success: true,
      key,
      created: result.payload?.created === true,
      masked: result.payload?.masked ?? null,
    }, { status: result.payload?.created ? 201 : 200, ...NO_STORE });
  } catch {
    return NextResponse.json({ error: 'Не удалось сохранить ключ' }, { status: 500, ...NO_STORE });
  }
}

export async function DELETE(request: Request) {
  try {
    const auth = await requireAdmin(request);
    if ('response' in auth) return auth.response;

    const key = new URL(request.url).searchParams.get('key') || '';
    if (!(SMTP_KEYS as readonly string[]).includes(key)) {
      return NextResponse.json(
        { error: `Ключ должен быть одним из: ${SMTP_KEYS.join(', ')}` },
        { status: 400, ...NO_STORE },
      );
    }

    const result = await deleteSmtpKey(key as SmtpKeyName);
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error || 'Не удалось удалить ключ' },
        { status: result.status, ...NO_STORE },
      );
    }
    return NextResponse.json({ success: true, key }, NO_STORE);
  } catch {
    return NextResponse.json({ error: 'Не удалось удалить ключ' }, { status: 500, ...NO_STORE });
  }
}
