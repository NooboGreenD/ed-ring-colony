import { NextResponse } from 'next/server';

import { createLinkCode, LINK_CODE_TTL_SECONDS } from '@/lib/helperDevices';
import { checkRateLimit } from '@/lib/rateLimit';
import { authFromRequest } from '@/lib/supabaseServer';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate, private' } };

/**
 * Код привязки лаунчера — выдаётся только владельцу учётной записи.
 *
 * Код короткий и живёт десять минут: его диктуют на другом компьютере или
 * переносят в лаунчер. Пароль при этом никуда не уезжает.
 */
export async function POST(request: Request) {
  const { user } = await authFromRequest(request);
  if (!user) {
    return NextResponse.json({ ok: false, error: 'Нужно войти в учётную запись.' }, { status: 401, ...NO_STORE });
  }
  if (!checkRateLimit(`helper-link-code:${user.id}`, 6)) {
    return NextResponse.json(
      { ok: false, error: 'Слишком много кодов подряд. Подождите минуту.' },
      { status: 429, ...NO_STORE },
    );
  }
  try {
    const { code, expiresAt } = await createLinkCode(user.id);
    return NextResponse.json({
      ok: true,
      code,
      expiresAt,
      ttlSeconds: LINK_CODE_TTL_SECONDS,
    }, NO_STORE);
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Не удалось создать код.' },
      { status: 500, ...NO_STORE },
    );
  }
}
