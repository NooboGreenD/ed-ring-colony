import { NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/billing/auth';
import {
  generatePublishToken,
  generateSignKey,
  removeSignKey,
  setPublishToken,
  storeStatus,
  upsertSignKey,
} from '@/lib/uploaderStore';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = { headers: { 'Cache-Control': 'no-store' } };

/**
 * Настройка канала обновлений Colonial Helper из админки.
 *
 * `GET`  — текущее состояние (те же данные, что и в `versions`, но без версий).
 * `POST` — изменить настройки: добавить/удалить/сгенерировать ключ подписи,
 *          задать/сгенерировать/очистить токен публикации.
 *
 * Всё пишется в `config.json` внутри тома хранилища и складывается с
 * переменными окружения — значения из окружения из UI не удалить.
 */
export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if ('response' in auth) return auth.response;
  const store = await storeStatus();
  return NextResponse.json({ ok: true, store }, NO_STORE);
}

interface ConfigBody {
  action?: string;
  id?: unknown;
  publicKey?: unknown;
  token?: unknown;
}

export async function POST(request: Request) {
  const auth = await requireAdmin(request);
  if ('response' in auth) return auth.response;

  const body = (await request.json().catch(() => null)) as ConfigBody | null;
  const action = String(body?.action ?? '');

  const done = async (
    result: { ok: boolean; error?: string; token?: string; key?: unknown },
    extra: Record<string, unknown> = {},
  ) => {
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.error }, { status: 400, ...NO_STORE });
    }
    const store = await storeStatus();
    return NextResponse.json({ ok: true, store, ...extra }, NO_STORE);
  };

  switch (action) {
    case 'addKey':
      return done(await upsertSignKey(String(body?.id ?? ''), String(body?.publicKey ?? '')));

    case 'removeKey':
      return done(await removeSignKey(String(body?.id ?? '')));

    case 'generateKey': {
      // Приватный ключ показываем один раз — на сервере он не хранится.
      const generated = generateSignKey(body?.id ? String(body.id) : undefined);
      const saved = await upsertSignKey(generated.id, generated.publicKey);
      if (!saved.ok) return done(saved);
      return done(saved, {
        generated: { id: generated.id, publicKey: generated.publicKey, privateKey: generated.privateKey },
      });
    }

    case 'setPublishToken':
      return done(await setPublishToken(String(body?.token ?? '')));

    case 'clearPublishToken':
      return done(await setPublishToken(null));

    case 'generatePublishToken': {
      const result = await generatePublishToken();
      if (!result.ok) return done(result);
      return done({ ok: true }, { generatedToken: result.token });
    }

    default:
      return NextResponse.json({ ok: false, error: `Неизвестное действие: ${action}` }, { status: 400, ...NO_STORE });
  }
}
