import { NextResponse } from 'next/server';

import { claimLinkCode } from '@/lib/helperDevices';
import { checkRateLimit } from '@/lib/rateLimit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate, private' } };

function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim() || 'local';
  return request.headers.get('x-real-ip')?.trim() || 'local';
}

/**
 * Обмен кода из профиля на токен устройства.
 *
 * Адрес намеренно без сессии: код вводит лаунчер на другом компьютере, где
 * cookie сайта нет. Ограничение частоты — по IP, чтобы восьмизначный код
 * нельзя было перебрать.
 */
export async function POST(request: Request) {
  const ip = clientIp(request);
  if (!checkRateLimit(`helper-link-claim:${ip}`, 12)) {
    return NextResponse.json(
      { ok: false, error: 'Слишком много попыток. Подождите минуту.' },
      { status: 429, ...NO_STORE },
    );
  }

  let body: { code?: unknown; device?: unknown } = {};
  try {
    body = await request.json() as { code?: unknown; device?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: 'Некорректный запрос.' }, { status: 400, ...NO_STORE });
  }

  const result = await claimLinkCode(body.code, String(body.device ?? '').trim());
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 400, ...NO_STORE });
  }
  return NextResponse.json({
    ok: true,
    token: result.token,
    deviceId: result.deviceId,
    profile: result.profile,
  }, NO_STORE);
}
