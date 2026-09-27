import { NextResponse } from 'next/server';

import { requireAdmin, errorResponse } from '@/lib/billing/auth';
import { applySmtpSettings } from '@/lib/updateAgent';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = { headers: { 'Cache-Control': 'no-store' } };

/**
 * Применить настройки почты: пересоздать контейнер auth стека Supabase (чтобы
 * GoTrue поднял SMTP-ключи) и затем web (чтобы поднялись ключи сайта, например
 * AUTH_EMAIL_ENABLED). Идёт через тот же процессный слот, что и обновление
 * (job `kind: 'smtp'`), поэтому не может пересечься с пересборкой.
 */
export async function POST(request: Request) {
  try {
    const auth = await requireAdmin(request);
    if ('response' in auth) return auth.response;

    // Адрес проверки GoTrue агент берёт от нас: web знает NEXT_PUBLIC_SUPABASE_URL.
    const supabaseUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/$/, '');
    const authHealthUrl = supabaseUrl ? `${supabaseUrl}/auth/v1/health` : '';

    const result = await applySmtpSettings(authHealthUrl);
    if (!result.ok) {
      return NextResponse.json(
        { success: false, error: result.error, update: result.update },
        { status: result.status, ...NO_STORE },
      );
    }
    return NextResponse.json({ success: true, update: result.update }, { status: 202, ...NO_STORE });
  } catch {
    return NextResponse.json(
      { error: 'Не удалось применить настройки почты' },
      { status: 500, ...NO_STORE },
    );
  }
}
