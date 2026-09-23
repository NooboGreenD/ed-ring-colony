import { NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/billing/auth';
import { deleteEnvKey, listEnvKeys, saveEnvKey } from '@/lib/updateAgent';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = { headers: { 'Cache-Control': 'no-store' } };
const KEY_RE = /^[A-Z][A-Z0-9_]{0,127}$/;
const MAX_VALUE_BYTES = 8 * 1024;

/**
 * Admin-only management of the host env file (.env.production).
 *
 * The web container never sees the raw values: the update-agent answers with
 * masks (length + last 4 chars), so editing an existing key means replacing
 * it, never reading it first. Applies only after «Применить»
 * (/api/admin/env/apply) recreates the services.
 */
export async function GET(request: Request) {
  try {
    const auth = await requireAdmin(request);
    if ('response' in auth) return auth.response;

    const result = await listEnvKeys();
    if (!result.ok) {
      return NextResponse.json({ error: result.error || 'Не удалось получить список ключей' }, { status: result.status, ...NO_STORE });
    }
    return NextResponse.json({
      success: true,
      configured: result.payload?.configured === true,
      keys: Array.isArray(result.payload?.keys) ? result.payload.keys : [],
    }, NO_STORE);
  } catch {
    return NextResponse.json({ error: 'Не удалось получить список ключей' }, { status: 500, ...NO_STORE });
  }
}

export async function POST(request: Request) {
  try {
    const auth = await requireAdmin(request);
    if ('response' in auth) return auth.response;

    const body = await request.json().catch(() => null) as { key?: unknown; value?: unknown } | null;
    const key = typeof body?.key === 'string' ? body.key.trim() : '';
    const value = typeof body?.value === 'string' ? body.value : null;
    if (!KEY_RE.test(key)) {
      return NextResponse.json({ error: 'Имя ключа: заглавные A–Z, цифры и _ (1–128 символов)' }, { status: 400, ...NO_STORE });
    }
    if (value == null || /[\r\n]/.test(value) || Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES) {
      return NextResponse.json({ error: 'Значение: одна строка до 8 КБ без перевода строки' }, { status: 400, ...NO_STORE });
    }

    const result = await saveEnvKey(key, value);
    if (!result.ok) {
      return NextResponse.json({ error: result.error || 'Не удалось сохранить ключ' }, { status: result.status, ...NO_STORE });
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
    if (!KEY_RE.test(key)) {
      return NextResponse.json({ error: 'Имя ключа: заглавные A–Z, цифры и _ (1–128 символов)' }, { status: 400, ...NO_STORE });
    }

    const result = await deleteEnvKey(key);
    if (!result.ok) {
      return NextResponse.json({ error: result.error || 'Не удалось удалить ключ' }, { status: result.status, ...NO_STORE });
    }
    return NextResponse.json({ success: true, key }, NO_STORE);
  } catch {
    return NextResponse.json({ error: 'Не удалось удалить ключ' }, { status: 500, ...NO_STORE });
  }
}
