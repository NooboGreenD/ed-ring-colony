import { NextResponse } from 'next/server';

import { profileForDevice, resolveDeviceToken, revokeDevice } from '@/lib/helperDevices';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate, private' } };

/**
 * Профиль пилота для лаунчера.
 *
 * Лаунчер показывает в правом верхнем углу аватар и имя командира — те же,
 * что на сайте. Данные берутся по токену устройства, поэтому лаунчер не
 * хранит ни почту, ни пароль.
 */
export async function GET(request: Request) {
  const device = await resolveDeviceToken(request);
  if (!device) {
    return NextResponse.json(
      { ok: false, error: 'Устройство не привязано или привязка отозвана.' },
      { status: 401, ...NO_STORE },
    );
  }
  const profile = await profileForDevice(device);
  return NextResponse.json({
    ok: true,
    profile,
    device: { id: device.deviceId, name: device.deviceName },
  }, NO_STORE);
}

/** Отвязать текущее устройство: лаунчер «забывает» учётную запись. */
export async function DELETE(request: Request) {
  const device = await resolveDeviceToken(request);
  if (!device) {
    // Уже отвязано — для клиента это успех: повторный запрос не должен ругаться.
    return NextResponse.json({ ok: true }, NO_STORE);
  }
  await revokeDevice(device.userId, device.deviceId);
  return NextResponse.json({ ok: true }, NO_STORE);
}
