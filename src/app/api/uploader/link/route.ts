import { NextResponse } from 'next/server';

import { listDevices, readSettings, revokeDevice } from '@/lib/helperDevices';
import { authFromRequest } from '@/lib/supabaseServer';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate, private' } };

/**
 * Привязанные лаунчеры в профиле на сайте.
 *
 * Пилот видит свои устройства, время последнего обращения и может отозвать
 * любое: после отзыва токен перестаёт работать сразу, а на компьютере это
 * выглядит как «требуется привязка».
 */
export async function GET(request: Request) {
  const { user } = await authFromRequest(request);
  if (!user) {
    return NextResponse.json({ ok: false, error: 'Нужно войти в учётную запись.' }, { status: 401, ...NO_STORE });
  }
  const [devices, settings] = await Promise.all([
    listDevices(user.id),
    readSettings(user.id),
  ]);
  return NextResponse.json({
    ok: true,
    devices,
    settingsUpdatedAt: settings?.updatedAt ?? '',
    settingsDevice: settings?.deviceName ?? '',
    hasSettings: Boolean(settings && Object.keys(settings.payload ?? {}).length),
  }, NO_STORE);
}

export async function DELETE(request: Request) {
  const { user } = await authFromRequest(request);
  if (!user) {
    return NextResponse.json({ ok: false, error: 'Нужно войти в учётную запись.' }, { status: 401, ...NO_STORE });
  }
  const deviceId = new URL(request.url).searchParams.get('device') ?? '';
  if (!deviceId) {
    return NextResponse.json({ ok: false, error: 'Не указано устройство.' }, { status: 400, ...NO_STORE });
  }
  const revoked = await revokeDevice(user.id, deviceId);
  if (!revoked) {
    return NextResponse.json({ ok: false, error: 'Устройство не найдено.' }, { status: 404, ...NO_STORE });
  }
  return NextResponse.json({ ok: true }, NO_STORE);
}
