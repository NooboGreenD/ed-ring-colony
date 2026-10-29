import { NextResponse } from 'next/server';

import { readSettings, resolveDeviceToken, writeSettings } from '@/lib/helperDevices';
import { authFromRequest } from '@/lib/supabaseServer';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate, private' } };

/**
 * Настройки Helper на сайте: снимок раскладки оверлея.
 *
 * Чтение по токену устройства нужно лаунчеру («скачать с сайта»), чтение по
 * сессии — странице профиля («что сейчас лежит на сайте»). Запись — только по
 * токену: снимок делает лаунчер, а не браузер.
 */
export async function GET(request: Request) {
  const device = await resolveDeviceToken(request);
  if (device) {
    const snapshot = await readSettings(device.userId);
    return NextResponse.json({
      ok: true,
      settings: snapshot?.payload ?? {},
      updatedAt: snapshot?.updatedAt ?? '',
      deviceName: snapshot?.deviceName ?? '',
    }, NO_STORE);
  }
  const { user } = await authFromRequest(request);
  if (!user) {
    return NextResponse.json({ ok: false, error: 'Нужно войти в учётную запись.' }, { status: 401, ...NO_STORE });
  }
  const snapshot = await readSettings(user.id);
  return NextResponse.json({
    ok: true,
    settings: snapshot?.payload ?? {},
    updatedAt: snapshot?.updatedAt ?? '',
    deviceName: snapshot?.deviceName ?? '',
  }, NO_STORE);
}

export async function PUT(request: Request) {
  const device = await resolveDeviceToken(request);
  if (!device) {
    return NextResponse.json(
      { ok: false, error: 'Устройство не привязано: сначала введите код из профиля.' },
      { status: 401, ...NO_STORE },
    );
  }
  let body: { settings?: unknown } = {};
  try {
    body = await request.json() as { settings?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: 'Некорректный запрос.' }, { status: 400, ...NO_STORE });
  }
  const result = await writeSettings(device.userId, body.settings, device.deviceName);
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 400, ...NO_STORE });
  }
  return NextResponse.json({ ok: true, updatedAt: result.updatedAt }, NO_STORE);
}
